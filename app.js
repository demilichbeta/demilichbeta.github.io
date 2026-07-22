(() => {
  'use strict';

  const L = window.PalletLogic;
  const DB_NAME = 'night-pallet-counter';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';
  const STATE_KEY = 'app-state';

  const VIEW_TITLES = {
    night: '夜班產出', online: '線上未退出', inventory: '現場盤點', stats: '統計核對',
    morning: '中班數量', transit: '過境貨', loaded: '提前載走', reports: '03:00 快速回報',
    returns: '回倉紀錄', events: '事件紀錄', shifts: '班次／備份',
  };

  let db;
  let state;
  let deferredInstallPrompt = null;
  let toastTimer = null;
  let wakeLock = null;
  let nightUndoOperationId = null;
  let undoDismissed = false;

  const el = (id) => document.getElementById(id);
  const main = el('mainContent');
  const drawer = el('drawer');
  const backdrop = el('drawerBackdrop');
  const eventDialog = el('eventDialog');
  const quantityDialog = el('quantityDialog');

  function defaultState() {
    return {
      version: 6,
      currentShiftId: null,
      shifts: [],
      activeView: 'night',
      ui: {
        statsGroup: 'ALL', statsAnomaliesOnly: false, statsCarrier: 'ALL', inventoryGroup: 'ALL',
        eventStation: 'ALL', eventCategory: 'ALL', eventCarrier: 'ALL', eventOrder: 'desc',
        nightCorrection: false, nightOtherCarrier: false, onlineOtherCarrier: false,
        transitCarrier: 'cage', loadedCarrier: 'cage', returnCarrier: 'cage',
      },
    };
  }

  function migrateAppState(rawState) {
    const base = defaultState();
    const migrated = rawState && typeof rawState === 'object' ? rawState : base;
    migrated.version = 6;
    migrated.shifts = Array.isArray(migrated.shifts) ? migrated.shifts : [];
    migrated.shifts.forEach((shift) => L.migrateShift(shift));
    migrated.ui = { ...base.ui, ...(migrated.ui || {}) };
    const validViews = new Set(Object.keys(VIEW_TITLES));
    if (!validViews.has(migrated.activeView)) migrated.activeView = 'night';
    if (!['ALL', ...L.GROUP_ORDER].includes(migrated.ui.statsGroup)) migrated.ui.statsGroup = 'ALL';
    if (!['ALL', ...L.GROUP_ORDER].includes(migrated.ui.inventoryGroup)) migrated.ui.inventoryGroup = 'ALL';
    if (!['ALL', ...L.CARRIERS].includes(migrated.ui.statsCarrier)) migrated.ui.statsCarrier = 'ALL';
    ['transitCarrier', 'loadedCarrier', 'returnCarrier'].forEach((key) => {
      if (!L.CARRIERS.includes(migrated.ui[key])) migrated.ui[key] = 'cage';
    });
    migrated.ui.nightCorrection = false;
    migrated.ui.nightOtherCarrier = false;
    migrated.ui.onlineOtherCarrier = false;
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

  function flashStationButton(station) {
    const button = document.querySelector(`[data-station="${station}"]`);
    if (!button) return;
    button.classList.remove('flash'); void button.offsetWidth; button.classList.add('flash');
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
    el('undoMessage').textContent = message || `上一筆：${last.station} ${carrierShort(last.carrier)}${last.delta > 0 ? '+' : ''}${last.delta}`;
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
      if (isNightAction) updateUndoBar(`${station} ${carrierShort(event.carrier)} ${delta > 0 ? '+' : ''}${delta}`, nightUndoOperationId);
      showToast(`${station} ${categoryLabel(category)}${carrierShort(event.carrier)} ${delta > 0 ? '+' : ''}${delta}`);
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

  function stationCarrierSummary(counts, station, category) {
    const c = counts[station][category];
    return `籠${c.cage}｜板${c.pallet}`;
  }

  function nightStationButtonsHtml(counts) {
    return L.CHUTES.map((chute) => `
      <section class="page-section">
        <h2 class="section-title">${chute.name}<small>${chute.stations.length}站</small></h2>
        <div class="station-grid">
          ${chute.stations.map((station) => {
            const category = counts[station].night;
            const total = L.countFor(category, 'ALL');
            const defaultCarrier = L.defaultCarrierForStation(station);
            return `<button class="station-btn" data-night-station="${station}" data-station="${station}">
              <span class="station-name">${station}</span><span class="station-count">${total}</span>
              <span class="carrier-mini">籠${category.cage}｜板${category.pallet}</span>
              <span class="default-badge">預設${carrierShort(defaultCarrier)}</span>
            </button>`;
          }).join('')}
        </div>
      </section>`).join('');
  }

  function nightCorrectionHtml(counts) {
    return L.CHUTES.map((chute) => `
      <section class="page-section"><h2 class="section-title">${chute.name}<small>${chute.stations.length}站</small></h2>
        <div class="night-correction-grid">${chute.stations.map((station) => `
          <div class="night-correction-card"><strong>${station}</strong>
            ${L.CARRIERS.map((carrier) => `<div class="carrier-adjust-line"><span>${carrierShort(carrier)} ${counts[station].night[carrier]}</span><button data-night-correct="-1" data-carrier="${carrier}" data-station="${station}">−</button><button data-night-correct="1" data-carrier="${carrier}" data-station="${station}">＋</button></div>`).join('')}
          </div>`).join('')}</div>
      </section>`).join('');
  }

  function renderNight() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const correction = state.ui.nightCorrection;
    const otherMode = state.ui.nightOtherCarrier;
    main.innerHTML = `
      <section class="card night-mode-card"><div><strong>${correction ? '夜班載具數修正模式' : '蓋章後，按站所一次。'}</strong>
        <p class="small-note">${correction ? '籠車與棧板可分別調整。' : '正常依站所預設載具；偶發另一種載具時，先啟用「下一筆非預設」。'}</p></div>
        <button type="button" class="${correction ? 'primary-btn' : 'secondary-btn'} night-mode-toggle" data-toggle-night-correction>${correction ? '返回快速＋1' : '修正前面數量'}</button>
      </section>
      ${!correction ? `<button type="button" class="full-width carrier-override ${otherMode ? 'active' : ''}" data-night-other>${otherMode ? '下一筆：使用非預設載具（按站所後自動關閉）' : '下一筆改用非預設載具'}</button>` : ''}
      ${correction ? nightCorrectionHtml(counts) : nightStationButtonsHtml(counts)}`;

    main.querySelector('[data-toggle-night-correction]').addEventListener('click', async () => {
      state.ui.nightCorrection = !state.ui.nightCorrection; state.ui.nightOtherCarrier = false; await saveState(); renderCurrentView();
    });
    if (correction) {
      main.querySelectorAll('[data-night-correct]').forEach((button) => button.addEventListener('click', () => addSingle(
        button.dataset.station, 'night', Number(button.dataset.nightCorrect), button.dataset.carrier, '夜班前面數量修正'
      )));
    } else {
      main.querySelector('[data-night-other]').addEventListener('click', async () => {
        state.ui.nightOtherCarrier = !state.ui.nightOtherCarrier; await saveState(); renderNight();
      });
      main.querySelectorAll('[data-night-station]').forEach((button) => button.addEventListener('click', async () => {
        const station = button.dataset.nightStation;
        const base = L.defaultCarrierForStation(station);
        const carrier = state.ui.nightOtherCarrier ? L.otherCarrier(base) : base;
        state.ui.nightOtherCarrier = false;
        await addSingle(station, 'night', 1, carrier);
      }));
    }
    updateUndoBar();
  }

  function renderTransit() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const carrier = state.ui.transitCarrier;
    main.innerHTML = `
      <section class="card"><strong>過境貨</strong><p class="small-note">先選載具，再以−1／＋1調整站所過境數。</p>${carrierModeHtml(carrier, 'transit-carrier')}</section>
      ${L.CHUTES.map((chute) => `<section class="page-section"><h2 class="section-title">${chute.name}</h2><div class="quantity-adjust-grid">${chute.stations.map((station) => `
        <div class="quantity-adjust-card"><strong>${station}</strong><span>${counts[station].transit[carrier]}</span><small>${stationCarrierSummary(counts, station, 'transit')}</small><div><button data-transit-change="-1" data-station="${station}">−1</button><button data-transit-change="1" data-station="${station}">＋1</button></div></div>`).join('')}</div></section>`).join('')}`;
    main.querySelectorAll('[data-transit-carrier]').forEach((button) => button.addEventListener('click', async () => { state.ui.transitCarrier = button.dataset.transitCarrier; await saveState(); renderTransit(); }));
    main.querySelectorAll('[data-transit-change]').forEach((button) => button.addEventListener('click', () => addSingle(button.dataset.station, 'transit', Number(button.dataset.transitChange), carrier)));
  }

  function openQuantity(station, category, carrier) {
    el('quantityStation').value = station; el('quantityCategory').value = category; el('quantityCarrier').value = carrier;
    el('quantityStationLabel').textContent = `${station}｜${carrierLabel(carrier)}`;
    el('quantityTitle').textContent = `新增${categoryLabel(category)}`; el('customQty').value = '';
    quantityDialog.showModal();
  }

  function renderLoaded() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const carrier = state.ui.loadedCarrier;
    main.innerHTML = `
      <section class="card"><strong>提前載走</strong><p class="small-note">先選載具；「登記」可快速加入1、2、3、5或自訂數量，−1用於修正。</p>${carrierModeHtml(carrier, 'loaded-carrier')}</section>
      ${L.CHUTES.map((chute) => `<section class="page-section"><h2 class="section-title">${chute.name}</h2><div class="loaded-grid">${chute.stations.map((station) => `
        <div class="loaded-card"><strong>${station}</strong><span>${counts[station].loaded[carrier]}</span><small>${stationCarrierSummary(counts, station, 'loaded')}</small><div><button data-loaded-minus data-station="${station}">−1</button><button data-loaded-open data-station="${station}">登記</button></div></div>`).join('')}</div></section>`).join('')}`;
    main.querySelectorAll('[data-loaded-carrier]').forEach((button) => button.addEventListener('click', async () => { state.ui.loadedCarrier = button.dataset.loadedCarrier; await saveState(); renderLoaded(); }));
    main.querySelectorAll('[data-loaded-minus]').forEach((button) => button.addEventListener('click', () => addSingle(button.dataset.station, 'loaded', -1, carrier)));
    main.querySelectorAll('[data-loaded-open]').forEach((button) => button.addEventListener('click', () => openQuantity(button.dataset.station, 'loaded', carrier)));
  }

  function dualCounterHtml(station, category, counts) {
    return `<div class="dual-count-card"><strong>${station}</strong>${L.CARRIERS.map((carrier) => `
      <div class="dual-count-line"><span>${carrierLabel(carrier)}</span><button data-count-step="-1" data-station="${station}" data-category="${category}" data-carrier="${carrier}">−</button>
      <input type="number" min="0" step="1" inputmode="numeric" value="${counts[station][category][carrier]}" data-set-count data-station="${station}" data-category="${category}" data-carrier="${carrier}">
      <button data-count-step="1" data-station="${station}" data-category="${category}" data-carrier="${carrier}">＋</button></div>`).join('')}</div>`;
  }

  function renderMorning() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    main.innerHTML = `<section class="card"><strong>00:00 中班盤點</strong><p class="small-note">依字母系列排列；籠車、棧板分開輸入。</p></section>
      ${L.GROUP_ORDER.map((group) => `<section class="page-section"><h2 class="section-title">${group} 系列<small>${L.STATION_GROUPS[group].length}站</small></h2><div class="dual-count-list">${L.STATION_GROUPS[group].map((station) => dualCounterHtml(station, 'morning', counts)).join('')}</div></section>`).join('')}`;
    bindCountInputs(); bindCountSteppers();
  }

  function renderOnline() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const otherMode = state.ui.onlineOtherCarrier;
    main.innerHTML = `
      <section class="card"><strong>04:30 線上未退出</strong><p class="small-note">「全部＋1」只套用 NS／TS；個別例外可啟用下一筆非預設。綠框代表已清零，橘框代表尚待轉完成。</p>
        <div class="bulk-online-actions"><button class="primary-btn" data-online-all-add>全部 NS／TS ${L.ONLINE_BULK_STATIONS.length} 站＋1</button><button class="secondary-btn" data-convert-all-online>全部線上轉完成</button></div>
      </section>
      <button type="button" class="full-width carrier-override ${otherMode ? 'active' : ''}" data-online-other>${otherMode ? '下一筆：使用非預設載具（按＋1後自動關閉）' : '下一筆改用非預設載具'}</button>
      ${L.CHUTES.map((chute) => `<section class="online-chute-section"><h2 class="online-chute-title">${chute.name}</h2><div class="input-list">${chute.stations.map((station) => {
        const online = counts[station].online; const total = L.countFor(online, 'ALL'); const zero = total === 0;
        return `<div class="online-row ${zero ? 'online-zero' : 'online-pending'}"><strong>${station}</strong><button class="online-adjust minus" data-online-change="-1" data-station="${station}">−1</button>
          <span class="online-count"><b>${total}</b><small>籠${online.cage}／板${online.pallet}</small></span><button class="online-adjust plus" data-online-change="1" data-station="${station}">＋1</button>
          <button class="online-convert" data-convert-online data-station="${station}" ${zero ? 'disabled' : ''}>${zero ? '已完成' : '轉完成'}</button></div>`;
      }).join('')}</div></section>`).join('')}`;

    main.querySelector('[data-online-other]').addEventListener('click', async () => { state.ui.onlineOtherCarrier = !state.ui.onlineOtherCarrier; await saveState(); renderOnline(); });
    main.querySelector('[data-online-all-add]').addEventListener('click', async () => {
      const result = L.addOnlineToAllStations(shift, 1); await saveState(); vibrate(80); renderCurrentView(); showToast(`NS／TS 共${result.stations}站已依預設載具＋1`);
    });
    main.querySelector('[data-convert-all-online]').addEventListener('click', async () => {
      try { const result = L.convertAllOnlineToNight(shift); await saveState(); vibrate(90); renderCurrentView(); showToast(`已轉完成${result.quantity}個載具`); }
      catch (error) { showToast(error.message); }
    });
    main.querySelectorAll('[data-online-change]').forEach((button) => button.addEventListener('click', async () => {
      const station = button.dataset.station; const delta = Number(button.dataset.onlineChange);
      if (delta < 0) return addSingle(station, 'online', -1, L.chooseCarrierToDecrement(shift, station, 'online'));
      const base = L.defaultCarrierForStation(station); const carrier = state.ui.onlineOtherCarrier ? L.otherCarrier(base) : base;
      state.ui.onlineOtherCarrier = false; await addSingle(station, 'online', 1, carrier);
    }));
    main.querySelectorAll('[data-convert-online]').forEach((button) => button.addEventListener('click', async () => {
      try { const qty = L.convertOnlineToNight(shift, button.dataset.station, 'ALL'); await saveState(); vibrate(65); renderCurrentView(); showToast(`${button.dataset.station} 已轉完成${qty}`); }
      catch (error) { showToast(error.message); }
    }));
  }

  function renderInventory() {
    const shift = requireShift(); if (!shift) return;
    const counts = L.computeCounts(shift);
    const allStats = L.computeAllStats(shift, 'ALL');
    const group = state.ui.inventoryGroup;
    const groups = group === 'ALL' ? L.GROUP_ORDER : [group];
    main.innerHTML = `<section class="card"><strong>現場盤點</strong><p class="small-note">依字母系列排列；可只顯示指定系列。籠車、棧板分別輸入，右側即時顯示應有與總差異。</p>
      <select id="inventoryGroupFilter" class="full-width-select"><option value="ALL">全部站所</option>${L.GROUP_ORDER.map((prefix) => `<option value="${prefix}" ${group === prefix ? 'selected' : ''}>只看 ${prefix}</option>`).join('')}</select></section>
      ${groups.map((prefix) => `<section class="page-section"><h2 class="section-title">${prefix} 系列<small>${L.STATION_GROUPS[prefix].length}站</small></h2><div class="inventory-list">${L.STATION_GROUPS[prefix].map((station) => {
        const st = allStats[station]; const cls = st.difference === 0 ? 'difference-good' : 'difference-bad';
        return `<div class="inventory-card ${cls}" data-inventory-row="${station}"><div class="inventory-head"><strong>${station}</strong><span>應${st.expected}｜差${st.difference}</span></div>
          <div class="inventory-inputs">${L.CARRIERS.map((carrier) => `<label>${carrierLabel(carrier)}<input type="number" min="0" step="1" inputmode="numeric" value="${counts[station].actual[carrier]}" data-set-count data-station="${station}" data-category="actual" data-carrier="${carrier}"></label>`).join('')}</div></div>`;
      }).join('')}</div></section>`).join('')}`;
    el('inventoryGroupFilter').addEventListener('change', async (event) => { state.ui.inventoryGroup = event.target.value; await saveState(); renderInventory(); });
    bindCountInputs();
  }

  function bindCountSteppers() {
    main.querySelectorAll('[data-count-step]').forEach((button) => button.addEventListener('click', async () => {
      await addSingle(button.dataset.station, button.dataset.category, Number(button.dataset.countStep), button.dataset.carrier, '大型按鈕調整');
    }));
  }

  function bindCountInputs() {
    main.querySelectorAll('[data-set-count]').forEach((input) => input.addEventListener('change', async () => {
      const shift = currentShift();
      const event = L.setCount(shift, input.dataset.station, input.dataset.category, Math.max(0, Number(input.value || 0)), input.dataset.carrier);
      if (!event) return;
      await saveState(); updateHeader(); showToast(`${input.dataset.station} ${carrierShort(input.dataset.carrier)}已保存`);
      if (input.dataset.category === 'actual') {
        const station = input.dataset.station; const s = L.computeAllStats(shift, 'ALL')[station]; const row = main.querySelector(`[data-inventory-row="${station}"]`);
        if (row) { row.classList.toggle('difference-good', s.difference === 0); row.classList.toggle('difference-bad', s.difference !== 0); row.querySelector('.inventory-head span').textContent = `應${s.expected}｜差${s.difference}`; }
      }
    }));
  }

  function renderStats() {
    const shift = requireShift(); if (!shift) return;
    const carrier = state.ui.statsCarrier;
    const stats = L.computeAllStats(shift, carrier);
    const allStats = L.computeAllStats(shift, 'ALL');
    const cageStats = L.computeAllStats(shift, 'cage');
    const palletStats = L.computeAllStats(shift, 'pallet');
    const totals = L.computeTotals(shift, carrier);
    const group = state.ui.statsGroup; const anomaliesOnly = state.ui.statsAnomaliesOnly;
    const groups = group === 'ALL' ? L.GROUP_ORDER : [group];
    const groupSections = groups.map((prefix) => {
      const stations = L.STATION_GROUPS[prefix].filter((station) => !anomaliesOnly || stats[station].difference !== 0);
      if (!stations.length) return '';
      return `<section class="page-section"><h2 class="section-title">${prefix} 系列<small>${stations.length}站</small></h2>${stations.map((station) => statsCard(station, stats[station], allStats[station], cageStats[station], palletStats[station], carrier)).join('')}</section>`;
    }).join('');
    main.innerHTML = `
      ${carrierModeHtml(carrier, 'stats-carrier', true)}
      <div class="stats-totals"><div class="total-card"><span>03:00回報</span><strong>${totals.REPORT03.reportTotal}</strong></div><div class="total-card"><span>05:00回報</span><strong>${totals.REPORT05.reportTotal}</strong></div><div class="total-card"><span>全部回報</span><strong>${totals.ALL.reportTotal}</strong></div></div>
      <div class="series-total-strip">${L.GROUP_ORDER.map((prefix) => `<span>${prefix}<b>${totals[prefix].reportTotal}</b></span>`).join('')}</div>
      <div class="filter-row"><select id="statsGroupFilter"><option value="ALL">全部站所</option>${L.GROUP_ORDER.map((prefix) => `<option value="${prefix}" ${group === prefix ? 'selected' : ''}>只看${prefix}</option>`).join('')}</select><label class="toggle"><input id="anomalyToggle" type="checkbox" ${anomaliesOnly ? 'checked' : ''}>只顯示異常</label></div>
      <div>${groupSections || '<div class="empty-state">沒有符合條件的站所。</div>'}</div>`;
    main.querySelectorAll('[data-stats-carrier]').forEach((button) => button.addEventListener('click', async () => { state.ui.statsCarrier = button.dataset.statsCarrier; await saveState(); renderStats(); }));
    el('statsGroupFilter').value = group;
    el('statsGroupFilter').addEventListener('change', async (event) => { state.ui.statsGroup = event.target.value; await saveState(); renderStats(); });
    el('anomalyToggle').addEventListener('change', async (event) => { state.ui.statsAnomaliesOnly = event.target.checked; await saveState(); renderStats(); });
  }

  function statsCard(station, s, all, cage, pallet, carrier) {
    const bad = s.difference !== 0;
    const fields = [['中班', s.morning], ['夜班', s.night], ['過境', s.transit], ['線上', s.online], ['回報', s.reportTotal], ['載走', s.loaded], ['應有', s.expected], ['現場', s.actual], ['差異', s.difference]];
    return `<article class="card stats-card ${bad ? 'bad' : ''}"><div class="stats-card-head"><div><strong>${station}</strong>${carrier === 'ALL' ? `<small>回報：籠${cage.reportTotal}／板${pallet.reportTotal}</small>` : `<small>目前檢視：${carrierLabel(carrier)}｜合計${all.reportTotal}</small>`}</div><span class="status-pill">${bad ? '差異異常' : '正常'}</span></div><div class="stats-grid">${fields.map(([label, value]) => `<div class="stat-cell"><span>${label}</span><b>${value}</b></div>`).join('')}</div></article>`;
  }

  async function copyText(text, successMessage = '已複製') {
    try { await navigator.clipboard.writeText(text); }
    catch { const textarea = document.createElement('textarea'); textarea.value = text; document.body.appendChild(textarea); textarea.select(); document.execCommand('copy'); textarea.remove(); }
    showToast(successMessage);
  }

  function renderReports() {
    const shift = requireShift(); if (!shift) return;
    const stats = L.computeAllStats(shift, 'ALL'); const cage = L.computeAllStats(shift, 'cage'); const pallet = L.computeAllStats(shift, 'pallet');
    const totals = L.computeTotals(shift, 'ALL');
    main.innerHTML = `<section class="card"><strong>03:00 派車快速回報</strong><p class="small-note">CS／SS／KS；總數下方保留籠車／棧板細分。</p></section>
      <div class="report-summary"><div class="total-card"><span>03:00合計</span><strong>${totals.REPORT03.reportTotal}</strong></div><div class="total-card"><span>CS／SS／KS</span><strong>${L.REPORT_GROUPS.THREE_AM.length}站</strong></div></div>
      <button id="copyReportBtn" class="primary-btn full-width report-copy-btn">複製03:00回報文字</button>
      <div class="report-list">${L.REPORT_GROUPS.THREE_AM.map((station) => { const s = stats[station]; return `<div class="report-row"><strong>${station}</strong><span><small>中</small>${s.morning}</span><span><small>夜</small>${s.night}</span><span><small>過</small>${s.transit}</span><span class="report-total"><small>總</small>${s.reportTotal}<em>籠${cage[station].reportTotal}／板${pallet[station].reportTotal}</em></span></div>`; }).join('')}</div>`;
    el('copyReportBtn').addEventListener('click', () => copyText(L.makeReportText(shift, 'THREE_AM'), '03:00回報已複製'));
  }

  function renderReturns() {
    const shift = requireShift(); if (!shift) return;
    const carrier = state.ui.returnCarrier;
    const returns = L.computeReturnCounts(shift);
    const buckets = L.computeReturnBuckets(shift);
    const currentBucket = L.currentReturnBucket();
    const sources = [...L.RETURN_SOURCES, ...Object.keys(returns.bySource).filter((source) => !L.RETURN_SOURCES.includes(source))];
    main.innerHTML = `
      <section class="card"><strong>回倉紀錄</strong><p class="small-note">不需輸入時間；每次＋1會自動歸入目前30分鐘時段。−1會撤銷該來源、該載具最近一筆，並同步修正原時段。</p>
        <div class="current-bucket">目前時段：<b>${currentBucket.label}</b></div>${carrierModeHtml(carrier, 'return-carrier')}</section>
      <section class="card return-note-card"><label for="returnNoteInput"><strong>特殊狀況備註</strong></label><textarea id="returnNoteInput" maxlength="160" rows="3" placeholder="例如：司機延遲、貨況異常、來源混載……"></textarea><button id="saveReturnNoteBtn" class="secondary-btn full-width">儲存備註至目前時段</button></section>
      <div class="return-source-grid">${sources.map((source) => { const value = returns.bySource[source] || { cage: 0, pallet: 0, total: 0 }; return `<div class="return-source-card"><strong>${source}</strong><span>${value[carrier]}</span><small>籠${value.cage}｜板${value.pallet}</small><div><button class="return-minus" data-return-change="-1" data-return-source="${source}">−1</button><button class="return-plus" data-return-change="1" data-return-source="${source}">＋1</button></div></div>`; }).join('')}</div>
      <section class="card return-grand-total"><span>回倉合計</span><strong>${returns.carrierTotals.total}</strong><small>籠${returns.carrierTotals.cage}｜板${returns.carrierTotals.pallet}</small></section>
      <section class="page-section"><h2 class="section-title">30分鐘時段紀錄<small>自動分欄</small></h2><div class="return-bucket-scroll">${buckets.length ? buckets.map(returnBucketHtml).join('') : '<div class="empty-state">尚無回倉紀錄。</div>'}</div></section>`;
    main.querySelectorAll('[data-return-carrier]').forEach((button) => button.addEventListener('click', async () => { state.ui.returnCarrier = button.dataset.returnCarrier; await saveState(); renderReturns(); }));
    main.querySelectorAll('[data-return-change]').forEach((button) => button.addEventListener('click', async () => {
      try { const count = L.adjustReturnCount(shift, button.dataset.returnSource, carrier, Number(button.dataset.returnChange)); await saveState(); vibrate(); showToast(`${button.dataset.returnSource} ${carrierShort(carrier)}目前${count}`); renderReturns(); updateHeader(); }
      catch (error) { showToast(error.message); }
    }));
    el('saveReturnNoteBtn').addEventListener('click', async () => {
      try { const note = L.addReturnNote(shift, el('returnNoteInput').value); await saveState(); showToast(`備註已存入${L.halfHourBucket(note.timestamp).label}`); renderReturns(); }
      catch (error) { showToast(error.message); }
    });
    main.querySelectorAll('[data-delete-return-note]').forEach((button) => button.addEventListener('click', async () => {
      if (!window.confirm('確定刪除這則回倉備註？')) return;
      try { L.deleteReturnNote(shift, button.dataset.deleteReturnNote); await saveState(); showToast('回倉備註已刪除'); renderReturns(); }
      catch (error) { showToast(error.message); }
    }));
  }

  function returnBucketHtml(bucket) {
    const details = Object.entries(bucket.sources).filter(([, value]) => value.total > 0).map(([source, value]) => `<div><strong>${source}</strong><span>${value.total}</span><small>籠${value.cage}／板${value.pallet}</small></div>`).join('');
    const notes = (bucket.notes || []).map((note) => `<div class="return-note-item"><span><b>${formatTime(note.timestamp).slice(0, 5)}</b>${escapeHtml(note.text)}</span><button class="return-note-delete" data-delete-return-note="${note.id}" aria-label="刪除備註">刪除</button></div>`).join('');
    return `<article class="return-bucket"><h3>${bucket.label}</h3><p>合計${bucket.total}｜籠${bucket.cage}｜板${bucket.pallet}</p>${details}${notes ? `<section class="return-notes"><h4>備註</h4>${notes}</section>` : ''}</article>`;
  }

  function renderEvents() {
    const shift = requireShift(); if (!shift) return;
    const stationFilter = state.ui.eventStation; const categoryFilter = state.ui.eventCategory; const carrierFilter = state.ui.eventCarrier; const order = state.ui.eventOrder;
    const events = shift.events.filter((event) => stationFilter === 'ALL' || event.station === stationFilter).filter((event) => categoryFilter === 'ALL' || event.category === categoryFilter).filter((event) => carrierFilter === 'ALL' || event.carrier === carrierFilter).slice().sort((a, b) => order === 'asc' ? String(a.timestamp).localeCompare(String(b.timestamp)) : String(b.timestamp).localeCompare(String(a.timestamp)));
    main.innerHTML = `<div class="filter-row events-four"><select id="eventStationFilter"><option value="ALL">全部站所</option>${L.STATIONS.map((station) => `<option value="${station}" ${station === stationFilter ? 'selected' : ''}>${station}</option>`).join('')}</select><select id="eventCategoryFilter"><option value="ALL">全部類別</option>${L.CATEGORIES.map((category) => `<option value="${category}" ${category === categoryFilter ? 'selected' : ''}>${categoryLabel(category)}</option>`).join('')}</select><select id="eventCarrierFilter"><option value="ALL">全部載具</option>${L.CARRIERS.map((carrier) => `<option value="${carrier}" ${carrier === carrierFilter ? 'selected' : ''}>${carrierLabel(carrier)}</option>`).join('')}</select><select id="eventOrderFilter"><option value="desc" ${order === 'desc' ? 'selected' : ''}>新到舊</option><option value="asc" ${order === 'asc' ? 'selected' : ''}>舊到新</option></select></div><div>${events.length ? events.map(eventHtml).join('') : '<div class="empty-state">沒有符合條件的紀錄。</div>'}</div>`;
    ['eventStationFilter', 'eventCategoryFilter', 'eventCarrierFilter', 'eventOrderFilter'].forEach((id) => el(id).addEventListener('change', async () => { state.ui.eventStation = el('eventStationFilter').value; state.ui.eventCategory = el('eventCategoryFilter').value; state.ui.eventCarrier = el('eventCarrierFilter').value; state.ui.eventOrder = el('eventOrderFilter').value; await saveState(); renderEvents(); }));
    main.querySelectorAll('[data-edit-event]').forEach((button) => button.addEventListener('click', () => openEventEdit(button.dataset.editEvent)));
    main.querySelectorAll('[data-delete-event]').forEach((button) => button.addEventListener('click', () => removeEvent(button.dataset.deleteEvent)));
  }

  function eventHtml(event) { return `<article class="event-item"><div class="event-main"><strong>${event.station}｜${categoryLabel(event.category)}｜${carrierShort(event.carrier)}</strong><b>${event.delta > 0 ? '+' : ''}${event.delta} → ${event.after}</b></div><div class="event-meta">${formatTime(event.timestamp)}${event.note ? `｜${escapeHtml(event.note)}` : ''}</div><div class="event-actions"><button class="secondary-btn" data-edit-event="${event.id}">修改</button><button class="danger-btn" data-delete-event="${event.id}">刪除</button></div></article>`; }
  function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

  function openEventEdit(eventId) {
    const event = currentShift().events.find((item) => item.id === eventId); if (!event) return;
    el('editEventId').value = event.id;
    el('editEventStation').innerHTML = L.STATIONS.map((station) => `<option value="${station}" ${station === event.station ? 'selected' : ''}>${station}</option>`).join('');
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
      <section class="card"><h3>匯出與備份</h3><div class="action-grid"><button id="exportCsvBtn" class="secondary-btn">點貨CSV</button><button id="exportReturnCsvBtn" class="secondary-btn">回倉CSV</button><button id="copyLogBtn" class="secondary-btn">複製工作日誌</button><button id="exportJsonBtn" class="secondary-btn">完整JSON</button><label class="secondary-btn file-button">匯入JSON<input id="importJsonInput" type="file" accept="application/json"></label><button id="clearAllBtn" class="danger-btn">清除全部資料</button></div></section>
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
  function exportAllJSON() { const payload = { app: '物流夜班點貨', schemaVersion: 6, exportedAt: new Date().toISOString(), state }; downloadFile(`夜班點貨_完整備份_${L.localDate()}.json`, JSON.stringify(payload, null, 2), 'application/json'); showToast('JSON備份已匯出'); }

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
    updateHeader();
    switch (state.activeView) {
      case 'night': renderNight(); break; case 'online': renderOnline(); break; case 'inventory': renderInventory(); break; case 'stats': renderStats(); break;
      case 'morning': renderMorning(); break; case 'transit': renderTransit(); break; case 'loaded': renderLoaded(); break; case 'reports': renderReports(); break;
      case 'returns': renderReturns(); break; case 'events': renderEvents(); break; case 'shifts': renderShifts(); break; default: state.activeView = 'night'; renderNight();
    }
    if (state.activeView !== 'night') hideUndoBar();
    bindViewLinks();
  }

  function bindViewLinks() { document.querySelectorAll('[data-view]').forEach((button) => { if (button.dataset.bound) return; button.dataset.bound = '1'; button.addEventListener('click', () => switchView(button.dataset.view)); }); }

  async function switchView(view) {
    if (state.activeView === 'night' && view !== 'night') { nightUndoOperationId = null; undoDismissed = false; state.ui.nightCorrection = false; state.ui.nightOtherCarrier = false; hideUndoBar(); }
    if (state.activeView === 'online' && view !== 'online') state.ui.onlineOtherCarrier = false;
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
    const station = el('quantityStation').value; const category = el('quantityCategory').value; const carrier = el('quantityCarrier').value; quantityDialog.close(); await addSingle(station, category, qty, carrier);
  }

  function setupStaticListeners() {
    el('menuBtn').addEventListener('click', openDrawer); el('closeDrawerBtn').addEventListener('click', closeDrawer); backdrop.addEventListener('click', closeDrawer); el('wakeLockBtn').addEventListener('click', toggleWakeLock);
    el('undoBtn').addEventListener('click', async () => { const shift = currentShift(); if (!shift || !nightUndoOperationId) return showToast('沒有可復原紀錄'); const removed = L.undoOperation(shift, nightUndoOperationId); if (!removed.length) return showToast('紀錄已不存在'); nightUndoOperationId = null; undoDismissed = false; await saveState(); vibrate(70); showToast(`已復原：${removed[0].station}${carrierShort(removed[0].carrier)}`); renderCurrentView(); });
    el('undoCloseBtn').addEventListener('click', () => { undoDismissed = true; hideUndoBar(); });
    el('eventEditForm').addEventListener('submit', saveEventEdit); el('quantityForm').addEventListener('submit', saveCustomQuantity);
    document.querySelectorAll('[data-qty]').forEach((button) => button.addEventListener('click', async () => { const station = el('quantityStation').value; const category = el('quantityCategory').value; const carrier = el('quantityCarrier').value; quantityDialog.close(); await addSingle(station, category, Number(button.dataset.qty), carrier); }));
    bindViewLinks();
    window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; el('installBtn').classList.remove('hidden'); });
    el('installBtn').addEventListener('click', async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; el('installBtn').classList.add('hidden'); });
    window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; el('installBtn').classList.add('hidden'); showToast('App已安裝'); });
    document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && wakeLock && 'wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* no-op */ } } });
  }

  async function registerServiceWorker() { if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('./service-worker.js'); } catch (error) { console.warn('Service Worker註冊失敗', error); } } }

  async function init() {
    try { db = await openDatabase(); state = migrateAppState((await dbGet(STATE_KEY)) || defaultState()); await saveState(); await ensureInitialShift(); setupStaticListeners(); await registerServiceWorker(); renderCurrentView(); }
    catch (error) { console.error(error); main.innerHTML = `<section class="card"><h2>App啟動失敗</h2><p>${escapeHtml(error.message)}</p><p class="small-note">請使用Chrome並允許網站儲存資料。</p></section>`; }
  }

  init();
})();
