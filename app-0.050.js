(() => {
  'use strict';

  const APP_VERSION = '0.050';
  const L = window.PalletLogic;
  const DB_NAME = 'night-pallet-counter';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';
  const STATE_KEY = 'app-state';

  const VIEW_TITLES = {
    night: '夜班產出', online: '二次分理', inventory: '現場盤點', reports: '快速回報', stats: '統計核對',
    morning: '中班數量', transit: '過境貨', loaded: '提前載走',
    returns: '回倉紀錄', events: '事件紀錄', shifts: '班次／備份',
  };

  let db;
  let state;
  let deferredInstallPrompt = null;
  let toastTimer = null;
  let wakeLock = null;
  let nightUndoOperationId = null;
  let undoDismissed = false;
  let returnRefreshTimer = null;
  let returnHistoryEditBucketKey = null;
  let returnHistoryEditSource = 'DC2';
  let loadedExpandedGroup = null;
  let loadedFocusStation = null;
  let preMidnightExpanded = false;
  let preMidnightEditing = false;
  let preMidnightAddGroup = null;
  let preMidnightOtherCarrier = false;
  let transitExpandedGroup = null;
  let transitFocusStation = null;
  let transitSummaryExpanded = false;
  let onlineExpandedChute = null;
  let morningDirectSaveQueue = Promise.resolve();
  const morningInputFlashTimers = new WeakMap();
  let nightChuteScrollHandler = null;
  let nightChuteScrollRaf = null;

  const el = (id) => document.getElementById(id);
  const main = el('mainContent');
  const drawer = el('drawer');
  const backdrop = el('drawerBackdrop');
  const eventDialog = el('eventDialog');
  const quantityDialog = el('quantityDialog');

  function defaultState() {
    return {
      version: 15,
      currentShiftId: null,
      shifts: [],
      activeView: 'night',
      ui: {
        statsGroup: 'ALL', statsAnomaliesOnly: false, statsCarrier: 'ALL', inventoryGroup: 'ALL', inventoryExpandedStations: [],
        morningGroup: 'ALL', morningZeroOnly: false,
        eventStation: 'ALL', eventCategory: 'ALL', eventCarrier: 'ALL', eventOrder: 'desc',
        nightCorrection: false, nightOtherCarrier: false, onlineOtherCarrier: false,
        morningOtherCarrier: false, loadedOtherCarrier: false, transitCarrier: 'cage', returnCarrier: 'cage', reportMode: 'THREE_AM',
      },
    };
  }

  function migrateAppState(rawState) {
    const base = defaultState();
    const migrated = rawState && typeof rawState === 'object' ? rawState : base;
    migrated.version = 15;
    migrated.shifts = Array.isArray(migrated.shifts) ? migrated.shifts : [];
    migrated.shifts.forEach((shift) => L.migrateShift(shift));
    migrated.ui = { ...base.ui, ...(migrated.ui || {}) };
    const validViews = new Set(Object.keys(VIEW_TITLES));
    if (migrated.activeView === 'reports5') migrated.activeView = 'reports';
    if (!validViews.has(migrated.activeView)) migrated.activeView = 'night';
    if (!['ALL', ...L.GROUP_ORDER].includes(migrated.ui.statsGroup)) migrated.ui.statsGroup = 'ALL';
    if (!['ALL', ...L.GROUP_ORDER].includes(migrated.ui.inventoryGroup)) migrated.ui.inventoryGroup = 'ALL';
    if (!['ALL', ...L.GROUP_ORDER].includes(migrated.ui.morningGroup)) migrated.ui.morningGroup = 'ALL';
    migrated.ui.morningZeroOnly = Boolean(migrated.ui.morningZeroOnly);
    migrated.ui.inventoryExpandedStations = Array.isArray(migrated.ui.inventoryExpandedStations)
      ? [...new Set(migrated.ui.inventoryExpandedStations
        .map((station) => L.canonicalStationName(station))
        .filter((station) => L.STATIONS.includes(station)))]
      : [];
    if (migrated.ui.eventStation !== 'ALL') {
      migrated.ui.eventStation = L.canonicalStationName(migrated.ui.eventStation);
      if (!L.STATIONS.includes(migrated.ui.eventStation)) migrated.ui.eventStation = 'ALL';
    }
    if (!['ALL', ...L.CARRIERS].includes(migrated.ui.statsCarrier)) migrated.ui.statsCarrier = 'ALL';
    if (!['THREE_AM', 'FIVE_AM'].includes(migrated.ui.reportMode)) migrated.ui.reportMode = 'THREE_AM';
    ['transitCarrier', 'returnCarrier'].forEach((key) => {
      if (!L.CARRIERS.includes(migrated.ui[key])) migrated.ui[key] = 'cage';
    });
    migrated.ui.nightCorrection = false;
    migrated.ui.nightOtherCarrier = false;
    migrated.ui.onlineOtherCarrier = false;
    migrated.ui.morningOtherCarrier = false;
    migrated.ui.loadedOtherCarrier = false;
    if (migrated.currentShiftId && !migrated.shifts.some((shift) => shift.id === migrated.currentShiftId)) {
      migrated.currentShiftId = migrated.shifts[0]?.id || null;
    }
    return migrated;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dbGet(key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dbSet(key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function saveState() { await dbSet(STATE_KEY, state); }
  function currentShift() { return state.shifts.find((shift) => shift.id === state.currentShiftId) || null; }

  function previousShift() {
    const shifts = state.shifts.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const currentIndex = shifts.findIndex((shift) => shift.id === state.currentShiftId);
    return shifts[currentIndex + 1] || shifts.find((shift) => shift.id !== state.currentShiftId) || null;
  }

  async function ensureInitialShift() {
    if (state.shifts.length > 0 && state.currentShiftId) return;
    const date = L.localDate();
    const testMode = new URLSearchParams(window.location.search).has('test');
    if (!(testMode || window.confirm(`尚未建立班次。要建立 ${date} 的大夜班嗎？`))) {
      state.activeView = 'shifts';
      return;
    }
    const shift = L.createShift(date);
    state.shifts.push(shift);
    state.currentShiftId = shift.id;
    await saveState();
  }

  function updateHeader() {
    const shift = currentShift();
    el('pageTitle').textContent = VIEW_TITLES[state.activeView] || '夜班點貨';
    const returns = shift ? L.computeReturnCounts(shift).carrierTotals.total : 0;
    el('shiftLabel').textContent = shift ? `${shift.date}｜00:00–08:00｜${shift.events.length}筆｜回倉${returns}` : '尚未建立班次';
    document.querySelectorAll('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.view === state.activeView));
  }

  function showToast(message, duration = 1900) {
    const toast = el('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
  }

  function vibrate(ms = 45) { if ('vibrate' in navigator) navigator.vibrate(ms); }
  function categoryLabel(category) { return L.CATEGORY_LABELS[category] || category; }
  function carrierLabel(carrier) { return L.CARRIER_LABELS[carrier] || carrier; }
  function carrierShort(carrier) { return carrier === 'cage' ? '籠' : '板'; }
  function formatTime(timestamp) { return new Date(timestamp).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

  function requireShift() {
    const shift = currentShift();
    if (shift) return shift;
    main.innerHTML = '<section class="card empty-state"><h2>尚未建立班次</h2><p>請先到「班次／備份」建立班次。</p><button class="primary-btn action-btn" data-view="shifts">前往建立班次</button></section>';
    bindViewLinks();
    return null;
  }

  function restartVisualAnimation(element, className) {
    if (!element) return;
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
  }

  function flashStationButton(station) {
    const button = document.querySelector(`[data-station="${station}"]`);
    if (!button) return;

    restartVisualAnimation(button, 'flash');

    if (state.activeView !== 'night' || !button.matches('[data-night-station]')) return;

    restartVisualAnimation(button, 'night-feedback-active');
    restartVisualAnimation(button.querySelector('[data-night-count]'), 'night-count-pulse');
    restartVisualAnimation(button.querySelector('.night-click-feedback'), 'is-visible');

    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove('night-feedback-active');
      button.querySelector('[data-night-count]')?.classList.remove('night-count-pulse');
      button.querySelector('.night-click-feedback')?.classList.remove('is-visible');
    }, 560);
  }

  function bindNightPressFeedback(button) {
    const pressOn = () => button.classList.add('night-pressing');
    const pressOff = () => button.classList.remove('night-pressing');

    button.addEventListener('pointerdown', pressOn);
    button.addEventListener('pointerup', pressOff);
    button.addEventListener('pointercancel', pressOff);
    button.addEventListener('pointerleave', pressOff);
  }

  function hideUndoBar() { el('undoBar').classList.add('hidden'); }

  function updateUndoBar(message = '', operationId = null) {
    const shift = currentShift();
    const bar = el('undoBar');
    if (state.activeView !== 'night' || !shift || undoDismissed) return bar.classList.add('hidden');
    if (operationId) nightUndoOperationId = operationId;
    if (!nightUndoOperationId) return bar.classList.add('hidden');
    const related = shift.events.filter((event) => (event.operationId || event.id) === nightUndoOperationId);
    if (!related.length) { nightUndoOperationId = null; return bar.classList.add('hidden'); }
    const last = related.at(-1);
    el('undoMessage').textContent = message || `上一筆：${stationLabel(last.station)} ${carrierShort(last.carrier)}${last.delta > 0 ? '+' : ''}${last.delta}`;
    bar.classList.remove('hidden');
  }

  async function addSingle(station, category, delta = 1, carrier = null, note = '') {
    const shift = currentShift();
    if (!shift) return null;
    try {
      const event = L.addEvent(shift, { station, category, carrier, delta, note });
      const isNightAction = state.activeView === 'night' && category === 'night';
      if (isNightAction) { nightUndoOperationId = event.operationId || event.id; undoDismissed = false; }
      await saveState();
      vibrate();
      const scrollPosition = window.scrollY;
      renderCurrentView();
      window.scrollTo(0, scrollPosition);
      requestAnimationFrame(() => flashStationButton(station));
      if (isNightAction) updateUndoBar(`${stationLabel(station)} ${carrierShort(event.carrier)} ${delta > 0 ? '+' : ''}${delta}`, nightUndoOperationId);
      showToast(`${stationLabel(station)} ${categoryLabel(category)}${carrierShort(event.carrier)} ${delta > 0 ? '+' : ''}${delta}`);
      return event;
    } catch (error) {
      showToast(error.message);
      return null;
    }
  }

  function carrierModeHtml(active, dataKey, includeAll = false) {
    const options = includeAll ? [['ALL', '合計'], ['cage', '籠車'], ['pallet', '棧板']] : [['cage', '籠車'], ['pallet', '棧板']];
    return `<div class="carrier-switch">${options.map(([value, label]) => `<button type="button" class="${active === value ? 'active' : ''}" data-${dataKey}="${value}">${label}</button>`).join('')}</div>`;
  }

  function carrierPair(cage, pallet, separator = '／') {
    return `${cage}籠${separator}${pallet}板`;
  }

  function stationLabel(station) {
    return L.displayStationName(station);
  }

  function stationCarrierSummary(counts, station, category) {
    const c = counts[station][category];
    return carrierPair(c.cage, c.pallet);
  }

  function guideDetailsHtml(title, brief, details) {
    return `<details class="card compact-guide"><summary><span><strong>${title}</strong><small>${brief}</small></span><span class="guide-toggle">操作說明</span></summary><p class="small-note">${details}</p></details>`;
  }

  function groupTitle(group) {
    if (group === 'NS') return 'NS／Nt 系列';
    if (group === 'TS') return 'TS／Tt 系列';
    if (group === 'CS') return 'CS／Ct 系列';
    if (group === 'S') return 'S 系列（SS／St／KS／Kt）';
    if (group === 'E') return 'E 系列（Et／Ht／Yt）';
    return `${group} 系列`;
  }

  function shortGroupTitle(group) {
    if (group === 'NS') return 'N系列';
    if (group === 'TS') return 'T系列';
    if (group === 'CS') return 'C系列';
    if (group === 'S') return 'S系列';
    if (group === 'E') return 'E系列';
    return `${group}系列`;
  }

  function actionCarrier(station, useOtherCarrier) {
    const base = L.defaultCarrierForStation(station);
    return useOtherCarrier ? L.otherCarrier(base) : base;
  }

  function resetOneShotCarrier(category) {
    if (category === 'morning') state.ui.morningOtherCarrier = false;
    if (category === 'loaded') state.ui.loadedOtherCarrier = false;
  }

  async function addQuantityAdjustment(station, category, carrier, direction, quantity) {
    resetOneShotCarrier(category);
    return addSingle(station, category, Number(direction) * Number(quantity), carrier);
  }

  function nightStationLabelClass(station) {
    const group = L.stationLabelColorGroup(station);
    return group === 'N' ? '' : `night-label-${group.toLowerCase()}`;
  }

  function nightChuteSectionAttrs(chute) {
    return `id="night-chute-${chute.id}" data-night-chute-section="${chute.id}"`;
  }

  function nightChuteNavHtml() {
    return `<nav class="night-chute-nav" aria-label="夜班滑道快速定位">
      ${L.CHUTES.map((chute) => `<button type="button" data-night-chute-jump="${chute.id}" aria-label="前往第${chute.id}滑道">${chute.id}</button>`).join('')}
    </nav>`;
  }

  function nightStationButtonsHtml(counts) {
    return L.CHUTES.map((chute) => `
      <section class="page-section night-chute-section" ${nightChuteSectionAttrs(chute)}>
        <h2 class="section-title">${chute.name}<small>${chute.stations.length}站</small></h2>
        <div class="station-grid">
          ${chute.stations.map((station) => {
            const category = counts[station].night;
            const total = L.countFor(category, 'ALL');
            const defaultCarrier = L.defaultCarrierForStation(station);
            return `<button class="station-btn ${nightStationLabelClass(station)}" data-night-station="${station}" data-station="${station}">
              <span class="night-click-feedback" aria-hidden="true">＋1</span>
              <span class="station-name">${stationLabel(station)}</span><span class="station-count" data-night-count>${total}</span>
              <span class="carrier-mini">${carrierPair(category.cage, category.pallet)}</span>
              <span class="default-badge">預設：${carrierLabel(defaultCarrier)}</span>
            </button>`;
          }).join('')}
        </div>
      </section>`).join('');
  }

  function nightCorrectionHtml(counts) {
    return L.CHUTES.map((chute) => `
      <section class="page-section night-chute-section" ${nightChuteSectionAttrs(chute)}><h2 class="section-title">${chute.name}<small>${chute.stations.length}站</small></h2>
        <div class="night-correction-grid">${chute.stations.map((station) => `
          <div class="night-correction-card"><strong>${stationLabel(station)}</strong>
            ${L.CARRIERS.map((carrier) => `<div class="carrier-adjust-line"><span>${counts[station].night[carrier]}${carrierShort(carrier)}</span><button data-night-correct="-1" data-carrier="${carrier}" data-station="${station}">−</button><button data-night-correct="1" data-carrier="${carrier}" data-station="${station}">＋</button></div>`).join('')}
          </div>`).join('')}</div>
      </section>`).join('');
  }

  function setActiveNightChute(chuteId) {
    main.querySelectorAll('[data-night-chute-jump]').forEach((button) => {
      const isActive = button.dataset.nightChuteJump === String(chuteId);
      button.classList.toggle('is-current', isActive);
      if (isActive) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    });
  }

  function clearNightChuteTracking() {
    if (nightChuteScrollHandler) {
      window.removeEventListener('scroll', nightChuteScrollHandler);
      window.removeEventListener('resize', nightChuteScrollHandler);
      nightChuteScrollHandler = null;
    }
    if (nightChuteScrollRaf !== null) {
      window.cancelAnimationFrame(nightChuteScrollRaf);
      nightChuteScrollRaf = null;
    }
  }

  function updateActiveNightChute() {
    nightChuteScrollRaf = null;
    const nav = main.querySelector('.night-chute-nav');
    const sections = [...main.querySelectorAll('[data-night-chute-section]')];
    if (!nav || !sections.length) return;

    const triggerY = nav.getBoundingClientRect().bottom + 12;
    let active = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= triggerY) active = section;
      else break;
    }

    const pageBottom = window.scrollY + window.innerHeight;
    const docBottom = document.documentElement.scrollHeight;
    if (pageBottom >= docBottom - 2) active = sections[sections.length - 1];
    setActiveNightChute(active.dataset.nightChuteSection);
  }

  function bindNightChuteTracking() {
    clearNightChuteTracking();
    nightChuteScrollHandler = () => {
      if (nightChuteScrollRaf !== null) return;
      nightChuteScrollRaf = window.requestAnimationFrame(updateActiveNightChute);
    };
    window.addEventListener('scroll', nightChuteScrollHandler, { passive: true });
    window.addEventListener('resize', nightChuteScrollHandler);
    updateActiveNightChute();
  }

  function bindNightChuteJump() {
    main.querySelectorAll('[data-night-chute-jump]').forEach((button) => button.addEventListener('click', () => {
      const chuteId = button.dataset.nightChuteJump;
      const target = main.querySelector(`[data-night-chute-section="${chuteId}"]`);
      if (target) {
        setActiveNightChute(chuteId);
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }));
  }

  function renderNight() {
    clearNightChuteTracking();
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const correction = state.ui.nightCorrection;
    const otherMode = state.ui.nightOtherCarrier;
    main.innerHTML = `
      <section class="card night-mode-card compact-mode-card">
        <div><strong>${correction ? '修正夜班數量' : '點站所＋1'}</strong><p class="small-note night-mode-note">${correction ? '籠／板可分別調整。' : '特殊載具先按「非預設」。'}</p></div>
      </section>
      <div class="night-quick-actions">
        <button type="button" class="${correction ? 'primary-btn' : 'secondary-btn'} night-mode-toggle" data-toggle-night-correction>${correction ? '返回＋1' : '修正數量'}</button>
        <button type="button" class="carrier-override ${otherMode ? 'active' : ''}" data-night-other ${correction ? 'disabled aria-disabled="true"' : ''}>${otherMode ? '非預設：開' : '非預設'}</button>
      </div>
      ${nightChuteNavHtml()}
      ${correction ? nightCorrectionHtml(counts) : nightStationButtonsHtml(counts)}`;

    main.querySelector('[data-toggle-night-correction]').addEventListener('click', async () => {
      state.ui.nightCorrection = !state.ui.nightCorrection; state.ui.nightOtherCarrier = false; await saveState(); renderCurrentView();
    });
    bindNightChuteJump();
    bindNightChuteTracking();
    if (correction) {
      main.querySelectorAll('[data-night-correct]').forEach((button) => button.addEventListener('click', () => addSingle(
        button.dataset.station, 'night', Number(button.dataset.nightCorrect), button.dataset.carrier, '夜班前面數量修正'
      )));
    } else {
      main.querySelector('[data-night-other]').addEventListener('click', async () => {
        state.ui.nightOtherCarrier = !state.ui.nightOtherCarrier; await saveState(); renderNight();
      });
      main.querySelectorAll('[data-night-station]').forEach((button) => {
        bindNightPressFeedback(button);
        button.addEventListener('click', async () => {
          const station = button.dataset.nightStation;
          const base = L.defaultCarrierForStation(station);
          const carrier = state.ui.nightOtherCarrier ? L.otherCarrier(base) : base;
          state.ui.nightOtherCarrier = false;
          await addSingle(station, 'night', 1, carrier);
        });
      });
    }
    updateUndoBar();
  }

  function transitSummaryEntries(counts) {
    return L.STATIONS.flatMap((station) => {
      const quantity = L.compactCarrierQuantity(
        counts[station].transit.cage,
        counts[station].transit.pallet
      );
      return quantity ? [{
        station,
        quantity,
        group: L.stationGroup(station),
        cage: counts[station].transit.cage,
        pallet: counts[station].transit.pallet,
      }] : [];
    });
  }

  function transitSummaryTotals(entries) {
    return entries.reduce((totals, entry) => {
      totals.stations += 1;
      totals.cage += Number(entry.cage || 0);
      totals.pallet += Number(entry.pallet || 0);
      return totals;
    }, { stations: 0, cage: 0, pallet: 0 });
  }

  function transitSummaryHtml(counts) {
    const entries = transitSummaryEntries(counts);
    const totals = transitSummaryTotals(entries);
    const totalQuantity = L.compactCarrierQuantity(
      totals.cage,
      totals.pallet
    ) || '0';

    return `<section class="card loaded-summary-card transit-summary-card ${transitSummaryExpanded ? 'is-expanded' : 'is-collapsed'}">
      <div class="transit-summary-head">
        <div class="transit-summary-title">
          <strong>目前過境貨</strong>
          <span>${totals.stations}站｜${totalQuantity}</span>
        </div>
        <button type="button"
          class="transit-summary-toggle"
          data-transit-summary-toggle
          aria-expanded="${transitSummaryExpanded ? 'true' : 'false'}">
          ${transitSummaryExpanded ? '收起' : '展開'}
        </button>
      </div>
      ${transitSummaryExpanded ? (
        entries.length
          ? `<div class="loaded-summary-chips">${entries.map((entry) =>
              `<button type="button" class="loaded-summary-chip transit-summary-chip" data-transit-summary-station="${entry.station}">
                <strong>${stationLabel(entry.station)}</strong><span>${entry.quantity}</span>
              </button>`
            ).join('')}</div>`
          : '<div class="loaded-summary-empty">目前無過境貨紀錄</div>'
      ) : ''}
    </section>`;
  }


  function transitSeriesButtonsHtml(counts) {
    return `<div class="loaded-series-buttons">${L.GROUP_ORDER.map((group) => {
      const usedStations = L.STATION_GROUPS[group].filter((station) =>
        L.countFor(counts[station].transit, 'ALL') > 0
      ).length;
      const active = transitExpandedGroup === group;

      return `<button type="button"
        class="loaded-series-button ${loadedSeriesButtonClass(group)} ${active ? 'active' : ''}"
        data-transit-group="${group}"
        aria-expanded="${active ? 'true' : 'false'}">
        <strong>${loadedSeriesLabel(group)}</strong>
        ${usedStations ? `<small>${usedStations}站</small>` : '<small aria-hidden="true">&nbsp;</small>'}
      </button>`;
    }).join('')}</div>`;
  }

  function transitExpandedGroupHtml(counts, carrier) {
    if (!transitExpandedGroup || !L.STATION_GROUPS[transitExpandedGroup]) return '';

    const group = transitExpandedGroup;
    const stations = L.STATION_GROUPS[group];

    return `<section class="page-section loaded-expanded-section transit-expanded-section">
      <h2 class="section-title">
        ${groupTitle(group)}
        <small>再次按${loadedSeriesLabel(group)}收合</small>
      </h2>
      <div class="loaded-grid">${stations.map((station) => {
        const category = counts[station].transit;
        const selectedCount = category[carrier];
        const totalQuantity = L.compactCarrierQuantity(
          category.cage,
          category.pallet
        ) || '0';
        const hasTransit = L.countFor(category, 'ALL') > 0;
        const focused = transitFocusStation === station;

        return `<article class="loaded-card transit-card ${hasTransit ? 'has-loaded has-transit' : ''} ${focused ? 'is-focused' : ''}"
          data-transit-card="${station}">
          <div class="loaded-card-head">
            <strong>${stationLabel(station)}</strong>
            <span>${totalQuantity}</span>
          </div>
          <small>目前操作：${carrierLabel(carrier)}</small>
          <div>
            <button type="button"
              data-transit-change="-1"
              data-station="${station}"
              ${selectedCount <= 0 ? 'disabled' : ''}>−1</button>
            <button type="button"
              data-transit-change="1"
              data-station="${station}">＋1</button>
          </div>
        </article>`;
      }).join('')}</div>
    </section>`;
  }

  function renderTransit() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const carrier = state.ui.transitCarrier;

    if (transitExpandedGroup && !L.GROUP_ORDER.includes(transitExpandedGroup)) {
      transitExpandedGroup = null;
    }

    main.innerHTML = `
      ${guideDetailsHtml('過境貨', '先選載具，再選系列', '籠車／棧板切換方式維持不變。一次只展開N／T／C／S／E其中一個系列；再次按同一系列可收合。上方過境貨小卡可直接定位站所。')}
      ${transitSummaryHtml(counts)}
      <section class="card transit-copy-card">
        <button id="copyTransitReportBtn" class="primary-btn full-width" type="button">複製過境貨文字</button>
        <p class="small-note">僅列出非0站所，最後附上籠車與棧板合計。</p>
      </section>
      <div class="sticky-control-bar carrier-awareness-bar transit-carrier-bar"><span>目前記錄載具：<b>${carrierLabel(carrier)}</b></span>${carrierModeHtml(carrier, 'transit-carrier')}</div>
      <section class="card loaded-series-selector transit-series-selector">
        <div class="loaded-series-selector-head">
          <strong>選擇系列</strong>
          <small>一次展開一個系列</small>
        </div>
        ${transitSeriesButtonsHtml(counts)}
      </section>
      ${transitExpandedGroupHtml(counts, carrier)}`;

    main.querySelectorAll('[data-transit-carrier]').forEach((button) =>
      button.addEventListener('click', async () => {
        state.ui.transitCarrier = button.dataset.transitCarrier;
        await saveState();
        renderTransit();
      })
    );

    el('copyTransitReportBtn').addEventListener('click', () =>
      copyText(L.makeTransitReportText(shift), '過境貨文字已複製')
    );

    main.querySelector('[data-transit-summary-toggle]').addEventListener('click', () => {
      transitSummaryExpanded = !transitSummaryExpanded;
      renderTransit();
    });

    main.querySelectorAll('[data-transit-group]').forEach((button) =>
      button.addEventListener('click', () => {
        const group = button.dataset.transitGroup;
        transitExpandedGroup = transitExpandedGroup === group ? null : group;
        transitFocusStation = null;
        renderTransit();
      })
    );

    main.querySelectorAll('[data-transit-summary-station]').forEach((button) =>
      button.addEventListener('click', () => {
        const station = button.dataset.transitSummaryStation;
        transitExpandedGroup = L.stationGroup(station);
        transitFocusStation = station;
        transitSummaryExpanded = true;
        renderTransit();
      })
    );

    main.querySelectorAll('[data-transit-change]').forEach((button) =>
      button.addEventListener('click', () =>
        addSingle(
          button.dataset.station,
          'transit',
          Number(button.dataset.transitChange),
          carrier
        )
      )
    );

    if (transitFocusStation) {
      const station = transitFocusStation;
      transitFocusStation = null;
      requestAnimationFrame(() => {
        const card = main.querySelector(`[data-transit-card="${station}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('is-focused');
        window.setTimeout(() => card.classList.remove('is-focused'), 1800);
      });
    }
  }


  function openQuantity(station, category, carrier, direction = 1) {
    const sign = Number(direction) < 0 ? -1 : 1;
    el('quantityStation').value = station; el('quantityCategory').value = category; el('quantityCarrier').value = carrier;
    el('quantityDirection').value = String(sign); el('quantityMode').value = 'adjust';
    el('quantityStationLabel').textContent = `${stationLabel(station)}｜${carrierLabel(carrier)}`;
    el('quantityTitle').textContent = `${sign > 0 ? '增加' : '減少'}${categoryLabel(category)}`; el('customQty').value = '';
    el('customQty').placeholder = `輸入要${sign > 0 ? '增加' : '減少'}的數量`;
    el('saveQuantityBtn').textContent = sign > 0 ? '加入' : '扣除';
    el('quantityQuickButtons').querySelectorAll('[data-qty]').forEach((button) => { button.textContent = `${sign > 0 ? '+' : '−'}${button.dataset.qty}`; });
    quantityDialog.showModal();
  }

  function loadedSeriesLabel(group) {
    return { NS: 'N', TS: 'T', CS: 'C', S: 'S', E: 'E' }[group] || group;
  }

  function loadedSeriesButtonClass(group) {
    return {
      NS: 'loaded-series-n',
      TS: 'loaded-series-t',
      CS: 'loaded-series-c',
      S: 'loaded-series-s',
      E: 'loaded-series-e',
    }[group] || '';
  }

  function preMidnightCarrier() {
    return preMidnightOtherCarrier ? 'pallet' : 'cage';
  }

  function preMidnightSummaryText(summary) {
    return L.compactCarrierQuantity(summary.cage, summary.pallet) || '0';
  }

  function preMidnightStationRowHtml(shift, station, summary, editable, isExtra) {
    const values = summary.stationCounts[station] || { cage: 0, pallet: 0 };
    const carrier = preMidnightCarrier();
    const selectedCount = Number(values[carrier] || 0);
    const quantity = L.compactCarrierQuantity(values.cage, values.pallet) || '0';
    return `<article class="pre-midnight-station-row ${isExtra ? 'is-extra' : ''}">
      <div class="pre-midnight-station-name">
        <strong>${stationLabel(station)}</strong>
        ${isExtra && editable ? `<button type="button" class="pre-midnight-remove" data-pre-midnight-remove="${station}" ${values.cage || values.pallet ? 'disabled' : ''} aria-label="移除${stationLabel(station)}">×</button>` : ''}
      </div>
      <div class="pre-midnight-stepper">
        ${editable ? `<button type="button" data-pre-midnight-change="-1" data-station="${station}" data-carrier="${carrier}" ${selectedCount <= 0 ? 'disabled' : ''}>−</button>` : ''}
        <span><b>${quantity}</b><small>${carrierPair(values.cage, values.pallet)}</small></span>
        ${editable ? `<button type="button" data-pre-midnight-change="1" data-station="${station}" data-carrier="${carrier}">＋</button>` : ''}
      </div>
    </article>`;
  }

  function preMidnightAddSelectorHtml(summary) {
    const selected = new Set([...L.PRE_MIDNIGHT_DEFAULT_STATIONS, ...summary.extraStations]);
    const group = preMidnightAddGroup;
    const available = group ? L.STATION_GROUPS[group].filter((station) => !selected.has(station)) : [];
    return `<div class="pre-midnight-add-area">
      <button type="button" class="pre-midnight-add-toggle" data-pre-midnight-add-toggle>＋ 其他站所</button>
      ${group !== null ? `<div class="pre-midnight-add-picker">
        <div class="pre-midnight-add-groups">${L.GROUP_ORDER.map((item) => `<button type="button" class="${item === group ? 'active' : ''} ${loadedSeriesButtonClass(item)}" data-pre-midnight-add-group="${item}">${loadedSeriesLabel(item)}</button>`).join('')}</div>
        <div class="pre-midnight-add-stations">${available.length ? available.map((station) => `<button type="button" data-pre-midnight-add-station="${station}">${stationLabel(station)}</button>`).join('') : '<span>此系列沒有可新增站所</span>'}</div>
      </div>` : ''}
    </div>`;
  }

  function preMidnightPanelHtml(shift) {
    const summary = L.computePreMidnightLoaded(shift);
    const completed = Boolean(summary.completedAt);
    const editable = !completed || preMidnightEditing;
    const stations = [...L.PRE_MIDNIGHT_DEFAULT_STATIONS, ...summary.extraStations];
    const status = completed ? '✓ 已盤點' : '尚未盤點';
    return `<section class="card pre-midnight-loaded-card ${completed ? 'is-complete' : ''}">
      <button type="button" class="pre-midnight-summary-button" data-pre-midnight-toggle aria-expanded="${preMidnightExpanded}">
        <span><strong>00前已載走</strong><small>${status}</small></span>
        <span class="pre-midnight-summary-value">${preMidnightSummaryText(summary)} <em>${preMidnightExpanded ? '⌃' : '⌄'}</em></span>
      </button>
      ${preMidnightExpanded ? `<div class="pre-midnight-body">
        <p class="small-note pre-midnight-note">00:00後確認與輸入即可；這裡記的是00:00前已經離場的貨，預設載具為籠。</p>
        <div class="pre-midnight-stations">${stations.map((station) => preMidnightStationRowHtml(shift, station, summary, editable, summary.extraStations.includes(station))).join('')}</div>
        ${summary.legacyCage > 0 ? `<div class="pre-midnight-legacy"><span>舊版未分站</span><strong>${summary.legacyCage}籠</strong>${editable ? '<button type="button" data-pre-midnight-clear-legacy>清除舊數</button>' : ''}</div>` : ''}
        ${editable ? `${preMidnightAddSelectorHtml(summary)}
          <div class="pre-midnight-actions">
            <button type="button" class="carrier-override ${preMidnightOtherCarrier ? 'active' : ''}" data-pre-midnight-other>${preMidnightOtherCarrier ? '下一筆：板' : '非預設'}</button>
            <button type="button" class="primary-btn" data-pre-midnight-complete>完成盤點</button>
          </div>` : `<button type="button" class="secondary-btn full-width" data-pre-midnight-edit>修改</button>`}
      </div>` : ''}
    </section>`;
  }

  function loadedSummaryEntries(counts) {
    return L.STATIONS.flatMap((station) => {
      const quantity = L.compactCarrierQuantity(
        counts[station].loaded.cage,
        counts[station].loaded.pallet
      );
      return quantity ? [{
        station,
        quantity,
        group: L.stationGroup(station),
      }] : [];
    });
  }

  function loadedSummaryHtml(counts) {
    const entries = loadedSummaryEntries(counts);
    if (!entries.length) {
      return '<div class="loaded-summary-empty">目前無已載走紀錄</div>';
    }

    return `<div class="loaded-summary-chips">${entries.map((entry) =>
      `<button type="button" class="loaded-summary-chip" data-loaded-summary-station="${entry.station}">
        <strong>${stationLabel(entry.station)}</strong><span>${entry.quantity}</span>
      </button>`
    ).join('')}</div>`;
  }

  function loadedSeriesButtonsHtml(counts) {
    return `<div class="loaded-series-buttons">${L.GROUP_ORDER.map((group) => {
      const usedStations = L.STATION_GROUPS[group].filter((station) =>
        L.countFor(counts[station].loaded, 'ALL') > 0
      ).length;
      const active = loadedExpandedGroup === group;
      return `<button type="button"
        class="loaded-series-button ${loadedSeriesButtonClass(group)} ${active ? 'active' : ''}"
        data-loaded-group="${group}"
        aria-expanded="${active ? 'true' : 'false'}">
        <strong>${loadedSeriesLabel(group)}</strong>
        ${usedStations ? `<small>${usedStations}站</small>` : '<small aria-hidden="true">&nbsp;</small>'}
      </button>`;
    }).join('')}</div>`;
  }

  function loadedExpandedGroupHtml(counts, otherMode) {
    if (!loadedExpandedGroup || !L.STATION_GROUPS[loadedExpandedGroup]) return '';

    const group = loadedExpandedGroup;
    const stations = L.STATION_GROUPS[group];
    return `<section class="page-section loaded-expanded-section">
      <h2 class="section-title">
        ${groupTitle(group)}
        <small>再次按${loadedSeriesLabel(group)}收合</small>
      </h2>
      <div class="loaded-grid">${stations.map((station) => {
        const carrier = actionCarrier(station, otherMode);
        const category = counts[station].loaded;
        const selectedCount = category[carrier];
        const totalQuantity = L.compactCarrierQuantity(category.cage, category.pallet) || '0';
        const hasLoaded = L.countFor(category, 'ALL') > 0;
        const focused = loadedFocusStation === station;

        return `<article class="loaded-card ${hasLoaded ? 'has-loaded' : ''} ${focused ? 'is-focused' : ''}"
          data-loaded-card="${station}">
          <div class="loaded-card-head">
            <strong>${stationLabel(station)}</strong>
            <span>${totalQuantity}</span>
          </div>
          <small>本次操作：${carrierLabel(carrier)}</small>
          <div>
            <button type="button"
              data-loaded-change="-1"
              data-carrier="${carrier}"
              data-station="${station}"
              ${selectedCount <= 0 ? 'disabled' : ''}>−1</button>
            <button type="button"
              data-loaded-change="1"
              data-carrier="${carrier}"
              data-station="${station}">＋1</button>
          </div>
        </article>`;
      }).join('')}</div>
    </section>`;
  }

  function renderLoaded() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const otherMode = state.ui.loadedOtherCarrier;

    if (loadedExpandedGroup && !L.GROUP_ORDER.includes(loadedExpandedGroup)) {
      loadedExpandedGroup = null;
    }

    main.innerHTML = `
      ${guideDetailsHtml('提前載走', '00前已載走＋夜班期間提前載走', '「00前已載走」記錄00:00前已離場的貨，可在00:00後確認輸入；下方一般提前載走則記夜班期間後續載走。兩者分開保存。')}
      ${preMidnightPanelHtml(shift)}
      <section class="card loaded-summary-card">
        <span>夜班期間已載走站所</span>
        ${loadedSummaryHtml(counts)}
      </section>
      <button type="button" class="full-width carrier-override ${otherMode ? 'active' : ''}" data-loaded-other>
        ${otherMode ? '下一筆：使用非預設載具（完成後自動關閉）' : '下一筆改用非預設載具'}
      </button>
      <section class="card loaded-series-selector">
        <div class="loaded-series-selector-head">
          <strong>選擇系列</strong>
          <small>一次展開一個系列</small>
        </div>
        ${loadedSeriesButtonsHtml(counts)}
      </section>
      ${loadedExpandedGroupHtml(counts, otherMode)}`;

    main.querySelector('[data-pre-midnight-toggle]')?.addEventListener('click', () => {
      preMidnightExpanded = !preMidnightExpanded;
      if (!preMidnightExpanded) { preMidnightAddGroup = null; preMidnightOtherCarrier = false; }
      renderLoaded();
    });

    main.querySelector('[data-pre-midnight-edit]')?.addEventListener('click', async () => {
      L.reopenPreMidnightLoaded(shift);
      preMidnightEditing = true;
      preMidnightOtherCarrier = false;
      await saveState();
      renderLoaded();
    });

    main.querySelector('[data-pre-midnight-other]')?.addEventListener('click', () => {
      preMidnightOtherCarrier = !preMidnightOtherCarrier;
      renderLoaded();
    });

    main.querySelectorAll('[data-pre-midnight-change]').forEach((button) =>
      button.addEventListener('click', async () => {
        L.adjustPreMidnightLoadedCount(shift, button.dataset.station, button.dataset.carrier, Number(button.dataset.preMidnightChange));
        preMidnightOtherCarrier = false;
        await saveState();
        vibrate();
        renderLoaded();
        updateHeader();
      })
    );

    main.querySelector('[data-pre-midnight-add-toggle]')?.addEventListener('click', () => {
      preMidnightAddGroup = preMidnightAddGroup === null ? 'NS' : null;
      renderLoaded();
    });

    main.querySelectorAll('[data-pre-midnight-add-group]').forEach((button) =>
      button.addEventListener('click', () => {
        preMidnightAddGroup = button.dataset.preMidnightAddGroup;
        renderLoaded();
      })
    );

    main.querySelectorAll('[data-pre-midnight-add-station]').forEach((button) =>
      button.addEventListener('click', async () => {
        L.addPreMidnightExtraStation(shift, button.dataset.preMidnightAddStation);
        await saveState();
        showToast(`${stationLabel(button.dataset.preMidnightAddStation)} 已加入00前已載走`);
        renderLoaded();
      })
    );

    main.querySelectorAll('[data-pre-midnight-remove]').forEach((button) =>
      button.addEventListener('click', async () => {
        try {
          L.removePreMidnightExtraStation(shift, button.dataset.preMidnightRemove);
          await saveState();
          renderLoaded();
        } catch (error) { showToast(error.message); }
      })
    );

    main.querySelector('[data-pre-midnight-clear-legacy]')?.addEventListener('click', async () => {
      if (!window.confirm('確定清除舊版未分站的00前轉出數量？')) return;
      L.clearPreMidnightLegacyCage(shift);
      await saveState();
      renderLoaded();
    });

    main.querySelector('[data-pre-midnight-complete]')?.addEventListener('click', async () => {
      L.completePreMidnightLoaded(shift);
      preMidnightEditing = false;
      preMidnightExpanded = false;
      preMidnightAddGroup = null;
      preMidnightOtherCarrier = false;
      await saveState();
      showToast(`00前已載走已完成：${preMidnightSummaryText(L.computePreMidnightLoaded(shift))}`);
      renderLoaded();
      updateHeader();
    });

    main.querySelector('[data-loaded-other]').addEventListener('click', async () => {
      state.ui.loadedOtherCarrier = !state.ui.loadedOtherCarrier;
      await saveState();
      renderLoaded();
    });

    main.querySelectorAll('[data-loaded-group]').forEach((button) =>
      button.addEventListener('click', () => {
        const group = button.dataset.loadedGroup;
        loadedExpandedGroup = loadedExpandedGroup === group ? null : group;
        loadedFocusStation = null;
        renderLoaded();
      })
    );

    main.querySelectorAll('[data-loaded-summary-station]').forEach((button) =>
      button.addEventListener('click', () => {
        const station = button.dataset.loadedSummaryStation;
        loadedExpandedGroup = L.stationGroup(station);
        loadedFocusStation = station;
        renderLoaded();
      })
    );

    main.querySelectorAll('[data-loaded-change]').forEach((button) =>
      button.addEventListener('click', async () => {
        await addSingle(
          button.dataset.station,
          'loaded',
          Number(button.dataset.loadedChange),
          button.dataset.carrier
        );
      })
    );

    if (loadedFocusStation) {
      const station = loadedFocusStation;
      loadedFocusStation = null;
      requestAnimationFrame(() => {
        const card = main.querySelector(`[data-loaded-card="${station}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('is-focused');
        window.setTimeout(() => card.classList.remove('is-focused'), 1800);
      });
    }
  }


  function dualCounterHtml(station, category, counts, useOtherCarrier = false) {
    const carrier = actionCarrier(station, useOtherCarrier);
    const value = counts[station][category][carrier];
    return `<div class="default-count-card" data-morning-card="${station}">
      <div class="default-count-head">
        <strong>${stationLabel(station)}</strong>
        <span data-morning-summary>本次：${carrierLabel(carrier)}｜${stationCarrierSummary(counts, station, category)}</span>
      </div>
      <div class="default-count-control">
        <button data-open-adjust data-direction="-1" data-station="${station}" data-category="${category}" data-carrier="${carrier}">−</button>
        <input class="default-count-input"
          type="number"
          min="0"
          step="1"
          inputmode="numeric"
          enterkeyhint="next"
          autocomplete="off"
          value="${value}"
          data-saved-value="${value}"
          data-morning-direct
          data-station="${station}"
          data-category="${category}"
          data-carrier="${carrier}"
          aria-label="${stationLabel(station)}${carrierLabel(carrier)}數量">
        <button data-open-adjust data-direction="1" data-station="${station}" data-category="${category}" data-carrier="${carrier}">＋</button>
      </div>
    </div>`;
  }

  function normalizeMorningDirectValue(value) {
    const number = Number(String(value ?? '').trim());
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
  }

  function queueMorningDirectSave() {
    const pending = morningDirectSaveQueue.then(() => saveState());
    morningDirectSaveQueue = pending.catch(() => {});
    return pending;
  }

  function flashMorningDirectInput(input, status) {
    if (!input?.isConnected) return;
    const previousTimer = morningInputFlashTimers.get(input);
    if (previousTimer) window.clearTimeout(previousTimer);

    input.classList.remove('is-saving', 'is-saved', 'is-save-error');
    if (status) input.classList.add(`is-${status}`);

    if (status === 'saved' || status === 'save-error') {
      const timer = window.setTimeout(() => {
        if (input.isConnected) input.classList.remove(`is-${status}`);
        morningInputFlashTimers.delete(input);
      }, status === 'saved' ? 650 : 1800);
      morningInputFlashTimers.set(input, timer);
    }
  }

  function updateMorningOtherCarrierButton() {
    const button = main.querySelector('[data-morning-other]');
    if (!button) return;
    const active = Boolean(state.ui.morningOtherCarrier);
    button.classList.toggle('active', active);
    button.textContent = active ? '非預設：開' : '非預設';
  }

  function morningStationIsZero(counts, station) {
    return L.countFor(counts[station].morning, 'ALL') === 0;
  }

  function updateMorningCardSummary(card, counts, carrier) {
    if (!card) return;
    const station = card.dataset.morningCard;
    const summary = card.querySelector('[data-morning-summary]');
    if (summary) {
      summary.textContent = `本次：${carrierLabel(carrier)}｜${stationCarrierSummary(counts, station, 'morning')}`;
    }
  }

  function refreshMorningCarrierControls(shift) {
    const counts = L.computeCounts(shift);

    main.querySelectorAll('[data-morning-card]').forEach((card) => {
      const station = card.dataset.morningCard;
      const carrier = actionCarrier(station, state.ui.morningOtherCarrier);
      const value = counts[station].morning[carrier];
      const input = card.querySelector('[data-morning-direct]');

      card.querySelectorAll('[data-open-adjust]').forEach((button) => {
        button.dataset.carrier = carrier;
      });

      if (input) {
        input.dataset.carrier = carrier;
        input.dataset.savedValue = String(value);
        input.value = String(value);
        input.setAttribute('aria-label', `${stationLabel(station)}${carrierLabel(carrier)}數量`);
      }

      updateMorningCardSummary(card, counts, carrier);
    });

    updateMorningOtherCarrierButton();
  }

  async function commitMorningDirectInput(input, shift) {
    if (!input?.isConnected) return false;

    const normalized = normalizeMorningDirectValue(input.value);
    const previous = normalizeMorningDirectValue(input.dataset.savedValue);
    input.value = String(normalized);

    if (normalized === previous) {
      input.dataset.savedValue = String(normalized);
      return false;
    }

    const usedOneShotCarrier = Boolean(state.ui.morningOtherCarrier);
    const event = L.setCount(
      shift,
      input.dataset.station,
      input.dataset.category,
      normalized,
      input.dataset.carrier
    );

    if (!event) {
      input.dataset.savedValue = String(normalized);
      return false;
    }

    input.dataset.savedValue = String(normalized);
    flashMorningDirectInput(input, 'saving');

    if (usedOneShotCarrier) {
      state.ui.morningOtherCarrier = false;
      refreshMorningCarrierControls(shift);
    } else {
      const counts = L.computeCounts(shift);
      updateMorningCardSummary(
        input.closest('[data-morning-card]'),
        counts,
        input.dataset.carrier
      );
    }

    try {
      await queueMorningDirectSave();
      updateHeader();
      if (state.ui.morningZeroOnly) {
        renderMorning();
      } else {
        flashMorningDirectInput(input, 'saved');
      }
      return true;
    } catch (error) {
      L.deleteEvent(shift, event.id);
      state.ui.morningOtherCarrier = usedOneShotCarrier;

      if (usedOneShotCarrier) {
        refreshMorningCarrierControls(shift);
      } else {
        input.value = String(previous);
        input.dataset.savedValue = String(previous);
        const counts = L.computeCounts(shift);
        updateMorningCardSummary(
          input.closest('[data-morning-card]'),
          counts,
          input.dataset.carrier
        );
      }

      flashMorningDirectInput(input, 'save-error');
      showToast(`儲存失敗：${error.message || '請稍後再試'}`, 2600);
      return false;
    }
  }

  function renderMorning() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const otherMode = state.ui.morningOtherCarrier;
    const group = state.ui.morningGroup;
    const zeroOnly = state.ui.morningZeroOnly;
    const groups = group === 'ALL' ? L.GROUP_ORDER : [group];
    const zeroScope = group === 'ALL' ? L.STATIONS : L.STATION_GROUPS[group];
    const zeroCount = zeroScope.filter((station) => morningStationIsZero(counts, station)).length;
    const groupSections = groups.map((prefix) => {
      const stations = L.STATION_GROUPS[prefix].filter((station) => !zeroOnly || morningStationIsZero(counts, station));
      if (!stations.length) return '';
      return `<section class="page-section"><h2 class="section-title">${groupTitle(prefix)}<small>${stations.length}站</small></h2><div class="default-count-list">${stations.map((station) => dualCounterHtml(station, 'morning', counts, otherMode)).join('')}</div></section>`;
    }).join('');

    main.innerHTML = `${guideDetailsHtml('00:00 中班盤點', '預設載具快速輸入', '可依 N／T／C／S／E 系列篩選；「只顯示數量0」會列出中班籠＋板合計為0的站所。正常採站所預設載具；按＋／−後可選1、2、5，點中央數字可直接輸入。')}
      <div class="morning-action-row">
        <button id="copyMorningReportBtn" class="secondary-btn morning-compact-btn">複製站所</button>
        <button type="button" class="carrier-override morning-compact-btn ${otherMode ? 'active' : ''}" data-morning-other>${otherMode ? '非預設：開' : '非預設'}</button>
      </div>
      <div class="morning-filter-row">
        <select id="morningGroupFilter" aria-label="中班系列分類">
          <option value="ALL">全部</option>
          ${L.GROUP_ORDER.map((prefix) => `<option value="${prefix}" ${group === prefix ? 'selected' : ''}>${shortGroupTitle(prefix)}</option>`).join('')}
        </select>
        <button id="morningZeroToggle" type="button" class="filter-toggle-btn ${zeroOnly ? 'active' : ''}" aria-pressed="${zeroOnly}">只顯示數量0（${zeroCount}）</button>
      </div>
      <div>${groupSections || '<div class="empty-state">沒有符合條件的站所。</div>'}</div>`;

    el('copyMorningReportBtn').addEventListener('click', () =>
      copyText(L.makeMorningReportText(shift), '中班數量文字已複製')
    );

    main.querySelector('[data-morning-other]').addEventListener('click', async () => {
      state.ui.morningOtherCarrier = !state.ui.morningOtherCarrier;
      await saveState();
      renderMorning();
    });

    el('morningGroupFilter').value = group;
    el('morningGroupFilter').addEventListener('change', async (event) => {
      state.ui.morningGroup = event.target.value;
      await saveState();
      renderMorning();
    });

    el('morningZeroToggle').addEventListener('click', async () => {
      state.ui.morningZeroOnly = !state.ui.morningZeroOnly;
      await saveState();
      renderMorning();
    });

    main.querySelectorAll('[data-open-adjust]').forEach((button) =>
      button.addEventListener('click', () =>
        openQuantity(
          button.dataset.station,
          button.dataset.category,
          button.dataset.carrier,
          Number(button.dataset.direction)
        )
      )
    );

    const morningDirectInputs = [...main.querySelectorAll('[data-morning-direct]')];

    morningDirectInputs.forEach((input, index) => {
      input.enterKeyHint = index === morningDirectInputs.length - 1 ? 'done' : 'next';

      input.addEventListener('focus', () => {
        input.classList.remove('is-saved', 'is-save-error');
        if (String(input.value).trim() === '0') input.value = '';
      });

      input.addEventListener('input', () => {
        input.classList.remove('is-saved', 'is-save-error');
      });

      input.addEventListener('change', () => {
        if (String(input.value).trim() === '') input.value = '0';
        void commitMorningDirectInput(input, shift);
      });

      input.addEventListener('blur', () => {
        if (String(input.value).trim() === '') input.value = '0';
        void commitMorningDirectInput(input, shift);
      });

      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();

        if (String(input.value).trim() === '') input.value = '0';
        void commitMorningDirectInput(input, shift);

        const nextInput = morningDirectInputs[index + 1];
        if (nextInput) {
          nextInput.focus({ preventScroll: false });
        } else {
          input.blur();
        }
      });
    });

  }


  function onlinePendingStationCount(counts, chute) {
    return chute.stations.filter((station) => L.countFor(counts[station].online, 'ALL') > 0).length;
  }

  function onlineChuteFilterHtml(counts) {
    const totalPendingStations = L.STATIONS.filter((station) => L.countFor(counts[station].online, 'ALL') > 0).length;
    const allActive = onlineExpandedChute === 'ALL';
    return `<nav class="online-chute-filter" aria-label="二次分理滑道顯示切換">
      <button type="button" class="${allActive ? 'active' : ''}" data-online-chute-filter="ALL" aria-pressed="${allActive ? 'true' : 'false'}">
        <strong>全部</strong><small>${totalPendingStations ? `${totalPendingStations}站` : '&nbsp;'}</small>
      </button>
      ${L.CHUTES.map((chute) => {
        const pendingStations = onlinePendingStationCount(counts, chute);
        const active = onlineExpandedChute === String(chute.id);
        return `<button type="button" class="${active ? 'active' : ''}" data-online-chute-filter="${chute.id}" aria-pressed="${active ? 'true' : 'false'}">
          <strong>${chute.id}</strong><small>${pendingStations ? `${pendingStations}站` : '&nbsp;'}</small>
        </button>`;
      }).join('')}
    </nav>`;
  }

  function onlineStationRowHtml(station, counts) {
    const pending = counts[station].online;
    const total = L.countFor(pending, 'ALL');
    const zero = total === 0;
    return `<div class="online-row ${zero ? 'online-zero' : 'online-pending'}" data-online-row="${station}">
      <strong>${stationLabel(station)}</strong>
      <button class="online-adjust minus" data-online-change="-1" data-station="${station}" ${zero ? 'disabled' : ''}>−1</button>
      <span class="online-count"><b>${total}</b><small>${carrierPair(pending.cage, pending.pallet)}</small></span>
      <button class="online-adjust plus" data-online-change="1" data-station="${station}">＋1</button>
      <button class="online-convert" data-convert-online data-station="${station}" ${zero ? 'disabled' : ''}>${zero ? '無待處理' : '轉完成'}</button>
    </div>`;
  }

  function onlineSelectorCardHtml(station) {
    const defaultCarrier = L.defaultCarrierForStation(station);
    return `<article class="online-selector-card">
      <div><strong>${stationLabel(station)}</strong><small>預設：${carrierLabel(defaultCarrier)}</small></div>
      <button type="button" data-online-change="1" data-station="${station}" aria-label="${stationLabel(station)}二次分理加1">＋1</button>
    </article>`;
  }

  function onlinePendingHtml(counts) {
    const pendingStations = L.STATIONS.filter((station) => L.countFor(counts[station].online, 'ALL') > 0);
    if (!pendingStations.length) {
      return `<section class="page-section online-pending-section online-pending-empty">
        <h2 class="section-title">待處理<small>0站</small></h2>
        <div class="empty-state">目前沒有待處理站所。請由上方滑道按鈕叫出站所後按＋1。</div>
      </section>`;
    }

    return `<section class="page-section online-pending-section">
      <h2 class="section-title">待處理<small>${pendingStations.length}站｜數量大於0固定顯示</small></h2>
      ${L.CHUTES.map((chute) => {
        const stations = chute.stations.filter((station) => L.countFor(counts[station].online, 'ALL') > 0);
        if (!stations.length) return '';
        return `<div class="online-pending-chute">
          <h3>${chute.name}<small>${stations.length}站</small></h3>
          <div class="input-list">${stations.map((station) => onlineStationRowHtml(station, counts)).join('')}</div>
        </div>`;
      }).join('')}
    </section>`;
  }

  function onlineExpandedChuteHtml(counts) {
    if (!onlineExpandedChute) return '';
    const chutes = onlineExpandedChute === 'ALL'
      ? L.CHUTES
      : L.CHUTES.filter((chute) => String(chute.id) === String(onlineExpandedChute));
    if (!chutes.length) return '';

    const sections = chutes.map((chute) => {
      // 已有待處理數量的站所固定顯示在上方，不在選站區重複出現。
      const availableStations = chute.stations.filter((station) => L.countFor(counts[station].online, 'ALL') === 0);
      return `<section class="page-section online-selector-section">
        <h2 class="section-title">${chute.name}<small>${availableStations.length ? '按＋1加入待處理' : '目前無其他可選站所'}</small></h2>
        ${availableStations.length
          ? `<div class="online-selector-grid">${availableStations.map((station) => onlineSelectorCardHtml(station)).join('')}</div>`
          : '<div class="empty-state">此滑道目前所有待處理站所都已固定顯示在上方。</div>'}
      </section>`;
    }).join('');

    return `<div class="online-selector-wrap">
      <div class="online-selector-note">${onlineExpandedChute === 'ALL' ? '目前顯示全部滑道｜再次按「全部」收合' : `目前展開第${onlineExpandedChute}滑道｜再次按${onlineExpandedChute}收合`}</div>
      ${sections}
    </div>`;
  }

  function renderOnline() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const otherMode = state.ui.onlineOtherCarrier;
    const completed = L.STATIONS.map((station) => ({ station, counts: counts[station].secondary, total: L.countFor(counts[station].secondary, 'ALL') })).filter((item) => item.total > 0);
    const completedTotal = completed.reduce((sum, item) => sum + item.total, 0);
    if (onlineExpandedChute && onlineExpandedChute !== 'ALL' && !L.CHUTES.some((chute) => String(chute.id) === String(onlineExpandedChute))) {
      onlineExpandedChute = null;
    }

    main.innerHTML = `
      <section class="online-toolbar" aria-label="二次分理快速操作">
        ${onlineChuteFilterHtml(counts)}
        <div class="online-toolbar-actions">
          <button type="button" class="primary-btn online-bulk-convert" data-convert-all-online>全部轉完成</button>
          <button type="button" class="carrier-override online-toolbar-carrier ${otherMode ? 'active' : ''}" data-online-other>${otherMode ? '非預設：開' : '非預設'}</button>
        </div>
        <details class="online-inline-guide"><summary><span>轉完成才計數量</span><span>操作說明</span></summary><p>平常只顯示已有待處理數量的站所。按上方滑道可暫時叫出該滑道全部0數量站所；按＋1後會固定顯示，轉完成或歸0後恢復隱藏。</p></details>
      </section>
      ${onlinePendingHtml(counts)}
      ${onlineExpandedChuteHtml(counts)}
      <section class="page-section secondary-completed-section"><h2 class="section-title">已轉完成紀錄<small>二次分理合計 ${completedTotal}</small></h2>
        <div class="secondary-completed-list">${completed.length ? completed.map((item) => `<div><strong>${stationLabel(item.station)}</strong><span>${item.total}</span><small>${carrierPair(item.counts.cage, item.counts.pallet)}</small></div>`).join('') : '<div class="empty-state">尚無已轉完成的二次分理數量。</div>'}</div>
      </section>`;

    main.querySelectorAll('[data-online-chute-filter]').forEach((button) => button.addEventListener('click', () => {
      const target = button.dataset.onlineChuteFilter;
      onlineExpandedChute = onlineExpandedChute === target ? null : target;
      renderOnline();
    }));
    main.querySelector('[data-online-other]').addEventListener('click', async () => { state.ui.onlineOtherCarrier = !state.ui.onlineOtherCarrier; await saveState(); renderOnline(); });
    main.querySelector('[data-convert-all-online]').addEventListener('click', async () => {
      try { const result = L.convertAllOnlineToSecondary(shift); await saveState(); vibrate(90); renderCurrentView(); showToast(`二次分理已轉完成${result.quantity}個載具`); }
      catch (error) { showToast(error.message); }
    });
    main.querySelectorAll('[data-online-change]').forEach((button) => button.addEventListener('click', async () => {
      const station = button.dataset.station; const delta = Number(button.dataset.onlineChange);
      if (delta < 0) return addSingle(station, 'online', -1, L.chooseCarrierToDecrement(shift, station, 'online'));
      const base = L.defaultCarrierForStation(station); const carrier = state.ui.onlineOtherCarrier ? L.otherCarrier(base) : base;
      state.ui.onlineOtherCarrier = false; await addSingle(station, 'online', 1, carrier);
    }));
    main.querySelectorAll('[data-convert-online]').forEach((button) => button.addEventListener('click', async () => {
      if (button.disabled) return;
      try { const qty = L.convertOnlineToSecondary(shift, button.dataset.station, 'ALL'); await saveState(); vibrate(65); renderCurrentView(); showToast(`${stationLabel(button.dataset.station)} 二次分理已轉完成${qty}`); }
      catch (error) { showToast(error.message); }
    }));
  }

  function inventoryCarrierInputHtml(station, carrier, counts, isDefault) {
    return `<label class="inventory-carrier-input ${isDefault ? 'is-default' : 'is-other'}"><span>${carrierLabel(carrier)}${isDefault ? '（預設）' : '（非預設）'}</span><input type="number" min="0" step="1" inputmode="numeric" value="${counts[station].actual[carrier]}" data-inventory-input data-station="${station}" data-carrier="${carrier}" aria-label="${stationLabel(station)}${carrierLabel(carrier)}現場數量"></label>`;
  }

  function inventoryStationHtml(station, counts, cageStats, palletStats) {
    const defaultCarrier = L.defaultCarrierForStation(station);
    const otherCarrier = L.otherCarrier(defaultCarrier);
    const requiredOther = otherCarrier === 'cage' ? cageStats[station].expected > 0 : palletStats[station].expected > 0;
    const hasOtherActual = counts[station].actual[otherCarrier] > 0;
    const manuallyExpanded = state.ui.inventoryExpandedStations.includes(station);
    const forcedExpanded = requiredOther || hasOtherActual;
    const expanded = forcedExpanded || manuallyExpanded;
    const correct = cageStats[station].difference === 0 && palletStats[station].difference === 0;
    const expandLabel = forcedExpanded ? '非預設需盤點' : (expanded ? '− 收合' : '＋ 非預設');
    const morningPair = carrierPair(cageStats[station].morning, palletStats[station].morning);
    const nightPair = carrierPair(cageStats[station].night, palletStats[station].night);
    const transitPair = carrierPair(cageStats[station].transit, palletStats[station].transit);
    // 「總」沿用盤點應有數：回報總數扣除已載走；不另外顯示已載走。
    const expectedPair = carrierPair(cageStats[station].expected, palletStats[station].expected);
    return `<div class="inventory-card ${correct ? 'difference-good' : 'difference-bad'}" data-inventory-row="${station}">
      <div class="inventory-head">
        <strong>${stationLabel(station)}</strong>
        <div class="inventory-summary-lines">
          <span class="inventory-summary-morning">中：${morningPair}</span>
          <span class="inventory-summary-night">夜：${nightPair}</span>
          <span class="inventory-summary-transit">過：${transitPair}</span>
          <span class="inventory-summary-total">總：${expectedPair}</span>
        </div>
      </div>
      ${expanded
        ? `<div class="inventory-dual-row">
            ${inventoryCarrierInputHtml(station, defaultCarrier, counts, true)}
            ${inventoryCarrierInputHtml(station, otherCarrier, counts, false)}
          </div>
          <button type="button" class="inventory-expand-btn inventory-expanded-action expanded" data-inventory-expand="${station}" aria-expanded="true" ${forcedExpanded ? 'disabled' : ''}>${expandLabel}</button>`
        : `<div class="inventory-primary-row">
            ${inventoryCarrierInputHtml(station, defaultCarrier, counts, true)}
            <button type="button" class="inventory-expand-btn" data-inventory-expand="${station}" aria-expanded="false">＋ 非預設</button>
          </div>`}
    </div>`;
  }

  function renderInventory() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const cageStats = L.computeAllStats(shift, 'cage');
    const palletStats = L.computeAllStats(shift, 'pallet');
    const group = state.ui.inventoryGroup;
    const groups = group === 'ALL' ? L.GROUP_ORDER : [group];
    main.innerHTML = `${guideDetailsHtml('現場盤點', '預設載具優先，顏色提示核對結果', '預設只顯示各站常用載具；需要另一種載具時按「＋ 非預設」。卡片上方以兩行四格顯示中班、夜班、過境及盤點總應有籠板數；總數已扣除提前載走，但不另外顯示載走。兩種載具都正確才顯示綠框，任一不符即顯示紅框。')}
      <section class="card compact-filter-card"><select id="inventoryGroupFilter" class="full-width-select"><option value="ALL">全部站所</option>${L.GROUP_ORDER.map((prefix) => `<option value="${prefix}" ${group === prefix ? 'selected' : ''}>只看 ${groupTitle(prefix)}</option>`).join('')}</select></section>
      ${groups.map((prefix) => `<section class="page-section"><h2 class="section-title">${groupTitle(prefix)}<small>${L.STATION_GROUPS[prefix].length}站</small></h2><div class="inventory-list">${L.STATION_GROUPS[prefix].map((station) => inventoryStationHtml(station, counts, cageStats, palletStats)).join('')}</div></section>`).join('')}`;
    el('inventoryGroupFilter').addEventListener('change', async (event) => { state.ui.inventoryGroup = event.target.value; await saveState(); renderInventory(); });
    main.querySelectorAll('[data-inventory-expand]').forEach((button) => button.addEventListener('click', async () => {
      const station = button.dataset.inventoryExpand;
      const set = new Set(state.ui.inventoryExpandedStations);
      if (set.has(station)) set.delete(station); else set.add(station);
      state.ui.inventoryExpandedStations = [...set];
      await saveState();
      const scrollPosition = window.scrollY; renderInventory(); window.scrollTo(0, scrollPosition);
    }));
    bindInventoryInputs();
  }

  function updateInventoryRowStatus(station) {
    const shift = currentShift(); if (!shift) return;
    const cage = L.computeAllStats(shift, 'cage')[station];
    const pallet = L.computeAllStats(shift, 'pallet')[station];
    const row = main.querySelector(`[data-inventory-row="${station}"]`);
    if (!row) return;
    const correct = cage.difference === 0 && pallet.difference === 0;
    row.classList.toggle('difference-good', correct);
    row.classList.toggle('difference-bad', !correct);
    const morningSummary = row.querySelector('.inventory-summary-morning');
    const nightSummary = row.querySelector('.inventory-summary-night');
    const transitSummary = row.querySelector('.inventory-summary-transit');
    const totalSummary = row.querySelector('.inventory-summary-total');
    if (morningSummary) morningSummary.textContent = `中：${carrierPair(cage.morning, pallet.morning)}`;
    if (nightSummary) nightSummary.textContent = `夜：${carrierPair(cage.night, pallet.night)}`;
    if (transitSummary) transitSummary.textContent = `過：${carrierPair(cage.transit, pallet.transit)}`;
    if (totalSummary) totalSummary.textContent = `總：${carrierPair(cage.expected, pallet.expected)}`;
  }

  function bindInventoryInputs() {
    main.querySelectorAll('[data-inventory-input]').forEach((input) => {
      input.addEventListener('focus', () => { if (String(input.value).trim() === '0') input.value = ''; });
      input.addEventListener('blur', async () => {
        if (String(input.value).trim() === '') input.value = '0';
        const value = Math.max(0, Number(input.value || 0));
        input.value = String(value);
        const shift = currentShift();
        const event = L.setCount(shift, input.dataset.station, 'actual', value, input.dataset.carrier);
        L.confirmActualEntry(shift, input.dataset.station, input.dataset.carrier);
        await saveState();
        updateHeader();
        updateInventoryRowStatus(input.dataset.station);
        if (event) showToast(`${stationLabel(input.dataset.station)} ${carrierShort(input.dataset.carrier)}已保存`);
      });
    });
  }

  function renderStats() {
    const shift = requireShift(); if (!shift) return;
    const carrier = state.ui.statsCarrier;
    const stats = L.computeAllStats(shift, carrier);
    const allStats = L.computeAllStats(shift, 'ALL');
    const cageStats = L.computeAllStats(shift, 'cage');
    const palletStats = L.computeAllStats(shift, 'pallet');
    const totals = L.computeTotals(shift, carrier);
    const overview = L.computeStatsOverview(shift);
    const group = state.ui.statsGroup; const anomaliesOnly = state.ui.statsAnomaliesOnly;
    const groups = group === 'ALL' ? L.GROUP_ORDER : [group];
    const anomalyScope = group === 'ALL' ? L.STATIONS : L.STATION_GROUPS[group];
    const anomalyCount = anomalyScope.filter((station) => stats[station].difference !== 0).length;
    const groupSections = groups.map((prefix) => {
      const stations = L.STATION_GROUPS[prefix].filter((station) => !anomaliesOnly || stats[station].difference !== 0);
      if (!stations.length) return '';
      return `<section class="page-section"><h2 class="section-title">${groupTitle(prefix)}<small>${stations.length}站</small></h2>${stations.map((station) => statsCard(station, stats[station], allStats[station], cageStats[station], palletStats[station], carrier)).join('')}</section>`;
    }).join('');
    main.innerHTML = `
      ${carrierModeHtml(carrier, 'stats-carrier', true)}
      <div class="stats-totals"><div class="total-card"><span>03:00回報</span><strong>${totals.REPORT03.reportTotal}</strong></div><div class="total-card"><span>05:00回報</span><strong>${totals.REPORT05.reportTotal}</strong></div><div class="total-card"><span>全部回報</span><strong>${totals.ALL.reportTotal}</strong></div></div>
      <section class="stats-overview-section">
        <div class="stats-overview-grid">
          <div class="total-card"><span>中＋夜 籠數</span><strong>${overview.morningNightCage}</strong></div>
          <div class="total-card"><span>中＋夜 板數</span><strong>${overview.morningNightPallet}</strong></div>
          <div class="total-card"><span>過境 籠＋板</span><strong>${overview.transitTotal}</strong></div>
        </div>
        <p class="small-note stats-overview-note">中＋夜已含00前已載走（${carrierPair(overview.preMidnightCage, overview.preMidnightPallet)}）；不含過境，也不扣夜班期間的一般提前載走。</p>
      </section>
      <div class="stats-filter-row"><select id="statsGroupFilter"><option value="ALL">全部</option>${L.GROUP_ORDER.map((prefix) => `<option value="${prefix}" ${group === prefix ? 'selected' : ''}>${shortGroupTitle(prefix)}</option>`).join('')}</select><button id="anomalyToggle" type="button" class="filter-toggle-btn ${anomaliesOnly ? 'active' : ''}" aria-pressed="${anomaliesOnly}">只顯示異常（${anomalyCount}）</button></div>
      <div>${groupSections || '<div class="empty-state">沒有符合條件的站所。</div>'}</div>`;
    main.querySelectorAll('[data-stats-carrier]').forEach((button) => button.addEventListener('click', async () => { state.ui.statsCarrier = button.dataset.statsCarrier; await saveState(); renderStats(); }));
    el('statsGroupFilter').value = group;
    el('statsGroupFilter').addEventListener('change', async (event) => { state.ui.statsGroup = event.target.value; await saveState(); renderStats(); });
    el('anomalyToggle').addEventListener('click', async () => { state.ui.statsAnomaliesOnly = !state.ui.statsAnomaliesOnly; await saveState(); renderStats(); });
  }

  function statsCard(station, s, all, cage, pallet, carrier) {
    const bad = s.difference !== 0;
    const fields = [
      ['應有', s.expected, 'stat-cell-priority'],
      ['現場', s.actual, 'stat-cell-priority'],
      ['差異', s.difference, `stat-cell-priority stat-cell-difference ${bad ? 'is-bad' : 'is-good'}`],
      ['中班', s.morning, ''],
      ['夜班', s.night, ''],
      ['過境', s.transit, ''],
      ['二分', s.secondary, ''],
      ['回報', s.reportTotal, ''],
      ['載走', s.loaded, ''],
    ];
    return `<article class="card stats-card ${bad ? 'bad' : ''}"><div class="stats-card-head"><div><strong>${stationLabel(station)}</strong>${carrier === 'ALL' ? `<small>回報：${carrierPair(cage.reportTotal, pallet.reportTotal)}</small>` : `<small>目前檢視：${carrierLabel(carrier)}｜合計${all.reportTotal}</small>`}</div><span class="status-pill">${bad ? '差異異常' : '正常'}</span></div><div class="stats-grid">${fields.map(([label, value, className]) => `<div class="stat-cell ${className}"><span>${label}</span><b>${value}</b></div>`).join('')}</div></article>`;
  }

  async function copyText(text, successMessage = '已複製') {
    try { await navigator.clipboard.writeText(text); }
    catch { const textarea = document.createElement('textarea'); textarea.value = text; document.body.appendChild(textarea); textarea.select(); document.execCommand('copy'); textarea.remove(); }
    showToast(successMessage);
  }

  function reportWarningHtml(time) {
    return `<section class="report-warning" role="alert"><div class="report-warning-head"><strong>${time}回報偵測到數字差異異常</strong><button id="closeReportWarningBtn" type="button" aria-label="關閉提示">×</button></div><p>此回報範圍內的統計核對存在異常，請先確認；也可以選擇仍要複製。</p><button id="forceCopyReportBtn" class="warning-copy-btn" type="button">仍要複製回報文字</button></section>`;
  }

  function renderReports() {
    const shift = requireShift(); if (!shift) return;
    const reportKey = state.ui.reportMode;
    const isThree = reportKey === 'THREE_AM';
    const stations = L.REPORT_GROUPS[reportKey];
    const stats = L.computeFastReportStats(shift, 'ALL');
    const cage = L.computeFastReportStats(shift, 'cage');
    const pallet = L.computeFastReportStats(shift, 'pallet');
    const time = isThree ? '03:00' : '05:00';
    const scope = isThree ? 'CS／Ct＋S' : 'NS／Nt／TS／Tt／E';
    const total = stations.reduce((sum, station) => sum + stats[station].reportTotal, 0);
    main.innerHTML = `
      <div class="sticky-control-bar report-switch-bar"><span>派車快速回報</span><div class="report-mode-switch"><button class="${isThree ? 'active' : ''}" data-report-mode="THREE_AM">03:00</button><button class="${!isThree ? 'active' : ''}" data-report-mode="FIVE_AM">05:00</button></div></div>
      <section class="card"><strong>${time} 派車快速回報</strong><p class="small-note">${scope}；複製文字使用0.033版全形固定欄寬表格，站所、中班、夜班與過境垂直對齊。</p></section>
      <div class="report-summary"><div class="total-card"><span>${time}合計</span><strong>${total}</strong></div><div class="total-card"><span>${scope}</span><strong>${stations.length}站</strong></div></div>
      <button id="copyReportBtn" class="primary-btn full-width report-copy-btn">複製${time}回報文字</button>
      <div id="reportWarningHost"></div>
      <div class="report-list">${stations.map((station) => { const st = stats[station]; return `<div class="report-row"><strong>${stationLabel(station)}</strong><span><small>中</small>${st.morning}</span><span><small>夜</small>${st.night}</span><span><small>過</small>${st.transit}</span><span class="report-total"><small>總</small>${st.reportTotal}<em>${carrierPair(cage[station].reportTotal, pallet[station].reportTotal)}</em></span></div>`; }).join('')}</div>`;
    main.querySelectorAll('[data-report-mode]').forEach((button) => button.addEventListener('click', async () => { state.ui.reportMode = button.dataset.reportMode; await saveState(); renderReports(); }));
    el('copyReportBtn').addEventListener('click', async () => {
      const anomalies = L.findFastReportAnomalies(shift, reportKey);
      const host = el('reportWarningHost');
      if (!anomalies.length) {
        host.innerHTML = '';
        await copyText(L.makeReportText(shift, reportKey), `${time}回報已複製`);
        return;
      }
      host.innerHTML = reportWarningHtml(time);
      el('closeReportWarningBtn').addEventListener('click', () => { host.innerHTML = ''; });
      el('forceCopyReportBtn').addEventListener('click', async () => {
        await copyText(L.makeReportText(shift, reportKey), `${time}回報已複製（統計核對仍有異常）`);
      });
      host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  function scheduleReturnBucketRefresh() {
    clearTimeout(returnRefreshTimer);
    if (state.activeView !== 'returns') return;
    const now = new Date();
    const next = new Date(now);
    next.setSeconds(1, 0);
    if (now.getMinutes() < 30) next.setMinutes(30); else { next.setHours(now.getHours() + 1); next.setMinutes(0); }
    returnRefreshTimer = setTimeout(() => { if (state.activeView === 'returns') renderReturns(); }, Math.max(1000, next.getTime() - now.getTime()));
  }

  function renderReturns() {
    const shift = requireShift(); if (!shift) return;
    const carrier = state.ui.returnCarrier;
    const returns = L.computeReturnCounts(shift);
    const current = L.computeCurrentReturnBucketCounts(shift);
    const buckets = L.computeReturnBuckets(shift);
    const currentBucket = current.bucket;
    const sources = [...L.RETURN_SOURCES, ...Object.keys(returns.bySource).filter((source) => !L.RETURN_SOURCES.includes(source))];
    const editBucket = buckets.find((bucket) => bucket.key === returnHistoryEditBucketKey) || null;
    if (editBucket && !sources.includes(returnHistoryEditSource)) returnHistoryEditSource = sources[0] || 'DC2';

    main.innerHTML = `
      ${guideDetailsHtml('回倉紀錄', '目前30分鐘批次計數', '面板只顯示目前30分鐘時段數量，到下一時段會自動歸零；下方歷史時段紀錄仍完整保留。−1只會扣除目前時段同來源、同載具的最近紀錄。歷史卡可按「修正此時段」，補登或扣除過去時段的數量。')}
      <div class="sticky-control-bar carrier-awareness-bar return-carrier-bar"><span>目前時段 <b>${currentBucket.label}</b>｜載具 <b>${carrierLabel(carrier)}</b></span>${carrierModeHtml(carrier, 'return-carrier')}</div>
      <div class="return-source-grid">${sources.map((source) => { const value = current.bySource[source] || { cage: 0, pallet: 0, total: 0 }; return `<div class="return-source-card"><strong>${source}</strong><span>${value[carrier]}</span><small>本時段：${carrierPair(value.cage, value.pallet)}</small><div><button class="return-minus" data-return-change="-1" data-return-source="${source}">−1</button><button class="return-plus" data-return-change="1" data-return-source="${source}">＋1</button></div></div>`; }).join('')}</div>
      <section class="card return-grand-total"><span>目前時段</span><strong>${current.carrierTotals.total}</strong><small>${carrierPair(current.carrierTotals.cage, current.carrierTotals.pallet)}</small><span>本班累計</span><strong>${returns.carrierTotals.total}</strong><small>${carrierPair(returns.carrierTotals.cage, returns.carrierTotals.pallet)}</small></section>
      <details class="card return-note-card collapsible-note"><summary>＋ 增加特殊狀況備註</summary><label for="returnNoteInput" class="sr-only">特殊狀況備註</label><textarea id="returnNoteInput" maxlength="160" rows="3" placeholder="例如：司機延遲、貨況異常、來源混載……"></textarea><button id="saveReturnNoteBtn" class="secondary-btn full-width">儲存備註至目前時段</button></details>
      <section class="page-section"><h2 class="section-title">30分鐘時段紀錄<small>可修正過去時段</small></h2><div class="return-bucket-scroll">${buckets.length ? buckets.map((bucket) => returnBucketHtml(bucket, returnHistoryEditBucketKey)).join('') : '<div class="empty-state">尚無回倉紀錄。</div>'}</div></section>
      ${editBucket ? returnHistoryEditorHtml(shift, editBucket, sources) : ''}
      <section class="card return-copy-card"><button id="copyReturnReportBtn" class="primary-btn full-width" type="button">複製回倉回報文字</button><p class="small-note">每個來源固定一行，使用｜分隔各時段；不使用全形字元、補齊空格或接續箭頭。</p></section>`;

    main.querySelectorAll('[data-return-carrier]').forEach((button) => button.addEventListener('click', async () => {
      state.ui.returnCarrier = button.dataset.returnCarrier;
      await saveState();
      renderReturns();
    }));

    main.querySelectorAll('[data-return-change]').forEach((button) => button.addEventListener('click', async () => {
      try {
        const count = L.adjustReturnBucketCount(shift, button.dataset.returnSource, carrier, Number(button.dataset.returnChange));
        await saveState();
        vibrate();
        showToast(`${button.dataset.returnSource} ${carrierShort(carrier)}本時段${count}`);
        renderReturns();
        updateHeader();
      } catch (error) {
        showToast(error.message);
      }
    }));

    main.querySelectorAll('[data-edit-return-bucket]').forEach((button) => button.addEventListener('click', () => {
      const bucket = buckets.find((item) => item.key === button.dataset.editReturnBucket);
      if (!bucket) return;
      returnHistoryEditBucketKey = bucket.key;
      returnHistoryEditSource = Object.entries(bucket.sources || {}).find(([, value]) => value.total > 0)?.[0] || sources[0] || 'DC2';
      renderReturns();
      requestAnimationFrame(() => el('returnHistoryEditor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }));

    el('closeReturnHistoryEditorBtn')?.addEventListener('click', () => {
      returnHistoryEditBucketKey = null;
      renderReturns();
    });

    el('returnHistorySourceSelect')?.addEventListener('change', (event) => {
      returnHistoryEditSource = event.target.value;
      renderReturns();
      requestAnimationFrame(() => el('returnHistoryEditor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    });

    main.querySelectorAll('[data-return-history-change]').forEach((button) => button.addEventListener('click', async () => {
      const bucket = buckets.find((item) => item.key === returnHistoryEditBucketKey);
      if (!bucket) return;
      const historyCarrier = button.dataset.returnHistoryCarrier;
      const delta = Number(button.dataset.returnHistoryChange);
      try {
        const count = L.adjustReturnBucketCount(shift, returnHistoryEditSource, historyCarrier, delta, bucket.start);
        await saveState();
        vibrate();
        showToast(`${bucket.label}｜${returnHistoryEditSource} ${carrierShort(historyCarrier)}修正為${count}`);
        renderReturns();
        updateHeader();
        requestAnimationFrame(() => el('returnHistoryEditor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      } catch (error) {
        showToast(error.message);
      }
    }));

    el('saveReturnNoteBtn').addEventListener('click', async () => {
      try {
        const note = L.addReturnNote(shift, el('returnNoteInput').value);
        await saveState();
        showToast(`備註已存入${L.halfHourBucket(note.timestamp).label}`);
        renderReturns();
      } catch (error) {
        showToast(error.message);
      }
    });

    main.querySelectorAll('[data-delete-return-note]').forEach((button) => button.addEventListener('click', async () => {
      if (!window.confirm('確定刪除這則回倉備註？')) return;
      try {
        L.deleteReturnNote(shift, button.dataset.deleteReturnNote);
        await saveState();
        showToast('回倉備註已刪除');
        renderReturns();
      } catch (error) {
        showToast(error.message);
      }
    }));

    el('copyReturnReportBtn').addEventListener('click', () => copyText(L.makeReturnReportText(shift), '回倉回報文字已複製'));
    scheduleReturnBucketRefresh();
  }

  function returnHistoryEditorHtml(shift, bucket, sources) {
    const cage = L.returnBucketSourceCounts(shift, returnHistoryEditSource, bucket.key, 'cage');
    const pallet = L.returnBucketSourceCounts(shift, returnHistoryEditSource, bucket.key, 'pallet');
    const sourceOptions = sources.map((source) => `<option value="${escapeHtml(source)}" ${source === returnHistoryEditSource ? 'selected' : ''}>${escapeHtml(source)}</option>`).join('');
    const adjustRow = (carrier, value) => `<div class="return-history-adjust-row">
      <span>${carrierLabel(carrier)}</span>
      <button class="return-minus" type="button" data-return-history-change="-1" data-return-history-carrier="${carrier}">−1</button>
      <strong>${value}</strong>
      <button class="return-plus" type="button" data-return-history-change="1" data-return-history-carrier="${carrier}">＋1</button>
    </div>`;

    return `<section class="card return-history-editor" id="returnHistoryEditor">
      <div class="return-history-editor-head">
        <div><span>歷史時段修正</span><strong>${bucket.label}</strong></div>
        <button id="closeReturnHistoryEditorBtn" type="button">關閉</button>
      </div>
      <label class="return-history-source-label" for="returnHistorySourceSelect">來源
        <select id="returnHistorySourceSelect">${sourceOptions}</select>
      </label>
      <div class="return-history-adjust-grid">
        ${adjustRow('cage', cage)}
        ${adjustRow('pallet', pallet)}
      </div>
      <p class="small-note">只修改${bucket.label}的${returnHistoryEditSource}，不影響目前時段與其他歷史時段。</p>
    </section>`;
  }

  function returnBucketHtml(bucket, selectedBucketKey = null) {
    const details = Object.entries(bucket.sources)
      .filter(([, value]) => value.total > 0)
      .map(([source, value]) => `<div><strong>${source}</strong><span>${value.total}</span><small>${carrierPair(value.cage, value.pallet)}</small></div>`)
      .join('');
    const notes = (bucket.notes || [])
      .map((note) => `<div class="return-note-item"><span><b>${formatTime(note.timestamp).slice(0, 5)}</b>${escapeHtml(note.text)}</span><button class="return-note-delete" data-delete-return-note="${note.id}" aria-label="刪除備註">刪除</button></div>`)
      .join('');
    return `<article class="return-bucket ${bucket.key === selectedBucketKey ? 'is-editing' : ''}">
      <h3>${bucket.label}</h3>
      <p>合計${bucket.total}｜${carrierPair(bucket.cage, bucket.pallet)}</p>
      ${details}
      ${notes ? `<section class="return-notes"><h4>備註</h4>${notes}</section>` : ''}
      <button class="return-bucket-edit-btn" type="button" data-edit-return-bucket="${bucket.key}">${bucket.key === selectedBucketKey ? '正在修正此時段' : '修正此時段'}</button>
    </article>`;
  }

  function renderEvents() {
    const shift = requireShift(); if (!shift) return;
    const stationFilter = state.ui.eventStation; const categoryFilter = state.ui.eventCategory; const carrierFilter = state.ui.eventCarrier; const order = state.ui.eventOrder;
    const events = shift.events.filter((event) => stationFilter === 'ALL' || event.station === stationFilter).filter((event) => categoryFilter === 'ALL' || event.category === categoryFilter).filter((event) => carrierFilter === 'ALL' || event.carrier === carrierFilter).slice().sort((a, b) => order === 'asc' ? String(a.timestamp).localeCompare(String(b.timestamp)) : String(b.timestamp).localeCompare(String(a.timestamp)));
    main.innerHTML = `<div class="filter-row events-four"><select id="eventStationFilter"><option value="ALL">全部站所</option>${L.STATIONS.map((station) => `<option value="${station}" ${station === stationFilter ? 'selected' : ''}>${stationLabel(station)}</option>`).join('')}</select><select id="eventCategoryFilter"><option value="ALL">全部類別</option>${L.CATEGORIES.map((category) => `<option value="${category}" ${category === categoryFilter ? 'selected' : ''}>${categoryLabel(category)}</option>`).join('')}</select><select id="eventCarrierFilter"><option value="ALL">全部載具</option>${L.CARRIERS.map((carrier) => `<option value="${carrier}" ${carrier === carrierFilter ? 'selected' : ''}>${carrierLabel(carrier)}</option>`).join('')}</select><select id="eventOrderFilter"><option value="desc" ${order === 'desc' ? 'selected' : ''}>新到舊</option><option value="asc" ${order === 'asc' ? 'selected' : ''}>舊到新</option></select></div><div>${events.length ? events.map(eventHtml).join('') : '<div class="empty-state">沒有符合條件的紀錄。</div>'}</div>`;
    ['eventStationFilter', 'eventCategoryFilter', 'eventCarrierFilter', 'eventOrderFilter'].forEach((id) => el(id).addEventListener('change', async () => { state.ui.eventStation = el('eventStationFilter').value; state.ui.eventCategory = el('eventCategoryFilter').value; state.ui.eventCarrier = el('eventCarrierFilter').value; state.ui.eventOrder = el('eventOrderFilter').value; await saveState(); renderEvents(); }));
    main.querySelectorAll('[data-edit-event]').forEach((button) => button.addEventListener('click', () => openEventEdit(button.dataset.editEvent)));
    main.querySelectorAll('[data-delete-event]').forEach((button) => button.addEventListener('click', () => removeEvent(button.dataset.deleteEvent)));
  }

  function eventHtml(event) { return `<article class="event-item"><div class="event-main"><strong>${stationLabel(event.station)}｜${categoryLabel(event.category)}｜${carrierShort(event.carrier)}</strong><b>${event.delta > 0 ? '+' : ''}${event.delta} → ${event.after}</b></div><div class="event-meta">${formatTime(event.timestamp)}${event.note ? `｜${escapeHtml(event.note)}` : ''}</div><div class="event-actions"><button class="secondary-btn" data-edit-event="${event.id}">修改</button><button class="danger-btn" data-delete-event="${event.id}">刪除</button></div></article>`; }
  function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

  function openEventEdit(eventId) {
    const event = currentShift().events.find((item) => item.id === eventId); if (!event) return;
    el('editEventId').value = event.id;
    el('editEventStation').innerHTML = L.STATIONS.map((station) => `<option value="${station}" ${station === event.station ? 'selected' : ''}>${stationLabel(station)}</option>`).join('');
    el('editEventCategory').innerHTML = L.CATEGORIES.map((category) => `<option value="${category}" ${category === event.category ? 'selected' : ''}>${categoryLabel(category)}</option>`).join('');
    el('editEventCarrier').innerHTML = L.CARRIERS.map((carrier) => `<option value="${carrier}" ${carrier === event.carrier ? 'selected' : ''}>${carrierLabel(carrier)}</option>`).join('');
    el('editEventDelta').value = event.delta; el('editEventNote').value = event.note || ''; eventDialog.showModal();
  }

  async function removeEvent(eventId) { if (!window.confirm('確定刪除這筆事件？數量會同步重算。')) return; L.deleteEvent(currentShift(), eventId); await saveState(); showToast('事件已刪除'); renderCurrentView(); }

  function getPreviousMorningCounts() {
    const previous = previousShift(); if (!previous) return null;
    const counts = L.computeCounts(previous); const result = {};
    L.STATIONS.forEach((station) => { result[station] = { cage: counts[station].morning.cage, pallet: counts[station].morning.pallet }; });
    return result;
  }

  function renderShifts() {
    const sorted = state.shifts.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    main.innerHTML = `<section class="card"><h3>建立新班次</h3><label class="small-note">班次日期</label><input id="newShiftDate" class="date-input" type="date" value="${L.localDate()}"><label class="toggle"><input id="copyMorningCheck" type="checkbox">複製上一班中班數量（含籠／板）</label><button id="createShiftBtn" class="primary-btn action-btn full-width">建立並切換班次</button></section>
      <section class="card"><h3>匯出與備份</h3><div class="action-grid"><button id="exportCsvBtn" class="secondary-btn">點貨CSV</button><button id="exportReturnCsvBtn" class="secondary-btn">回倉CSV</button><button id="copyLogBtn" class="secondary-btn">複製工作日誌</button><button id="exportJsonBtn" class="secondary-btn">完整JSON</button><label class="secondary-btn file-button action-grid-full">匯入JSON<input id="importJsonInput" type="file" accept="application/json"></label></div></section>
      <section class="card danger-zone"><h3>危險操作</h3><p class="small-note">清除後會刪除所有班次與本機紀錄。系統仍會要求兩次確認並輸入「全部清除」。</p><button id="clearAllBtn" class="danger-btn full-width">清除全部資料</button></section>
      <section class="card"><h3>歷史班次</h3>${sorted.length ? sorted.map((shift) => `<div class="shift-item ${shift.id === state.currentShiftId ? 'active' : ''}"><div><strong>${shift.date}</strong><small>${shift.events.length}筆事件</small></div><button class="secondary-btn" data-switch-shift="${shift.id}" ${shift.id === state.currentShiftId ? 'disabled' : ''}>${shift.id === state.currentShiftId ? '目前' : '切換'}</button></div>`).join('') : '<div class="empty-state">沒有班次。</div>'}</section>`;
    el('createShiftBtn').addEventListener('click', createNewShift); el('exportCsvBtn').addEventListener('click', exportCurrentCSV); el('exportReturnCsvBtn').addEventListener('click', exportReturnCSV); el('copyLogBtn').addEventListener('click', copyWorkLog); el('exportJsonBtn').addEventListener('click', exportAllJSON); el('importJsonInput').addEventListener('change', importJSON); el('clearAllBtn').addEventListener('click', clearAllData);
    main.querySelectorAll('[data-switch-shift]').forEach((button) => button.addEventListener('click', async () => { state.currentShiftId = button.dataset.switchShift; await saveState(); showToast('已切換班次'); renderCurrentView(); }));
  }

  async function createNewShift() {
    const date = el('newShiftDate').value; if (!date) return showToast('請選擇日期');
    const existing = state.shifts.find((shift) => shift.id === `${date}-night`);
    if (existing) { if (!window.confirm(`${date}班次已存在，要切換嗎？`)) return; state.currentShiftId = existing.id; await saveState(); return renderCurrentView(); }
    if (!window.confirm(`確定建立${date}大夜班？`)) return;
    const shift = L.createShift(date, el('copyMorningCheck').checked ? getPreviousMorningCounts() : null); state.shifts.push(shift); state.currentShiftId = shift.id; await saveState(); showToast('新班次已建立'); renderCurrentView();
  }

  function downloadFile(filename, content, type) { const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1200); }
  function exportCurrentCSV() { const shift = currentShift(); if (!shift) return showToast('尚無班次'); downloadFile(`點貨事件_${shift.date}.csv`, L.makeShiftCSV(shift), 'text/csv;charset=utf-8'); showToast('CSV已匯出'); }
  function exportReturnCSV() { const shift = currentShift(); if (!shift) return showToast('尚無班次'); downloadFile(`回倉紀錄_${shift.date}.csv`, L.makeReturnBatchCSV(shift), 'text/csv;charset=utf-8'); showToast('回倉CSV已匯出'); }
  function exportAllJSON() { const payload = { app: '物流夜班點貨', schemaVersion: 15, exportedAt: new Date().toISOString(), state }; downloadFile(`夜班點貨_完整備份_${L.localDate()}.json`, JSON.stringify(payload, null, 2), 'application/json'); showToast('JSON備份已匯出'); }

  async function importJSON(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try { const parsed = JSON.parse(await file.text()); const migrated = validateImportedState(parsed.state || parsed); if (!window.confirm('匯入會取代目前全部資料，確定繼續？')) return; state = migrated; await saveState(); showToast('資料已還原'); renderCurrentView(); }
    catch (error) { showToast(`匯入失敗：${error.message}`, 3500); }
    finally { event.target.value = ''; }
  }

  function validateImportedState(imported) {
    if (!imported || !Array.isArray(imported.shifts)) throw new Error('備份格式不正確');
    imported.shifts.forEach((shift) => { if (!shift.id || !shift.date || !Array.isArray(shift.events)) throw new Error('班次資料不完整'); L.migrateShift(shift); shift.events.forEach((event) => { if (!L.STATIONS.includes(event.station) || !L.CATEGORIES.includes(event.category) || !L.CARRIERS.includes(event.carrier)) throw new Error('含有不支援的站所、類別或載具'); }); });
    return migrateAppState(imported);
  }

  async function copyWorkLog() { const shift = currentShift(); if (!shift) return showToast('尚無班次'); await copyText(L.makeWorkLogText(shift), '工作日誌已複製'); }
  async function clearAllData() { if (!window.confirm('第一次確認：確定清除全部班次？')) return; if (window.prompt('第二次確認：請輸入「全部清除」') !== '全部清除') return showToast('未清除資料'); state = defaultState(); await saveState(); await ensureInitialShift(); showToast('全部資料已清除'); renderCurrentView(); }

  function renderCurrentView() {
    clearTimeout(returnRefreshTimer);
    if (state.activeView !== 'night') clearNightChuteTracking();
    updateHeader();
    switch (state.activeView) {
      case 'night': renderNight(); break; case 'online': renderOnline(); break; case 'inventory': renderInventory(); break; case 'reports': renderReports(); break; case 'stats': renderStats(); break;
      case 'morning': renderMorning(); break; case 'transit': renderTransit(); break; case 'loaded': renderLoaded(); break;
      case 'returns': renderReturns(); break; case 'events': renderEvents(); break; case 'shifts': renderShifts(); break; default: state.activeView = 'night'; renderNight();
    }
    if (state.activeView !== 'night') hideUndoBar();
    bindViewLinks();
  }

  function bindViewLinks() { document.querySelectorAll('[data-view]').forEach((button) => { if (button.dataset.bound) return; button.dataset.bound = '1'; button.addEventListener('click', () => switchView(button.dataset.view)); }); }

  async function switchView(view) {
    if (state.activeView === 'night' && view !== 'night') { nightUndoOperationId = null; undoDismissed = false; state.ui.nightCorrection = false; state.ui.nightOtherCarrier = false; hideUndoBar(); }
    if (state.activeView === 'online' && view !== 'online') { state.ui.onlineOtherCarrier = false; onlineExpandedChute = null; }
    if (state.activeView === 'morning' && view !== 'morning') state.ui.morningOtherCarrier = false;
    if (state.activeView === 'loaded' && view !== 'loaded') {
      state.ui.loadedOtherCarrier = false;
      loadedExpandedGroup = null;
      loadedFocusStation = null;
      preMidnightExpanded = false;
      preMidnightEditing = false;
      preMidnightAddGroup = null;
      preMidnightOtherCarrier = false;
    }
    if (state.activeView === 'transit' && view !== 'transit') {
      transitExpandedGroup = null;
      transitFocusStation = null;
      transitSummaryExpanded = false;
    }
    state.activeView = view; await saveState(); closeDrawer(); renderCurrentView(); window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function openDrawer() { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); backdrop.classList.remove('hidden'); }
  function closeDrawer() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); backdrop.classList.add('hidden'); }

  async function toggleWakeLock() {
    if (!('wakeLock' in navigator)) return showToast('瀏覽器不支援螢幕喚醒');
    try { if (wakeLock) { await wakeLock.release(); wakeLock = null; } else { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', updateWakeLockButton); } updateWakeLockButton(); }
    catch (error) { showToast(`無法切換：${error.message}`); }
  }
  function updateWakeLockButton() { el('wakeLockBtn').textContent = `保持螢幕喚醒：${wakeLock ? '開' : '關'}`; }

  async function saveEventEdit(event) {
    event.preventDefault();
    try { L.editEvent(currentShift(), el('editEventId').value, { station: el('editEventStation').value, category: el('editEventCategory').value, carrier: el('editEventCarrier').value, delta: Number(el('editEventDelta').value), note: el('editEventNote').value }); await saveState(); eventDialog.close(); showToast('事件已修改'); renderCurrentView(); }
    catch (error) { showToast(error.message); }
  }

  async function saveCustomQuantity(event) {
    event.preventDefault(); const qty = Number(el('customQty').value); if (!Number.isFinite(qty) || qty <= 0) return showToast('請輸入大於0的數量');
    const station = el('quantityStation').value; const category = el('quantityCategory').value; const carrier = el('quantityCarrier').value; const direction = Number(el('quantityDirection').value || 1); quantityDialog.close();
    await addQuantityAdjustment(station, category, carrier, direction, qty);
  }

  function setupStaticListeners() {
    el('menuBtn').addEventListener('click', openDrawer); el('closeDrawerBtn').addEventListener('click', closeDrawer); backdrop.addEventListener('click', closeDrawer); el('wakeLockBtn').addEventListener('click', toggleWakeLock);
    el('undoBtn').addEventListener('click', async () => { const shift = currentShift(); if (!shift || !nightUndoOperationId) return showToast('沒有可復原紀錄'); const removed = L.undoOperation(shift, nightUndoOperationId); if (!removed.length) return showToast('紀錄已不存在'); nightUndoOperationId = null; undoDismissed = false; await saveState(); vibrate(70); showToast(`已復原：${stationLabel(removed[0].station)}${carrierShort(removed[0].carrier)}`); renderCurrentView(); });
    el('undoCloseBtn').addEventListener('click', () => { undoDismissed = true; hideUndoBar(); });
    el('eventEditForm').addEventListener('submit', saveEventEdit); el('quantityForm').addEventListener('submit', saveCustomQuantity);
    document.addEventListener('pointerdown', (event) => {
      const active = document.activeElement;
      if (state && state.activeView === 'inventory' && active && active.matches('[data-inventory-input]') && active !== event.target && String(active.value).trim() === '') {
        active.value = '0';
        active.blur();
      }
    });
    document.querySelectorAll('[data-qty]').forEach((button) => button.addEventListener('click', async () => { const station = el('quantityStation').value; const category = el('quantityCategory').value; const carrier = el('quantityCarrier').value; const direction = Number(el('quantityDirection').value || 1); quantityDialog.close(); await addQuantityAdjustment(station, category, carrier, direction, Number(button.dataset.qty)); }));
    bindViewLinks();
    window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; el('installBtn').classList.remove('hidden'); });
    el('installBtn').addEventListener('click', async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; el('installBtn').classList.add('hidden'); });
    window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; el('installBtn').classList.add('hidden'); showToast('App已安裝'); });
    document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && wakeLock && 'wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* no-op */ } } });
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      let controllerReloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (controllerReloaded) return;
        controllerReloaded = true;
        const reloadKey = 'night-pallet-counter-controller-reload-0.050';
        if (sessionStorage.getItem(reloadKey)) return;
        sessionStorage.setItem(reloadKey, '1');
        window.location.reload();
      });
      const registration = await navigator.serviceWorker.register(
        './service-worker-0.050.js?v=0.050',
        { updateViaCache: 'none' }
      );
      await registration.update();
    } catch (error) {
      console.warn('Service Worker註冊失敗', error);
    }
  }

  async function init() {
    try {
      if (!L || L.VERSION !== APP_VERSION) {
        throw new Error(`版本檔案不一致：App ${APP_VERSION}／Logic ${L?.VERSION || '未載入'}。請重新整理或清除網站快取。`);
      }
      db = await openDatabase(); state = migrateAppState((await dbGet(STATE_KEY)) || defaultState()); await saveState(); await ensureInitialShift(); setupStaticListeners(); await registerServiceWorker(); renderCurrentView(); }
    catch (error) { console.error(error); main.innerHTML = `<section class="card"><h2>App啟動失敗</h2><p>${escapeHtml(error.message)}</p><p class="small-note">請使用Chrome並允許網站儲存資料。</p></section>`; }
  }

  init();
})();
