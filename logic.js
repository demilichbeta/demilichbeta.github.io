(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PalletLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHUTES = [
    { id: 1, name: '第一滑道', stations: ['NS2', 'NS3', 'NS5', 'NS6', 'NS8', 'NS9'] },
    { id: 2, name: '第二滑道', stations: ['NS10', 'NS11', 'NS12', 'NS13'] },
    { id: 3, name: '第三滑道', stations: ['NS15', 'NS16', 'NS17', 'NS18', 'NS19'] },
    { id: 4, name: '第四滑道', stations: ['NS20', 'NS21', 'NS22', 'NS23'] },
    { id: 5, name: '第五滑道', stations: ['TS1', 'TS2', 'TS3', 'TS5', 'TS6', 'TS11'] },
  ];

  const STATIONS = CHUTES.flatMap((c) => c.stations);
  const CATEGORIES = ['morning', 'night', 'transit', 'loaded', 'online', 'actual'];
  const CATEGORY_LABELS = {
    morning: '早班',
    night: '夜班',
    transit: '過境',
    loaded: '載走',
    online: '線上',
    actual: '現場',
  };

  function uid(prefix = 'id') {
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  function nowIso(date = new Date()) {
    return date.toISOString();
  }

  function localDate(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function createShift(date, previousMorning = null) {
    const shift = {
      id: `${date}-night`,
      date,
      createdAt: nowIso(),
      status: 'active',
      events: [],
    };
    if (previousMorning) {
      const opId = uid('copy');
      STATIONS.forEach((station) => {
        const value = Number(previousMorning[station] || 0);
        if (value > 0) {
          shift.events.push({
            id: uid('evt'),
            operationId: opId,
            timestamp: nowIso(),
            station,
            category: 'morning',
            delta: value,
            after: value,
            note: '複製上一班早班數量',
          });
        }
      });
    }
    return shift;
  }

  function emptyCounts() {
    const result = {};
    STATIONS.forEach((station) => {
      result[station] = {
        morning: 0,
        night: 0,
        transit: 0,
        loaded: 0,
        online: 0,
        actual: 0,
      };
    });
    return result;
  }

  function computeCounts(shift) {
    const counts = emptyCounts();
    const events = Array.isArray(shift?.events) ? shift.events : [];
    events
      .slice()
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      .forEach((event) => {
        if (!counts[event.station] || !CATEGORIES.includes(event.category)) return;
        counts[event.station][event.category] += Number(event.delta || 0);
      });
    STATIONS.forEach((station) => {
      CATEGORIES.forEach((category) => {
        if (!Number.isFinite(counts[station][category])) counts[station][category] = 0;
      });
    });
    return counts;
  }

  function recomputeEventAfters(shift) {
    const running = emptyCounts();
    shift.events
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      .forEach((event) => {
        if (!running[event.station] || !CATEGORIES.includes(event.category)) return;
        running[event.station][event.category] += Number(event.delta || 0);
        event.after = running[event.station][event.category];
      });
    return shift;
  }

  function stationStats(count) {
    const reportTotal = count.morning + count.night + count.transit + count.online;
    const expected = reportTotal - count.loaded;
    const difference = count.actual - expected;
    return { ...count, reportTotal, expected, difference };
  }

  function computeAllStats(shift) {
    const counts = computeCounts(shift);
    const stats = {};
    STATIONS.forEach((station) => {
      stats[station] = stationStats(counts[station]);
    });
    return stats;
  }

  function computeTotals(shift) {
    const stats = computeAllStats(shift);
    const groups = {
      NS: { reportTotal: 0, expected: 0, actual: 0, difference: 0 },
      TS: { reportTotal: 0, expected: 0, actual: 0, difference: 0 },
      ALL: { reportTotal: 0, expected: 0, actual: 0, difference: 0 },
    };
    STATIONS.forEach((station) => {
      const group = station.startsWith('TS') ? 'TS' : 'NS';
      ['reportTotal', 'expected', 'actual', 'difference'].forEach((field) => {
        groups[group][field] += stats[station][field];
        groups.ALL[field] += stats[station][field];
      });
    });
    return groups;
  }

  function addEvent(shift, { station, category, delta, note = '', timestamp = nowIso(), operationId = uid('op') }) {
    if (!STATIONS.includes(station)) throw new Error(`未知站所：${station}`);
    if (!CATEGORIES.includes(category)) throw new Error(`未知類別：${category}`);
    const number = Number(delta);
    if (!Number.isFinite(number) || number === 0) throw new Error('數量必須是非零數字');
    const current = computeCounts(shift)[station][category];
    if (current + number < 0) throw new Error(`${CATEGORY_LABELS[category] || category}數量不能低於 0`);
    const event = {
      id: uid('evt'),
      operationId,
      timestamp,
      station,
      category,
      delta: number,
      after: current + number,
      note,
    };
    shift.events.push(event);
    recomputeEventAfters(shift);
    return event;
  }

  function setCount(shift, station, category, newValue, note = '') {
    const value = Math.max(0, Number(newValue || 0));
    const current = computeCounts(shift)[station][category];
    const delta = value - current;
    if (delta === 0) return null;
    return addEvent(shift, { station, category, delta, note });
  }

  function convertOnlineToNight(shift, station, amount = 1) {
    const counts = computeCounts(shift);
    const qty = Math.min(Math.max(1, Number(amount || 1)), counts[station].online);
    if (qty <= 0) throw new Error('此站所沒有可轉完成的線上板');
    const operationId = uid('convert');
    const timestamp = nowIso();
    addEvent(shift, { station, category: 'online', delta: -qty, note: '線上轉夜班完成', timestamp, operationId });
    addEvent(shift, { station, category: 'night', delta: qty, note: '線上轉夜班完成', timestamp, operationId });
    return qty;
  }

  function addOnlineToAllStations(shift, amount = 1) {
    const qty = Math.max(1, Number(amount || 1));
    const counts = computeCounts(shift);
    const operationId = uid('online-all');
    const timestamp = nowIso();
    STATIONS.forEach((station) => {
      shift.events.push({
        id: uid('evt'),
        operationId,
        timestamp,
        station,
        category: 'online',
        delta: qty,
        after: counts[station].online + qty,
        note: '全部站所線上加一',
      });
    });
    recomputeEventAfters(shift);
    return { stations: STATIONS.length, quantity: STATIONS.length * qty };
  }

  function convertAllOnlineToNight(shift) {
    const counts = computeCounts(shift);
    const targets = STATIONS
      .map((station) => ({ station, qty: counts[station].online }))
      .filter((item) => item.qty > 0);
    if (!targets.length) throw new Error('目前沒有可轉完成的線上板');

    const operationId = uid('convert-all');
    const timestamp = nowIso();
    let total = 0;
    targets.forEach(({ station, qty }) => {
      shift.events.push({
        id: uid('evt'),
        operationId,
        timestamp,
        station,
        category: 'online',
        delta: -qty,
        after: 0,
        note: '全部線上轉夜班完成',
      });
      shift.events.push({
        id: uid('evt'),
        operationId,
        timestamp,
        station,
        category: 'night',
        delta: qty,
        after: counts[station].night + qty,
        note: '全部線上轉夜班完成',
      });
      total += qty;
    });
    recomputeEventAfters(shift);
    return { stations: targets.length, quantity: total };
  }

  function undoLastOperation(shift) {
    if (!shift.events.length) return [];
    const last = shift.events
      .slice()
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      .at(-1);
    const operationId = last.operationId || last.id;
    const removed = shift.events.filter((event) => (event.operationId || event.id) === operationId);
    shift.events = shift.events.filter((event) => (event.operationId || event.id) !== operationId);
    recomputeEventAfters(shift);
    return removed;
  }

  function editEvent(shift, eventId, patch) {
    const event = shift.events.find((item) => item.id === eventId);
    if (!event) throw new Error('找不到事件');
    if (patch.station && !STATIONS.includes(patch.station)) throw new Error('站所無效');
    if (patch.category && !CATEGORIES.includes(patch.category)) throw new Error('類別無效');
    if (patch.delta !== undefined) {
      const value = Number(patch.delta);
      if (!Number.isFinite(value) || value === 0) throw new Error('數量必須是非零數字');
      event.delta = value;
    }
    if (patch.station) event.station = patch.station;
    if (patch.category) event.category = patch.category;
    if (patch.note !== undefined) event.note = String(patch.note || '');
    recomputeEventAfters(shift);
    return event;
  }

  function deleteEvent(shift, eventId) {
    const before = shift.events.length;
    shift.events = shift.events.filter((item) => item.id !== eventId);
    recomputeEventAfters(shift);
    return before !== shift.events.length;
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function makeShiftCSV(shift) {
    const rows = [['日期', '時間', '站所', '類別', '變動', '操作後累計', '備註']];
    shift.events
      .slice()
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      .forEach((event) => {
        const date = new Date(event.timestamp);
        rows.push([
          date.toLocaleDateString('zh-TW'),
          date.toLocaleTimeString('zh-TW', { hour12: false }),
          event.station,
          CATEGORY_LABELS[event.category] || event.category,
          event.delta,
          event.after,
          event.note || '',
        ]);
      });
    return '\ufeff' + rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  }

  function makeWorkLogText(shift) {
    const stats = computeAllStats(shift);
    const totals = computeTotals(shift);
    const lines = [
      `日期：${shift.date}`,
      '',
      `NS 回報總數：${totals.NS.reportTotal}`,
      `TS 回報總數：${totals.TS.reportTotal}`,
      `全部回報總數：${totals.ALL.reportTotal}`,
      '',
      '站所統計：',
    ];
    STATIONS.forEach((station) => {
      const s = stats[station];
      lines.push(
        `${station}｜早${s.morning}｜夜${s.night}｜過${s.transit}｜線${s.online}｜回報${s.reportTotal}｜載${s.loaded}｜應有${s.expected}｜現${s.actual}｜差${s.difference}`
      );
    });
    return lines.join('\n');
  }

  return {
    CHUTES,
    STATIONS,
    CATEGORIES,
    CATEGORY_LABELS,
    uid,
    nowIso,
    localDate,
    createShift,
    emptyCounts,
    computeCounts,
    recomputeEventAfters,
    stationStats,
    computeAllStats,
    computeTotals,
    addEvent,
    setCount,
    convertOnlineToNight,
    addOnlineToAllStations,
    convertAllOnlineToNight,
    undoLastOperation,
    editEvent,
    deleteEvent,
    csvEscape,
    makeShiftCSV,
    makeWorkLogText,
  };
});
