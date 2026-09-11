// Run records: per-second aggregation while running, a summary at the end,
// and persistence in the agent-private localStorage (injected so tests use a
// plain object). Records never include raw sensor samples; they keep one
// entry per active second: [second, cadence, steps].

export const STORAGE_KEY = 'doublerunner.records.v1';
export const MAX_RECORDS = 20;
export const MAX_SECONDS = 3 * 60 * 60;
export const TARGET_TOLERANCE = 5;

export function createSession(options) {
  return {
    startedAt: options.startedAt,
    targetCadence: options.targetCadence,
    source: options.source || 'gyroscope',
    seconds: []
  };
}

// Records the aggregate of one active second. A later call for the same
// second replaces the earlier entry.
export function noteSecond(session, entry) {
  if (entry.second < 0 || entry.second >= MAX_SECONDS) return;
  const point = [entry.second, Math.round(entry.cadence || 0), entry.steps || 0];
  const last = session.seconds[session.seconds.length - 1];
  if (last && last[0] === entry.second) session.seconds[session.seconds.length - 1] = point;
  else session.seconds.push(point);
}

export function finishSession(session, options) {
  const active = session.seconds.filter((point) => point[1] > 0);
  const avgCadence = active.length
    ? Math.round(active.reduce((sum, point) => sum + point[1], 0) / active.length)
    : 0;
  const inTarget = active.filter(
    (point) => Math.abs(point[1] - session.targetCadence) <= TARGET_TOLERANCE
  ).length;
  return {
    id: String(session.startedAt),
    startedAt: session.startedAt,
    endedAt: options.endedAt,
    activeMs: Math.max(0, Math.round(options.activeMs || 0)),
    steps: options.steps || 0,
    avgCadence,
    targetCadence: session.targetCadence,
    inTargetRatio: active.length ? inTarget / active.length : 0,
    source: session.source,
    series: session.seconds.slice()
  };
}

function isRecord(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.startedAt === 'number' &&
    typeof value.activeMs === 'number' &&
    Array.isArray(value.series)
  );
}

export function loadRecords(storage) {
  if (!storage || typeof storage.getItem !== 'function') return [];
  let raw = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (_error) {
    return [];
  }
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch (_error) {
    return [];
  }
}

// Newest first; returns the list that was written.
export function saveRecord(storage, record) {
  const others = loadRecords(storage).filter((item) => item.id !== record.id);
  const kept = [record].concat(others).slice(0, MAX_RECORDS);
  if (storage && typeof storage.setItem === 'function') {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(kept));
    } catch (_error) {
      // Storage full or unavailable: the record still exists in memory for
      // this Page; nothing else to do.
    }
  }
  return kept;
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  return hours ? hours + ':' + mmss : mmss;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// The runtime's getTimezoneOffset() has been seen in UTC and in seconds;
// normalise it to minutes east of UTC.
export function normalizeOffsetMinutes(rawOffset) {
  if (typeof rawOffset !== 'number' || !Number.isFinite(rawOffset)) return 0;
  const east = 0 - rawOffset;
  const minutes = Math.abs(east) > 16 * 60 ? Math.round(east / 60) : Math.round(east);
  return minutes || 0;
}

export function formatRecordLine(record, offsetMinutes) {
  const shifted = new Date(record.startedAt + (offsetMinutes || 0) * 60000);
  const stamp =
    shifted.getUTCMonth() + 1 + '/' + shifted.getUTCDate() + ' ' +
    pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes());
  const demo = record.source === 'demo' ? ' · 演示' : '';
  return (
    stamp + ' · ' + formatDuration(record.activeMs) + ' · ' + record.steps + ' 步 · 平均 ' +
    record.avgCadence + ' spm' + demo
  );
}
