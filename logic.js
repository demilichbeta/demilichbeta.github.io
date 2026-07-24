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
    { id: 10, name: '第十滑道', stations: ['CS3', 'CS6', 'NS20', 'NS21', 'NS22', 'NS23', 'YT1', 'HT1'] },
    { id: 11, name: '第十一滑道', stations: ['TS1', 'TS2', 'TS3', 'TS5', 'TS6', 'TS11', 'ET3'] },
    { id: 12, name: '第十二滑道', stations: ['SS3', 'SS4', 'SS5', 'SS6', 'SS7', 'KS1', 'KS2', 'KS3'] },
  ];

  const STATIONS = CHUTES.flatMap((chute) => chute.stations);
  const naturalStationSort = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

  // 個別系列：用於統計頁上方的小框與精確系列小計。
  const SERIES_ORDER = ['NS', 'TS', 'CS', 'SS', 'KS', 'HT', 'YT', 'ET'];
  const SERIES_GROUPS = Object.fromEntries(
    SERIES_ORDER.map((series) => [series, STATIONS.filter((station) => station.startsWith(series)).sort(naturalStationSort)])
  );

  // 快速分類：NS、TS、CS、S（SS+KS）、E（ET+HT+YT）。
  const GROUP_ORDER = ['NS', 'TS', 'CS', 'S', 'E'];
  const STATION_GROUPS = {
    NS: [...SERIES_GROUPS.NS],
    TS: [...SERIES_GROUPS.TS],
    CS: [...SERIES_GROUPS.CS],
    S: [...SERIES_GROUPS.SS, ...SERIES_GROUPS.KS],
    E: [...SERIES_GROUPS.ET, ...SERIES_GROUPS.HT, ...SERIES_GROUPS.YT].sort(naturalStationSort),
  };

  function stationSeries(station) {
    return SERIES_ORDER.find((series) => station.startsWith(series)) || '';
  }

  function stationGroup(station) {
    const series = stationSeries(station);
    if (series === 'SS' || series === 'KS') return 'S';
    if (series === 'ET' || series === 'HT' || series === 'YT') return 'E';
    return series;
  }

  const REPORT_GROUPS = {
    THREE_AM: [...SERIES_GROUPS.CS, ...SERIES_GROUPS.SS, ...SERIES_GROUPS.KS],
    FIVE_AM: [...SERIES_GROUPS.NS, ...SERIES_GROUPS.TS, ...SERIES_GROUPS.ET, ...SERIES_GROUPS.HT, ...SERIES_GROUPS.YT],
  };
  // 04:30 的『全部＋1』只套用 NS／TS。
  const ONLINE_BULK_STATIONS = [...SERIES_GROUPS.NS, ...SERIES_GROUPS.TS];
  const RETURN_SOURCES = ['DC9', 'DC4', 'DC11', 'CS4', 'SDC', 'DC2', 'NS2', 'NS5', 'NS1', 'DC12'];

  const CARRIERS = ['cage', 'pallet'];
  const CARRIER_LABELS = { cage: '籠車', pallet: '棧板' };
  const CAGE_DEFAULT_STATIONS = new Set([
    'NS2', 'NS6', 'NS8', 'NS9', 'NS18',
    'CS12', 'CS4', 'CS5', 'CS6',
    'TS1', 'TS2', 'TS5', 'TS6', 'TS11',
    'SS3', 'SS4', 'SS5', 'SS6', 'SS7',
    'KS1', 'KS2', 'KS3',
    'YT1', 'HT1', 'ET3',
  ]);

  const CATEGORIES = ['morning', 'night', 'transit', 'loaded', 'online', 'secondary', 'actual'];
  const CATEGORY_LABELS = {
    morning: '中班',
    night: '夜班',
    transit: '過境',
    loaded: '載走',
    online: '二分待完成',
    secondary: '二分',
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

  function defaultCarrierForStation(station) {
    return CAGE_DEFAULT_STATIONS.has(station) ? 'cage' : 'pallet';
  }

  function otherCarrier(carrier) {
    return carrier === 'cage' ? 'pallet' : 'cage';
  }

  function normalizeCarrier(carrier, station) {
    return CARRIERS.includes(carrier) ? carrier : defaultCarrierForStation(station);
  }

  function emptyCarrierCounts() {
    return { cage: 0, pallet: 0 };
  }

  function emptyStationCount() {
    return Object.fromEntries(CATEGORIES.map((category) => [category, emptyCarrierCounts()]));
  }

  function createShift(date, previousMorning = null) {
    const shift = {
      id: `${date}-night`,
      date,
      createdAt: nowIso(),
      status: 'active',
      events: [],
      returnEvents: [],
      returnNotes: [],
      actualConfirmed: {},
      returnBatches: [],
      returnCounts: {},
      schemaVersion: 10,
    };
    if (previousMorning) {
      const operationId = uid('copy');
      STATIONS.forEach((station) => {
        const sourceValue = previousMorning[station];
        CARRIERS.forEach((carrier) => {
          const value = typeof sourceValue === 'object'
            ? Number(sourceValue?.[carrier] || 0)
            : carrier === defaultCarrierForStation(station) ? Number(sourceValue || 0) : 0;
          if (value > 0) {
            shift.events.push({
              id: uid('evt'), operationId, timestamp: nowIso(), station, category: 'morning', carrier,
              delta: value, after: value, note: '複製上一班中班數量',
            });
          }
        });
      });
    }
    return shift;
  }

  function migrationTimestamp(shift) {
    const candidate = shift.createdAt ? new Date(shift.createdAt) : new Date(`${shift.date || localDate()}T00:00:00`);
    return Number.isNaN(candidate.getTime()) ? nowIso() : candidate.toISOString();
  }

  function migrateShift(shift) {
    if (!shift || typeof shift !== 'object') throw new Error('班次資料無效');
    if (!Array.isArray(shift.events)) shift.events = [];
    if (!Array.isArray(shift.returnBatches)) shift.returnBatches = [];
    if (!Array.isArray(shift.returnEvents)) shift.returnEvents = [];
    if (!Array.isArray(shift.returnNotes)) shift.returnNotes = [];
    if (!shift.actualConfirmed || typeof shift.actualConfirmed !== 'object' || Array.isArray(shift.actualConfirmed)) shift.actualConfirmed = {};

    shift.events.forEach((event) => {
      event.carrier = normalizeCarrier(event.carrier, event.station);
      event.note = String(event.note || '').replaceAll('早班', '中班');
      if (!event.operationId) event.operationId = event.id || uid('op');
    });

    if (!shift._returnEventsMigratedV5) {
      const migratedTotals = {};
      if (shift.returnCounts && typeof shift.returnCounts === 'object' && !Array.isArray(shift.returnCounts)) {
        Object.entries(shift.returnCounts).forEach(([source, value]) => {
          const qty = Math.max(0, Number(value || 0));
          if (qty > 0) migratedTotals[String(source).trim().toUpperCase()] = qty;
        });
      } else if (shift.returnBatches.length) {
        shift.returnBatches.forEach((batch) => {
          const source = String(batch.source || '').trim().toUpperCase();
          if (!source) return;
          const qty = Math.max(0, Number(batch.mixed || 0)) + Math.max(0, Number(batch.transit || 0));
          migratedTotals[source] = (migratedTotals[source] || 0) + qty;
        });
      }
      const timestamp = migrationTimestamp(shift);
      Object.entries(migratedTotals).forEach(([source, qty]) => {
        shift.returnEvents.push({
          id: uid('ret'), timestamp, source, carrier: 'pallet', delta: qty,
          note: '由舊版回倉總數轉入；載具暫列棧板',
        });
      });
      shift._returnEventsMigratedV5 = true;
    }

    shift.returnEvents = shift.returnEvents
      .filter((event) => event && event.source)
      .map((event) => {
        const rawSource = String(event.source).trim().toUpperCase();
        return {
          id: event.id || uid('ret'),
          timestamp: event.timestamp || migrationTimestamp(shift),
          source: rawSource === 'CS12' ? 'CS4' : rawSource,
          carrier: CARRIERS.includes(event.carrier) ? event.carrier : 'pallet',
          delta: Math.max(0, Number(event.delta || 0)),
          note: String(event.note || ''),
        };
      })
      .filter((event) => event.delta > 0);

    shift.returnNotes = shift.returnNotes
      .filter((item) => item && String(item.text || '').trim())
      .map((item) => ({
        id: item.id || uid('rnote'),
        timestamp: item.timestamp || migrationTimestamp(shift),
        text: String(item.text || '').trim(),
      }));

    shift.schemaVersion = 10;
    recomputeEventAfters(shift);
    return shift;
  }

  function emptyCounts() {
    const result = {};
    STATIONS.forEach((station) => { result[station] = emptyStationCount(); });
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
        const carrier = normalizeCarrier(event.carrier, event.station);
        counts[event.station][event.category][carrier] += Number(event.delta || 0);
      });
    STATIONS.forEach((station) => {
      CATEGORIES.forEach((category) => {
        CARRIERS.forEach((carrier) => {
          const value = counts[station][category][carrier];
          counts[station][category][carrier] = Number.isFinite(value) ? Math.max(0, value) : 0;
        });
      });
    });
    return counts;
  }

  function countFor(categoryCounts, carrier = 'ALL') {
    if (!categoryCounts) return 0;
    if (carrier === 'ALL') return CARRIERS.reduce((sum, key) => sum + Number(categoryCounts[key] || 0), 0);
    return Number(categoryCounts[carrier] || 0);
  }

  function recomputeEventAfters(shift) {
    const running = emptyCounts();
    shift.events
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      .forEach((event) => {
        if (!running[event.station] || !CATEGORIES.includes(event.category)) return;
        event.carrier = normalizeCarrier(event.carrier, event.station);
        running[event.station][event.category][event.carrier] += Number(event.delta || 0);
        event.after = running[event.station][event.category][event.carrier];
      });
    return shift;
  }

  function stationStats(count, carrier = 'ALL') {
    const morning = countFor(count.morning, carrier);
    const night = countFor(count.night, carrier);
    const transit = countFor(count.transit, carrier);
    const online = countFor(count.online, carrier);
    const secondary = countFor(count.secondary, carrier);
    const loaded = countFor(count.loaded, carrier);
    const actual = countFor(count.actual, carrier);
    // 二次分理只有「轉完成」後的 secondary 才列入回報；online 僅是待處理數。
    const reportTotal = morning + night + transit + secondary;
    const expected = reportTotal - loaded;
    const difference = actual - expected;
    return { morning, night, transit, online, secondary, loaded, actual, reportTotal, expected, difference };
  }

  function computeAllStats(shift, carrier = 'ALL') {
    const counts = computeCounts(shift);
    const stats = {};
    STATIONS.forEach((station) => { stats[station] = stationStats(counts[station], carrier); });
    return stats;
  }

  function blankTotal() {
    return { morning: 0, night: 0, transit: 0, online: 0, secondary: 0, loaded: 0, reportTotal: 0, expected: 0, actual: 0, difference: 0 };
  }

  function computeTotals(shift, carrier = 'ALL') {
    const stats = computeAllStats(shift, carrier);
    const groups = { ALL: blankTotal(), REPORT03: blankTotal(), REPORT05: blankTotal() };
    [...new Set([...GROUP_ORDER, ...SERIES_ORDER])].forEach((group) => { groups[group] = blankTotal(); });
    STATIONS.forEach((station) => {
      const series = stationSeries(station);
      const displayGroup = stationGroup(station);
      const reportKey = REPORT_GROUPS.THREE_AM.includes(station) ? 'REPORT03' : 'REPORT05';
      const targetKeys = new Set([series, displayGroup, reportKey, 'ALL']);
      Object.keys(blankTotal()).forEach((field) => {
        targetKeys.forEach((key) => {
          if (key && groups[key]) groups[key][field] += stats[station][field];
        });
      });
    });
    return groups;
  }

  function addEvent(shift, { station, category, carrier, delta, note = '', timestamp = nowIso(), operationId = uid('op') }) {
    if (!STATIONS.includes(station)) throw new Error(`未知站所：${station}`);
    if (!CATEGORIES.includes(category)) throw new Error(`未知類別：${category}`);
    const normalizedCarrier = normalizeCarrier(carrier, station);
    const number = Number(delta);
    if (!Number.isFinite(number) || number === 0) throw new Error('數量必須是非零數字');
    const current = computeCounts(shift)[station][category][normalizedCarrier];
    if (current + number < 0) throw new Error(`${CATEGORY_LABELS[category]}${CARRIER_LABELS[normalizedCarrier]}數量已是 0`);
    const event = {
      id: uid('evt'), operationId, timestamp, station, category, carrier: normalizedCarrier,
      delta: number, after: current + number, note,
    };
    shift.events.push(event);
    recomputeEventAfters(shift);
    return event;
  }

  function setCount(shift, station, category, newValue, carrier) {
    const normalizedCarrier = normalizeCarrier(carrier, station);
    const value = Math.max(0, Number(newValue || 0));
    const current = computeCounts(shift)[station][category][normalizedCarrier];
    const delta = value - current;
    if (delta === 0) return null;
    return addEvent(shift, { station, category, carrier: normalizedCarrier, delta, note: '直接輸入數量' });
  }

  function chooseCarrierToDecrement(shift, station, category) {
    const counts = computeCounts(shift)[station][category];
    const recent = shift.events
      .filter((event) => event.station === station && event.category === category)
      .slice()
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    for (const event of recent) {
      const carrier = normalizeCarrier(event.carrier, station);
      if (counts[carrier] > 0) return carrier;
    }
    const preferred = defaultCarrierForStation(station);
    if (counts[preferred] > 0) return preferred;
    const alternate = otherCarrier(preferred);
    return counts[alternate] > 0 ? alternate : preferred;
  }

  function convertOnlineToSecondary(shift, station, carrier = 'ALL') {
    const counts = computeCounts(shift)[station].online;
    const carriers = carrier === 'ALL' ? CARRIERS : [normalizeCarrier(carrier, station)];
    const targets = carriers.map((key) => ({ carrier: key, qty: counts[key] })).filter((item) => item.qty > 0);
    if (!targets.length) throw new Error('此站所沒有可轉完成的二次分理載具');
    const operationId = uid('convert');
    const timestamp = nowIso();
    let total = 0;
    targets.forEach((item) => {
      addEvent(shift, { station, category: 'online', carrier: item.carrier, delta: -item.qty, note: '二次分理轉完成', timestamp, operationId });
      addEvent(shift, { station, category: 'secondary', carrier: item.carrier, delta: item.qty, note: '二次分理轉完成', timestamp, operationId });
      total += item.qty;
    });
    return total;
  }

  function addOnlineToStations(shift, stations = ONLINE_BULK_STATIONS, amount = 1) {
    const targetStations = stations.filter((station) => STATIONS.includes(station));
    const qty = Math.max(1, Number(amount || 1));
    const operationId = uid('online-bulk');
    const timestamp = nowIso();
    targetStations.forEach((station) => addEvent(shift, {
      station, category: 'online', carrier: defaultCarrierForStation(station), delta: qty,
      note: 'NS／TS 二次分理全部待處理加一', timestamp, operationId,
    }));
    return { stations: targetStations.length, quantity: targetStations.length * qty };
  }

  function addOnlineToAllStations(shift, amount = 1) {
    return addOnlineToStations(shift, ONLINE_BULK_STATIONS, amount);
  }

  function convertAllOnlineToSecondary(shift) {
    const counts = computeCounts(shift);
    const targets = [];
    STATIONS.forEach((station) => CARRIERS.forEach((carrier) => {
      const qty = counts[station].online[carrier];
      if (qty > 0) targets.push({ station, carrier, qty });
    }));
    if (!targets.length) throw new Error('目前沒有可轉完成的二次分理載具');
    const operationId = uid('convert-all');
    const timestamp = nowIso();
    let total = 0;
    targets.forEach(({ station, carrier, qty }) => {
      addEvent(shift, { station, category: 'online', carrier, delta: -qty, note: '全部二次分理轉完成', timestamp, operationId });
      addEvent(shift, { station, category: 'secondary', carrier, delta: qty, note: '全部二次分理轉完成', timestamp, operationId });
      total += qty;
    });
    return { stations: new Set(targets.map((item) => item.station)).size, quantity: total };
  }

  function undoLastOperation(shift) {
    if (!shift.events.length) return [];
    const last = shift.events.slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).at(-1);
    return undoOperation(shift, last.operationId || last.id);
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
    if (patch.carrier && !CARRIERS.includes(patch.carrier)) throw new Error('載具無效');
    if (patch.delta !== undefined) {
      const value = Number(patch.delta);
      if (!Number.isFinite(value) || value === 0) throw new Error('數量必須是非零數字');
      event.delta = value;
    }
    if (patch.station) event.station = patch.station;
    if (patch.category) event.category = patch.category;
    if (patch.carrier) event.carrier = patch.carrier;
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

  function returnEventTotal(shift, source, carrier) {
    return shift.returnEvents
      .filter((event) => event.source === source && event.carrier === carrier)
      .reduce((sum, event) => sum + Number(event.delta || 0), 0);
  }

  function adjustReturnCount(shift, source, carrier, delta, timestamp = nowIso()) {
    migrateShift(shift);
    const cleanSource = String(source || '').trim().toUpperCase();
    const normalizedCarrier = CARRIERS.includes(carrier) ? carrier : 'pallet';
    const amount = Number(delta);
    if (!cleanSource) throw new Error('回倉來源無效');
    if (!Number.isFinite(amount) || amount === 0) throw new Error('調整數量必須是非零數字');

    if (amount > 0) {
      shift.returnEvents.push({ id: uid('ret'), timestamp, source: cleanSource, carrier: normalizedCarrier, delta: amount, note: '' });
    } else {
      let remaining = Math.abs(amount);
      const candidates = shift.returnEvents
        .filter((event) => event.source === cleanSource && event.carrier === normalizedCarrier && event.delta > 0)
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
      const available = candidates.reduce((sum, event) => sum + event.delta, 0);
      if (available < remaining) throw new Error(`${cleanSource} ${CARRIER_LABELS[normalizedCarrier]}回倉數量已是 0`);
      for (const event of candidates) {
        if (remaining <= 0) break;
        const used = Math.min(event.delta, remaining);
        event.delta -= used;
        remaining -= used;
      }
      shift.returnEvents = shift.returnEvents.filter((event) => event.delta > 0);
    }
    return returnEventTotal(shift, cleanSource, normalizedCarrier);
  }


  function returnBucketSourceCounts(shift, source, bucketKey, carrier = 'ALL') {
    migrateShift(shift);
    const cleanSource = String(source || '').trim().toUpperCase();
    const counts = { cage: 0, pallet: 0, total: 0 };
    shift.returnEvents.forEach((event) => {
      if (event.source !== cleanSource || halfHourBucket(event.timestamp).key !== bucketKey) return;
      counts[event.carrier] += Number(event.delta || 0);
      counts.total += Number(event.delta || 0);
    });
    return carrier === 'ALL' ? counts.total : counts[carrier];
  }

  function adjustReturnBucketCount(shift, source, carrier, delta, timestamp = nowIso()) {
    migrateShift(shift);
    const cleanSource = String(source || '').trim().toUpperCase();
    const normalizedCarrier = CARRIERS.includes(carrier) ? carrier : 'pallet';
    const amount = Number(delta);
    const bucket = halfHourBucket(timestamp);
    if (!cleanSource) throw new Error('回倉來源無效');
    if (!Number.isFinite(amount) || amount === 0) throw new Error('調整數量必須是非零數字');

    if (amount > 0) {
      shift.returnEvents.push({ id: uid('ret'), timestamp, source: cleanSource, carrier: normalizedCarrier, delta: amount, note: '' });
    } else {
      let remaining = Math.abs(amount);
      const candidates = shift.returnEvents
        .filter((event) => event.source === cleanSource && event.carrier === normalizedCarrier && event.delta > 0 && halfHourBucket(event.timestamp).key === bucket.key)
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
      const available = candidates.reduce((sum, event) => sum + event.delta, 0);
      if (available < remaining) throw new Error(`${cleanSource} ${CARRIER_LABELS[normalizedCarrier]}本時段數量已是 0`);
      for (const event of candidates) {
        if (remaining <= 0) break;
        const used = Math.min(event.delta, remaining);
        event.delta -= used;
        remaining -= used;
      }
      shift.returnEvents = shift.returnEvents.filter((event) => event.delta > 0);
    }
    return returnBucketSourceCounts(shift, cleanSource, bucket.key, normalizedCarrier);
  }

  function computeCurrentReturnBucketCounts(shift, timestamp = nowIso()) {
    migrateShift(shift);
    const bucket = halfHourBucket(timestamp);
    const bySource = {};
    const sources = [...new Set([...RETURN_SOURCES, ...shift.returnEvents.map((event) => event.source)])];
    sources.forEach((source) => {
      const cage = returnBucketSourceCounts(shift, source, bucket.key, 'cage');
      const pallet = returnBucketSourceCounts(shift, source, bucket.key, 'pallet');
      bySource[source] = { cage, pallet, total: cage + pallet };
    });
    const carrierTotals = {
      cage: Object.values(bySource).reduce((sum, value) => sum + value.cage, 0),
      pallet: Object.values(bySource).reduce((sum, value) => sum + value.pallet, 0),
    };
    carrierTotals.total = carrierTotals.cage + carrierTotals.pallet;
    return { bucket, bySource, carrierTotals };
  }

  function computeReturnCounts(shift, carrier = 'ALL') {
    migrateShift(shift);
    const bySource = {};
    const sources = [...new Set([...RETURN_SOURCES, ...shift.returnEvents.map((event) => event.source)])];
    sources.forEach((source) => {
      const cage = returnEventTotal(shift, source, 'cage');
      const pallet = returnEventTotal(shift, source, 'pallet');
      bySource[source] = { cage, pallet, total: cage + pallet };
    });
    const filtered = Object.fromEntries(Object.entries(bySource).map(([source, value]) => [source,
      carrier === 'ALL' ? value.total : value[carrier]
    ]));
    const total = Object.values(filtered).reduce((sum, value) => sum + Number(value || 0), 0);
    const carrierTotals = {
      cage: Object.values(bySource).reduce((sum, value) => sum + value.cage, 0),
      pallet: Object.values(bySource).reduce((sum, value) => sum + value.pallet, 0),
    };
    carrierTotals.total = carrierTotals.cage + carrierTotals.pallet;
    return { bySource, filtered, total, carrierTotals };
  }

  function halfHourBucket(timestamp) {
    const date = new Date(timestamp);
    const start = new Date(date);
    start.setSeconds(0, 0);
    start.setMinutes(date.getMinutes() < 30 ? 0 : 30);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const hhmm = (value) => `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
    return { key: `${localDate(start)}T${hhmm(start)}`, label: `${hhmm(start)}–${hhmm(end)}`, start: start.toISOString() };
  }

  function addReturnNote(shift, text, timestamp = nowIso()) {
    migrateShift(shift);
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('請輸入回倉備註');
    const note = { id: uid('rnote'), timestamp, text: cleanText };
    shift.returnNotes.push(note);
    return note;
  }

  function deleteReturnNote(shift, noteId) {
    migrateShift(shift);
    const before = shift.returnNotes.length;
    shift.returnNotes = shift.returnNotes.filter((item) => item.id !== noteId);
    if (shift.returnNotes.length === before) throw new Error('找不到回倉備註');
    return true;
  }

  function computeReturnBuckets(shift) {
    migrateShift(shift);
    const buckets = {};
    const ensureBucket = (timestamp) => {
      const bucket = halfHourBucket(timestamp);
      if (!buckets[bucket.key]) buckets[bucket.key] = { ...bucket, total: 0, cage: 0, pallet: 0, sources: {}, notes: [] };
      return buckets[bucket.key];
    };
    shift.returnEvents.forEach((event) => {
      const target = ensureBucket(event.timestamp);
      if (!target.sources[event.source]) target.sources[event.source] = { cage: 0, pallet: 0, total: 0 };
      target.sources[event.source][event.carrier] += event.delta;
      target.sources[event.source].total += event.delta;
      target[event.carrier] += event.delta;
      target.total += event.delta;
    });
    shift.returnNotes.forEach((note) => {
      ensureBucket(note.timestamp).notes.push(note);
    });
    Object.values(buckets).forEach((bucket) => bucket.notes.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))));
    return Object.values(buckets).sort((a, b) => a.start.localeCompare(b.start));
  }

  function currentReturnBucket(date = new Date()) {
    return halfHourBucket(date.toISOString());
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function makeShiftCSV(shift) {
    const rows = [['日期', '時間', '站所', '類別', '載具', '變動', '操作後累計', '備註']];
    shift.events.slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).forEach((event) => {
      const date = new Date(event.timestamp);
      rows.push([
        date.toLocaleDateString('zh-TW'), date.toLocaleTimeString('zh-TW', { hour12: false }), event.station,
        CATEGORY_LABELS[event.category] || event.category, CARRIER_LABELS[event.carrier] || event.carrier,
        event.delta, event.after, event.note || '',
      ]);
    });
    return '\ufeff' + rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  }

  function makeReturnBatchCSV(shift) {
    migrateShift(shift);
    const rows = [['日期', '時間', '30分鐘時段', '來源', '載具', '數量', '備註']];
    const records = [
      ...shift.returnEvents.map((event) => ({ type: 'event', timestamp: event.timestamp, event })),
      ...shift.returnNotes.map((note) => ({ type: 'note', timestamp: note.timestamp, note })),
    ].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    records.forEach((record) => {
      const date = new Date(record.timestamp);
      if (record.type === 'event') {
        const event = record.event;
        rows.push([
          date.toLocaleDateString('zh-TW'), date.toLocaleTimeString('zh-TW', { hour12: false }),
          halfHourBucket(event.timestamp).label, event.source, CARRIER_LABELS[event.carrier], event.delta, event.note || '',
        ]);
      } else {
        rows.push([
          date.toLocaleDateString('zh-TW'), date.toLocaleTimeString('zh-TW', { hour12: false }),
          halfHourBucket(record.note.timestamp).label, '備註', '', '', record.note.text,
        ]);
      }
    });
    const totals = computeReturnCounts(shift);
    rows.push(['', '', '', '合計', '籠車', totals.carrierTotals.cage, '']);
    rows.push(['', '', '', '合計', '棧板', totals.carrierTotals.pallet, '']);
    rows.push(['', '', '', '全部合計', '', totals.carrierTotals.total, '']);
    return '\ufeff' + rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  }


  function makeMorningReportText(shift) {
    const counts = computeCounts(shift);
    const lines = [`中班數量｜${shift.date}`];
    GROUP_ORDER.forEach((group) => {
      lines.push(`${group}：`);
      STATION_GROUPS[group].forEach((station) => {
        const cage = counts[station].morning.cage;
        const pallet = counts[station].morning.pallet;
        let detail = '0';
        if (cage > 0 && pallet > 0) detail = `${cage}籠／${pallet}板`;
        else if (cage > 0) detail = `${cage}籠`;
        else if (pallet > 0) detail = `${pallet}板`;
        lines.push(`${station}：${detail}`);
      });
    });
    const cageTotal = STATIONS.reduce((sum, station) => sum + counts[station].morning.cage, 0);
    const palletTotal = STATIONS.reduce((sum, station) => sum + counts[station].morning.pallet, 0);
    lines.push(`合計：${cageTotal}籠／${palletTotal}板｜總${cageTotal + palletTotal}`);
    return lines.join('\n');
  }

  // 派車快速回報只計中班、夜班、過境；二次分理為05:00後工作，不列入03:00／05:00回報。
  function fastReportStationStats(shift, station, carrier = 'ALL') {
    if (!STATIONS.includes(station)) throw new Error('未知站所');
    const counts = computeCounts(shift)[station];
    const read = (category) => carrier === 'ALL'
      ? CARRIERS.reduce((sum, item) => sum + Number(counts[category][item] || 0), 0)
      : Number(counts[category][normalizeCarrier(carrier, station)] || 0);
    const morning = read('morning');
    const night = read('night');
    const transit = read('transit');
    const loaded = read('loaded');
    const actual = read('actual');
    const reportTotal = morning + night + transit;
    const expected = reportTotal - loaded;
    return { morning, night, transit, loaded, actual, reportTotal, expected, difference: actual - expected };
  }

  function computeFastReportStats(shift, carrier = 'ALL') {
    return Object.fromEntries(STATIONS.map((station) => [station, fastReportStationStats(shift, station, carrier)]));
  }

  function confirmActualEntry(shift, station, carrier, timestamp = nowIso()) {
    if (!STATIONS.includes(station)) throw new Error('未知站所');
    const normalizedCarrier = normalizeCarrier(carrier, station);
    if (!shift.actualConfirmed || typeof shift.actualConfirmed !== 'object') shift.actualConfirmed = {};
    shift.actualConfirmed[`${station}:${normalizedCarrier}`] = timestamp;
    return shift.actualConfirmed[`${station}:${normalizedCarrier}`];
  }

  function hasActualEntry(shift, station) {
    const confirmations = shift?.actualConfirmed && typeof shift.actualConfirmed === 'object'
      ? Object.keys(shift.actualConfirmed).some((key) => key.startsWith(`${station}:`))
      : false;
    return confirmations || (Array.isArray(shift?.events) && shift.events.some((event) => event.station === station && event.category === 'actual'));
  }

  function findFastReportAnomalies(shift, reportKey = 'THREE_AM') {
    const stations = REPORT_GROUPS[reportKey];
    if (!stations) throw new Error('未知回報類型');
    const counts = computeCounts(shift);
    const cageStats = computeFastReportStats(shift, 'cage');
    const palletStats = computeFastReportStats(shift, 'pallet');
    const anomalies = [];

    stations.forEach((station) => {
      const reasons = [];
      ['morning', 'night', 'transit', 'loaded', 'actual'].forEach((category) => {
        CARRIERS.forEach((carrier) => {
          const value = counts[station][category][carrier];
          if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
            reasons.push(`${CATEGORY_LABELS[category]}${carrier === 'cage' ? '籠' : '板'}數值異常`);
          }
        });
      });

      // 有做過現場盤點時，才核對籠車與棧板；尚未盤點不視為異常，避免03:00全部誤報。
      if (hasActualEntry(shift, station)) {
        if (cageStats[station].difference !== 0) reasons.push(`籠應${cageStats[station].expected}／現${cageStats[station].actual}`);
        if (palletStats[station].difference !== 0) reasons.push(`板應${palletStats[station].expected}／現${palletStats[station].actual}`);
      }

      if (reasons.length) anomalies.push({ station, reasons: [...new Set(reasons)] });
    });
    return anomalies;
  }

  function makeReportText(shift, reportKey = 'THREE_AM') {
    const stations = REPORT_GROUPS[reportKey];
    if (!stations) throw new Error('未知回報類型');
    const stats = computeFastReportStats(shift, 'ALL');
    const cageStats = computeFastReportStats(shift, 'cage');
    const palletStats = computeFastReportStats(shift, 'pallet');
    const title = reportKey === 'THREE_AM' ? '03:00 CS／SS／KS 回報' : '05:00 NS／TS／E 回報';
    const lines = [`${title}｜${shift.date}`];
    stations.forEach((station) => {
      const s = stats[station];
      lines.push(`${station}：中${s.morning}／夜${s.night}／過${s.transit}｜總${s.reportTotal}（籠${cageStats[station].reportTotal}／板${palletStats[station].reportTotal}）`);
    });
    const total = stations.reduce((sum, station) => sum + stats[station].reportTotal, 0);
    lines.push(`合計：${total}`);
    return lines.join('\n');
  }

  function makeWorkLogText(shift) {
    migrateShift(shift);
    const stats = computeAllStats(shift, 'ALL');
    const cageStats = computeAllStats(shift, 'cage');
    const palletStats = computeAllStats(shift, 'pallet');
    const totals = computeTotals(shift, 'ALL');
    const returns = computeReturnCounts(shift);
    const buckets = computeReturnBuckets(shift);
    const lines = [
      `日期：${shift.date}`, '',
      `03:00 CS／SS／KS 回報總數：${totals.REPORT03.reportTotal}`,
      `05:00 NS／TS／E 回報總數：${totals.REPORT05.reportTotal}`,
      `全部回報總數：${totals.ALL.reportTotal}`, '',
      '回倉紀錄：',
    ];
    if (!buckets.length) lines.push('無');
    buckets.forEach((bucket) => {
      const details = Object.entries(bucket.sources)
        .filter(([, value]) => value.total > 0)
        .map(([source, value]) => `${source} ${value.total}（籠${value.cage}／板${value.pallet}）`)
        .join('、');
      const noteText = bucket.notes?.length ? `｜備註：${bucket.notes.map((item) => item.text).join('；')}` : '';
      lines.push(`${bucket.label}｜${details || '無'}${noteText}`);
    });
    lines.push(`回倉合計：${returns.carrierTotals.total}（籠${returns.carrierTotals.cage}／板${returns.carrierTotals.pallet}）`);
    lines.push('', '站所統計：');
    STATIONS.forEach((station) => {
      const s = stats[station];
      lines.push(`${station}｜中${s.morning}｜夜${s.night}｜過${s.transit}｜二${s.secondary}｜待轉${s.online}｜回報${s.reportTotal}（籠${cageStats[station].reportTotal}／板${palletStats[station].reportTotal}）｜載${s.loaded}｜應有${s.expected}｜現${s.actual}｜差${s.difference}`);
    });
    return lines.join('\n');
  }

  return {
    CHUTES, STATIONS, SERIES_ORDER, SERIES_GROUPS, GROUP_ORDER, STATION_GROUPS, REPORT_GROUPS, ONLINE_BULK_STATIONS, RETURN_SOURCES,
    CARRIERS, CARRIER_LABELS, CAGE_DEFAULT_STATIONS, CATEGORIES, CATEGORY_LABELS,
    uid, nowIso, localDate, naturalStationSort, stationSeries, stationGroup, defaultCarrierForStation, otherCarrier, normalizeCarrier,
    createShift, migrateShift, emptyCounts, computeCounts, countFor, recomputeEventAfters,
    stationStats, computeAllStats, computeTotals, addEvent, setCount, chooseCarrierToDecrement,
    convertOnlineToSecondary, addOnlineToStations, addOnlineToAllStations, convertAllOnlineToSecondary,
    undoLastOperation, undoOperation, editEvent, deleteEvent,
    adjustReturnCount, adjustReturnBucketCount, returnBucketSourceCounts, computeCurrentReturnBucketCounts, computeReturnCounts, halfHourBucket, addReturnNote, deleteReturnNote, computeReturnBuckets, currentReturnBucket,
    csvEscape, makeShiftCSV, makeReturnBatchCSV, makeMorningReportText, fastReportStationStats, computeFastReportStats, confirmActualEntry, findFastReportAnomalies, makeReportText, makeWorkLogText,
  };
});
