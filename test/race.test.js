'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRace,
  addHeat,
  renameHeat,
  removeHeat,
  setHeatStartTime,
  setHeatDurationMinutes,
  assignParticipantHeat,
  addParticipant,
  setParticipantRfidCode,
  setParticipantStartNumber,
  removeParticipant,
  startRace,
  countPendingPreStartScans,
  stopRace,
  resumeRace,
  endRace,
  newRaceFromTemplate,
  setLapDistance,
  setMinLapSeconds,
  resetRace,
  resetToDefaults,
  recordScan,
  editScan,
  removeScan,
  excludeScan,
  includeScan,
  getLeaderboard,
  getScanHistory,
  getLapHistory,
  DomainError,
} = require('../server/domain/race');

test('addParticipant assigns incrementing ids and defaults', () => {
  const race = createRace();
  const a = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  const b = addParticipant(race, { name: 'Bo', gender: 'male', rfidCode: '0000000002' });

  assert.equal(a.id, 1);
  assert.equal(a.gender, 'other');
  assert.equal(b.id, 2);
  assert.equal(race.participants.length, 2);
});

test('addParticipant allows an empty RFID code (added later) but rejects missing name and duplicate codes', () => {
  const race = createRace();
  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });

  assert.throws(() => addParticipant(race, { name: '', rfidCode: '0000000002' }), DomainError);

  // No code yet is fine — it can be assigned later via setParticipantRfidCode.
  const bo = addParticipant(race, { name: 'Bo', rfidCode: '' });
  assert.equal(bo.rfidCode, null);

  assert.throws(
    () => addParticipant(race, { name: 'Cleo', rfidCode: '0000000001' }),
    /already assigned to Ada/
  );
});

test('addParticipant auto-assigns unique, incrementing start numbers, overwritable via setParticipantStartNumber', () => {
  const race = createRace();
  const a = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  const b = addParticipant(race, { name: 'Bo', rfidCode: '0000000002' });
  assert.equal(a.startNumber, 1);
  assert.equal(b.startNumber, 2);

  setParticipantStartNumber(race, a.id, 42);
  assert.equal(a.startNumber, 42);

  // The next auto-assigned number keeps climbing above the highest in use.
  const cleo = addParticipant(race, { name: 'Cleo', rfidCode: '0000000003' });
  assert.equal(cleo.startNumber, 43);

  assert.throws(() => setParticipantStartNumber(race, b.id, 42), /already assigned to Ada/);
  assert.throws(() => setParticipantStartNumber(race, b.id, 0), DomainError);
  assert.throws(() => setParticipantStartNumber(race, b.id, 1.5), DomainError);
  assert.throws(() => setParticipantStartNumber(race, 999, 7), /No participant with id/);
});

test('setParticipantRfidCode assigns, rejects duplicates, and can clear a code', () => {
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '' });
  const bo = addParticipant(race, { name: 'Bo', rfidCode: '0000000002' });

  setParticipantRfidCode(race, ada.id, '0000000001');
  assert.equal(ada.rfidCode, '0000000001');

  assert.throws(() => setParticipantRfidCode(race, bo.id, '0000000001'), /already assigned to Ada/);
  assert.throws(() => setParticipantRfidCode(race, 999, '0000000005'), /No participant with id/);

  setParticipantRfidCode(race, ada.id, '');
  assert.equal(ada.rfidCode, null);
});

test('removeParticipant deletes a signed-up participant', () => {
  const race = createRace();
  const a = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  removeParticipant(race, a.id);
  assert.equal(race.participants.length, 0);
  assert.throws(() => removeParticipant(race, a.id), DomainError);
});

test('startRace requires at least one participant and flips status once', () => {
  const race = createRace();
  assert.throws(() => startRace(race), /at least one participant/);

  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  assert.equal(race.status, 'started');
  assert.ok(race.heats[0].startAt);
  assert.throws(() => startRace(race), /already started/);
});

