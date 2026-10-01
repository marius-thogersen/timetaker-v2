'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const race = require('./domain/race');
const { Store } = require('./domain/store');

const HTTP_PORT = 4577;
// Loopback-only, matches the port timetaker's rfid_reader.py already talks to.
const SCAN_PORT = 45677;
const HOST = '127.0.0.1';

const DATA_FILE = path.join(__dirname, '..', 'data', 'race.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new Store(DATA_FILE);
const state = store.load(race.createRace);

function persist() {
  store.save(state);
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
  return {
    status: state.status,
    startedAt: state.startedAt,
    participants: state.participants,
    genders: race.GENDERS,
    lastScanReceivedAt,
    scanCount: state.scans.length,
  };
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
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
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

    if (url.pathname === '/api/race/start' && req.method === 'POST') {
      race.startRace(state);
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
    console.error(error);
    return sendJson(res, 500, { error: 'internal error' });
  }
});

httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`TimeTaker v2 running at http://${HOST}:${HTTP_PORT}`);
});

scanServer.listen(SCAN_PORT, HOST, () => {
  console.log(`Listening for RFID scans on ${HOST}:${SCAN_PORT}`);
});
