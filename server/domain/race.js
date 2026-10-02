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
    status: 'signup', // 'signup' | 'started' | 'stopped' | 'ended'
    endedAt: null, // when the race was ended (for the auto-generated archive label)
    lapDistanceMeters: null, // optional: distance of one lap/round, for a "distance covered" column
    // Two scans of the same chip closer together than this are treated as
    // one lap (reader bounce / an operator testing the scanner). Organizer-
    // configurable since readers/chips vary in how prone they are to this.
    minLapSeconds: DEFAULT_MIN_LAP_SECONDS,
    // Windows of time during which scans were not counted (race was paused).
    // { from: ISOString, to: ISOString|null } — `to: null` means still paused.
    pausedIntervals: [],
    nextParticipantId: 1,
    nextHeatId: 2,
    // A race can have multiple start groups ("heats"), each with its own
    // start time, so e.g. a kids' heat and an adults' heat can start at
    // different times while still sharing one leaderboard/history view.
    // Every race starts with one default heat so single-heat races need no
    // extra setup.
    heats: [{ id: 1, name: 'Heat 1', startAt: null, durationMinutes: null }],
    participants: [], // { id, name, gender, rfidCode, rfidAssignedAt, heatId, startNumber }
    nextScanId: 1,
    scans: [], // { id, time (ISO string), code }
  };
}

function requireSignupMode(race) {
  if (race.status !== 'signup') {
    throw new DomainError('The race has already started. Reset it to change participants.');
  }
}

/** Finds a heat by id, or null if it doesn't exist. */
function findHeat(race, heatId) {
  return race.heats.find((h) => h.id === heatId) || null;
}

function requireHeat(race, heatId) {
  const heat = findHeat(race, heatId);
  if (!heat) {
    throw new DomainError(`No heat with id ${heatId}.`);
  }
  return heat;
}

/** The moment a heat's window closes, derived from its start time plus its
 *  optional duration — or null if it has no start time or no duration set
 *  (meaning the heat never cuts off). Duration is relative to the start
 *  time, so moving the start time automatically moves the end time with it. */
function heatEndAt(heat) {
  if (!heat || !heat.startAt || !heat.durationMinutes) return null;
  return new Date(new Date(heat.startAt).getTime() + heat.durationMinutes * 60_000).toISOString();
}

/** Adds a new heat (start group). Allowed at any time, since organizers may
 *  realize they need another group after signups are already underway. */
function addHeat(race, name) {
  const cleanName = (name || '').trim() || `Heat ${race.heats.length + 1}`;
  const heat = { id: race.nextHeatId++, name: cleanName, startAt: null, durationMinutes: null };
  race.heats.push(heat);
  return heat;
}

/** Removes a heat. Refuses to remove the last remaining heat, and refuses to
 *  remove a heat that still has participants assigned (move them first). */
function removeHeat(race, heatId) {
  if (race.heats.length <= 1) {
    throw new DomainError('At least one heat is required.');
  }
  requireHeat(race, heatId);
  const hasParticipants = race.participants.some((p) => p.heatId === heatId);
  if (hasParticipants) {
    throw new DomainError('Move participants out of this heat before removing it.');
  }
  race.heats = race.heats.filter((h) => h.id !== heatId);
}

/** Sets or changes one heat's official start time. Allowed in signup (to
 *  schedule ahead of time) and while the race is running (to correct it),
 *  since lap durations and the leaderboard cutoff for that heat's
 *  participants are always derived from this value. */
function setHeatStartTime(race, heatId, startAt) {
  const heat = requireHeat(race, heatId);
  const parsed = new Date(startAt);
  if (!startAt || Number.isNaN(parsed.getTime())) {
    throw new DomainError('Invalid start time.');
  }
  heat.startAt = parsed.toISOString();
  return heat.startAt;
}

/** Sets or clears one heat's optional duration (in whole minutes). Once set,
 *  scans timestamped at or after startAt + duration are excluded from that
 *  heat's leaderboard/lap counting — useful for capping a heat's run so
 *  later scans (e.g. from a following heat sharing the same reader) don't
 *  bleed into it. Pass null/empty to clear it again (no cutoff). */