test('startRace keeps a start time that was preset during signup', () => {
  const race = createRace();
  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  setHeatStartTime(race, race.heats[0].id, '2024-01-01T09:00:00.000Z');

  startRace(race);
  assert.equal(race.heats[0].startAt, '2024-01-01T09:00:00.000Z');
});

test('startRace refuses to start while every heat is scheduled for later, but allows it once that time arrives', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T09:00:00.000Z') });
  const race = createRace();
  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  // createRace() seeds two default heats — schedule both for later so
  // there's truly nothing due yet (an untouched heat with no startAt at
  // all would otherwise count as "due now" and let the race start).
  setHeatStartTime(race, race.heats[0].id, '2024-01-01T10:00:00.000Z'); // an hour from "now"
  setHeatStartTime(race, race.heats[1].id, '2024-01-01T10:00:00.000Z');

  assert.throws(() => startRace(race), /hasn't arrived yet/);
  assert.equal(race.status, 'signup');

  t.mock.timers.tick(60 * 60 * 1000); // now 10:00 — the scheduled time has arrived
  startRace(race);
  assert.equal(race.status, 'started');
});

test('startRace allows starting once at least one heat is due, even if another heat is scheduled later', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T09:00:00.000Z') });
  const race = createRace();
  addParticipant(race, { name: 'Ada', rfidCode: '0000000001', heatId: race.heats[0].id });
  setHeatStartTime(race, race.heats[0].id, '2024-01-01T09:00:00.000Z'); // due now
  setHeatStartTime(race, race.heats[1].id, '2024-01-01T11:00:00.000Z'); // an hour later

  startRace(race);
  assert.equal(race.status, 'started');
  assert.equal(race.heats[0].startAt, '2024-01-01T09:00:00.000Z');
  // Heat 2 keeps its own future schedule rather than being forced to "now".
  assert.equal(race.heats[1].startAt, '2024-01-01T11:00:00.000Z');
});

test('startRace refuses when every heat is scheduled for later', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T09:00:00.000Z') });
  const race = createRace();
  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  setHeatStartTime(race, race.heats[0].id, '2024-01-01T10:00:00.000Z');
  setHeatStartTime(race, race.heats[1].id, '2024-01-01T11:00:00.000Z');

  assert.throws(() => startRace(race), /hasn't arrived yet/);
  assert.equal(race.status, 'signup');
});

test('scans recorded before Start is actually pressed never count by default, even though a heat\'s startAt already passed', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T08:00:00.000Z') });
  const race = createRace();
  setMinLapSeconds(race, 5);
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' }); // rfidAssignedAt: 08:00
  setHeatStartTime(race, race.heats[0].id, '2024-01-01T09:00:00.000Z'); // scheduled for 09:00

  // A scan comes in before anyone presses Start — e.g. the organizer is
  // still fiddling with signup while the reader is already live.
  t.mock.timers.tick(90 * 60 * 1000); // now 09:30
  recordScan(race, { time: '2024-01-01T09:30:00.000Z', code: ada.rfidCode });
  assert.equal(countPendingPreStartScans(race), 1);

  t.mock.timers.tick(30 * 60 * 1000); // now 10:00 — Start is finally pressed
  startRace(race); // no includePreStartScans — the strict default
  assert.equal(race.startedAt, '2024-01-01T10:00:00.000Z');
  assert.equal(getLeaderboard(race)[0].rounds, 0);

  // A scan after the real start time counts as normal.
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode });
  assert.equal(getLeaderboard(race)[0].rounds, 1);
});

test('startRace({ includePreStartScans: true }) includes scans since each heat\'s own scheduled start time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T08:00:00.000Z') });
  const race = createRace();
  setMinLapSeconds(race, 5);
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' }); // rfidAssignedAt: 08:00
  setHeatStartTime(race, race.heats[0].id, '2024-01-01T09:00:00.000Z');

  t.mock.timers.tick(90 * 60 * 1000); // now 09:30
  recordScan(race, { time: '2024-01-01T09:30:00.000Z', code: ada.rfidCode });
  t.mock.timers.tick(30 * 60 * 1000); // now 10:00
  startRace(race, { includePreStartScans: true });

  assert.equal(race.startedAt, null);
  assert.equal(getLeaderboard(race)[0].rounds, 1);
});

