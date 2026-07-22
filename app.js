(() => {
  'use strict';

  const L = window.PalletLogic;
  const DB_NAME = 'night-pallet-counter';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';
  const STATE_KEY = 'app-state';

  const VIEW_TITLES = {
    night: '夜班產出',
    transit: '過境貨',
    loaded: '提前載走',
    inventory: '現場盤點',
    stats: '統計核對',
    morning: '早班數量',
    online: '線上未退出',
    events: '事件紀錄',
    reports: '03:00 快速回報',
    returns: '回倉紀錄',
    shifts: '班次／備份',
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
      version: 4,
      currentShiftId: null,
      shifts: [],
      activeView: 'night',
      ui: {
        statsGroup: 'ALL',
        statsAnomaliesOnly: false,
        eventStation: 'ALL',
        eventCategory: 'ALL',
        eventOrder: 'desc',
        nightCorrection: false,
      },
    };
  }

  function migrateAppState(rawState) {
    const base = defaultState();
    const migrated = rawState && typeof rawState === 'object' ? rawState : base;
    migrated.version = 4;
    migrated.shifts = Array.isArray(migrated.shifts) ? migrated.shifts : [];
    migrated.shifts.forEach((shift) => L.migrateShift(shift));
    migrated.ui = { ...base.ui, ...(migrated.ui || {}) };
    const validViews = new Set(Object.keys(VIEW_TITLES));
    if (!validViews.has(migrated.activeView)) migrated.activeView = 'night';
    if (!['ALL', ...L.GROUP_ORDER].includes(migrated.ui.statsGroup)) migrated.ui.statsGroup = 'ALL';
    migrated.ui.nightCorrection = false;
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
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
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

  async function saveState() {
    await dbSet(STATE_KEY, state);
  }

  function currentShift() {
    return state.shifts.find((shift) => shift.id === state.currentShiftId) || null;
  }

  function previousShift() {
    const shifts = state.shifts
      .slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const currentIndex = shifts.findIndex((s) => s.id === state.currentShiftId);
    return shifts[currentIndex + 1] || shifts.find((s) => s.id !== state.currentShiftId) || null;
  }

  async function ensureInitialShift() {
    if (state.shifts.length > 0 && state.currentShiftId) return;
    const date = L.localDate();
    const testMode = new URLSearchParams(window.location.search).has('test');
    const approved = testMode || window.confirm(`尚未建立班次。要建立 ${date} 的大夜班嗎？`);
    if (!approved) {
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
    el('shiftLabel').textContent = shift ? `${shift.date}｜00:00–08:00｜${shift.events.length} 筆事件｜回倉 ${L.computeReturnCounts(shift).total} 板` : '尚未建立班次';
    document.querySelectorAll('.nav-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === state.activeView);
    });
  }

  function showToast(message, duration = 1800) {
    const toast = el('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
  }

  function vibrate(ms = 45) {
    if ('vibrate' in navigator) navigator.vibrate(ms);
  }

  function categoryLabel(category) {
    return L.CATEGORY_LABELS[category] || category;
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('zh-TW', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function requireShift() {
    const shift = currentShift();
    if (shift) return shift;
    main.innerHTML = `
      <section class="card empty-state">
        <h2>尚未建立班次</h2>
        <p>請先到「班次／備份」建立今天的大夜班。</p>
        <button class="primary-btn action-btn" data-view="shifts">前往建立班次</button>
      </section>`;
    bindViewLinks();
    return null;
  }

  function flashStationButton(station) {
    const button = document.querySelector(`[data-station="${station}"]`);
    if (!button) return;
    button.classList.remove('flash');
    void button.offsetWidth;
    button.classList.add('flash');
  }

  function hideUndoBar() {
    el('undoBar').classList.add('hidden');
  }

  function updateUndoBar(message = '', operationId = null) {
    const shift = currentShift();
    const bar = el('undoBar');
    if (state.activeView !== 'night' || !shift || undoDismissed) {
      bar.classList.add('hidden');
      return;
    }
    if (operationId) nightUndoOperationId = operationId;
    if (!nightUndoOperationId) {
      bar.classList.add('hidden');
      return;
    }
    const related = shift.events.filter((event) => (event.operationId || event.id) === nightUndoOperationId);
    if (!related.length) {
      nightUndoOperationId = null;
      bar.classList.add('hidden');
      return;
    }
    const last = related.at(-1);
    el('undoMessage').textContent = message || `上一筆：${last.station} ${categoryLabel(last.category)} ${last.delta > 0 ? '+' : ''}${last.delta}`;
    bar.classList.remove('hidden');
  }

  async function addSingle(station, category, delta = 1, note = '') {
    const shift = currentShift();
    if (!shift) return;
    const current = L.computeCounts(shift)[station]?.[category] ?? 0;
    if (current + Number(delta) < 0) {
      showToast(`${station} ${categoryLabel(category)} 已是 0`);
      return null;
    }
    const event = L.addEvent(shift, { station, category, delta, note });
    const isNightAction = state.activeView === 'night' && category === 'night';
    if (isNightAction) {
      nightUndoOperationId = event.operationId || event.id;
      undoDismissed = false;
    }
    await saveState();
    vibrate();
    const scrollPosition = window.scrollY;
    renderCurrentView();
    window.scrollTo(0, scrollPosition);
    requestAnimationFrame(() => flashStationButton(station));
    if (isNightAction) updateUndoBar(`${station} 夜班 ${delta > 0 ? '+' : ''}${delta}`, nightUndoOperationId);
    showToast(`${station} ${categoryLabel(category)} ${delta > 0 ? '+' : ''}${delta}`);
    return event;
  }

  function stationButtonsHtml(category, counts) {
    return L.CHUTES.map((chute) => `
      <section class="page-section">
        <h2 class="section-title">${chute.name}<small>${chute.stations.length}站</small></h2>
        <div class="station-grid">
          ${chute.stations.map((station) => `
            <button class="station-btn" data-station="${station}" data-category="${category}">
              <span class="station-name">${station}</span>
              <span class="station-count">${counts[station][category]}</span>
            </button>`).join('')}
        </div>
      </section>`).join('');
  }

  function nightCorrectionHtml(counts) {
    return L.CHUTES.map((chute) => `
      <section class="page-section">
        <h2 class="section-title">${chute.name}<small>${chute.stations.length}站</small></h2>
        <div class="night-correction-grid">
          ${chute.stations.map((station) => `
            <div class="night-correction-card" data-station-card="${station}">
              <strong>${station}</strong>
              <span>${counts[station].night}</span>
              <div>
                <button type="button" class="night-correct-minus" data-night-correct="-1" data-station="${station}" aria-label="${station} 夜班減一">−1</button>
                <button type="button" class="night-correct-plus" data-night-correct="1" data-station="${station}" aria-label="${station} 夜班加一">＋1</button>
              </div>
            </div>`).join('')}
        </div>
      </section>`).join('');
  }

  function renderNight() {
    const shift = requireShift();
    if (!shift) return;
    const counts = L.computeCounts(shift);
    const correction = state.ui.nightCorrection;
    main.innerHTML = `
      <section class="card night-mode-card">
        <div>
          <strong>${correction ? '夜班板數修正模式' : '退出板完成蓋章後，按對應站所一次。'}</strong>
          <p class="small-note">${correction
            ? '直接對任何站所加一或減一，不必逐步復原後面的紀錄。'
            : '誤按可立即復原；較早的板數請使用「修正前面板數」。'}</p>
        </div>
        <button type="button" class="${correction ? 'primary-btn' : 'secondary-btn'} night-mode-toggle" data-toggle-night-correction>
          ${correction ? '返回快速＋1' : '修正前面板數'}
        </button>
      </section>
      ${correction ? nightCorrectionHtml(counts) : stationButtonsHtml('night', counts)}`;

    main.querySelector('[data-toggle-night-correction]').addEventListener('click', async () => {
      state.ui.nightCorrection = !state.ui.nightCorrection;
      await saveState();
      renderCurrentView();
    });

    if (correction) {
      main.querySelectorAll('[data-night-correct]').forEach((button) => {
        button.addEventListener('click', () => addSingle(
          button.dataset.station,
          'night',
          Number(button.dataset.nightCorrect),
          '夜班前面板數修正'
        ));
      });
    } else {
      main.querySelectorAll('[data-category="night"]').forEach((button) => {
        button.addEventListener('click', () => addSingle(button.dataset.station, 'night', 1));
      });
    }
    updateUndoBar();
  }

  function openQuantity(station, category) {
    const isTransit = category === 'transit';
    el('quantityStation').value = station;
    el('quantityCategory').value = category;
    el('quantityStationLabel').textContent = station;
    el('quantityTitle').textContent = isTransit ? '調整過境數量' : `新增${categoryLabel(category)}`;
    el('customQty').value = '';
    document.querySelectorAll('.transit-only').forEach((item) => item.classList.toggle('hidden', !isTransit));
    document.querySelectorAll('.loaded-only').forEach((item) => item.classList.toggle('hidden', isTransit));
    el('quantityQuickButtons').classList.toggle('two-buttons', isTransit);
    el('saveQuantityBtn').classList.toggle('hidden', isTransit);
    quantityDialog.showModal();
  }

  function renderQuantityPage(category) {
    const shift = requireShift();
    if (!shift) return;
    const counts = L.computeCounts(shift);
    const instructions = category === 'transit'
      ? '選站所後，用大型 −1／+1 按鈕調整過境板數。數量不會低於 0。'
      : '選站所，登記已提前載走的板數。';
    main.innerHTML = `
      <section class="card">
        <strong>${categoryLabel(category)}</strong>
        <p class="small-note">${instructions}</p>
      </section>
      ${stationButtonsHtml(category, counts)}`;
    main.querySelectorAll(`[data-category="${category}"]`).forEach((button) => {
      button.addEventListener('click', () => openQuantity(button.dataset.station, category));
    });
  }

  function renderMorning() {
    const shift = requireShift();
    if (!shift) return;
    const counts = L.computeCounts(shift);
    main.innerHTML = `
      <section class="card">
        <strong>00:00 早班盤點</strong>
        <p class="small-note">使用大型 −／＋ 按鈕調整；也可點中間數字直接輸入。</p>
      </section>
      <div class="input-list">
        ${L.STATIONS.map((station) => `
          <div class="count-stepper-row">
            <strong>${station}</strong>
            <button type="button" class="count-stepper-btn minus" data-count-step="-1" data-station="${station}" data-category="morning" aria-label="${station} 早班減一">−</button>
            <input class="count-stepper-input" type="number" min="0" step="1" inputmode="numeric" value="${counts[station].morning}" data-set-count data-station="${station}" data-category="morning" aria-label="${station} 早班數量">
            <button type="button" class="count-stepper-btn plus" data-count-step="1" data-station="${station}" data-category="morning" aria-label="${station} 早班加一">＋</button>
          </div>`).join('')}
      </div>`;
    bindCountInputs();
    bindCountSteppers();
  }

  function renderOnline() {
    const shift = requireShift();
    if (!shift) return;
    const counts = L.computeCounts(shift);
    main.innerHTML = `
      <section class="card">
        <strong>04:30 線上未退出</strong>
        <p class="small-note">線上板與夜班完成數分開；整批按鈕可用「復原上一筆」一次撤回。</p>
        <div class="bulk-online-actions">
          <button type="button" class="primary-btn" data-online-all-add>NS／TS 全部 25 站＋1</button>
          <button type="button" class="secondary-btn" data-convert-all-online>全部線上轉完成</button>
        </div>
      </section>
      <div class="input-list">
        ${L.STATIONS.map((station) => `
          <div class="online-row">
            <strong>${station}</strong>
            <button type="button" class="online-adjust minus" data-online-change="-1" data-station="${station}">−1</button>
            <span class="online-count">${counts[station].online}</span>
            <button type="button" class="online-adjust plus" data-online-change="1" data-station="${station}">+1</button>
            <button type="button" class="online-convert" data-convert-online data-station="${station}">轉完成</button>
          </div>`).join('')}
      </div>`;

    main.querySelector('[data-online-all-add]').addEventListener('click', async () => {
      const result = L.addOnlineToAllStations(shift, 1);
      await saveState();
      vibrate(80);
      renderCurrentView();
      showToast(`NS／TS 全部 ${result.stations} 站已加 1`);
    });

    main.querySelector('[data-convert-all-online]').addEventListener('click', async () => {
      try {
        const result = L.convertAllOnlineToNight(shift);
        await saveState();
        vibrate(90);
        renderCurrentView();
        showToast(`已將 ${result.quantity} 板全部轉完成`);
      } catch (error) {
        showToast(error.message);
      }
    });

    main.querySelectorAll('[data-online-change]').forEach((button) => {
      button.addEventListener('click', async () => {
        const station = button.dataset.station;
        const delta = Number(button.dataset.onlineChange);
        if (delta < 0 && counts[station].online <= 0) return showToast(`${station} 線上已是 0`);
        await addSingle(station, 'online', delta);
      });
    });
    main.querySelectorAll('[data-convert-online]').forEach((button) => {
      button.addEventListener('click', async () => {
        const station = button.dataset.station;
        try {
          L.convertOnlineToNight(shift, station, 1);
          await saveState();
          vibrate(65);
          renderCurrentView();
          showToast(`${station} 已轉夜班完成`);
        } catch (error) {
          showToast(error.message);
        }
      });
    });
  }

  function renderInventory() {
    const shift = requireShift();
    if (!shift) return;
    const stats = L.computeAllStats(shift);
    main.innerHTML = `
      <section class="card">
        <strong>現場盤點</strong>
        <p class="small-note">輸入現場實際板數，App 立即比較「應在現場」並顯示差異。</p>
      </section>
      <div class="input-list">
        ${L.STATIONS.map((station) => {
          const s = stats[station];
          const cls = s.difference === 0 ? 'difference-good' : 'difference-bad';
          return `
            <label class="input-row ${cls}">
              <strong>${station}</strong>
              <input type="number" min="0" step="1" inputmode="numeric" value="${s.actual}" data-set-count data-station="${station}" data-category="actual">
              <span class="hint">應${s.expected}<br>差${s.difference}</span>
            </label>`;
        }).join('')}
      </div>`;
    bindCountInputs();
  }

  function bindCountSteppers() {
    main.querySelectorAll('[data-count-step]').forEach((button) => {
      button.addEventListener('click', async () => {
        const station = button.dataset.station;
        const category = button.dataset.category;
        const delta = Number(button.dataset.countStep);
        const counts = L.computeCounts(currentShift());
        if (delta < 0 && counts[station][category] <= 0) {
          showToast(`${station} ${categoryLabel(category)} 已是 0`);
          return;
        }
        await addSingle(station, category, delta, '大型按鈕調整');
      });
    });
  }

  function bindCountInputs() {
    main.querySelectorAll('[data-set-count]').forEach((input) => {
      input.addEventListener('change', async () => {
        const shift = currentShift();
        const station = input.dataset.station;
        const category = input.dataset.category;
        const newValue = Math.max(0, Number(input.value || 0));
        const event = L.setCount(shift, station, category, newValue, '直接輸入數量');
        if (event) {
          await saveState();
          updateHeader();
          showToast(`${station} 已保存`);
          if (category === 'actual') {
            const current = L.computeAllStats(shift)[station];
            const row = input.closest('.input-row');
            row.classList.toggle('difference-good', current.difference === 0);
            row.classList.toggle('difference-bad', current.difference !== 0);
            const hint = row.querySelector('.hint');
            if (hint) hint.innerHTML = `應${current.expected}<br>差${current.difference}`;
          }
        }
      });
    });
  }

  function renderStats() {
    const shift = requireShift();
    if (!shift) return;
    const stats = L.computeAllStats(shift);
    const totals = L.computeTotals(shift);
    const group = state.ui.statsGroup;
    const anomaliesOnly = state.ui.statsAnomaliesOnly;
    const filtered = L.STATIONS.filter((station) => {
      const groupMatch = group === 'ALL' || station.startsWith(group);
      const anomalyMatch = !anomaliesOnly || stats[station].difference !== 0;
      return groupMatch && anomalyMatch;
    });

    main.innerHTML = `
      <div class="stats-totals">
        <div class="total-card"><span>03:00 回報</span><strong>${totals.REPORT03.reportTotal}</strong></div>
        <div class="total-card"><span>05:00 回報</span><strong>${totals.REPORT05.reportTotal}</strong></div>
        <div class="total-card"><span>全部回報</span><strong>${totals.ALL.reportTotal}</strong></div>
      </div>
      <div class="series-total-strip">
        ${L.GROUP_ORDER.map((prefix) => `<span>${prefix} <b>${totals[prefix].reportTotal}</b></span>`).join('')}
      </div>
      <div class="filter-row">
        <select id="statsGroupFilter" aria-label="站所系列">
          <option value="ALL" ${group === 'ALL' ? 'selected' : ''}>全部站所</option>
          ${L.GROUP_ORDER.map((prefix) => `<option value="${prefix}" ${group === prefix ? 'selected' : ''}>只看 ${prefix}</option>`).join('')}
        </select>
        <label class="toggle"><input id="anomalyToggle" type="checkbox" ${anomaliesOnly ? 'checked' : ''}>只顯示異常</label>
      </div>
      <div>
        ${filtered.length ? filtered.map((station) => statsCard(station, stats[station])).join('') : '<div class="empty-state">目前沒有符合條件的站所。</div>'}
      </div>`;

    el('statsGroupFilter').addEventListener('change', async (event) => {
      state.ui.statsGroup = event.target.value;
      await saveState();
      renderStats();
    });
    el('anomalyToggle').addEventListener('change', async (event) => {
      state.ui.statsAnomaliesOnly = event.target.checked;
      await saveState();
      renderStats();
    });
  }

  function statsCard(station, s) {
    const bad = s.difference !== 0;
    const fields = [
      ['早班', s.morning], ['夜班', s.night], ['過境', s.transit], ['線上', s.online], ['回報', s.reportTotal],
      ['載走', s.loaded], ['應有', s.expected], ['現場', s.actual], ['差異', s.difference],
    ];
    return `
      <article class="card stats-card ${bad ? 'bad' : ''}">
        <div class="stats-card-head"><strong>${station}</strong><span class="status-pill">${bad ? '差異異常' : '正常'}</span></div>
        <div class="stats-grid">
          ${fields.map(([label, value]) => `<div class="stat-cell"><span>${label}</span><b>${value}</b></div>`).join('')}
        </div>
      </article>`;
  }

  async function copyText(text, successMessage = '已複製') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    showToast(successMessage);
  }

  function reportRow(station, stats) {
    const s = stats[station];
    return `
      <div class="report-row">
        <strong>${station}</strong>
        <span><small>早</small>${s.morning}</span>
        <span><small>夜</small>${s.night}</span>
        <span><small>過</small>${s.transit}</span>
        <span class="report-total"><small>總</small>${s.reportTotal}</span>
      </div>`;
  }

  function renderReports() {
    const shift = requireShift();
    if (!shift) return;
    const stats = L.computeAllStats(shift);
    const totals = L.computeTotals(shift);
    const stations = L.REPORT_GROUPS.THREE_AM;
    const groups = ['CS', 'SS', 'KS'];
    const title = '03:00｜CS／SS／KS';

    main.innerHTML = `
      <section class="card">
        <strong>03:00 派車快速回報</strong>
        <p class="small-note">直接讀取早班、夜班、過境及總數。05:00 請直接使用統計總表。</p>
      </section>
      <div class="report-summary">
        <div class="total-card"><span>${title} 合計</span><strong>${totals.REPORT03.reportTotal}</strong></div>
        ${groups.map((group) => `<div class="total-card"><span>${group}</span><strong>${totals[group].reportTotal}</strong></div>`).join('')}
      </div>
      <button type="button" id="copyReportBtn" class="primary-btn full-width report-copy-btn">複製 03:00 回報文字</button>
      <div class="report-list">
        ${stations.map((station) => reportRow(station, stats)).join('')}
      </div>`;

    el('copyReportBtn').addEventListener('click', () => copyText(
      L.makeReportText(shift, 'THREE_AM'),
      '03:00 回報已複製'
    ));
  }

  function renderReturns() {
    const shift = requireShift();
    if (!shift) return;
    const returns = L.computeReturnCounts(shift);
    const sources = [
      ...L.RETURN_SOURCES,
      ...Object.keys(returns.bySource).filter((source) => !L.RETURN_SOURCES.includes(source) && returns.bySource[source] > 0),
    ];

    main.innerHTML = `
      <section class="card">
        <strong>回倉板數</strong>
        <p class="small-note">只記各回倉來源的板數，不記時間或過境總數。按＋1新增，按−1修正。</p>
        <div class="return-source-grid">
          ${sources.map((source) => `
            <div class="return-source-card">
              <strong>${source}</strong>
              <span>${returns.bySource[source] || 0}</span>
              <div>
                <button type="button" class="return-minus" data-return-change="-1" data-return-source="${source}" aria-label="${source} 回倉減一">−1</button>
                <button type="button" class="return-plus" data-return-change="1" data-return-source="${source}" aria-label="${source} 回倉加一">＋1</button>
              </div>
            </div>`).join('')}
        </div>
      </section>
      <section class="card return-grand-total">
        <span>回倉總板數</span>
        <strong>${returns.total}</strong>
      </section>`;

    main.querySelectorAll('[data-return-change]').forEach((button) => {
      button.addEventListener('click', async () => {
        const source = button.dataset.returnSource;
        const delta = Number(button.dataset.returnChange);
        try {
          const count = L.adjustReturnCount(shift, source, delta);
          await saveState();
          vibrate(45);
          showToast(`${source} 回倉 ${delta > 0 ? '+' : ''}${delta}，目前 ${count}`);
          renderReturns();
          updateHeader();
        } catch (error) {
          showToast(error.message);
        }
      });
    });
  }

  function renderEvents() {
    const shift = requireShift();
    if (!shift) return;
    const stationFilter = state.ui.eventStation;
    const categoryFilter = state.ui.eventCategory;
    const order = state.ui.eventOrder;
    const events = shift.events
      .filter((event) => stationFilter === 'ALL' || event.station === stationFilter)
      .filter((event) => categoryFilter === 'ALL' || event.category === categoryFilter)
      .slice()
      .sort((a, b) => order === 'asc'
        ? String(a.timestamp).localeCompare(String(b.timestamp))
        : String(b.timestamp).localeCompare(String(a.timestamp)));

    main.innerHTML = `
      <div class="filter-row three">
        <select id="eventStationFilter"><option value="ALL">全部站所</option>${L.STATIONS.map((s) => `<option value="${s}" ${s === stationFilter ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="eventCategoryFilter"><option value="ALL">全部類別</option>${L.CATEGORIES.map((c) => `<option value="${c}" ${c === categoryFilter ? 'selected' : ''}>${categoryLabel(c)}</option>`).join('')}</select>
        <select id="eventOrderFilter"><option value="desc" ${order === 'desc' ? 'selected' : ''}>新到舊</option><option value="asc" ${order === 'asc' ? 'selected' : ''}>舊到新</option></select>
      </div>
      <div>${events.length ? events.map(eventHtml).join('') : '<div class="empty-state">沒有符合條件的紀錄。</div>'}</div>`;

    ['eventStationFilter', 'eventCategoryFilter', 'eventOrderFilter'].forEach((id) => {
      el(id).addEventListener('change', async () => {
        state.ui.eventStation = el('eventStationFilter').value;
        state.ui.eventCategory = el('eventCategoryFilter').value;
        state.ui.eventOrder = el('eventOrderFilter').value;
        await saveState();
        renderEvents();
      });
    });
    main.querySelectorAll('[data-edit-event]').forEach((button) => button.addEventListener('click', () => openEventEdit(button.dataset.editEvent)));
    main.querySelectorAll('[data-delete-event]').forEach((button) => button.addEventListener('click', () => removeEvent(button.dataset.deleteEvent)));
  }

  function eventHtml(event) {
    return `
      <article class="event-item">
        <div class="event-main">
          <strong>${event.station}｜${categoryLabel(event.category)}</strong>
          <b>${event.delta > 0 ? '+' : ''}${event.delta} → ${event.after}</b>
        </div>
        <div class="event-meta">${formatTime(event.timestamp)}${event.note ? `｜${escapeHtml(event.note)}` : ''}</div>
        <div class="event-actions">
          <button class="secondary-btn" data-edit-event="${event.id}">修改</button>
          <button class="danger-btn" data-delete-event="${event.id}">刪除</button>
        </div>
      </article>`;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function openEventEdit(eventId) {
    const shift = currentShift();
    const event = shift.events.find((item) => item.id === eventId);
    if (!event) return;
    el('editEventId').value = event.id;
    el('editEventStation').innerHTML = L.STATIONS.map((station) => `<option value="${station}" ${station === event.station ? 'selected' : ''}>${station}</option>`).join('');
    el('editEventCategory').innerHTML = L.CATEGORIES.map((category) => `<option value="${category}" ${category === event.category ? 'selected' : ''}>${categoryLabel(category)}</option>`).join('');
    el('editEventDelta').value = event.delta;
    el('editEventNote').value = event.note || '';
    eventDialog.showModal();
  }

  async function removeEvent(eventId) {
    if (!window.confirm('確定刪除這筆事件？數量會同步重算。')) return;
    const shift = currentShift();
    L.deleteEvent(shift, eventId);
    await saveState();
    showToast('事件已刪除');
    renderCurrentView();
  }

  function getPreviousMorningCounts() {
    const previous = previousShift();
    if (!previous) return null;
    const counts = L.computeCounts(previous);
    const result = {};
    L.STATIONS.forEach((station) => result[station] = counts[station].morning);
    return result;
  }

  function renderShifts() {
    const shift = currentShift();
    const sorted = state.shifts.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    main.innerHTML = `
      <section class="card">
        <h3>建立新班次</h3>
        <label class="small-note">班次日期</label>
        <input id="newShiftDate" class="date-input" type="date" value="${L.localDate()}">
        <label class="toggle"><input id="copyMorningCheck" type="checkbox">複製上一班早班數量</label>
        <button id="createShiftBtn" class="primary-btn action-btn" style="width:100%;margin-top:10px">建立並切換班次</button>
      </section>

      <section class="card">
        <h3>匯出與備份</h3>
        <div class="action-grid">
          <button id="exportCsvBtn" class="action-btn">匯出點貨 CSV</button>
          <button id="exportReturnCsvBtn" class="action-btn">匯出回倉 CSV</button>
          <button id="copyLogBtn" class="action-btn">複製工作日誌</button>
          <button id="exportJsonBtn" class="action-btn">匯出完整 JSON</button>
          <button id="importJsonBtn" class="action-btn">匯入 JSON</button>
        </div>
        <input id="importJsonFile" class="hidden" type="file" accept="application/json,.json">
        <p class="small-note">資料存在本機瀏覽器。清除 Chrome 網站資料前，請先匯出 JSON 備份。</p>
      </section>

      <section class="card">
        <h3>歷史班次</h3>
        ${sorted.length ? sorted.map((item) => `
          <div class="shift-item ${item.id === state.currentShiftId ? 'active' : ''}">
            <div><strong>${item.date}</strong><div class="small-note">${item.events.length} 筆事件</div></div>
            <button class="secondary-btn" data-switch-shift="${item.id}" ${item.id === state.currentShiftId ? 'disabled' : ''}>${item.id === state.currentShiftId ? '使用中' : '切換'}</button>
          </div>`).join('') : '<div class="empty-state">尚無班次。</div>'}
      </section>

      <section class="card">
        <h3>危險操作</h3>
        <button id="clearAllBtn" class="danger-btn action-btn" style="width:100%">清除全部資料</button>
      </section>`;

    el('createShiftBtn').addEventListener('click', createNewShift);
    el('exportCsvBtn').addEventListener('click', exportCurrentCSV);
    el('exportReturnCsvBtn').addEventListener('click', exportReturnCSV);
    el('copyLogBtn').addEventListener('click', copyWorkLog);
    el('exportJsonBtn').addEventListener('click', exportAllJSON);
    el('importJsonBtn').addEventListener('click', () => el('importJsonFile').click());
    el('importJsonFile').addEventListener('change', importJSON);
    el('clearAllBtn').addEventListener('click', clearAllData);
    main.querySelectorAll('[data-switch-shift]').forEach((button) => button.addEventListener('click', async () => {
      state.currentShiftId = button.dataset.switchShift;
      await saveState();
      showToast('已切換班次');
      renderCurrentView();
    }));
  }

  async function createNewShift() {
    const date = el('newShiftDate').value;
    if (!date) return showToast('請選擇日期');
    const existing = state.shifts.find((shift) => shift.id === `${date}-night`);
    if (existing) {
      if (!window.confirm(`${date} 班次已存在，要直接切換嗎？`)) return;
      state.currentShiftId = existing.id;
      await saveState();
      return renderCurrentView();
    }
    if (!window.confirm(`確定建立 ${date} 的大夜班並切換？`)) return;
    const previousMorning = el('copyMorningCheck').checked ? getPreviousMorningCounts() : null;
    const shift = L.createShift(date, previousMorning);
    state.shifts.push(shift);
    state.currentShiftId = shift.id;
    await saveState();
    showToast('新班次已建立');
    renderCurrentView();
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function exportCurrentCSV() {
    const shift = currentShift();
    if (!shift) return showToast('尚無班次');
    downloadFile(`點貨事件_${shift.date}.csv`, L.makeShiftCSV(shift), 'text/csv;charset=utf-8');
    showToast('CSV 已匯出');
  }

  function exportReturnCSV() {
    const shift = currentShift();
    if (!shift) return showToast('尚無班次');
    downloadFile(`回倉紀錄_${shift.date}.csv`, L.makeReturnBatchCSV(shift), 'text/csv;charset=utf-8');
    showToast('回倉 CSV 已匯出');
  }

  function exportAllJSON() {
    const payload = {
      app: '夜班點貨',
      schemaVersion: 4,
      exportedAt: new Date().toISOString(),
      state,
    };
    downloadFile(`夜班點貨_完整備份_${L.localDate()}.json`, JSON.stringify(payload, null, 2), 'application/json');
    showToast('JSON 備份已匯出');
  }

  async function importJSON(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = parsed.state || parsed;
      const migrated = validateImportedState(imported);
      if (!window.confirm('匯入會取代目前全部資料，確定繼續？')) return;
      state = migrated;
      await saveState();
      showToast('資料已還原');
      renderCurrentView();
    } catch (error) {
      showToast(`匯入失敗：${error.message}`, 3500);
    } finally {
      event.target.value = '';
    }
  }

  function validateImportedState(imported) {
    if (!imported || !Array.isArray(imported.shifts)) throw new Error('備份格式不正確');
    imported.shifts.forEach((shift) => {
      if (!shift.id || !shift.date || !Array.isArray(shift.events)) throw new Error('班次資料不完整');
      shift.events.forEach((evt) => {
        if (!L.STATIONS.includes(evt.station) || !L.CATEGORIES.includes(evt.category)) throw new Error('含有不支援的站所或類別');
      });
      L.migrateShift(shift);
    });
    return migrateAppState(imported);
  }

  async function copyWorkLog() {
    const shift = currentShift();
    if (!shift) return showToast('尚無班次');
    await copyText(L.makeWorkLogText(shift), '工作日誌已複製');
  }

  async function clearAllData() {
    if (!window.confirm('第一次確認：確定要清除全部班次及紀錄？')) return;
    const typed = window.prompt('第二次確認：請輸入「全部清除」');
    if (typed !== '全部清除') return showToast('未清除資料');
    state = defaultState();
    await saveState();
    showToast('全部資料已清除');
    await ensureInitialShift();
    renderCurrentView();
  }

  function renderCurrentView() {
    updateHeader();
    switch (state.activeView) {
      case 'night': renderNight(); break;
      case 'transit': renderQuantityPage('transit'); break;
      case 'loaded': renderQuantityPage('loaded'); break;
      case 'inventory': renderInventory(); break;
      case 'stats': renderStats(); break;
      case 'morning': renderMorning(); break;
      case 'online': renderOnline(); break;
      case 'reports': renderReports(); break;
      case 'returns': renderReturns(); break;
      case 'events': renderEvents(); break;
      case 'shifts': renderShifts(); break;
      default: state.activeView = 'night'; renderNight();
    }
    if (state.activeView !== 'night') hideUndoBar();
    bindViewLinks();
  }

  function bindViewLinks() {
    document.querySelectorAll('[data-view]').forEach((button) => {
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', () => switchView(button.dataset.view));
    });
  }

  async function switchView(view) {
    if (state.activeView === 'night' && view !== 'night') {
      nightUndoOperationId = null;
      undoDismissed = false;
      state.ui.nightCorrection = false;
      hideUndoBar();
    }
    state.activeView = view;
    await saveState();
    closeDrawer();
    renderCurrentView();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function openDrawer() {
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.classList.remove('hidden');
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.classList.add('hidden');
  }

  async function toggleWakeLock() {
    if (!('wakeLock' in navigator)) return showToast('此瀏覽器不支援螢幕喚醒鎖定');
    try {
      if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      } else {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', updateWakeLockButton);
      }
      updateWakeLockButton();
    } catch (error) {
      showToast(`無法切換螢幕喚醒：${error.message}`);
    }
  }

  function updateWakeLockButton() {
    el('wakeLockBtn').textContent = `保持螢幕喚醒：${wakeLock ? '開' : '關'}`;
  }

  async function saveEventEdit(event) {
    event.preventDefault();
    try {
      const shift = currentShift();
      L.editEvent(shift, el('editEventId').value, {
        station: el('editEventStation').value,
        category: el('editEventCategory').value,
        delta: Number(el('editEventDelta').value),
        note: el('editEventNote').value,
      });
      await saveState();
      eventDialog.close();
      showToast('事件已修改');
      renderCurrentView();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function saveCustomQuantity(event) {
    event.preventDefault();
    if (el('quantityCategory').value === 'transit') return;
    const qty = Number(el('customQty').value);
    if (!Number.isFinite(qty) || qty <= 0) return showToast('請輸入大於 0 的數量');
    const station = el('quantityStation').value;
    const category = el('quantityCategory').value;
    quantityDialog.close();
    await addSingle(station, category, qty);
  }

  function setupStaticListeners() {
    el('menuBtn').addEventListener('click', openDrawer);
    el('closeDrawerBtn').addEventListener('click', closeDrawer);
    backdrop.addEventListener('click', closeDrawer);
    el('wakeLockBtn').addEventListener('click', toggleWakeLock);
    el('undoBtn').addEventListener('click', async () => {
      const shift = currentShift();
      if (!shift || !nightUndoOperationId) return showToast('沒有可復原的夜班紀錄');
      const removed = L.undoOperation(shift, nightUndoOperationId);
      if (!removed.length) return showToast('這筆紀錄已不存在');
      nightUndoOperationId = null;
      undoDismissed = false;
      await saveState();
      vibrate(70);
      const first = removed[0];
      showToast(`已復原：${first.station} 夜班`);
      renderCurrentView();
    });
    el('undoCloseBtn').addEventListener('click', () => {
      undoDismissed = true;
      hideUndoBar();
    });
    el('eventEditForm').addEventListener('submit', saveEventEdit);
    el('quantityForm').addEventListener('submit', saveCustomQuantity);
    document.querySelectorAll('[data-qty]').forEach((button) => {
      button.addEventListener('click', async () => {
        const qty = Number(button.dataset.qty);
        const station = el('quantityStation').value;
        const category = el('quantityCategory').value;
        quantityDialog.close();
        await addSingle(station, category, qty);
      });
    });
    bindViewLinks();

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      el('installBtn').classList.remove('hidden');
    });
    el('installBtn').addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      el('installBtn').classList.add('hidden');
    });
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      el('installBtn').classList.add('hidden');
      showToast('App 已安裝到主畫面');
    });
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && wakeLock && 'wakeLock' in navigator) {
        try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* no-op */ }
      }
    });
  }

  async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('./service-worker.js');
      } catch (error) {
        console.warn('Service Worker 註冊失敗', error);
      }
    }
  }

  async function init() {
    try {
      db = await openDatabase();
      state = migrateAppState((await dbGet(STATE_KEY)) || defaultState());
      await saveState();
      await ensureInitialShift();
      setupStaticListeners();
      await registerServiceWorker();
      renderCurrentView();
    } catch (error) {
      console.error(error);
      main.innerHTML = `<section class="card"><h2>App 啟動失敗</h2><p>${escapeHtml(error.message)}</p><p class="small-note">請確認使用 Chrome 並允許網站儲存資料。</p></section>`;
    }
  }

  init();
})();