function setHeatDurationMinutes(race, heatId, durationMinutes) {
  const heat = requireHeat(race, heatId);
  if (durationMinutes === null || durationMinutes === undefined || durationMinutes === '') {
    heat.durationMinutes = null;
    return heat.durationMinutes;
  }
  const parsed = Number(durationMinutes);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new DomainError('Duration must be a whole number of minutes greater than zero.');
  }
  heat.durationMinutes = parsed;
  return heat.durationMinutes;
}

/** Moves a participant into a different heat. Allowed any time, so an
 *  organizer can correct a mis-assigned participant even mid-race. */
function assignParticipantHeat(race, participantId, heatId) {
  const participant = race.participants.find((p) => p.id === participantId);
  if (!participant) {
    throw new DomainError(`No participant with id ${participantId}.`);
  }
  requireHeat(race, heatId);
  participant.heatId = heatId;
  return participant;
}

function addParticipant(race, { name, gender, rfidCode, heatId }) {
  requireSignupMode(race);

  const cleanName = (name || '').trim();
  const cleanCode = (rfidCode || '').trim();
  const cleanGender = (gender || 'other').trim().toLowerCase();

  if (!cleanName) {
    throw new DomainError('Name is required.');
  }
  if (!GENDERS.includes(cleanGender)) {
    throw new DomainError(`Gender must be one of: ${GENDERS.join(', ')}.`);
  }

  // The RFID code is optional at signup — organizers may want to register
  // participants ahead of time and assign/scan their chip later.
  if (cleanCode) {
    const clash = race.participants.find((p) => p.rfidCode === cleanCode);
    if (clash) {
      throw new DomainError(`RFID code ${cleanCode} is already assigned to ${clash.name}.`);
    }
  }

  const resolvedHeatId = heatId !== undefined && heatId !== null && heatId !== ''
    ? Number(heatId)
    : race.heats[0].id;
  requireHeat(race, resolvedHeatId);

  const participant = {
    id: race.nextParticipantId++,
    name: cleanName,
    gender: cleanGender,
    rfidCode: cleanCode || null,
    // When this participant's *current* code was assigned — a scan only
    // ever counts for them if it happened at/after this moment (matching
    // is not retroactive, see setParticipantRfidCode's doc-comment).
    rfidAssignedAt: cleanCode ? new Date().toISOString() : null,
    heatId: resolvedHeatId,
    startNumber: nextAvailableStartNumber(race),
  };
  race.participants.push(participant);
  return participant;
}

/** The next start number that isn't already taken — one more than the
 *  highest currently assigned, or 1 if nobody has one yet. Used to
 *  auto-assign a unique number to every new participant; recomputed from
 *  the current participants rather than a separate counter, so it keeps
 *  working sensibly even after manual overwrites or removals. */
function nextAvailableStartNumber(race) {
  const used = race.participants.map((p) => p.startNumber).filter((n) => Number.isInteger(n));
  return used.length > 0 ? Math.max(...used) + 1 : 1;
}

/** Overwrites a participant's auto-assigned start number. Must stay a
 *  unique positive whole number across all participants. */
function setParticipantStartNumber(race, participantId, startNumber) {
  const participant = race.participants.find((p) => p.id === participantId);
  if (!participant) {
    throw new DomainError(`No participant with id ${participantId}.`);
  }
  const parsed = Number(startNumber);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DomainError('Start number must be a positive whole number.');
  }
  const clash = race.participants.find((p) => p.id !== participantId && p.startNumber === parsed);
  if (clash) {
    throw new DomainError(`Start number ${parsed} is already assigned to ${clash.name}.`);
  }
  participant.startNumber = parsed;
  return participant.startNumber;
}

/** Sets or clears a participant's RFID code after the fact — e.g. an
 *  organizer registered them without a chip yet and scans/assigns one once
 *  it's handed out. Refuses a code already in use by someone else.
 *
 *  Stamps `rfidAssignedAt` to this moment whenever a non-empty code is set,
 *  so matching stays non-retroactive: a scan received *before* this code
 *  was assigned to this participant never counts for them, even if the
 *  exact same code string was reused from someone else earlier. */