test('countPendingPreStartScans is 0 once the race is no longer in signup', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T10:00:00.000Z') });
  const race = createRace();
  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  assert.equal(countPendingPreStartScans(race), 0);
});

test('setHeatStartTime works during signup and after the race has started, and rejects invalid input', () => {
  const race = createRace();
  const heatId = race.heats[0].id;
  setHeatStartTime(race, heatId, '2024-01-01T08:00:00.000Z');
  assert.equal(race.heats[0].startAt, '2024-01-01T08:00:00.000Z');

  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);

  setHeatStartTime(race, heatId, '2024-01-01T08:30:00.000Z');
  assert.equal(race.heats[0].startAt, '2024-01-01T08:30:00.000Z');

  assert.throws(() => setHeatStartTime(race, heatId, 'not a date'), DomainError);
  assert.throws(() => setHeatStartTime(race, heatId, ''), DomainError);
  assert.throws(() => setHeatStartTime(race, 999, '2024-01-01T08:00:00.000Z'), /No heat with id/);
});

test('setHeatDurationMinutes validates input, is relative to the start time, and excludes late scans from the leaderboard', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const heatId = race.heats[0].id;
  setHeatStartTime(race, heatId, '2024-01-01T08:00:00.000Z');

  assert.throws(() => setHeatDurationMinutes(race, heatId, 'not a number'), DomainError);
  assert.throws(() => setHeatDurationMinutes(race, heatId, 0), DomainError);
  assert.throws(() => setHeatDurationMinutes(race, heatId, -5), DomainError);
  assert.throws(() => setHeatDurationMinutes(race, heatId, 1.5), DomainError);
  assert.throws(() => setHeatDurationMinutes(race, 999, 60), /No heat with id/);

  setHeatDurationMinutes(race, heatId, 60); // ends at 09:00
  assert.equal(race.heats[0].durationMinutes, 60);

  // Duration is relative: moving the start time moves the end time with it,
  // no ordering conflict to worry about.
  setHeatStartTime(race, heatId, '2024-01-01T08:30:00.000Z'); // now ends at 09:30
  assert.equal(race.heats[0].startAt, '2024-01-01T08:30:00.000Z');

  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  race.status = 'started';
  recordScan(race, { time: '2024-01-01T09:00:00.000Z', code: ada.rfidCode }); // counts: within window
  recordScan(race, { time: '2024-01-01T09:45:00.000Z', code: ada.rfidCode }); // excluded: after duration elapsed

  const [row] = getLeaderboard(race);
  assert.equal(row.rounds, 1);

  const history = getScanHistory(race, { participantId: ada.id });
  const lateScan = history.find((e) => e.time === '2024-01-01T09:45:00.000Z');
  assert.equal(lateScan.counted, false);
  assert.equal(lateScan.reason, 'after_end');

  // Clearing it (empty string) removes the cutoff again.
  setHeatDurationMinutes(race, heatId, '');
  assert.equal(race.heats[0].durationMinutes, null);
});

test('addHeat, assignParticipantHeat and removeHeat manage multiple start groups', () => {
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  const heat2 = addHeat(race, 'Kids');
  assert.equal(heat2.name, 'Kids');
  assert.equal(race.heats.length, 3); // the 2 default heats plus "Kids"

  assignParticipantHeat(race, ada.id, heat2.id);
  assert.equal(race.participants.find((p) => p.id === ada.id).heatId, heat2.id);

  // Can't remove a heat that still has participants in it.
  assert.throws(() => removeHeat(race, heat2.id), /Move participants/);

  assignParticipantHeat(race, ada.id, race.heats[0].id);
  removeHeat(race, heat2.id);
  assert.equal(race.heats.length, 2);

  removeHeat(race, race.heats[1].id);
  assert.equal(race.heats.length, 1);

  // Can't remove the last remaining heat.
  assert.throws(() => removeHeat(race, race.heats[0].id), /At least one heat/);
});

