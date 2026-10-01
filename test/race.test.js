'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRace,
  addParticipant,
  removeParticipant,
  startRace,
  resetRace,
  recordScan,
  getLeaderboard,
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

test('addParticipant rejects missing name, missing code, and duplicate code', () => {
  const race = createRace();
  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });

  assert.throws(() => addParticipant(race, { name: '', rfidCode: '0000000002' }), DomainError);
  assert.throws(() => addParticipant(race, { name: 'Bo', rfidCode: '' }), DomainError);
  assert.throws(
    () => addParticipant(race, { name: 'Bo', rfidCode: '0000000001' }),
    /already assigned to Ada/
  );
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
  assert.ok(race.startedAt);
  assert.throws(() => startRace(race), /already started/);
});

test('signup is locked once the race has started', () => {
  const race = createRace();
  const a = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);

  assert.throws(() => addParticipant(race, { name: 'Bo', rfidCode: '0000000002' }), DomainError);
  assert.throws(() => removeParticipant(race, a.id), DomainError);
});

test('resetRace clears everything back to signup', () => {
  const race = createRace();
  addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  recordScan(race, { code: '0000000001' });

  resetRace(race);
  assert.equal(race.status, 'signup');
  assert.equal(race.participants.length, 0);
  assert.equal(race.scans.length, 0);
});

test('recordScan stores every scan, even before start or for an unknown code', () => {
  const race = createRace();
  recordScan(race, { code: '0000000009' });
  recordScan(race, { time: '2024-01-01T00:00:00.000Z', code: '0000000001' });
  assert.equal(race.scans.length, 2);
  assert.throws(() => recordScan(race, { code: '' }), DomainError);
});

test('getLeaderboard ranks by rounds, ignoring scans before the race started', () => {
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  const bo = addParticipant(race, { name: 'Bo', rfidCode: '0000000002' });

  // A scan before the race starts (e.g. testing the reader) must not count.
  recordScan(race, { time: '2024-01-01T09:00:00.000Z', code: ada.rfidCode });
  startRace(race);
  race.startedAt = '2024-01-01T10:00:00.000Z';

  recordScan(race, { time: '2024-01-01T10:01:00.000Z', code: ada.rfidCode });
  recordScan(race, { time: '2024-01-01T10:02:00.000Z', code: ada.rfidCode });
  recordScan(race, { time: '2024-01-01T10:01:00.000Z', code: bo.rfidCode });

  const board = getLeaderboard(race);
  assert.equal(board[0].name, 'Ada');
  assert.equal(board[0].rounds, 2);
  assert.equal(board[1].name, 'Bo');
  assert.equal(board[1].rounds, 1);
});

test('getLeaderboard collapses two scans within the minimum lap window into one round', () => {
  const race = createRace();
  const ada = addParticipant(race, { name: 'Ada', rfidCode: '0000000001' });
  startRace(race);
  race.startedAt = '2024-01-01T10:00:00.000Z';

  recordScan(race, { time: '2024-01-01T10:01:00.000Z', code: ada.rfidCode });
  recordScan(race, { time: '2024-01-01T10:01:02.000Z', code: ada.rfidCode }); // bounce, 2s later
  recordScan(race, { time: '2024-01-01T10:05:00.000Z', code: ada.rfidCode }); // real next lap

  const board = getLeaderboard(race, { minLapSeconds: 5 });
  assert.equal(board[0].rounds, 2);
});