function setParticipantRfidCode(race, participantId, rfidCode) {
  const participant = race.participants.find((p) => p.id === participantId);
  if (!participant) {
    throw new DomainError(`No participant with id ${participantId}.`);
  }
  const cleanCode = (rfidCode || '').trim();
  if (cleanCode) {
    const clash = race.participants.find((p) => p.id !== participantId && p.rfidCode === cleanCode);
    if (clash) {
      throw new DomainError(`RFID code ${cleanCode} is already assigned to ${clash.name}.`);
    }
  }
  participant.rfidCode = cleanCode || null;
  participant.rfidAssignedAt = cleanCode ? new Date().toISOString() : null;
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
  if (race.status !== 'signup') {
    throw new DomainError(
      race.status === 'stopped'
        ? 'The race is stopped. Resume it instead of starting a new one.'
        : 'The race has already started.'
    );
  }
  if (race.participants.length === 0) {
    throw new DomainError('Add at least one participant before starting.');
  }
  race.status = 'started';
  // Each heat may already have its own start time configured ahead of time;
  // only default a heat to "now" if nobody configured one for it.
  const now = new Date().toISOString();
  for (const heat of race.heats) {
    if (!heat.startAt) heat.startAt = now;
  }
}

/** Pauses scan counting without losing anything: incoming scans keep being
 *  stored, but any scan timestamped from now on is excluded from the
 *  leaderboard until the race is resumed (and permanently excluded for the
 *  paused window itself, even after resuming — a human can review/reinstate
 *  specific scans later via the history view). */
function stopRace(race) {
  if (race.status !== 'started') {
    throw new DomainError('The race is not currently running.');
  }
  race.status = 'stopped';
  race.pausedIntervals.push({ from: new Date().toISOString(), to: null });
}

/** Resumes a paused race. Scans start counting again from this moment;
 *  the paused window that just ended remains excluded from the leaderboard.
 *  Also allows resuming an *ended* race — unusual, but the race was never
 *  meant to be hard-locked, just frozen; this is how an organizer corrects
 *  an accidental "End race" click. */
function resumeRace(race) {
  if (race.status !== 'stopped' && race.status !== 'ended') {
    throw new DomainError('The race is not currently stopped or ended.');
  }
  const openInterval = race.pausedIntervals.find((interval) => interval.to === null);
  if (openInterval) {
    openInterval.to = new Date().toISOString();
  }
  race.status = 'started';
  race.endedAt = null;
}

/** Ends the race: a terminal status for once the event is actually over.
 *  Nothing is deleted — scans/participants/heats all stay exactly as they
 *  are, viewable and exportable — it just stops counting new scans (reusing
 *  the same paused-interval mechanism "stop" uses) and unlocks the
 *  "New race from this template" flow. Can still be undone via
 *  `resumeRace` if clicked by mistake. */
function endRace(race) {
  if (race.status !== 'started' && race.status !== 'stopped') {
    throw new DomainError('The race is not currently running or stopped.');
  }
  // If it's already stopped there's an open paused interval covering "now
  // until it resumes" — ending it just keeps that same interval open, no
  // need for a second one.
  if (race.status === 'started') {
    race.pausedIntervals.push({ from: new Date().toISOString(), to: null });
  }
  race.status = 'ended';
  race.endedAt = new Date().toISOString();
}

/** Sets the distance of a single lap/round (in meters), so the leaderboard
 *  can also show total distance covered. Allowed any time; pass null/0 to
 *  clear it and hide the distance column again. */
function setLapDistance(race, lapDistanceMeters) {
  if (lapDistanceMeters === null || lapDistanceMeters === undefined || lapDistanceMeters === '') {
    race.lapDistanceMeters = null;
    return race.lapDistanceMeters;
  }
  const parsed = Number(lapDistanceMeters);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new DomainError('Lap distance must be a positive number of meters.');
  }
  race.lapDistanceMeters = parsed;
  return race.lapDistanceMeters;
}

/** Sets the minimum gap (in whole seconds) between two scans of the same
 *  chip for the second one to count as a new lap, rather than a reader
 *  "bounce" / accidental double scan. Pass null/empty to reset it back to
 *  the default. */