test('createRace starts with two default heats, ready for a typical 2-group race', () => {
  const race = createRace();
  assert.equal(race.heats.length, 2);
  assert.equal(race.heats[0].name, 'Heat 1');
  assert.equal(race.heats[1].name, 'Heat 2');
});

test('addHeat falls back to "Heat n+1" when given a blank name', () => {
  const race = createRace(); // already has Heat 1 and Heat 2
  const heat3 = addHeat(race, '   ');
  assert.equal(heat3.name, 'Heat 3');
});

test('renameHeat sets a new name, or falls back to "Heat n" (by position) when blank', () => {
  const race = createRace();
  const heat2 = race.heats[1];
  renameHeat(race, heat2.id, 'Kids heat');
  assert.equal(race.heats[1].name, 'Kids heat');

  renameHeat(race, heat2.id, '   ');
  assert.equal(race.heats[1].name, 'Heat 2');

  assert.throws(() => renameHeat(race, 999, 'Nope'), /No heat with id 999/);
});

test('signup is locked once the race has started', () => {
  const race = createRace();
  const a = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);

  assert.throws(() => addParticipant(race, { name: 'Bo', rfidCode: '0000000002' }), DomainError);
  assert.throws(() => removeParticipant(race, a.id), DomainError);
});

test('resetRace clears scans/rounds back to zero but keeps participants, heats and settings', () => {
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  setLapDistance(race, 400);
  setMinLapSeconds(race, 10);
  startRace(race);
  recordScan(race, { code: '0000000001' });
  stopRace(race);

  resetRace(race);
  assert.equal(race.status, 'signup');
  assert.equal(race.scans.length, 0);
  assert.equal(race.pausedIntervals.length, 0);
  assert.equal(race.participants.length, 1);
  assert.equal(race.participants[0].name, 'Ada');
  assert.equal(race.participants[0].rfidCode, '0000000001');
  assert.equal(race.lapDistanceMeters, 400);
  assert.equal(race.minLapSeconds, 10);
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 0);
});

test('resetToDefaults wipes participants, heats, scans and settings back to a brand new race', () => {
  const race = createRace();
  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  addHeat(race, 'Kids');
  setLapDistance(race, 400);
  setMinLapSeconds(race, 10);
  startRace(race);
  recordScan(race, { code: '0000000001' });

  resetToDefaults(race);
  assert.equal(race.status, 'signup');
  assert.equal(race.participants.length, 0);
  assert.equal(race.scans.length, 0);
  assert.equal(race.heats.length, 2);
  assert.equal(race.heats[0].name, 'Heat 1');
  assert.equal(race.heats[1].name, 'Heat 2');
  assert.equal(race.lapDistanceMeters, 5000);
  assert.equal(race.minLapSeconds, 600);
});

test('recordScan stores every scan, even before start or for an unknown code', () => {
  const race = createRace();
  recordScan(race, { code: '0000000009' });
  recordScan(race, { time: '2024-01-01T00:00:00.000Z', code: '0000000001' });
  assert.equal(race.scans.length, 2);
  assert.throws(() => recordScan(race, { code: '' }), DomainError);
});

test('recordScan normalizes a reader\'s timezone-less local timestamp to UTC, so it compares correctly with paused intervals', () => {
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  stopRace(race); // opens a paused interval starting "now" (real wall-clock time)

  // Simulate the RFID reader: datetime.now().isoformat(timespec="milliseconds"),
  // i.e. local time with no timezone designator, for "right now".
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const localNowNoTz = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  const scan = recordScan(race, { time: localNowNoTz, code: ada.rfidCode });

  // Stored time must be a real UTC ISO string (ends in Z), not the raw
  // local-time string, so it compares correctly against pausedIntervals.
  assert.match(scan.time, /Z$/);
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 0);
});

