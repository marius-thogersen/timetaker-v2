'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const race = require('./domain/race');
const { SqliteStore } = require('./domain/sqlite-store');
const { leaderboardToCsv } = require('./domain/csv');

const HTTP_PORT = 4577;
// Loopback-only, matches the port timetaker's rfid_reader.py already talks to.
const SCAN_PORT = 45677;
const HOST = '127.0.0.1';

const DATA_FILE = path.join(__dirname, '..', 'data', 'race.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new SqliteStore(DATA_FILE);
const state = store.load(race.createRace);

function persist() {
  store.save(state);
}

// Every console line gets a timestamp, so operators (and anyone reading a
// redirected log file) can tell exactly when something happened, no matter
// how long the server has been running unattended. Matches the format used
// by rfid_reader.py's console/app.log output: local wall-clock time plus
// its UTC offset, e.g. "2026-10-02 13:47:17 +0200".
function pad(number, width = 2) {
  return String(number).padStart(width, '0');
}

function formatTimestamp(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offsetAbs = Math.abs(offsetMinutes);
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const offsetPart = `${offsetSign}${pad(Math.floor(offsetAbs / 60))}${pad(offsetAbs % 60)}`;
  return `${datePart} ${timePart} ${offsetPart}`;
}

function logLine(...args) {
  console.log(`[${formatTimestamp(new Date())}]`, ...args);
}
function logErrorLine(...args) {
  console.error(`[${formatTimestamp(new Date())}]`, ...args);
}

let lastScanReceivedAt = null;

// ---------------------------------------------------------------------------
// Scan socket server: same newline-delimited JSON protocol as TimeTaker's
// scan_server.rs, so rfid-reader/rfid_reader.py works completely unmodified.
// ---------------------------------------------------------------------------
const scanServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      handleScanLine(socket, line);
    }
  });

  socket.on('error', () => {
    // A reader disconnecting mid-write is normal (race over, app closed).
  });
});

function handleScanLine(socket, line) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch (error) {
    writeReply(socket, { status: 'error', message: `invalid payload: ${error.message}` });
    return;
  }

  try {
    const scan = race.recordScan(state, payload);
    lastScanReceivedAt = new Date().toISOString();
    persist();
    writeReply(socket, { status: 'ok', id: scan.id });
  } catch (error) {
    writeReply(socket, { status: 'error', message: error.message });
  }
}

function writeReply(socket, reply) {
  try {
    socket.write(`${JSON.stringify(reply)}\n`);
  } catch (error) {
    // Reader already disconnected; nothing to do.
  }
}

// ---------------------------------------------------------------------------
// HTTP server: a small hand-rolled router (no framework) serving the static
// frontend plus a JSON API.
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function publicState() {
  const openPause = state.pausedIntervals.find((interval) => interval.to === null);
  return {
    status: state.status,
    endedAt: state.endedAt || null,
    heats: state.heats,
    lapDistanceMeters: state.lapDistanceMeters,
    minLapSeconds: state.minLapSeconds,
    stoppedAt: openPause ? openPause.from : null,
    participants: state.participants,
    genders: race.GENDERS,
    lastScanReceivedAt,
    scanCount: state.scans.length,
  };
}

/** Human-friendly label for an archived race, e.g. "2026-10-02 14:30" —
 *  local time, matching how the rest of the app displays dates/times. */
function formatArchiveLabel(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(csv),
  });
  res.end(csv);
}

