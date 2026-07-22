(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PalletLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHUTES = [
    { id: 7, name: '第七滑道', stations: ['NS2', 'NS3', 'NS5', 'NS6', 'NS8', 'NS9'] },
    { id: 8, name: '第八滑道', stations: ['CS2', 'CS12', 'NS10', 'NS11', 'NS12', 'NS13'] },
    { id: 9, name: '第九滑道', stations: ['CS4', 'CS5', 'NS15', 'NS16', 'NS17', 'NS18', 'NS19'] },
    { id: 10, name: '第十滑道', stations: ['CS3', 'CS6', 'NS20', 'NS21', 'NS22', 'NS23'] },
    { id: 11, name: '第十一滑道', stations: ['TS1', 'TS2', 'TS3', 'TS5', 'TS6', 'TS11'] },
    { id: 12, name: '第十二滑道', stations: ['SS3', 'SS4', 'SS5', 'SS6', 'SS7', 'KS1', 'KS2', 'KS3'] },
  ];

  const STATIONS = CHUTES.flatMap((chute) => chute.stations);
  const GROUP_ORDER = ['CS', 'SS', 'KS', 'NS', 'TS'];
  const STATION_GROUPS = Object.fromEntries(
    GROUP_ORDER.map((group) => [group, STATIONS.filter((station) => station.startsWith(group))])
  );
  const REPORT_GROUPS = {
    THREE_AM: [...STATION_GROUPS.CS, ...STATION_GROUPS.SS, ...STATION_GROUPS.KS],
    FIVE_AM: [...STATION_GROUPS.NS, ...STATION_GROUPS.TS],
  };
  const RETURN_SOURCES = ['DC9', 'DC4', 'DC11', 'CS12', 'SDC', 'DC2', 'NS2', 'NS1', 'DC12'];

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
      returnBatches: [],
      returnCounts: Object.fromEntries(RETURN_SOURCES.map((source) => [source, 0])),
    };
    if (previousMorning) {
      const operationId = uid('copy');
      STATIONS.forEach((station) => {
        const value = Number(previousMorning[station] || 0);
        if (value > 0) {
          shift.events.push({
            id: uid('evt'),
            operationId,
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

  function migrateShift(shift) {
    if (!shift || typeof shift !== 'object') throw new Error('班次資料無效');
    if (!Array.isArray(shift.events)) shift.events = [];
    if (!Array.isArray(shift.returnBatches)) shift.returnBatches = [];
    if (!shift.returnCounts || typeof shift.returnCounts !== 'object' || Array.isArray(shift.returnCounts)) {
      shift.returnCounts = {};
      shift.returnBatches.forEach((batch) => {
        const source = String(batch.source || '').trim().toUpperCase();
        if (!source) return;
        const total = Math.max(0, Number(batch.mixed || 0)) + Math.max(0, Number(batch.transit || 0));
        shift.returnCounts[source] = (shift.returnCounts[source] || 0) + total;
      });
    }
    RETURN_SOURCES.forEach((source) => {
      const value = Number(shift.returnCounts[source] || 0);
      shift.returnCounts[source] = Number.isFinite(value) && value > 0 ? value : 0;
    });
    recomputeEventAfters(shift);
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

  function blankTotal() {
    return {
      morning: 0,
      night: 0,
      transit: 0,
      online: 0,
      loaded: 0,
      reportTotal: 0,
      expected: 0,
      actual: 0,
      difference: 0,
    };
  }

  function computeTotals(shift) {
    const stats = computeAllStats(shift);
    const groups = { ALL: blankTotal(), REPORT03: blankTotal(), REPORT05: blankTotal() };
    GROUP_ORDER.forEach((group) => { groups[group] = blankTotal(); });

    STATIONS.forEach((station) => {
      const group = GROUP_ORDER.find((prefix) => station.startsWith(prefix));
      const reportKey = REPORT_GROUPS.THREE_AM.includes(station) ? 'REPORT03' : 'REPORT05';
      const fields = Object.keys(blankTotal());
      fields.forEach((field) => {
        groups[group][field] += stats[station][field];
        groups[reportKey][field] += stats[station][field];
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

  function addOnlineToStations(shift, stations = REPORT_GROUPS.FIVE_AM, amount = 1) {
    const targetStations = stations.filter((station) => STATIONS.includes(station));
    const qty = Math.max(1, Number(amount || 1));
    const counts = computeCounts(shift);
    const operationId = uid('online-bulk');
    const timestamp = nowIso();
    targetStations.forEach((station) => {
      shift.events.push({
        id: uid('evt'),
        operationId,
        timestamp,
        station,
        category: 'online',
        delta: qty,
        after: counts[station].online + qty,
        note: 'NS／TS 全部站所線上加一',
      });
    });
    recomputeEventAfters(shift);
    return { stations: targetStations.length, quantity: targetStations.length * qty };
  }

  function addOnlineToAllStations(shift, amount = 1) {
    return addOnlineToStations(shift, REPORT_GROUPS.FIVE_AM, amount);
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

  function undoOperation(shift, operationId) {
    if (!operationId) return [];
    const removed = shift.events.filter((event) => (event.operationId || event.id) === operationId);
    if (!removed.length) return [];
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

  function adjustReturnCount(shift, source, delta) {
    migrateShift(shift);
    const cleanSource = String(source || '').trim().toUpperCase();
    const amount = Number(delta);
    if (!cleanSource) throw new Error('回倉來源無效');
    if (!Number.isFinite(amount) || amount === 0) throw new Error('調整數量必須是非零數字');
    const current = Number(shift.returnCounts[cleanSource] || 0);
    if (current + amount < 0) throw new Error(`${cleanSource} 回倉數量已是 0`);
    shift.returnCounts[cleanSource] = current + amount;
    return shift.returnCounts[cleanSource];
  }

  function setReturnCount(shift, source, value) {
    migrateShift(shift);
    const cleanSource = String(source || '').trim().toUpperCase();
    const number = Math.max(0, Number(value || 0));
    if (!cleanSource || !Number.isFinite(number)) throw new Error('回倉數量無效');
    shift.returnCounts[cleanSource] = number;
    return number;
  }

  function computeReturnCounts(shift) {
    migrateShift(shift);
    const bySource = {};
    Object.entries(shift.returnCounts).forEach(([source, value]) => {
      const number = Math.max(0, Number(value || 0));
      if (number > 0 || RETURN_SOURCES.includes(source)) bySource[source] = number;
    });
    const total = Object.values(bySource).reduce((sum, value) => sum + Number(value || 0), 0);
    return { bySource, total };
  }

  function addReturnBatch(shift, { source, mixed = 0, transit = 0, note = '', timestamp = nowIso() }) {
    migrateShift(shift);
    const cleanSource = String(source || '').trim().toUpperCase();
    const mixedQty = Math.max(0, Number(mixed || 0));
    const transitQty = Math.max(0, Number(transit || 0));
    if (!cleanSource) throw new Error('請輸入回倉來源');
    if (!Number.isFinite(mixedQty) || !Number.isFinite(transitQty) || mixedQty + transitQty <= 0) {
      throw new Error('待分或過境至少要有 1 板');
    }
    const batch = {
      id: uid('batch'),
      timestamp,
      source: cleanSource,
      mixed: mixedQty,
      transit: transitQty,
      note: String(note || '').trim(),
    };
    shift.returnBatches.push(batch);
    return batch;
  }

  function editReturnBatch(shift, batchId, patch) {
    migrateShift(shift);
    const batch = shift.returnBatches.find((item) => item.id === batchId);
    if (!batch) throw new Error('找不到回倉紀錄');
    const source = patch.source === undefined ? batch.source : String(patch.source || '').trim().toUpperCase();
    const mixed = patch.mixed === undefined ? batch.mixed : Math.max(0, Number(patch.mixed || 0));
    const transit = patch.transit === undefined ? batch.transit : Math.max(0, Number(patch.transit || 0));
    if (!source) throw new Error('請輸入回倉來源');
    if (!Number.isFinite(mixed) || !Number.isFinite(transit) || mixed + transit <= 0) throw new Error('數量無效');
    batch.source = source;
    batch.mixed = mixed;
    batch.transit = transit;
    if (patch.note !== undefined) batch.note = String(patch.note || '').trim();
    if (patch.timestamp) batch.timestamp = patch.timestamp;
    return batch;
  }

  function deleteReturnBatch(shift, batchId) {
    migrateShift(shift);
    const before = shift.returnBatches.length;
    shift.returnBatches = shift.returnBatches.filter((item) => item.id !== batchId);
    return before !== shift.returnBatches.length;
  }

  function computeReturnBatchTotals(shift) {
    migrateShift(shift);
    const batchTotals = shift.returnBatches.reduce((total, batch) => {
      total.mixed += Number(batch.mixed || 0);
      total.transit += Number(batch.transit || 0);
      return total;
    }, { mixed: 0, transit: 0 });
    const counts = computeCounts(shift);
    const stationTransit = STATIONS.reduce((sum, station) => sum + counts[station].transit, 0);
    return {
      mixed: batchTotals.mixed,
      transit: batchTotals.transit,
      all: batchTotals.mixed + batchTotals.transit,
      stationTransit,
      transitDifference: stationTransit - batchTotals.transit,
    };
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

  function makeReturnBatchCSV(shift) {
    const totals = computeReturnCounts(shift);
    const rows = [['來源', '回倉板數']];
    Object.entries(totals.bySource).forEach(([source, count]) => rows.push([source, count]));
    rows.push(['合計', totals.total]);
    return '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  }

  function makeReportText(shift, reportKey = 'THREE_AM') {
    const stations = REPORT_GROUPS[reportKey];
    if (!stations) throw new Error('未知回報類型');
    const stats = computeAllStats(shift);
    const title = reportKey === 'THREE_AM' ? '03:00 CS／SS／KS 回報' : '05:00 NS／TS 回報';
    const lines = [`${title}｜${shift.date}`];
    stations.forEach((station) => {
      const s = stats[station];
      lines.push(`${station}：早${s.morning}／夜${s.night}／過${s.transit}｜總${s.reportTotal}`);
    });
    const total = stations.reduce((sum, station) => sum + stats[station].reportTotal, 0);
    lines.push(`合計：${total}`);
    return lines.join('\n');
  }

  function makeWorkLogText(shift) {
    migrateShift(shift);
    const stats = computeAllStats(shift);
    const totals = computeTotals(shift);
    const returns = computeReturnCounts(shift);
    const lines = [
      `日期：${shift.date}`,
      '',
      `03:00 CS／SS／KS 回報總數：${totals.REPORT03.reportTotal}`,
      `全部回報總數：${totals.ALL.reportTotal}`,
      '',
      '回倉紀錄：',
    ];
    const nonZeroReturns = Object.entries(returns.bySource).filter(([, count]) => Number(count) > 0);
    if (!nonZeroReturns.length) lines.push('無');
    else nonZeroReturns.forEach(([source, count]) => lines.push(`${source}：${count}板`));
    lines.push(`回倉合計：${returns.total}`);
    lines.push('', '站所統計：');
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
    GROUP_ORDER,
    STATION_GROUPS,
    REPORT_GROUPS,
    RETURN_SOURCES,
    CATEGORIES,
    CATEGORY_LABELS,
    uid,
    nowIso,
    localDate,
    createShift,
    migrateShift,
    emptyCounts,
    computeCounts,
    recomputeEventAfters,
    stationStats,
    computeAllStats,
    computeTotals,
    addEvent,
    setCount,
    convertOnlineToNight,
    addOnlineToStations,
    addOnlineToAllStations,
    convertAllOnlineToNight,
    undoLastOperation,
    undoOperation,
    editEvent,
    deleteEvent,
    adjustReturnCount,
    setReturnCount,
    computeReturnCounts,
    addReturnBatch,
    editReturnBatch,
    deleteReturnBatch,
    computeReturnBatchTotals,
    csvEscape,
    makeShiftCSV,
    makeReturnBatchCSV,
    makeReportText,
    makeWorkLogText,
  };
});