test('a scan before the race was ever started never counts, even if a matching participant is added afterwards', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  // Scan arrives before any participant exists and before the race starts.
  recordScan(race, { time: '2024-01-01T09:00:00.000Z', code: '0000000001' });
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 0);
  assert.equal(getScanHistory(race)[0].reason, 'race_not_started');
});

test('a scan during signup never counts, even if the heat still has a start time left over from a previous reset', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5);
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode });
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 1);

  resetRace(race); // clears scans/rounds but deliberately keeps heats.startAt
  assert.equal(race.status, 'signup');
  assert.ok(race.heats[0].startAt, 'heat start time should survive a reset');

  // A scan received now, before "Start race" is pressed again, must not
  // count just because the heat object still has an old startAt on it.
  recordScan(race, { time: '2024-01-01T10:10:00.000Z', code: ada.rfidCode });
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 0);
  assert.equal(getScanHistory(race)[0].reason, 'race_not_started');
});

test('matching an RFID code is not retroactive: a scan from before the code was assigned never counts for that participant', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T10:06:00.000Z') });
  const race = createRace();
  setMinLapSeconds(race, 5);
  const ada = addParticipant(race, { name: 'Ada' }); // no code yet
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';

  // Someone scans this code before it's ever assigned to Ada.
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: '0000000001' });
  assert.equal(getScanHistory(race)[0].reason, 'unknown_code');

  // Now the code is assigned to Ada.
  setParticipantRfidCode(race, ada.id, '0000000001');
  assert.ok(ada.rfidAssignedAt);

  // The old scan still never counts for Ada — matching is not retroactive.
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 0);
  assert.equal(getScanHistory(race)[0].reason, 'code_assigned_after_scan');

  // But a new scan, after the code was assigned, counts normally.
  recordScan(race, { time: '2024-01-01T10:10:00.000Z', code: '0000000001' });
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 1);
});

test('editScan corrects a stored scan\'s time and/or code, and removeScan deletes it', () => {
  const race = createRace();
  const scan = recordScan(race, { time: '2024-01-01T10:00:00.000Z', code: '0000000001' });

  editScan(race, scan.id, { code: '0000000002' });
  assert.equal(race.scans[0].code, '0000000002');

  editScan(race, scan.id, { time: '2024-01-01T11:00:00.000Z' });
  assert.equal(race.scans[0].time, '2024-01-01T11:00:00.000Z');

  assert.throws(() => editScan(race, scan.id, { time: 'not-a-date' }), DomainError);
  assert.throws(() => editScan(race, scan.id, { code: '  ' }), DomainError);
  assert.throws(() => editScan(race, 999, { code: '0000000003' }), DomainError);

  removeScan(race, scan.id);
  assert.equal(race.scans.length, 0);
  assert.throws(() => removeScan(race, scan.id), DomainError);
});

test('excludeScan requires a reason and keeps an excluded scan from ever counting as a lap', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T08:00:00.000Z') });
  const race = createRace();
  setMinLapSeconds(race, 5);
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  setHeatStartTime(race, race.heats[0].id, '2024-01-01T09:00:00.000Z');
  setHeatStartTime(race, race.heats[1].id, '2024-01-01T09:00:00.000Z');
  t.mock.timers.tick(60 * 60 * 1000); // now 09:00 — heats are due
  startRace(race);

  t.mock.timers.tick(30 * 60 * 1000); // now 09:30
  const scan = recordScan(race, { time: new Date().toISOString(), code: ada.rfidCode });

  assert.throws(() => excludeScan(race, scan.id, ''), /reason/);
  assert.throws(() => excludeScan(race, scan.id, '   '), /reason/);
  assert.throws(() => excludeScan(race, 999, 'duplicate chip'), DomainError);

  excludeScan(race, scan.id, 'Organizer saw this was a stray tap');
  assert.equal(race.scans[0].excluded, true);
  assert.equal(race.scans[0].excludeReason, 'Organizer saw this was a stray tap');
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 0);

  const history = getScanHistory(race);
  const entry = history.find((e) => e.id === scan.id);
  assert.equal(entry.counted, false);
  assert.equal(entry.reason, 'manually_excluded');
  assert.equal(entry.excludeReason, 'Organizer saw this was a stray tap');

  includeScan(race, scan.id);
  assert.equal(race.scans[0].excluded, false);
  assert.equal(race.scans[0].excludeReason, null);
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 1);

  assert.throws(() => includeScan(race, 999), DomainError);
});

