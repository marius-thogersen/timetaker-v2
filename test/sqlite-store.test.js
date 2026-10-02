'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteStore } = require('../server/domain/sqlite-store');
const { createRace, recordScan, excludeScan } = require('../server/domain/race');

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'timetaker-store-')), 'race.sqlite');
}

test('an excluded scan survives a save/load round trip (regression: schema was missing the columns)', () => {
  const dbPath = tempDbPath();
  const store = new SqliteStore(dbPath);

  const state = createRace();
  recordScan(state, { time: new Date().toISOString(), code: 'ABC123' });
  const scanId = state.scans[0].id;
  excludeScan(state, scanId, 'Known bad tag, re-scanned manually');

  store.save(state);

  // Simulate a server restart: a brand new store instance re-reading the
  // same file, the same way the real app does on startup.
  const reloaded = new SqliteStore(dbPath).load(createRace);
  const scan = reloaded.scans.find((s) => s.id === scanId);

  assert.equal(scan.excluded, true);
  assert.equal(scan.excludeReason, 'Known bad tag, re-scanned manually');
});

test('a normal (non-excluded) scan still round trips with excluded false and no reason', () => {
  const dbPath = tempDbPath();
  const store = new SqliteStore(dbPath);

  const state = createRace();
  recordScan(state, { time: new Date().toISOString(), code: 'XYZ789' });
  store.save(state);

  const reloaded = new SqliteStore(dbPath).load(createRace);
  const scan = reloaded.scans[0];

  assert.equal(scan.excluded, false);
  assert.equal(scan.excludeReason, null);
});