function setMinLapSeconds(race, minLapSeconds) {
  if (minLapSeconds === null || minLapSeconds === undefined || minLapSeconds === '') {
    race.minLapSeconds = DEFAULT_MIN_LAP_SECONDS;
    return race.minLapSeconds;
  }
  const parsed = Number(minLapSeconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new DomainError('Minimum lap time must be a positive number of seconds.');
  }
  race.minLapSeconds = parsed;
  return race.minLapSeconds;
}

/** Resets lap counting for a fresh run without losing the work already done
 *  setting up the race: participants (names/genders/RFID codes/start
 *  numbers), heats (names/start times/durations), and race settings (lap
 *  distance, minimum lap time) are all kept exactly as they are. Only the
 *  scan log and paused/stopped history are cleared (so every participant's
 *  rounds go back to zero), and status returns to "signup" so heat start
 *  times can be adjusted again before the next run. */
function resetRace(race) {
  race.status = 'signup';
  race.endedAt = null;
  race.scans = [];
  race.nextScanId = 1;
  race.pausedIntervals = [];
}

/** Starts a brand new race using the current (ended) race's heats and
 *  participants as a template — same heat names/start times/durations, same
 *  participants (names/genders/RFID codes/start numbers/heat assignments)
 *  — but with no scan/round data at all, back in signup so dates and heat
 *  assignments can be adjusted before running it for real. Only allowed
 *  once a race has been ended; the caller is expected to archive the
 *  about-to-be-cleared race first (its full state, taken *before* calling
 *  this) so it remains available in race history. */
function newRaceFromTemplate(race) {
  if (race.status !== 'ended') {
    throw new DomainError('Only an ended race can be used as a template for a new one.');
  }
  resetRace(race);
}

/** Records a raw scan. Always stored, even for an unknown code or before the
 *  race starts, so nothing a reader captured is ever lost.
 *
 *  The reader sends its own local-time timestamp with no timezone
 *  designator (e.g. "2026-10-02T11:30:00.123"). Every other timestamp in
 *  this app (heat start times, paused intervals) is stored as a proper UTC
 *  ISO string via `new Date().toISOString()`, and all of the eligibility
 *  checks compare timestamps as plain strings — so a reader-supplied
 *  timestamp MUST be normalized to that same UTC format here, otherwise
 *  comparing a local-time string against a UTC string lexicographically
 *  gives nonsense results (e.g. a scan during a pause not being recognized
 *  as paused). `new Date(...)` parses a timezone-less date-time string as
 *  local time on this same machine, so this conversion is correct as long
 *  as the server and the reader run on the same PC (true for this app). */
function recordScan(race, { time, code }) {
  const cleanCode = (code || '').trim();
  if (!cleanCode) {
    throw new DomainError('Scan is missing a code.');
  }
  const cleanTime = time && String(time).trim();
  let normalizedTime = new Date().toISOString();
  if (cleanTime) {
    const parsed = new Date(cleanTime);
    if (Number.isNaN(parsed.getTime())) {
      throw new DomainError('Invalid scan time.');
    }
    normalizedTime = parsed.toISOString();
  }
  const scan = {
    id: race.nextScanId++,
    time: normalizedTime,
    code: cleanCode,
  };
  race.scans.push(scan);
  return scan;
}

/** Edits a stored scan's time and/or code — e.g. to correct a misread code,
 *  or to fix a timestamp so a scan counts (or stops counting) as intended.
 *  Organizers review the scan history as an audit log, so this is allowed
 *  regardless of race status. Pass only the fields that should change. */
function editScan(race, scanId, { time, code } = {}) {
  const scan = race.scans.find((s) => s.id === scanId);
  if (!scan) {
    throw new DomainError(`No scan with id ${scanId}.`);
  }
  if (time !== undefined) {
    const cleanTime = String(time || '').trim();
    const parsed = new Date(cleanTime);
    if (!cleanTime || Number.isNaN(parsed.getTime())) {
      throw new DomainError('Invalid scan time.');
    }
    scan.time = parsed.toISOString();
  }
  if (code !== undefined) {
    const cleanCode = (code || '').trim();
    if (!cleanCode) {
      throw new DomainError('Scan code cannot be empty.');
    }
    scan.code = cleanCode;
  }
  return scan;
}