test('getLeaderboard ranks by rounds, ignoring scans before the race started', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  const bo = addParticipant(race, { name: 'Bo', rfidCode: '0000000002' });

  // A scan before the race starts (e.g. testing the reader) must not count.
  recordScan(race, { time: '2024-01-01T09:00:00.000Z', code: ada.rfidCode });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5);

  recordScan(race, { time: '2024-01-01T10:01:00.000Z', code: ada.rfidCode });
  recordScan(race, { time: '2024-01-01T10:02:00.000Z', code: ada.rfidCode });
  recordScan(race, { time: '2024-01-01T10:01:00.000Z', code: bo.rfidCode });

  const board = getLeaderboard(race);
  assert.equal(board[0].name, 'Ada');
  assert.equal(board[0].rounds, 2);
  assert.equal(board[1].name, 'Bo');
  assert.equal(board[1].rounds, 1);
});

test('getLeaderboard collapses two scans within the minimum lap window into one round', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';

  recordScan(race, { time: '2024-01-01T10:01:00.000Z', code: ada.rfidCode });
  recordScan(race, { time: '2024-01-01T10:01:02.000Z', code: ada.rfidCode }); // bounce, 2s later
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode }); // real next lap

  const board = getLeaderboard(race, { minLapSeconds: 5 });
  assert.equal(board[0].rounds, 2);
});

test('getLeaderboard also applies the minimum lap window to the first lap, measured from the heat start', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5 * 60); // 5 minute minimum lap

  // Nobody can genuinely finish a lap in 2 minutes with a 5 minute minimum,
  // so this is reader noise near the start line, not a real first lap.
  recordScan(race, { time: '2024-01-01T10:02:00.000Z', code: ada.rfidCode });
  let board = getLeaderboard(race);
  assert.equal(board[0].rounds, 0);
  let history = getScanHistory(race, { participantId: ada.id });
  assert.equal(history[0].counted, false);
  assert.equal(history[0].reason, 'bounce');

  // A scan at/after the minimum window counts as the (real) first lap.
  recordScan(race, { time: '2024-01-01T10:06:00.000Z', code: ada.rfidCode });
  board = getLeaderboard(race);
  assert.equal(board[0].rounds, 1);
  assert.equal(board[0].lastLapDurationMs, 6 * 60 * 1000);
  history = getScanHistory(race, { participantId: ada.id });
  assert.equal(history[0].counted, true);
});

test('getLapHistory lists every counted lap in order with its duration, and rejects an unknown participant', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5);

  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode }); // lap 1: 5 min
  recordScan(race, { time: '2024-01-01T10:05:02.000Z', code: ada.rfidCode }); // bounce, ignored
  recordScan(race, { time: '2024-01-01T10:08:00.000Z', code: ada.rfidCode }); // lap 2: 3 min

  const laps = getLapHistory(race, ada.id);
  assert.equal(laps.length, 2);
  assert.deepEqual(laps[0], { lapNumber: 1, time: '2024-01-01T10:05:00.000Z', durationMs: 5 * 60 * 1000 });
  assert.deepEqual(laps[1], { lapNumber: 2, time: '2024-01-01T10:08:00.000Z', durationMs: 3 * 60 * 1000 });

  assert.throws(() => getLapHistory(race, 999), /No participant with id/);
});

test('getLeaderboard computes the most recent lap duration from the previous lap or race start', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5);

  // First lap: duration measured from the race's start time.
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode });
  let board = getLeaderboard(race);
  assert.equal(board[0].lastLapDurationMs, 5 * 60 * 1000);

  // Second lap: duration measured from the previous lap, not from start.
  recordScan(race, { time: '2024-01-01T10:08:00.000Z', code: ada.rfidCode });
  board = getLeaderboard(race);
  assert.equal(board[0].lastLapDurationMs, 3 * 60 * 1000);
});

