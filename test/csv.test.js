'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { leaderboardToCsv } = require('../server/domain/csv');

test('leaderboardToCsv ranks globally by given order and quotes names containing commas', () => {
  const csv = leaderboardToCsv([
    // getLeaderboard already ranks globally across heats (most rounds
    // first, ties broken by least time spent), so the CSV's rank column
    // is simply position in the given order — not reset per heat.
    { heatId: 1, startNumber: 1, name: 'Ada', gender: 'female', heatName: 'Heat 1', rounds: 5, timeSpentMs: 300_000, distanceMeters: 2000, lastLapAt: '2024-01-01T10:06:00.000Z', lastLapDurationMs: 60_000 },
    { heatId: 2, startNumber: 3, name: 'Bo', gender: 'other', heatName: 'Heat 2', rounds: 3, timeSpentMs: 180_000, distanceMeters: 1200, lastLapAt: '2024-01-01T10:05:00.000Z', lastLapDurationMs: 65_000 },
    { heatId: 1, startNumber: 2, name: 'Smith, Jr.', gender: 'male', heatName: 'Heat 1', rounds: 1, timeSpentMs: null, distanceMeters: null, lastLapAt: null, lastLapDurationMs: null },
  ]);

  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Rank,Bib,Name,Gender,Heat,Rounds,Time spent (s),Distance (m),Last lap at,Last lap duration (s)');
  assert.equal(lines[1], '1,1,Ada,female,Heat 1,5,300,2000,2024-01-01T10:06:00.000Z,60');
  assert.equal(lines[2], '2,3,Bo,other,Heat 2,3,180,1200,2024-01-01T10:05:00.000Z,65');
  assert.equal(lines[3], '3,2,"Smith, Jr.",male,Heat 1,1,,,,');
});