/** Permanently removes a scan from the raw log — e.g. a test scan during
 *  setup, or a misread that shouldn't be kept around at all. */
function removeScan(race, scanId) {
  const index = race.scans.findIndex((s) => s.id === scanId);
  if (index === -1) {
    throw new DomainError(`No scan with id ${scanId}.`);
  }
  race.scans.splice(index, 1);
}

/** True if the given ISO timestamp falls inside a paused (stopped) window. */
function isPaused(race, isoTime) {
  return race.pausedIntervals.some((interval) => isoTime >= interval.from && (interval.to === null || isoTime < interval.to));
}

/** Scans for one participant that are eligible to count at all: the race
 *  must have actually been (re)started since the last reset (never just
 *  because a heat still has an old `startAt` lying around — resetting a
 *  race deliberately keeps heat start times for next time, so `startAt`
 *  alone can't be trusted as "the race is live"; only the race's own
 *  status can), scanned at/after that heat's start time (and before its
 *  end, if any), not during a paused window, and not before this
 *  participant's *current* RFID code was actually assigned to them
 *  (matching is intentionally not retroactive — see
 *  `setParticipantRfidCode`). Oldest first. */
function eligibleScansForParticipant(race, participant) {
  // Nothing is eligible until the race has been started at least once
  // since the last reset/new-race-from-template — regardless of whatever
  // heat.startAt happens to still be set to.
  if (race.status === 'signup') return [];

  const heat = findHeat(race, participant.heatId);
  const cutoff = heat ? heat.startAt : null;
  const endCutoff = heatEndAt(heat);
  return race.scans
    .filter((s) => s.code === participant.rfidCode)
    .filter((s) => !cutoff || s.time >= cutoff)
    .filter((s) => !endCutoff || s.time < endCutoff)
    .filter((s) => !isPaused(race, s.time))
    .filter((s) => !participant.rfidAssignedAt || s.time >= participant.rfidAssignedAt)
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** Walks one participant's eligible scans and decides which ones count as a
 *  lap (collapsing reader bounces within minLapSeconds), returning the
 *  running totals plus the set of scan ids that counted. Shared by the
 *  leaderboard and the scan-history/audit view so the two never disagree. */
function computeLaps(eligibleScans, cutoff, minLapSeconds) {
  let rounds = 0;
  let lastLapAt = null;
  let lastLapDurationMs = null;
  const countedScanIds = new Set();

  for (const scan of eligibleScans) {
    const isFirst = lastLapAt === null;
    const secondsSinceLast = isFirst ? Infinity : (new Date(scan.time) - new Date(lastLapAt)) / 1000;
    if (isFirst || secondsSinceLast >= minLapSeconds) {
      // Duration is measured from the previous counted lap, or from the
      // race's start time if this is the first one.
      const referenceTime = isFirst ? cutoff : lastLapAt;
      rounds += 1;
      lastLapDurationMs = referenceTime ? new Date(scan.time) - new Date(referenceTime) : null;
      lastLapAt = scan.time;
      countedScanIds.add(scan.id);
    }
  }

  return { rounds, lastLapAt, lastLapDurationMs, countedScanIds };
}

/** Ranked list of participants by completed rounds (laps), including the
 *  duration of each one's most recent lap (time since the previous lap, or
 *  since their heat's start time for a first lap). Rows are grouped by heat
 *  (each heat ranked independently, since heats start at different times),
 *  then ranked by rounds within that heat. */
function getLeaderboard(race, { minLapSeconds } = {}) {
  const effectiveMinLapSeconds = minLapSeconds ?? race.minLapSeconds ?? DEFAULT_MIN_LAP_SECONDS;
  const rows = race.participants.map((p) => {
    const heat = findHeat(race, p.heatId);
    const cutoff = heat ? heat.startAt : null;
    const eligibleScans = eligibleScansForParticipant(race, p);
    const { rounds, lastLapAt, lastLapDurationMs } = computeLaps(eligibleScans, cutoff, effectiveMinLapSeconds);

    return {
      id: p.id,
      name: p.name,
      gender: p.gender,
      rfidCode: p.rfidCode,
      startNumber: p.startNumber,
      heatId: p.heatId,
      heatName: heat ? heat.name : null,
      rounds,
      lastLapAt,
      lastLapDurationMs,
      distanceMeters: race.lapDistanceMeters ? rounds * race.lapDistanceMeters : null,
    };
  });

  return rows.sort((a, b) => {
    if (a.heatId !== b.heatId) return a.heatId - b.heatId;
    if (b.rounds !== a.rounds) return b.rounds - a.rounds;
    if (a.lastLapAt && b.lastLapAt) return a.lastLapAt.localeCompare(b.lastLapAt);
    if (a.lastLapAt) return -1;
    if (b.lastLapAt) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Full audit view of every scan ever received, newest first, annotated with
 *  which participant it matched (if any) and whether it actually counted
 *  toward that participant's rounds — and if not, why. Nothing is ever
 *  dropped from this view, including scans for unknown codes or scans from
 *  before that participant's heat started or while the race was paused, so
 *  an organizer can review and correct the record later.
 *  Pass `participantId` to see just one participant's scans. */
function getScanHistory(race, { participantId, minLapSeconds } = {}) {
  const effectiveMinLapSeconds = minLapSeconds ?? race.minLapSeconds ?? DEFAULT_MIN_LAP_SECONDS;
  const byCode = new Map(race.participants.map((p) => [p.rfidCode, p]));

  // Figure out, per participant, which scan ids actually counted as a lap.
  const countedScanIds = new Set();
  for (const p of race.participants) {
    const heat = findHeat(race, p.heatId);
    const cutoff = heat ? heat.startAt : null;
    const eligibleScans = eligibleScansForParticipant(race, p);
    const { countedScanIds: counted } = computeLaps(eligibleScans, cutoff, effectiveMinLapSeconds);
    for (const id of counted) countedScanIds.add(id);
  }

  let entries = race.scans.map((s) => {
    const participant = byCode.get(s.code) || null;
    const heat = participant ? findHeat(race, participant.heatId) : null;
    const cutoff = heat ? heat.startAt : null;
    const endCutoff = heatEndAt(heat);
    const counted = countedScanIds.has(s.id);
    let reason = null;
    if (counted) {
      reason = null;
    } else if (!participant) {
      reason = 'unknown_code';
    } else if (participant.rfidAssignedAt && s.time < participant.rfidAssignedAt) {
      // Checked before "race not started": a scan from before this code was
      // even assigned to this participant is never eligible for them,
      // regardless of what the race's status is.
      reason = 'code_assigned_after_scan';
    } else if (race.status === 'signup') {
      reason = 'race_not_started';
    } else if (!cutoff) {
      reason = 'race_not_started';
    } else if (s.time < cutoff) {
      reason = 'before_start';
    } else if (endCutoff && s.time >= endCutoff) {
      reason = 'after_end';
    } else if (isPaused(race, s.time)) {
      reason = 'paused';
    } else {
      reason = 'bounce';
    }

    return {
      id: s.id,
      time: s.time,
      code: s.code,
      participantId: participant ? participant.id : null,
      participantName: participant ? participant.name : null,
      counted,
      reason,
    };
  });

  if (participantId !== undefined && participantId !== null) {
    entries = entries.filter((e) => e.participantId === participantId);
  }

  return entries.sort((a, b) => b.time.localeCompare(a.time));
}

module.exports = {
  GENDERS,
  DEFAULT_MIN_LAP_SECONDS,
  DomainError,
  createRace,
  addHeat,
  removeHeat,
  setHeatStartTime,
  setHeatDurationMinutes,
  assignParticipantHeat,
  addParticipant,
  setParticipantRfidCode,
  setParticipantStartNumber,
  removeParticipant,
  startRace,
  stopRace,
  resumeRace,
  endRace,
  newRaceFromTemplate,
  setLapDistance,
  setMinLapSeconds,
  resetRace,
  recordScan,
  editScan,
  removeScan,
  getLeaderboard,
  getScanHistory,
};