test('getLeaderboard falls back to the race\'s actual start time to measure a lap duration when a participant\'s heat is orphaned', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  // Simulate a participant whose heat reference is orphaned (e.g. its heat
  // was removed from under it) — there's no heat-specific startAt to
  // measure a first lap from, but the race's own real start time
  // (race.startedAt) still applies as the fallback reference.
  ada.heatId = 'no-such-heat';
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode });

  const board = getLeaderboard(race);
  assert.equal(board[0].rounds, 1);
  assert.equal(board[0].lastLapDurationMs, 10 * 60 * 60 * 1000 + 5 * 60 * 1000);
});

test('setLapDistance validates input and getLeaderboard reports distance covered', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5);
  setLapDistance(race, null); // start from "no distance configured", not the app-wide default

  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode });
  recordScan(race, { time: '2024-01-01T10:10:00.000Z', code: ada.rfidCode });

  // No distance configured yet.
  let board = getLeaderboard(race);
  assert.equal(board[0].distanceMeters, null);

  setLapDistance(race, 400);
  board = getLeaderboard(race);
  assert.equal(board[0].rounds, 2);
  assert.equal(board[0].distanceMeters, 800);

  setLapDistance(race, null);
  board = getLeaderboard(race);
  assert.equal(board[0].distanceMeters, null);

  assert.throws(() => setLapDistance(race, -5), DomainError);
  assert.throws(() => setLapDistance(race, 'abc'), DomainError);
});

test('setMinLapSeconds validates input and adjusts the leaderboard\'s bounce window', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5); // a short test window, independent of the app-wide default

  recordScan(race, { time: '2024-01-01T10:00:03.000Z', code: ada.rfidCode }); // first lap
  recordScan(race, { time: '2024-01-01T10:00:07.000Z', code: ada.rfidCode }); // 4s later

  // This short window treats the second scan as a bounce.
  assert.equal(getLeaderboard(race)[0].rounds, 1);

  setMinLapSeconds(race, 2);
  assert.equal(race.minLapSeconds, 2);
  assert.equal(getLeaderboard(race)[0].rounds, 2);

  // Clearing it resets back to the default.
  setMinLapSeconds(race, null);
  assert.equal(race.minLapSeconds, 600);

  assert.throws(() => setMinLapSeconds(race, -1), DomainError);
  assert.throws(() => setMinLapSeconds(race, 'abc'), DomainError);
});

test('stopRace pauses scan counting and resumeRace lets it continue, without losing data', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5);

  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode }); // lap 1, counts

  stopRace(race);
  assert.equal(race.status, 'stopped');
  race.pausedIntervals[0].from = '2024-01-01T10:06:00.000Z'; // pin the pause start for the test

  // Scans recorded while stopped are stored but must not count.
  recordScan(race, { time: '2024-01-01T10:07:00.000Z', code: ada.rfidCode });
  let board = getLeaderboard(race);
  assert.equal(board[0].rounds, 1);

  resumeRace(race);
  assert.equal(race.status, 'started');
  race.pausedIntervals[0].to = '2024-01-01T10:10:00.000Z'; // pin the pause end for the test

  // A scan after resuming counts again.
  recordScan(race, { time: '2024-01-01T10:15:00.000Z', code: ada.rfidCode });
  board = getLeaderboard(race);
  assert.equal(board[0].rounds, 2);
  assert.equal(race.scans.length, 3, 'every scan is kept, even the paused one');
});

test('stopRace and resumeRace reject being called from the wrong state', () => {
  const race = createRace();
  assert.throws(() => stopRace(race), /not currently running/);
  assert.throws(() => resumeRace(race), /not currently stopped/);

  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  assert.throws(() => resumeRace(race), /not currently stopped/);

  stopRace(race);
  assert.throws(() => stopRace(race), /not currently running/);
  assert.throws(() => startRace(race), /Resume it instead/);
});

