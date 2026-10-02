'use strict';

/**
 * Race simulator — a standalone dev/demo tool, completely separate from the
 * real app. It pretends to be an RFID reader: it fetches whoever is
 * currently signed up (via the normal HTTP API) and then sends fake scans
 * for them over the same TCP socket the real `rfid_reader.py` uses
 * (127.0.0.1:45677, newline-delimited JSON — see docs/scan-flow.md).
 *
 * Zero changes to server/domain code were needed to build this: it only
 * talks to already-existing, documented interfaces. To remove the entire
 * feature, delete this one file (and this tools/ folder, if nothing else
 * is added to it) — nothing else references it.
 *
 * Usage (run from the repo root, with the server already running):
 *   node tools/simulate-race.js
 *   node tools/simulate-race.js --participants 8 --duration 2 --speed 20
 *   node tools/simulate-race.js --port 4577 --min-lap 8 --max-lap 25
 *
 * Flags:
 *   --host <host>          TimeTaker HTTP host (default 127.0.0.1)
 *   --port <port>          TimeTaker HTTP port (default 4577)
 *   --scan-port <port>     TimeTaker scan socket port (default 45677)
 *   --participants <n>     If nobody is signed up yet, create N fake
 *                          participants first (default 6, only used when
 *                          the race has zero participants)
 *   --duration <minutes>   How long to keep simulating (default 5)
 *   --speed <x>            Time multiplier: how much faster than real time
 *                          the simulated race runs (default 10x)
 *   --min-lap <seconds>    Fastest simulated lap, real race time (default 20)
 *   --max-lap <seconds>    Slowest simulated lap, real race time (default 60)
 *   --no-start             Don't call /api/race/start; assume it's already
 *                          running (useful to layer scans onto a live race)
 */

const http = require('node:http');
const net = require('node:net');

function parseArgs(argv) {
  const args = {
    host: '127.0.0.1',
    port: 4577,
    scanPort: 45677,
    participants: 6,
    duration: 5,
    speed: 10,
    minLap: 20,
    maxLap: 60,
    start: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--host': args.host = next(); break;
      case '--port': args.port = Number(next()); break;
      case '--scan-port': args.scanPort = Number(next()); break;
      case '--participants': args.participants = Number(next()); break;
      case '--duration': args.duration = Number(next()); break;
      case '--speed': args.speed = Number(next()); break;
      case '--min-lap': args.minLap = Number(next()); break;
      case '--max-lap': args.maxLap = Number(next()); break;
      case '--no-start': args.start = false; break;
      case '--help': case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown flag: ${flag} (see --help)`);
        process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Race simulator — generates fake RFID scans against a running TimeTaker server.

Usage: node tools/simulate-race.js [flags]

  --host <host>          TimeTaker HTTP host (default 127.0.0.1)
  --port <port>          TimeTaker HTTP port (default 4577)
  --scan-port <port>     TimeTaker scan socket port (default 45677)
  --participants <n>     Create N fake participants if none exist (default 6)
  --duration <minutes>   How long to simulate, in real wall-clock minutes (default 5)
  --speed <x>            Simulated-race speedup multiplier (default 10x)
  --min-lap <seconds>    Fastest simulated lap (default 20)
  --max-lap <seconds>    Slowest simulated lap (default 60)
  --no-start             Don't call /api/race/start (assume already running)
`);
}

function httpRequest({ host, port, method, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host,
        port,
        method,
        path,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            /* non-JSON response, leave parsed as null */
          }
          if (res.statusCode >= 400) {
            reject(new Error(`${method} ${path} -> ${res.statusCode}: ${data}`));
          } else {
            resolve(parsed);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const FIRST_NAMES = [
  'Alex', 'Jamie', 'Sam', 'Jordan', 'Morgan', 'Casey', 'Taylor', 'Riley',
  'Drew', 'Skyler', 'Quinn', 'Avery', 'Rowan', 'Dana', 'Kim', 'Lane',
];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fakeRfidCode(n) {
  // Matches the real reader's format: 10 digits, starting with 0.
  return '0' + String(n).padStart(9, '9').slice(-9);
}

async function ensureParticipants(args) {
  const state = await httpRequest({ host: args.host, port: args.port, method: 'GET', path: '/api/state' });
  if (state.participants.length > 0) {
    console.log(`Found ${state.participants.length} existing participant(s), reusing them.`);
    return state.participants;
  }

  console.log(`No participants signed up yet — creating ${args.participants} fake ones.`);
  const created = [];
  for (let i = 1; i <= args.participants; i++) {
    const participant = await httpRequest({
      host: args.host,
      port: args.port,
      method: 'POST',
      path: '/api/participants',
      body: {
        name: `${randomChoice(FIRST_NAMES)} #${i}`,
        gender: randomChoice(['female', 'male', 'other']),
        rfidCode: fakeRfidCode(i),
      },
    });
    created.push(participant);
  }
  return created;
}

function sendScan({ host, scanPort }, code, isoTime) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: scanPort }, () => {
      socket.write(JSON.stringify({ time: isoTime, code }) + '\n');
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        socket.end();
      }
    });
    socket.on('close', () => resolve(buffer.trim()));
    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error('scan socket timed out'));
    });
  });
}

/** One independent "runner": keeps scanning in its own lap-time loop for the
 *  whole simulated duration, without blocking the others. */
async function runParticipant(args, participant, untilRealMs) {
  while (Date.now() < untilRealMs) {
    const lapRealMs = (args.minLap + Math.random() * (args.maxLap - args.minLap)) * 1000 / args.speed;
    await sleep(lapRealMs);
    if (Date.now() >= untilRealMs) break;
    try {
      const reply = await sendScan(args, participant.rfidCode, new Date().toISOString());
      const parsed = JSON.parse(reply || '{}');
      const mark = parsed.status === 'ok' ? '✓' : `✗ (${parsed.message || 'rejected'})`;
      console.log(`  ${mark} ${participant.name} scanned`);
    } catch (error) {
      console.error(`  ! ${participant.name}: ${error.message}`);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Simulating against http://${args.host}:${args.port} (scan socket :${args.scanPort})`);
  const participants = await ensureParticipants(args);
  if (participants.length === 0) {
    console.error('No participants to simulate with — aborting.');
    process.exit(1);
  }

  if (args.start) {
    try {
      await httpRequest({ host: args.host, port: args.port, method: 'POST', path: '/api/race/start' });
      console.log('Race started.');
    } catch (error) {
      console.log(`(Didn't start the race — ${error.message}; assuming it's already running.)`);
    }
  }

  console.log(
    `Simulating ${participants.length} participant(s) for ${args.duration} real minute(s) ` +
      `at ${args.speed}x speed (laps ${args.minLap}-${args.maxLap}s)...`
  );
  const untilRealMs = Date.now() + args.duration * 60 * 1000;
  await Promise.all(participants.map((p) => runParticipant(args, p, untilRealMs)));

  console.log('Simulation finished.');
}

main().catch((error) => {
  console.error('Simulation failed:', error.message);
  process.exit(1);
});