function sendJsonDownload(res, filename, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function serveStaticFile(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, path.normalize(requestPath).replace(/^([.]{2}[/\\])+/, ''));

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      // The whole app is just a handful of static files served straight off
      // disk — always serve the latest copy instead of letting the browser
      // cache a stale version across restarts/updates.
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      return sendJson(res, 200, race.getLeaderboard(state));
    }

    const lapsMatch = url.pathname.match(/^\/api\/participants\/(\d+)\/laps$/);
    if (lapsMatch && req.method === 'GET') {
      return sendJson(res, 200, race.getLapHistory(state, Number(lapsMatch[1])));
    }

    if (url.pathname === '/api/scans' && req.method === 'GET') {
      const participantIdParam = url.searchParams.get('participantId');
      const participantId = participantIdParam ? Number(participantIdParam) : undefined;
      return sendJson(res, 200, race.getScanHistory(state, { participantId }));
    }

    const scanMatch = url.pathname.match(/^\/api\/scans\/(\d+)$/);
    if (scanMatch && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      race.editScan(state, Number(scanMatch[1]), body);
      persist();
      return sendJson(res, 200, race.getScanHistory(state));
    }
    if (scanMatch && req.method === 'DELETE') {
      race.removeScan(state, Number(scanMatch[1]));
      persist();
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/participants' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const participant = race.addParticipant(state, body);
      persist();
      return sendJson(res, 201, participant);
    }

    const participantMatch = url.pathname.match(/^\/api\/participants\/(\d+)$/);
    if (participantMatch && req.method === 'DELETE') {
      race.removeParticipant(state, Number(participantMatch[1]));
      persist();
      return sendJson(res, 200, { ok: true });
    }

    const participantRfidMatch = url.pathname.match(/^\/api\/participants\/(\d+)\/rfid-code$/);
    if (participantRfidMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      race.setParticipantRfidCode(state, Number(participantRfidMatch[1]), body.rfidCode);
      persist();
      return sendJson(res, 200, publicState());
    }

    const participantStartNumberMatch = url.pathname.match(/^\/api\/participants\/(\d+)\/start-number$/);
    if (participantStartNumberMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      race.setParticipantStartNumber(state, Number(participantStartNumberMatch[1]), body.startNumber);
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/race/start' && req.method === 'POST') {
      race.startRace(state);
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/race/stop' && req.method === 'POST') {
      race.stopRace(state);
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/race/resume' && req.method === 'POST') {
      race.resumeRace(state);
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/race/end' && req.method === 'POST') {
      race.endRace(state);
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/race/new-from-template' && req.method === 'POST') {
      // Snapshot first (cheap, pure in-memory clone) — if the status check
      // inside newRaceFromTemplate throws, nothing has been archived or
      // changed yet.
      const snapshot = JSON.parse(JSON.stringify(state));
      race.newRaceFromTemplate(state);
      const label = formatArchiveLabel(new Date(snapshot.endedAt || Date.now()));
      store.addArchive(label, snapshot);
      lastScanReceivedAt = null;
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/export/leaderboard.json' && req.method === 'GET') {
      return sendJsonDownload(res, 'leaderboard.json', race.getLeaderboard(state));
    }

    if (url.pathname === '/api/export/leaderboard.csv' && req.method === 'GET') {
      return sendCsv(res, 'leaderboard.csv', leaderboardToCsv(race.getLeaderboard(state)));
    }

    if (url.pathname === '/api/archive' && req.method === 'GET') {
      return sendJson(res, 200, store.listArchives());
    }

    const archiveLeaderboardMatch = url.pathname.match(/^\/api\/archive\/(\d+)\/leaderboard$/);
    if (archiveLeaderboardMatch && req.method === 'GET') {
      const snapshot = store.getArchive(Number(archiveLeaderboardMatch[1]));
      if (!snapshot) return sendJson(res, 404, { error: 'No such archived race.' });
      return sendJson(res, 200, race.getLeaderboard(snapshot));
    }

    const archiveExportJsonMatch = url.pathname.match(/^\/api\/archive\/(\d+)\/export\.json$/);
    if (archiveExportJsonMatch && req.method === 'GET') {
      const snapshot = store.getArchive(Number(archiveExportJsonMatch[1]));
      if (!snapshot) return sendJson(res, 404, { error: 'No such archived race.' });
      return sendJsonDownload(res, `race-${archiveExportJsonMatch[1]}-leaderboard.json`, race.getLeaderboard(snapshot));
    }

    const archiveExportCsvMatch = url.pathname.match(/^\/api\/archive\/(\d+)\/export\.csv$/);
    if (archiveExportCsvMatch && req.method === 'GET') {
      const snapshot = store.getArchive(Number(archiveExportCsvMatch[1]));
      if (!snapshot) return sendJson(res, 404, { error: 'No such archived race.' });
      return sendCsv(res, `race-${archiveExportCsvMatch[1]}-leaderboard.csv`, leaderboardToCsv(race.getLeaderboard(snapshot)));
    }

    if (url.pathname === '/api/race/start-time' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const heatId = body.heatId !== undefined ? Number(body.heatId) : state.heats[0].id;
      race.setHeatStartTime(state, heatId, body.startAt);
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/heats' && req.method === 'POST') {
      const body = await readJsonBody(req);
      race.addHeat(state, body.name);
      persist();
      return sendJson(res, 201, publicState());
    }

    const heatMatch = url.pathname.match(/^\/api\/heats\/(\d+)$/);
    if (heatMatch && req.method === 'DELETE') {
      race.removeHeat(state, Number(heatMatch[1]));
      persist();
      return sendJson(res, 200, publicState());
    }

    const heatStartTimeMatch = url.pathname.match(/^\/api\/heats\/(\d+)\/start-time$/);
    if (heatStartTimeMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      race.setHeatStartTime(state, Number(heatStartTimeMatch[1]), body.startAt);
      persist();
      return sendJson(res, 200, publicState());
    }

    const heatNameMatch = url.pathname.match(/^\/api\/heats\/(\d+)\/name$/);
    if (heatNameMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      race.renameHeat(state, Number(heatNameMatch[1]), body.name);
      persist();
      return sendJson(res, 200, publicState());
    }

    const heatDurationMatch = url.pathname.match(/^\/api\/heats\/(\d+)\/duration$/);
    if (heatDurationMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      race.setHeatDurationMinutes(state, Number(heatDurationMatch[1]), body.durationMinutes);
      persist();
      return sendJson(res, 200, publicState());
    }

    const participantHeatMatch = url.pathname.match(/^\/api\/participants\/(\d+)\/heat$/);
    if (participantHeatMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      race.assignParticipantHeat(state, Number(participantHeatMatch[1]), Number(body.heatId));
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/race/lap-distance' && req.method === 'POST') {
      const body = await readJsonBody(req);
      race.setLapDistance(state, body.lapDistanceMeters);
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/race/min-lap-seconds' && req.method === 'POST') {
      const body = await readJsonBody(req);
      race.setMinLapSeconds(state, body.minLapSeconds);
      persist();
      return sendJson(res, 200, publicState());
    }

    if (url.pathname === '/api/race/reset' && req.method === 'POST') {
      race.resetRace(state);
      lastScanReceivedAt = null;
      persist();
      return sendJson(res, 200, publicState());
    }

    if (req.method === 'GET') {
      return serveStaticFile(req, res);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    if (error instanceof race.DomainError) {
      return sendJson(res, 400, { error: error.message });
    }
    logErrorLine(error);
    return sendJson(res, 500, { error: 'internal error' });
  }
});

httpServer.listen(HTTP_PORT, HOST, () => {
  logLine(`TimeTaker v2 running at http://${HOST}:${HTTP_PORT}`);
});

scanServer.listen(SCAN_PORT, HOST, () => {
  logLine(`Listening for RFID scans on ${HOST}:${SCAN_PORT}`);
});