test('endRace stops counting and resumeRace can undo it; newRaceFromTemplate requires it first', (t) => {
  // "now" starts before the rfidAssignedAt stamp needs it, then we tick
  // forward past the hardcoded scan time before ending the race, since
  // endRace/resumeRace stamp paused-interval boundaries with "now".
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  assert.throws(() => endRace(race), /not currently running or stopped/);

  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  assert.throws(() => newRaceFromTemplate(race), /Only an ended race/);

  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5);
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode });
  t.mock.timers.tick(12 * 60 * 60 * 1000); // now 2024-01-01T12:00:00.000Z
  endRace(race);
  assert.equal(race.status, 'ended');
  assert.ok(race.endedAt);

  // A scan during "ended" never counts, same as while paused.
  recordScan(race, { code: ada.rfidCode });
  assert.equal(getLeaderboard(race).find((r) => r.id === ada.id).rounds, 1);

  // Resuming an ended race is allowed (undoing an accidental end).
  resumeRace(race);
  assert.equal(race.status, 'started');
  assert.equal(race.endedAt, null);

  endRace(race);
  assert.equal(race.status, 'ended');
});

test('newRaceFromTemplate keeps heats and participants but clears scans/rounds and status', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  setHeatStartTime(race, 1, '2024-01-01T10:00:00.000Z');
  setHeatDurationMinutes(race, 1, 60);
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  t.mock.timers.tick(10 * 60 * 60 * 1000); // now 2024-01-01T10:00:00.000Z, heat's start time has arrived
  startRace(race);
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode });
  endRace(race);

  newRaceFromTemplate(race);
  assert.equal(race.status, 'signup');
  assert.equal(race.endedAt, null);
  assert.equal(race.scans.length, 0);
  assert.equal(race.pausedIntervals.length, 0);
  assert.equal(race.heats[0].startAt, '2024-01-01T10:00:00.000Z');
  assert.equal(race.heats[0].durationMinutes, 60);
  assert.equal(race.participants.length, 1);
  assert.equal(race.participants[0].rfidCode, '0000000001');
});

test('getScanHistory lists every scan newest-first, annotated with participant match and count status', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00.000Z') });
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  const bo = addParticipant(race, { name: 'Bo', rfidCode: '0000000002' });

  recordScan(race, { time: '2024-01-01T09:00:00.000Z', code: ada.rfidCode }); // before start
  recordScan(race, { time: '2024-01-01T09:30:00.000Z', code: '0000000099' }); // unknown code
  startRace(race);
  race.heats[0].startAt = '2024-01-01T10:00:00.000Z';
  setMinLapSeconds(race, 5);
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode }); // counted
  recordScan(race, { time: '2024-01-01T10:05:02.000Z', code: ada.rfidCode }); // bounce
  recordScan(race, { time: '2024-01-01T10:06:00.000Z', code: bo.rfidCode }); // counted

  const history = getScanHistory(race);
  assert.equal(history.length, 5);
  assert.equal(history[0].time, '2024-01-01T10:06:00.000Z', 'newest first');

  const byTime = Object.fromEntries(history.map((h) => [h.time, h]));
  assert.equal(byTime['2024-01-01T09:00:00.000Z'].reason, 'before_start');
  assert.equal(byTime['2024-01-01T09:30:00.000Z'].reason, 'unknown_code');
  assert.equal(byTime['2024-01-01T09:30:00.000Z'].participantName, null);
  assert.equal(byTime['2024-01-01T10:05:00.000Z'].counted, true);
  assert.equal(byTime['2024-01-01T10:05:02.000Z'].reason, 'bounce');
  assert.equal(byTime['2024-01-01T10:06:00.000Z'].counted, true);

  const adaOnly = getScanHistory(race, { participantId: ada.id });
  assert.equal(adaOnly.length, 3);
  assert.ok(adaOnly.every((e) => e.participantId === ada.id));
});
