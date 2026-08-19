(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PalletLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.061';

  const CHUTES = [
    { id: 7, name: '第七滑道', stations: ['NS2', 'NT3', 'NS5', 'NS6', 'NT8', 'NT9'] },
    { id: 8, name: '第八滑道', stations: ['CT2', 'CS12', 'NT10', 'NT11', 'NT12', 'NT13', 'NS15'] },
    { id: 9, name: '第九滑道', stations: ['CS4', 'CT5', 'NT16', 'NT17', 'NS18', 'NT19', 'NT20'] },
    { id: 10, name: '第十滑道', stations: ['CS3', 'CT6', 'NT21', 'NT22', 'NT23', 'NT24', 'YT1', 'HT1'] },
    { id: 11, name: '第十一滑道', stations: ['TS1', 'TT2', 'TS3', 'TS5', 'TT6', 'TS11', 'ET3'] },
    { id: 12, name: '第十二滑道', stations: ['SS3', 'ST4', 'ST5', 'ST6', 'SS7', 'KS1', 'KT2', 'KS3'] },
  ];

  const STATIONS = CHUTES.flatMap((chute) => chute.stations);
  const naturalStationSort = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
  const stationNumber = (station) => Number(String(station || '').match(/\d+/)?.[0] || Number.MAX_SAFE_INTEGER);
  const operationalStationSort = (a, b) => stationNumber(a) - stationNumber(b) || naturalStationSort(a, b);

  // 0.018：指定站所第二碼由 S 改為 T。此表同時負責舊資料自動轉名。
  const STATION_RENAMES = Object.freeze({
    "CS2": "CT2",
    "CS5": "CT5",
    "CS6": "CT6",
    "SS4": "ST4",
    "SS5": "ST5",
    "SS6": "ST6",
    "KS2": "KT2",
    "TS2": "TT2",
    "TS6": "TT6",
    "NS3": "NT3",
    "NS8": "NT8",
    "NS9": "NT9",
    "NS10": "NT10",
    "NS11": "NT11",
    "NS12": "NT12",
    "NS13": "NT13",
    "NS16": "NT16",
    "NS17": "NT17",
    "NS19": "NT19",
    "NS20": "NT20",
    "NS21": "NT21",
    "NS22": "NT22",
    "NS23": "NT23"
  });

  function canonicalStationName(station) {
    const normalized = String(station || '').trim().toUpperCase();
    return STATION_RENAMES[normalized] || normalized;
  }

  // 0.035：僅改顯示名稱。第二個字母為T時顯示為小寫t，內部代碼仍維持大寫。
  function displayStationName(station) {
    const canonical = canonicalStationName(station);
    if (canonical.length >= 2 && canonical[1] === 'T') {
      return `${canonical[0]}t${canonical.slice(2)}`;
    }
    return canonical;
  }

  // NT／TT／CT／ST／KT 仍歸在原工作系列，用於既有快速分組與回報時段。
  const SERIES_PREFIX_ALIASES = Object.freeze({ NT: 'NS', TT: 'TS', CT: 'CS', ST: 'SS', KT: 'KS' });

  // 個別系列：用於統計頁上方的小框與精確系列小計。
  const SERIES_ORDER = ['NS', 'TS', 'CS', 'SS', 'KS', 'YT', 'HT', 'ET'];

  function stationSeries(station) {
    const canonical = canonicalStationName(station);
    return SERIES_PREFIX_ALIASES[canonical.slice(0, 2)]
      || SERIES_ORDER.find((series) => canonical.startsWith(series))
      || '';
  }

  const SERIES_GROUPS = Object.fromEntries(
    SERIES_ORDER.map((series) => [
      series,
      STATIONS.filter((station) => stationSeries(station) === series).sort(operationalStationSort),
    ])
  );

  // 快速分類：NS（含NT）、TS（含TT）、CS（含CT）、S（SS/ST+KS/KT）、E。
  const GROUP_ORDER = ['NS', 'TS', 'CS', 'S', 'E'];
  const STATION_GROUPS = {
    NS: [...SERIES_GROUPS.NS],
    TS: [...SERIES_GROUPS.TS],
    CS: [...SERIES_GROUPS.CS],
    S: [...SERIES_GROUPS.SS, ...SERIES_GROUPS.KS],
    E: [...SERIES_GROUPS.YT, ...SERIES_GROUPS.HT, ...SERIES_GROUPS.ET],
  };

  function stationGroup(station) {
    const series = stationSeries(station);
    if (series === 'SS' || series === 'KS') return 'S';
    if (series === 'ET' || series === 'HT' || series === 'YT') return 'E';
    return series;
  }

  // 籠標色系：只供夜班快速站所卡做低干擾辨識。
  function stationLabelColorGroup(station) {
    const value = String(station || '').trim().toUpperCase();
    if (/^(HT|YT|ET)/.test(value)) return 'E';
    if (['TT2', 'TS5', 'TT6'].includes(value)) return 'C';
    if (/^T/.test(value)) return 'T';
    if (/^C/.test(value)) return 'C';
    if (/^[SK]/.test(value)) return 'SK';
    return 'N';
  }

  const REPORT_GROUPS = {
    THREE_AM: [...SERIES_GROUPS.CS, ...SERIES_GROUPS.SS, ...SERIES_GROUPS.KS],
    FIVE_AM: [...SERIES_GROUPS.NS, ...SERIES_GROUPS.TS, ...SERIES_GROUPS.YT, ...SERIES_GROUPS.HT, ...SERIES_GROUPS.ET],
  };
  // 0.046：05:00快速回報畫面與統計範圍不變，只有複製文字排除指定站所。
  const REPORT_COPY_EXCLUSIONS = Object.freeze({
    FIVE_AM: new Set(['NS6', 'TS1', 'TS3']),
  });
  // 04:30 的『全部＋1』套用 N系列（NS/NT）與 T系列（TS/TT）。
  const ONLINE_BULK_STATIONS = [...SERIES_GROUPS.NS, ...SERIES_GROUPS.TS];
  const RETURN_SOURCES = ['DC9', 'DC4', 'DC11', 'CS4', 'SDC', 'DC2', 'NS2', 'NS5', 'NS1', 'DC12', 'DC6', 'TS5', 'DC7'];

  // 0.019：回倉複製文字專用順序。回倉頁面與30分鐘時段卡片排序不變。
  const RETURN_REPORT_SOURCE_ORDER = ['DC2', 'DC4', 'DC6', 'DC9', 'DC11', 'NS1', 'NS2', 'NS5', 'TS5', 'SDC', 'DC12', 'DC7', 'CS4'];

  // 0.047：00前已載走獨立於中班盤點。常用站預設顯示，其他站可按班次臨時加入。
  const PRE_MIDNIGHT_DEFAULT_STATIONS = Object.freeze(['NS6', 'TS3', 'YT1', 'HT1', 'ET3']);

  const CARRIERS = ['cage', 'pallet'];
  const CARRIER_LABELS = { cage: '籠車', pallet: '棧板' };
  const CAGE_DEFAULT_STATIONS = new Set([
    'NS2', 'NS6', 'NT8', 'NT9', 'NS18',
    'CS12', 'CS4', 'CT5', 'CT6',
    'TS1', 'TT2', 'TS5', 'TT6', 'TS11',
    'SS3', 'ST4', 'ST5', 'ST6', 'SS7',
    'KS1', 'KT2', 'KS3',
    'YT1', 'HT1', 'ET3',
  ]);

  const CATEGORIES = ['morning', 'night', 'transit', 'loaded', 'online', 'secondary', 'actual'];
  // 0.056：特殊盤點只修改既有正式分類，不建立第二份數量資料。
  const SPECIAL_EDIT_CATEGORIES = Object.freeze(['morning', 'night', 'transit', 'actual']);
  // 確認簽章包含所有會影響該站最終核對的事件分類；任何正常流程後續變動都會自動使確認失效。
  const SPECIAL_SIGNATURE_CATEGORIES = Object.freeze(['morning', 'night', 'transit', 'loaded', 'online', 'secondary', 'actual']);
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
      preMidnightLoaded: { counts: {}, extraStations: [], completedAt: null, legacyCage: 0 },
      preMidnightReturns: { counts: {}, completedAt: null },
      specialInventory: { confirmations: {} },
      schemaVersion: 17,
    };
    if (previousMorning) {
      const operationId = uid('copy');
      STATIONS.forEach((station) => {
        const legacyName = Object.keys(STATION_RENAMES).find((oldName) => STATION_RENAMES[oldName] === station);
        const sourceValue = previousMorning[station] ?? (legacyName ? previousMorning[legacyName] : undefined);
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
    // 0.047：把舊版「00前轉出總籠數」一次性搬到獨立的00前已載走結構。
    // 舊資料沒有站所明細，因此保留在 legacyCage，不硬塞進任何站所，避免資料失真。
    const legacyTransferCage = Math.max(0, Math.floor(Number(shift.preMidnightTransferCage || 0)));
    const sourcePreMidnight = shift.preMidnightLoaded && typeof shift.preMidnightLoaded === 'object' && !Array.isArray(shift.preMidnightLoaded)
      ? shift.preMidnightLoaded
      : {};
    const migratedPreMidnightCounts = {};
    Object.entries(sourcePreMidnight.counts || {}).forEach(([rawStation, rawCounts]) => {
      const station = canonicalStationName(rawStation);
      if (!STATIONS.includes(station)) return;
      const cage = Math.max(0, Math.floor(Number(rawCounts?.cage || 0)));
      const pallet = Math.max(0, Math.floor(Number(rawCounts?.pallet || 0)));
      if (cage || pallet) migratedPreMidnightCounts[station] = { cage, pallet };
    });
    const migratedPreMidnightExtras = Array.isArray(sourcePreMidnight.extraStations)
      ? sourcePreMidnight.extraStations
        .map(canonicalStationName)
        .filter((station, index, values) => STATIONS.includes(station) && !PRE_MIDNIGHT_DEFAULT_STATIONS.includes(station) && values.indexOf(station) === index)
      : [];
    Object.entries(migratedPreMidnightCounts).forEach(([station, counts]) => {
      if ((counts.cage || counts.pallet) && !PRE_MIDNIGHT_DEFAULT_STATIONS.includes(station) && !migratedPreMidnightExtras.includes(station)) {
        migratedPreMidnightExtras.push(station);
      }
    });
    shift.preMidnightLoaded = {
      counts: migratedPreMidnightCounts,
      extraStations: migratedPreMidnightExtras,
      completedAt: sourcePreMidnight.completedAt ? String(sourcePreMidnight.completedAt) : null,
      legacyCage: Math.max(0, Math.floor(Number(sourcePreMidnight.legacyCage || 0))) + legacyTransferCage,
    };
    delete shift.preMidnightTransferCage;

    shift.events.forEach((event) => {
      event.station = canonicalStationName(event.station);
      event.carrier = normalizeCarrier(event.carrier, event.station);
      event.note = String(event.note || '').replaceAll('早班', '中班');
      if (!event.operationId) event.operationId = event.id || uid('op');
    });

    // 盤點格曾明確輸入0的確認狀態，也要跟著站所名稱轉移。
    const migratedActualConfirmed = {};
    Object.entries(shift.actualConfirmed).forEach(([key, value]) => {
      const [rawStation, rawCarrier] = String(key).split(':');
      const station = canonicalStationName(rawStation);
      if (!STATIONS.includes(station) || !CARRIERS.includes(rawCarrier)) return;
      const migratedKey = `${station}:${rawCarrier}`;
      if (!migratedActualConfirmed[migratedKey] || String(value) > String(migratedActualConfirmed[migratedKey])) {
        migratedActualConfirmed[migratedKey] = value;
      }
    });
    shift.actualConfirmed = migratedActualConfirmed;

    // 0.056：特殊盤點只保存「確認狀態／簽章」，數量仍全部來自 events。
    // 舊資料沒有此欄位時建立空結構；站所改名時確認索引一併轉名。
    const sourceSpecialInventory = shift.specialInventory && typeof shift.specialInventory === 'object' && !Array.isArray(shift.specialInventory)
      ? shift.specialInventory
      : {};
    const migratedSpecialConfirmations = {};
    Object.entries(sourceSpecialInventory.confirmations || {}).forEach(([rawStation, rawConfirmation]) => {
      const station = canonicalStationName(rawStation);
      if (!STATIONS.includes(station) || !rawConfirmation || typeof rawConfirmation !== 'object') return;
      const timestamp = rawConfirmation.timestamp ? String(rawConfirmation.timestamp) : null;
      const signature = rawConfirmation.signature ? String(rawConfirmation.signature) : '';
      if (!timestamp || !signature) return;
      const existing = migratedSpecialConfirmations[station];
      if (!existing || timestamp > existing.timestamp) migratedSpecialConfirmations[station] = { timestamp, signature };
    });
    shift.specialInventory = { confirmations: migratedSpecialConfirmations };

    // 0.061：00前回倉獨立保存，不混入00後30分鐘 returnEvents。
    // 只接受既有回倉來源；籠／板分開記錄，完成狀態只用於防誤觸。
    const sourcePreMidnightReturns = shift.preMidnightReturns && typeof shift.preMidnightReturns === 'object' && !Array.isArray(shift.preMidnightReturns)
      ? shift.preMidnightReturns
      : {};
    const migratedPreMidnightReturnCounts = {};
    Object.entries(sourcePreMidnightReturns.counts || {}).forEach(([rawSource, rawCounts]) => {
      const source = String(rawSource || '').trim().toUpperCase();
      if (!RETURN_SOURCES.includes(source)) return;
      const cage = Math.max(0, Math.floor(Number(rawCounts?.cage || 0)));
      const pallet = Math.max(0, Math.floor(Number(rawCounts?.pallet || 0)));
      if (cage || pallet) migratedPreMidnightReturnCounts[source] = { cage, pallet };
    });
    shift.preMidnightReturns = {
      counts: migratedPreMidnightReturnCounts,
      completedAt: sourcePreMidnightReturns.completedAt ? String(sourcePreMidnightReturns.completedAt) : null,
    };

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

    shift.schemaVersion = 17;
    recomputeEventAfters(shift);
    return shift;
  }

  function preMidnightStationCounts(shift, station) {
    migrateShift(shift);
    station = canonicalStationName(station);
    if (!STATIONS.includes(station)) throw new Error('未知站所');
    const value = shift.preMidnightLoaded.counts[station] || emptyCarrierCounts();
    return { cage: Number(value.cage || 0), pallet: Number(value.pallet || 0) };
  }

  function computePreMidnightLoaded(shift) {
    migrateShift(shift);
    const stationCounts = {};
    let cage = Number(shift.preMidnightLoaded.legacyCage || 0);
    let pallet = 0;
    STATIONS.forEach((station) => {
      const value = preMidnightStationCounts(shift, station);
      stationCounts[station] = value;
      cage += value.cage;
      pallet += value.pallet;
    });
    return {
      stationCounts,
      cage,
      pallet,
      total: cage + pallet,
      legacyCage: Number(shift.preMidnightLoaded.legacyCage || 0),
      extraStations: [...shift.preMidnightLoaded.extraStations],
      completedAt: shift.preMidnightLoaded.completedAt || null,
    };
  }

  function setPreMidnightLoadedCount(shift, station, carrier, value) {
    migrateShift(shift);
    station = canonicalStationName(station);
    if (!STATIONS.includes(station)) throw new Error('未知站所');
    const normalizedCarrier = CARRIERS.includes(carrier) ? carrier : 'cage';
    const next = Math.max(0, Math.floor(Number(value || 0)));
    const current = preMidnightStationCounts(shift, station);
    current[normalizedCarrier] = next;
    if (current.cage || current.pallet) shift.preMidnightLoaded.counts[station] = current;
    else delete shift.preMidnightLoaded.counts[station];
    return next;
  }

  function adjustPreMidnightLoadedCount(shift, station, carrier, delta) {
    const current = preMidnightStationCounts(shift, station);
    const normalizedCarrier = CARRIERS.includes(carrier) ? carrier : 'cage';
    return setPreMidnightLoadedCount(shift, station, normalizedCarrier, current[normalizedCarrier] + Number(delta || 0));
  }

  function addPreMidnightExtraStation(shift, station) {
    migrateShift(shift);
    station = canonicalStationName(station);
    if (!STATIONS.includes(station)) throw new Error('未知站所');
    if (PRE_MIDNIGHT_DEFAULT_STATIONS.includes(station)) return station;
    if (!shift.preMidnightLoaded.extraStations.includes(station)) {
      shift.preMidnightLoaded.extraStations.push(station);
      shift.preMidnightLoaded.extraStations.sort(operationalStationSort);
    }
    return station;
  }

  function removePreMidnightExtraStation(shift, station) {
    migrateShift(shift);
    station = canonicalStationName(station);
    if (PRE_MIDNIGHT_DEFAULT_STATIONS.includes(station)) throw new Error('常用站所不能移除');
    const current = preMidnightStationCounts(shift, station);
    if (current.cage || current.pallet) throw new Error('請先將此站數量歸零再移除');
    shift.preMidnightLoaded.extraStations = shift.preMidnightLoaded.extraStations.filter((item) => item !== station);
    delete shift.preMidnightLoaded.counts[station];
    return true;
  }

  function completePreMidnightLoaded(shift, timestamp = nowIso()) {
    migrateShift(shift);
    shift.preMidnightLoaded.completedAt = timestamp;
    return timestamp;
  }

  function reopenPreMidnightLoaded(shift) {
    migrateShift(shift);
    shift.preMidnightLoaded.completedAt = null;
    return null;
  }

  function clearPreMidnightLegacyCage(shift) {
    migrateShift(shift);
    shift.preMidnightLoaded.legacyCage = 0;
    return 0;
  }

  function makePreMidnightLoadedSummaryText(shift) {
    const summary = computePreMidnightLoaded(shift);
    const lines = [];
    PRE_MIDNIGHT_DEFAULT_STATIONS.concat(summary.extraStations).forEach((station) => {
      const value = summary.stationCounts[station];
      const quantity = compactCarrierQuantity(value.cage, value.pallet);
      if (quantity) lines.push(`${displayStationName(station)} ${quantity}`);
    });
    if (summary.legacyCage > 0) lines.push(`舊版未分站 ${summary.legacyCage}籠`);
    if (!lines.length) lines.push('00前已載走：0');
    lines.push(`合計${summary.cage}籠${summary.pallet}板`);
    return lines.join('／');
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
    // 0.056：online一按＋1即先列入現場應有；轉完成時 online→secondary，因此應有總數不跳動。
    // 03:00／05:00回報仍只使用獨立 fastReportStationStats，不會把6點後二分混入派車回報。
    const reportTotal = morning + night + transit + secondary;
    const expected = reportTotal + online - loaded;
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
    station = canonicalStationName(station);
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
    station = canonicalStationName(station);
    if (!STATIONS.includes(station)) throw new Error(`未知站所：${station}`);
    const normalizedCarrier = normalizeCarrier(carrier, station);
    const value = Math.max(0, Number(newValue || 0));
    const current = computeCounts(shift)[station][category][normalizedCarrier];
    const delta = value - current;
    if (delta === 0) return null;
    return addEvent(shift, { station, category, carrier: normalizedCarrier, delta, note: '直接輸入數量' });
  }

  function specialInventorySignatureFromCount(count) {
    return SPECIAL_SIGNATURE_CATEGORIES.flatMap((category) =>
      CARRIERS.map((carrier) => `${category}:${carrier}:${Number(count?.[category]?.[carrier] || 0)}`)
    ).join('|');
  }

  function specialInventorySignature(shift, station) {
    station = canonicalStationName(station);
    if (!STATIONS.includes(station)) throw new Error(`未知站所：${station}`);
    return specialInventorySignatureFromCount(computeCounts(shift)[station]);
  }

  function specialInventoryConfirmation(shift, station, precomputedCounts = null) {
    station = canonicalStationName(station);
    if (!STATIONS.includes(station)) throw new Error(`未知站所：${station}`);
    const confirmations = shift?.specialInventory?.confirmations || {};
    const stored = confirmations[station] || null;
    if (!stored) return { confirmed: false, timestamp: null, stale: false };
    const stationCount = precomputedCounts?.[station] || computeCounts(shift)[station];
    const currentSignature = specialInventorySignatureFromCount(stationCount);
    const confirmed = stored.signature === currentSignature;
    return { confirmed, timestamp: stored.timestamp || null, stale: !confirmed };
  }

  function isSpecialInventoryConfirmed(shift, station, precomputedCounts = null) {
    return specialInventoryConfirmation(shift, station, precomputedCounts).confirmed;
  }

  function normalizeSpecialSnapshot(snapshot) {
    const normalized = {};
    CARRIERS.forEach((carrier) => {
      normalized[carrier] = {};
      SPECIAL_EDIT_CATEGORIES.forEach((category) => {
        const raw = Number(snapshot?.[carrier]?.[category] ?? 0);
        normalized[carrier][category] = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
      });
    });
    return normalized;
  }

  function confirmSpecialInventoryStation(shift, station, snapshot, timestamp = nowIso()) {
    migrateShift(shift);
    station = canonicalStationName(station);
    if (!STATIONS.includes(station)) throw new Error(`未知站所：${station}`);
    const normalized = normalizeSpecialSnapshot(snapshot);
    const current = computeCounts(shift)[station];
    const operationId = uid('special');
    const changes = [];

    // 先完整算出差額，確認所有目標都是非負整數後，再一次寫回正式事件帳。
    CARRIERS.forEach((carrier) => {
      SPECIAL_EDIT_CATEGORIES.forEach((category) => {
        const before = Number(current[category][carrier] || 0);
        const after = normalized[carrier][category];
        const delta = after - before;
        if (delta !== 0) changes.push({ carrier, category, before, after, delta });
      });
    });

    changes.forEach((change) => {
      addEvent(shift, {
        station,
        category: change.category,
        carrier: change.carrier,
        delta: change.delta,
        note: `特殊盤點修正：${CATEGORY_LABELS[change.category]}`,
        timestamp,
        operationId,
      });
    });

    // 特殊盤點是最終現場確認；即使輸入0，也要留下「此載具已盤過」的確認狀態。
    CARRIERS.forEach((carrier) => confirmActualEntry(shift, station, carrier, timestamp));

    shift.specialInventory.confirmations[station] = {
      timestamp,
      signature: specialInventorySignature(shift, station),
    };

    return { station, timestamp, operationId, changes };
  }

  function clearSpecialInventoryConfirmation(shift, station) {
    migrateShift(shift);
    station = canonicalStationName(station);
    if (!STATIONS.includes(station)) throw new Error(`未知站所：${station}`);
    delete shift.specialInventory.confirmations[station];
    return true;
  }

  function chooseCarrierToDecrement(shift, station, category) {
    station = canonicalStationName(station);
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
    station = canonicalStationName(station);
    const counts = computeCounts(shift)[station].online;
    const carriers = carrier === 'ALL' ? CARRIERS : [normalizeCarrier(carrier, station)];
    const targets = carriers.map((key) => ({ carrier: key, qty: counts[key] })).filter((item) => item.qty > 0);
    if (!targets.length) throw new Error('此站所沒有可轉完成的二次分理載具');
    const operationId = uid('convert');
    const timestamp = nowIso();
    let total = 0;
    targets.forEach((item) => {
      // 0.056：二分「轉完成」代表6點後現場已確認此載具；online→secondary讓應有不重複增加，actual同步增加。
      addEvent(shift, { station, category: 'online', carrier: item.carrier, delta: -item.qty, note: '二次分理轉完成', timestamp, operationId });
      addEvent(shift, { station, category: 'secondary', carrier: item.carrier, delta: item.qty, note: '二次分理轉完成', timestamp, operationId });
      addEvent(shift, { station, category: 'actual', carrier: item.carrier, delta: item.qty, note: '二次分理轉完成同步現場盤點', timestamp, operationId });
      confirmActualEntry(shift, station, item.carrier, timestamp);
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
      note: 'NS／Nt／TS／Tt 二次分理全部待處理加一', timestamp, operationId,
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
      addEvent(shift, { station, category: 'actual', carrier, delta: qty, note: '全部二次分理轉完成同步現場盤點', timestamp, operationId });
      confirmActualEntry(shift, station, carrier, timestamp);
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
    if (patch.station) patch.station = canonicalStationName(patch.station);
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

  function preMidnightReturnSourceCounts(shift, source) {
    migrateShift(shift);
    const cleanSource = String(source || '').trim().toUpperCase();
    if (!RETURN_SOURCES.includes(cleanSource)) throw new Error('未知回倉來源');
    const value = shift.preMidnightReturns.counts[cleanSource] || emptyCarrierCounts();
    return { cage: Number(value.cage || 0), pallet: Number(value.pallet || 0) };
  }

  function setPreMidnightReturnCount(shift, source, carrier, value) {
    migrateShift(shift);
    const cleanSource = String(source || '').trim().toUpperCase();
    if (!RETURN_SOURCES.includes(cleanSource)) throw new Error('未知回倉來源');
    const normalizedCarrier = CARRIERS.includes(carrier) ? carrier : 'cage';
    const next = Math.max(0, Math.floor(Number(value || 0)));
    const current = preMidnightReturnSourceCounts(shift, cleanSource);
    current[normalizedCarrier] = next;
    if (current.cage || current.pallet) shift.preMidnightReturns.counts[cleanSource] = current;
    else delete shift.preMidnightReturns.counts[cleanSource];
    return next;
  }

  function adjustPreMidnightReturnCount(shift, source, carrier, delta) {
    const current = preMidnightReturnSourceCounts(shift, source);
    const normalizedCarrier = CARRIERS.includes(carrier) ? carrier : 'cage';
    return setPreMidnightReturnCount(shift, source, normalizedCarrier, current[normalizedCarrier] + Number(delta || 0));
  }

  function computePreMidnightReturnCounts(shift) {
    migrateShift(shift);
    const bySource = {};
    RETURN_SOURCES.forEach((source) => {
      const value = preMidnightReturnSourceCounts(shift, source);
      bySource[source] = { cage: value.cage, pallet: value.pallet, total: value.cage + value.pallet };
    });
    const carrierTotals = {
      cage: Object.values(bySource).reduce((sum, value) => sum + value.cage, 0),
      pallet: Object.values(bySource).reduce((sum, value) => sum + value.pallet, 0),
    };
    carrierTotals.total = carrierTotals.cage + carrierTotals.pallet;
    return { bySource, carrierTotals, completedAt: shift.preMidnightReturns.completedAt || null };
  }

  function completePreMidnightReturns(shift, timestamp = nowIso()) {
    migrateShift(shift);
    shift.preMidnightReturns.completedAt = timestamp;
    return timestamp;
  }

  function reopenPreMidnightReturns(shift) {
    migrateShift(shift);
    shift.preMidnightReturns.completedAt = null;
    return null;
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

  function computeCombinedReturnCounts(shift) {
    migrateShift(shift);
    const before = computePreMidnightReturnCounts(shift);
    const after = computeReturnCounts(shift);
    const sources = [...new Set([...RETURN_SOURCES, ...Object.keys(after.bySource)])];
    const bySource = {};
    sources.forEach((source) => {
      const pre = before.bySource[source] || emptyCarrierCounts();
      const post = after.bySource[source] || emptyCarrierCounts();
      const cage = Number(pre.cage || 0) + Number(post.cage || 0);
      const pallet = Number(pre.pallet || 0) + Number(post.pallet || 0);
      bySource[source] = { cage, pallet, total: cage + pallet };
    });
    const carrierTotals = {
      cage: Object.values(bySource).reduce((sum, value) => sum + value.cage, 0),
      pallet: Object.values(bySource).reduce((sum, value) => sum + value.pallet, 0),
    };
    carrierTotals.total = carrierTotals.cage + carrierTotals.pallet;
    return { bySource, carrierTotals, preMidnight: before, afterMidnight: after };
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
        date.toLocaleDateString('zh-TW'), date.toLocaleTimeString('zh-TW', { hour12: false }), displayStationName(event.station),
        CATEGORY_LABELS[event.category] || event.category, CARRIER_LABELS[event.carrier] || event.carrier,
        event.delta, event.after, event.note || '',
      ]);
    });
    return '\ufeff' + rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  }

  function makeReturnBatchCSV(shift) {
    migrateShift(shift);
    const rows = [['日期', '時間', '30分鐘時段', '來源', '載具', '數量', '備註']];
    const preMidnight = computePreMidnightReturnCounts(shift);
    RETURN_SOURCES.forEach((source) => {
      const value = preMidnight.bySource[source];
      CARRIERS.forEach((carrier) => {
        if (Number(value?.[carrier] || 0) > 0) {
          rows.push([shift.date, '00前', '00前', source, CARRIER_LABELS[carrier], value[carrier], '00前回倉']);
        }
      });
    });
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
    const totals = computeCombinedReturnCounts(shift);
    rows.push(['', '', '', '合計（含00前）', '籠車', totals.carrierTotals.cage, '']);
    rows.push(['', '', '', '合計（含00前）', '棧板', totals.carrierTotals.pallet, '']);
    rows.push(['', '', '', '全部合計（含00前）', '', totals.carrierTotals.total, '']);
    return '\ufeff' + rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  }


  function makeReturnReportText(shift) {
    migrateShift(shift);
    const buckets = computeReturnBuckets(shift);
    const preMidnight = computePreMidnightReturnCounts(shift);
    const combined = computeCombinedReturnCounts(shift);
    const hasCounts = buckets.some((bucket) => bucket.total > 0) || preMidnight.carrierTotals.total > 0;
    const hasNotes = buckets.some((bucket) => (bucket.notes || []).length > 0);
    if (!hasCounts && !hasNotes) {
      // 即使全0，也保留固定來源清單與完整回倉總數區，方便直接貼給轉運人員。
    }

    const unknownSources = [...new Set([
      ...buckets.flatMap((bucket) => Object.keys(bucket.sources || {})),
      ...Object.keys(combined.bySource),
    ].filter((source) => !RETURN_REPORT_SOURCE_ORDER.includes(source) &&
      Number(combined.bySource?.[source]?.total || 0) > 0))].sort(naturalStationSort);
    const sourceOrder = [...RETURN_REPORT_SOURCE_ORDER, ...unknownSources];

    const bucketStartTime = (bucket) =>
      String(bucket.label || '').split(/[–~]/)[0];

    const quantityText = (value) => {
      const parts = [];
      if (Number(value?.pallet || 0) > 0) parts.push(`${value.pallet}板`);
      if (Number(value?.cage || 0) > 0) parts.push(`${value.cage}籠`);
      return parts.join('');
    };

    // 0.061：上半部只列出00後實際有回倉紀錄的來源；0不列出。
    // 順序固定依 RETURN_REPORT_SOURCE_ORDER，與00前回倉輸入順序一致。
    const lines = sourceOrder.flatMap((source) => {
      const entries = buckets
        .map((bucket) => ({ bucket, value: bucket.sources?.[source] }))
        .filter(({ value }) => Number(value?.total || 0) > 0)
        .map(({ bucket, value }) => `${quantityText(value)} ${bucketStartTime(bucket)}`);
      return entries.length ? [`${source}｜${entries.join('｜')}`] : [];
    });

    const notes = buckets
      .flatMap((bucket) => (bucket.notes || []).map((note) => ({
        timestamp: note.timestamp,
        time: bucketStartTime(bucket),
        text: String(note.text || '').trim(),
      })))
      .filter((note) => note.text)
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

    if (notes.length) {
      lines.push('');
      lines.push('備註');
      notes.forEach((note) => lines.push(`${note.time} ${note.text}`));
    }

    const afterMidnight = combined.afterMidnight || computeReturnCounts(shift);
    lines.push(`00後合計 ${Number(afterMidnight.carrierTotals?.pallet || 0)}板${Number(afterMidnight.carrierTotals?.cage || 0)}籠`);
    lines.push('--回倉總數含00前--');
    sourceOrder.forEach((source) => {
      const value = combined.bySource[source] || { cage: 0, pallet: 0 };
      // 此區依現場回報習慣固定「板→籠」，0也必須顯示。
      lines.push(`${source} ${Number(value.pallet || 0)}板 ${Number(value.cage || 0)}籠`);
    });
    lines.push(`今日合計 ${combined.carrierTotals.pallet}板${combined.carrierTotals.cage}籠`);

    return lines.join('\n');
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
        lines.push(`${displayStationName(station)}：${detail}`);
      });
    });
    const cageTotal = STATIONS.reduce((sum, station) => sum + counts[station].morning.cage, 0);
    const palletTotal = STATIONS.reduce((sum, station) => sum + counts[station].morning.pallet, 0);
    lines.push(`合計：${cageTotal}籠／${palletTotal}板｜總${cageTotal + palletTotal}`);
    return lines.join('\n');
  }

  // 派車快速回報只計中班、夜班、過境；二次分理為05:00後工作，不列入03:00／05:00回報。
  function fastReportStationStats(shift, station, carrier = 'ALL') {
    station = canonicalStationName(station);
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
    station = canonicalStationName(station);
    if (!STATIONS.includes(station)) throw new Error('未知站所');
    const normalizedCarrier = normalizeCarrier(carrier, station);
    if (!shift.actualConfirmed || typeof shift.actualConfirmed !== 'object') shift.actualConfirmed = {};
    shift.actualConfirmed[`${station}:${normalizedCarrier}`] = timestamp;
    return shift.actualConfirmed[`${station}:${normalizedCarrier}`];
  }

  function hasActualEntry(shift, station) {
    station = canonicalStationName(station);
    const confirmations = shift?.actualConfirmed && typeof shift.actualConfirmed === 'object'
      ? Object.keys(shift.actualConfirmed).some((key) => key.startsWith(`${station}:`))
      : false;
    return confirmations || (Array.isArray(shift?.events) && shift.events.some((event) => event.station === station && event.category === 'actual'));
  }

  // 複製快速回報前，直接採用「統計核對」的完整計算結果檢查指定回報範圍。
  // 03:00：CS/CT + S（SS/ST／KS/KT）；05:00：NS/NT + TS/TT + E。
  // 籠車或棧板任一載具的差異不為 0，就視為該站存在數字差異異常。
  function findFastReportAnomalies(shift, reportKey = 'THREE_AM') {
    const stations = REPORT_GROUPS[reportKey];
    if (!stations) throw new Error('未知回報類型');
    const cageStats = computeAllStats(shift, 'cage');
    const palletStats = computeAllStats(shift, 'pallet');
    return stations
      .filter((station) => cageStats[station].difference !== 0 || palletStats[station].difference !== 0)
      .map((station) => ({ station }));
  }

  function compactCarrierQuantity(cage, pallet) {
    const parts = [];
    const cageValue = Number(cage || 0);
    const palletValue = Number(pallet || 0);
    if (cageValue > 0) parts.push(`${cageValue}籠`);
    if (palletValue > 0) parts.push(`${palletValue}板`);
    return parts.join('');
  }

  function toFullWidthReportText(value) {
    return String(value ?? '')
      .replace(/ /g, '　')
      .replace(/[!-~]/g, (character) =>
        String.fromCharCode(character.charCodeAt(0) + 0xFEE0)
      );
  }

  function reportTextWidth(value) {
    return [...String(value ?? '')].length;
  }

  function padReportCell(value, width) {
    const text = String(value ?? '');
    return text + '　'.repeat(Math.max(0, width - reportTextWidth(text)));
  }

  function makeReportText(shift, reportKey = 'THREE_AM') {
    const stations = REPORT_GROUPS[reportKey];
    if (!stations) throw new Error('未知回報類型');
    const excludedStations = REPORT_COPY_EXCLUSIONS[reportKey] || new Set();
    const copyStations = stations.filter((station) => !excludedStations.has(station));
    const counts = computeCounts(shift);
    const headers = ['站所', '中班', '夜班', '過境'];

    const rows = copyStations.map((station) => {
      const morning = compactCarrierQuantity(
        counts[station].morning.cage,
        counts[station].morning.pallet
      );
      const night = compactCarrierQuantity(
        counts[station].night.cage,
        counts[station].night.pallet
      );
      const transit = compactCarrierQuantity(
        counts[station].transit.cage,
        counts[station].transit.pallet
      );
      const quantities = [morning, night, transit].map((value) =>
        value ? toFullWidthReportText(value) : ''
      );

      if (!quantities.some(Boolean)) quantities[0] = '０';

      return [
        toFullWidthReportText(station),
        ...quantities,
      ];
    });

    const widths = headers.map((header, index) =>
      Math.max(
        reportTextWidth(header),
        ...rows.map((row) => reportTextWidth(row[index]))
      )
    );

    const formatRow = (row) =>
      row.map((cell, index) => padReportCell(cell, widths[index]))
        .join('　')
        .trimEnd();

    return [formatRow(headers), ...rows.map(formatRow)].join('\n');
  }


  function makeTransitReportText(shift) {
    const counts = computeCounts(shift);
    const totals = { cage: 0, pallet: 0 };
    const lines = [];

    STATIONS.forEach((station) => {
      const values = counts[station].transit;
      const cage = Number(values.cage || 0);
      const pallet = Number(values.pallet || 0);
      totals.cage += cage;
      totals.pallet += pallet;

      const quantity = compactCarrierQuantity(cage, pallet);
      if (quantity) {
        lines.push(`${displayStationName(station)}｜${quantity}`);
      }
    });

    if (!lines.length) lines.push('目前無過境貨紀錄');
    lines.push(`合計${totals.cage}籠${totals.pallet}板`);
    return lines.join('\n');
  }

  function makeLoadedSummaryText(shift) {
    const counts = computeCounts(shift);
    const entries = STATIONS.flatMap((station) => {
      const values = counts[station].loaded;
      const quantity = compactCarrierQuantity(values.cage, values.pallet);
      return quantity ? [`${displayStationName(station)} ${quantity}`] : [];
    });
    return entries.length ? entries.join('／') : '目前無已載走紀錄';
  }

  function computeStatsOverview(shift) {
    const counts = computeCounts(shift);
    const preMidnight = computePreMidnightLoaded(shift);
    const overview = STATIONS.reduce((result, station) => {
      const stationCounts = counts[station];
      result.morningNightCage += stationCounts.morning.cage + stationCounts.night.cage;
      result.morningNightPallet += stationCounts.morning.pallet + stationCounts.night.pallet;
      result.transitTotal += stationCounts.transit.cage + stationCounts.transit.pallet;
      return result;
    }, {
      morningNightCage: preMidnight.cage,
      morningNightPallet: preMidnight.pallet,
      transitTotal: 0,
      preMidnightCage: preMidnight.cage,
      preMidnightPallet: preMidnight.pallet,
      preMidnightTotal: preMidnight.total,
    });
    return overview;
  }

  function makeWorkLogText(shift) {
    migrateShift(shift);
    const stats = computeAllStats(shift, 'ALL');
    const cageStats = computeAllStats(shift, 'cage');
    const palletStats = computeAllStats(shift, 'pallet');
    const totals = computeTotals(shift, 'ALL');
    const returns = computeCombinedReturnCounts(shift);
    const buckets = computeReturnBuckets(shift);
    const lines = [
      `日期：${shift.date}`, '',
      `03:00 CS／Ct＋S 回報總數：${totals.REPORT03.reportTotal}`,
      `05:00 NS／Nt／TS／Tt／E 回報總數：${totals.REPORT05.reportTotal}`,
      `全部回報總數：${totals.ALL.reportTotal}`, '',
      `00前已載走：${makePreMidnightLoadedSummaryText(shift)}`, '',
      '回倉紀錄：',
    ];
    if (!buckets.length) lines.push('無');
    buckets.forEach((bucket) => {
      const details = Object.entries(bucket.sources)
        .filter(([, value]) => value.total > 0)
        .map(([source, value]) => `${source} ${value.total}（${value.cage}籠／${value.pallet}板）`)
        .join('、');
      const noteText = bucket.notes?.length ? `｜備註：${bucket.notes.map((item) => item.text).join('；')}` : '';
      lines.push(`${bucket.label}｜${details || '無'}${noteText}`);
    });
    lines.push(`回倉合計（含00前）：${returns.carrierTotals.total}（${returns.carrierTotals.cage}籠／${returns.carrierTotals.pallet}板）`);
    lines.push('', '站所統計：');
    STATIONS.forEach((station) => {
      const s = stats[station];
      lines.push(`${displayStationName(station)}｜中${s.morning}｜夜${s.night}｜過${s.transit}｜二${s.secondary}｜待轉${s.online}｜回報${s.reportTotal}（${cageStats[station].reportTotal}籠／${palletStats[station].reportTotal}板）｜載${s.loaded}｜應有${s.expected}｜現${s.actual}｜差${s.difference}`);
    });
    return lines.join('\n');
  }

  return {
    VERSION, CHUTES, STATIONS, STATION_RENAMES, SERIES_PREFIX_ALIASES, SERIES_ORDER, SERIES_GROUPS, GROUP_ORDER, STATION_GROUPS, REPORT_GROUPS, ONLINE_BULK_STATIONS, RETURN_SOURCES, RETURN_REPORT_SOURCE_ORDER, PRE_MIDNIGHT_DEFAULT_STATIONS,
    CARRIERS, CARRIER_LABELS, CAGE_DEFAULT_STATIONS, CATEGORIES, CATEGORY_LABELS, SPECIAL_EDIT_CATEGORIES, SPECIAL_SIGNATURE_CATEGORIES,
    uid, nowIso, localDate, naturalStationSort, operationalStationSort, canonicalStationName, displayStationName, stationSeries, stationGroup, stationLabelColorGroup, defaultCarrierForStation, otherCarrier, normalizeCarrier,
    createShift, migrateShift, preMidnightStationCounts, computePreMidnightLoaded, setPreMidnightLoadedCount, adjustPreMidnightLoadedCount, addPreMidnightExtraStation, removePreMidnightExtraStation, completePreMidnightLoaded, reopenPreMidnightLoaded, clearPreMidnightLegacyCage, makePreMidnightLoadedSummaryText,
    emptyCounts, computeCounts, countFor, recomputeEventAfters,
    stationStats, computeAllStats, computeTotals, addEvent, setCount, specialInventorySignatureFromCount, specialInventorySignature, specialInventoryConfirmation, isSpecialInventoryConfirmed, confirmSpecialInventoryStation, clearSpecialInventoryConfirmation, chooseCarrierToDecrement,
    convertOnlineToSecondary, addOnlineToStations, addOnlineToAllStations, convertAllOnlineToSecondary,
    undoLastOperation, undoOperation, editEvent, deleteEvent,
    preMidnightReturnSourceCounts, setPreMidnightReturnCount, adjustPreMidnightReturnCount, computePreMidnightReturnCounts, completePreMidnightReturns, reopenPreMidnightReturns,
    adjustReturnCount, adjustReturnBucketCount, returnBucketSourceCounts, computeCurrentReturnBucketCounts, computeReturnCounts, computeCombinedReturnCounts, halfHourBucket, addReturnNote, deleteReturnNote, computeReturnBuckets, currentReturnBucket,
    csvEscape, makeShiftCSV, makeReturnBatchCSV, makeReturnReportText, makeMorningReportText,
    fastReportStationStats, computeFastReportStats, confirmActualEntry, findFastReportAnomalies,
    compactCarrierQuantity, toFullWidthReportText, reportTextWidth, padReportCell,
    makeReportText, makeTransitReportText, makeLoadedSummaryText, computeStatsOverview, makeWorkLogText,
  };
});
