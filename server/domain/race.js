'use strict';

/**
 * Core domain for TimeTaker v2: a single race with participants identified by
 * an RFID code. No persistence, no I/O — pure functions operating on a plain
 * state object so they stay trivial to unit test.
 */

const GENDERS = ['female', 'male', 'other'];

// Two scans of the same chip closer together than this are treated as one
// lap (reader bounce / an operator testing the scanner during signup).
const DEFAULT_MIN_LAP_SECONDS = 5;

class DomainError extends Error {}

function createRace() {
  return {
    status: 'signup', // 'signup' | 'started'
    startedAt: null,
    nextParticipantId: 1,
    participants: [], // { id, name, gender, rfidCode }
    nextScanId: 1,
    scans: [], // { id, time (ISO string), code }
  };
}

function requireSignupMode(race) {
  if (race.status !== 'signup') {
    throw new DomainError('The race has already started. Reset it to change participants.');
  }
}

function addParticipant(race, { name, gender, rfidCode }) {
  requireSignupMode(race);

  const cleanName = (name || '').trim();
  const cleanCode = (rfidCode || '').trim();
  const cleanGender = (gender || 'other').trim().toLowerCase();

  if (!cleanName) {
    throw new DomainError('Name is required.');
  }
  if (!cleanCode) {
    throw new DomainError('RFID code is required.');
  }
  if (!GENDERS.includes(cleanGender)) {
    throw new DomainError(`Gender must be one of: ${GENDERS.join(', ')}.`);
  }

  const clash = race.participants.find((p) => p.rfidCode === cleanCode);
  if (clash) {
    throw new DomainError(`RFID code ${cleanCode} is already assigned to ${clash.name}.`);
  }

  const participant = {
    id: race.nextParticipantId++,
    name: cleanName,
    gender: cleanGender,
    rfidCode: cleanCode,
  };
  race.participants.push(participant);
  return participant;
}

function removeParticipant(race, id) {
  requireSignupMode(race);
  const index = race.participants.findIndex((p) => p.id === id);
  if (index === -1) {
    throw new DomainError(`No participant with id ${id}.`);
  }
  race.participants.splice(index, 1);
}

function startRace(race) {
  if (race.status === 'started') {
    throw new DomainError('The race has already started.');
  }
  if (race.participants.length === 0) {
    throw new DomainError('Add at least one participant before starting.');
  }
  race.status = 'started';
  race.startedAt = new Date().toISOString();
}

function resetRace(race) {
  const fresh = createRace();
  Object.assign(race, fresh);
}

/** Records a raw scan. Always stored, even for an unknown code or before the
 *  race starts, so nothing a reader captured is ever lost. */
function recordScan(race, { time, code }) {
  const cleanCode = (code || '').trim();
  if (!cleanCode) {
    throw new DomainError('Scan is missing a code.');
  }
  const scan = {
    id: race.nextScanId++,
    time: time && String(time).trim() ? String(time).trim() : new Date().toISOString(),
    code: cleanCode,
  };
  race.scans.push(scan);
  return scan;
}

/** Ranked list of participants by completed rounds (laps). */
function getLeaderboard(race, { minLapSeconds = DEFAULT_MIN_LAP_SECONDS } = {}) {
  const cutoff = race.startedAt;

  const rows = race.participants.map((p) => {
    const scansForParticipant = race.scans
      .filter((s) => s.code === p.rfidCode)
      .filter((s) => !cutoff || s.time >= cutoff)
      .sort((a, b) => a.time.localeCompare(b.time));

    let rounds = 0;
    let lastLapAt = null;
    for (const scan of scansForParticipant) {
      const isFirst = lastLapAt === null;
      const secondsSinceLast = isFirst
        ? Infinity
        : (new Date(scan.time) - new Date(lastLapAt)) / 1000;
      if (isFirst || secondsSinceLast >= minLapSeconds) {
        rounds += 1;
        lastLapAt = scan.time;
      }
    }

    return {
      id: p.id,
      name: p.name,
      gender: p.gender,
      rfidCode: p.rfidCode,
      rounds,
      lastLapAt,
    };
  });

  return rows.sort((a, b) => {
    if (b.rounds !== a.rounds) return b.rounds - a.rounds;
    if (a.lastLapAt && b.lastLapAt) return a.lastLapAt.localeCompare(b.lastLapAt);
    if (a.lastLapAt) return -1;
    if (b.lastLapAt) return 1;
    return a.name.localeCompare(b.name);
  });
}

module.exports = {
  GENDERS,
  DomainError,
  createRace,
  addParticipant,
  removeParticipant,
  startRace,
  resetRace,
  recordScan,
  getLeaderboard,
};
