import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RECORDS,
  STORAGE_KEY,
  createSession,
  finishSession,
  formatDuration,
  formatRecordLine,
  loadRecords,
  noteSecond,
  normalizeOffsetMinutes,
  saveRecord
} from '../agent/lib/records.js';

function fakeStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value))
  };
}

test('per-second notes replace earlier entries for the same second', () => {
  const session = createSession({ startedAt: 1000, targetCadence: 180 });
  noteSecond(session, { second: 0, cadence: 0, steps: 1 });
  noteSecond(session, { second: 1, cadence: 178.4, steps: 3 });
  noteSecond(session, { second: 1, cadence: 181, steps: 3 });
  noteSecond(session, { second: -1, cadence: 181, steps: 3 });
  assert.deepEqual(session.seconds, [[0, 0, 1], [1, 181, 3]]);
});

test('finishSession summarises cadence, target ratio, and duration', () => {
  const session = createSession({ startedAt: 5000, targetCadence: 180, source: 'gyroscope' });
  const cadences = [0, 170, 176, 180, 184, 190, 0, 178];
  cadences.forEach((cadence, second) => noteSecond(session, { second, cadence, steps: 3 }));
  const record = finishSession(session, { endedAt: 15000, activeMs: 8000.4, steps: 24 });
  assert.equal(record.id, '5000');
  assert.equal(record.avgCadence, Math.round((170 + 176 + 180 + 184 + 190 + 178) / 6));
  assert.equal(record.inTargetRatio, 4 / 6);
  assert.equal(record.activeMs, 8000);
  assert.equal(record.steps, 24);
  assert.equal(record.series.length, 8);
  assert.equal(record.source, 'gyroscope');
});

test('records are saved newest first, capped, and tolerate corrupt storage', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: '{not json' });
  assert.deepEqual(loadRecords(storage), []);
  for (let index = 0; index < MAX_RECORDS + 3; index += 1) {
    const session = createSession({ startedAt: index * 1000, targetCadence: 180 });
    saveRecord(storage, finishSession(session, { endedAt: index * 1000 + 500, activeMs: 500, steps: 1 }));
  }
  const records = loadRecords(storage);
  assert.equal(records.length, MAX_RECORDS);
  assert.equal(records[0].startedAt, (MAX_RECORDS + 2) * 1000);
  // Saving the same record again replaces it instead of duplicating it.
  saveRecord(storage, records[0]);
  assert.equal(loadRecords(storage).length, MAX_RECORDS);
  assert.deepEqual(loadRecords(null), []);
  assert.deepEqual(loadRecords({ getItem: () => { throw new Error('denied'); } }), []);
  const broken = fakeStorage({ [STORAGE_KEY]: JSON.stringify([{ nope: true }, 3]) });
  assert.deepEqual(loadRecords(broken), []);
});

test('formatting helpers', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(65_000), '01:05');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  assert.equal(normalizeOffsetMinutes(-480), 480);
  assert.equal(normalizeOffsetMinutes(-28800), 480);
  assert.equal(normalizeOffsetMinutes(0), 0);
  assert.equal(normalizeOffsetMinutes(undefined), 0);
  const record = {
    startedAt: Date.UTC(2026, 8, 11, 9, 5),
    activeMs: 1_830_000,
    steps: 5400,
    avgCadence: 177,
    source: 'demo'
  };
  assert.equal(formatRecordLine(record, 480), '9/11 17:05 · 30:30 · 5400 steps · avg 177 spm · demo');
  assert.equal(formatRecordLine({ ...record, source: 'gyroscope' }, 0), '9/11 09:05 · 30:30 · 5400 steps · avg 177 spm');
});
