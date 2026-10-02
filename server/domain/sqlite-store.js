'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_MIN_LAP_SECONDS } = require('./race');

/**
 * Loads and saves the single race using a real SQLite database file
 * (via Node's built-in node:sqlite — no extra packages to install on the
 * user's PC, but the data is still a normal .sqlite file they can open with
 * any SQLite browser if they ever want to look under the hood).
 *
 * The tables are normalized (participants, scans, paused_intervals) purely
 * so the file is easy to inspect/query directly; the app itself still reads
 * the whole race into memory and writes it back as a whole on every change,
 * the same simple pattern the previous JSON-file store used.
 */
class SqliteStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  open() {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS race_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS heats (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        start_at TEXT,
        duration_minutes INTEGER
      );
      CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        gender TEXT NOT NULL,
        rfid_code TEXT,
        heat_id INTEGER NOT NULL DEFAULT 1,
        start_number INTEGER
      );
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY,
        time TEXT NOT NULL,
        code TEXT NOT NULL,
        excluded INTEGER NOT NULL DEFAULT 0,
        exclude_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS paused_intervals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_time TEXT NOT NULL,
        to_time TEXT
      );
      CREATE TABLE IF NOT EXISTS race_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        participant_count INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    this.migrate();
    return this.db;
  }

  /** Small forward-only migrations for databases created before a column
   *  existed — `ALTER TABLE ADD COLUMN` only runs if the column is missing,
   *  so this is safe to run on every startup against an already-migrated
   *  database too. */
  migrate() {
    const columns = this.db.prepare("PRAGMA table_info(participants)").all().map((c) => c.name);
    if (!columns.includes('rfid_assigned_at')) {
      this.db.exec('ALTER TABLE participants ADD COLUMN rfid_assigned_at TEXT');
    }
    const scanColumns = this.db.prepare("PRAGMA table_info(scans)").all().map((c) => c.name);
    if (!scanColumns.includes('excluded')) {
      this.db.exec('ALTER TABLE scans ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0');
    }
    if (!scanColumns.includes('exclude_reason')) {
      this.db.exec('ALTER TABLE scans ADD COLUMN exclude_reason TEXT');
    }
  }


  load(createDefault) {
    const db = this.open();
    const metaRows = db.prepare('SELECT key, value FROM race_meta').all();

    if (metaRows.length === 0) {
      // Fresh database: seed it with a default race so the file always
      // reflects exactly what's in memory from the very first run.
      const fresh = createDefault();
      this.save(fresh);
      return fresh;
    }

    const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
    const heats = db
      .prepare('SELECT id, name, start_at AS startAt, duration_minutes AS durationMinutes FROM heats ORDER BY id')
      .all()
      .map((h) => ({ ...h, startAt: h.startAt || null, durationMinutes: h.durationMinutes || null }));
    const participants = db
      .prepare('SELECT id, name, gender, rfid_code AS rfidCode, rfid_assigned_at AS rfidAssignedAt, heat_id AS heatId, start_number AS startNumber FROM participants ORDER BY id')
      .all()
      .map((p) => ({ ...p, rfidAssignedAt: p.rfidAssignedAt || null }));
    const scans = db
      .prepare('SELECT id, time, code, excluded, exclude_reason AS excludeReason FROM scans ORDER BY id')
      .all()
      .map((s) => ({ ...s, excluded: Boolean(s.excluded), excludeReason: s.excludeReason || null }));
    const pausedIntervals = db
      .prepare('SELECT from_time AS "from", to_time AS "to" FROM paused_intervals ORDER BY id')
      .all();

    return {
      status: meta.status || 'signup',
      endedAt: meta.endedAt || null,
      lapDistanceMeters: meta.lapDistanceMeters ? Number(meta.lapDistanceMeters) : null,
      minLapSeconds: meta.minLapSeconds ? Number(meta.minLapSeconds) : DEFAULT_MIN_LAP_SECONDS,
      pausedIntervals,
      nextParticipantId: Number(meta.nextParticipantId || 1),
      nextHeatId: Number(meta.nextHeatId || 2),
      heats: heats.length > 0 ? heats : [{ id: 1, name: 'Heat 1', startAt: null, durationMinutes: null }],
      participants,
      nextScanId: Number(meta.nextScanId || 1),
      scans,
    };
  }

  save(state) {
    const db = this.open();
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM heats');
      db.exec('DELETE FROM participants');
      db.exec('DELETE FROM scans');
      db.exec('DELETE FROM paused_intervals');

      const insertHeat = db.prepare('INSERT INTO heats (id, name, start_at, duration_minutes) VALUES (?, ?, ?, ?)');
      for (const h of state.heats) {
        insertHeat.run(h.id, h.name, h.startAt, h.durationMinutes || null);
      }

      const insertParticipant = db.prepare(
        'INSERT INTO participants (id, name, gender, rfid_code, rfid_assigned_at, heat_id, start_number) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const p of state.participants) {
        insertParticipant.run(p.id, p.name, p.gender, p.rfidCode, p.rfidAssignedAt || null, p.heatId, p.startNumber || null);
      }

      const insertScan = db.prepare('INSERT INTO scans (id, time, code, excluded, exclude_reason) VALUES (?, ?, ?, ?, ?)');
      for (const s of state.scans) {
        insertScan.run(s.id, s.time, s.code, s.excluded ? 1 : 0, s.excludeReason || null);
      }

      const insertPaused = db.prepare(
        'INSERT INTO paused_intervals (from_time, to_time) VALUES (?, ?)'
      );
      for (const interval of state.pausedIntervals || []) {
        insertPaused.run(interval.from, interval.to);
      }

      const upsertMeta = db.prepare(
        'INSERT INTO race_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
      upsertMeta.run('status', state.status);
      upsertMeta.run('endedAt', state.endedAt || '');
      upsertMeta.run('lapDistanceMeters', state.lapDistanceMeters ? String(state.lapDistanceMeters) : '');
      upsertMeta.run('minLapSeconds', state.minLapSeconds ? String(state.minLapSeconds) : '');
      upsertMeta.run('nextParticipantId', String(state.nextParticipantId));
      upsertMeta.run('nextHeatId', String(state.nextHeatId));
      upsertMeta.run('nextScanId', String(state.nextScanId));

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Archives a full race snapshot (taken *before* it's cleared for reuse)
   *  so it stays available in Race History even after "New race from this
   *  template" wipes the live race's scans. Stored as one JSON blob since
   *  it's never queried piecemeal — only ever loaded back out whole. */
  addArchive(label, snapshot) {
    const db = this.open();
    const archivedAt = new Date().toISOString();
    db.prepare(
      'INSERT INTO race_archive (label, archived_at, participant_count, data) VALUES (?, ?, ?, ?)'
    ).run(label, archivedAt, snapshot.participants.length, JSON.stringify(snapshot));
    return { archivedAt };
  }

  /** Lightweight list for the Race History page — no need to parse every
   *  snapshot's JSON blob just to show a list of past races. */
  listArchives() {
    const db = this.open();
    return db
      .prepare('SELECT id, label, archived_at AS archivedAt, participant_count AS participantCount FROM race_archive ORDER BY id DESC')
      .all();
  }

  /** The full snapshot for one archived race, or null if it doesn't exist. */
  getArchive(id) {
    const db = this.open();
    const row = db.prepare('SELECT data FROM race_archive WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }
}

module.exports = { SqliteStore };
