'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { leaderboardToCsv } = require('../server/domain/csv');

test('leaderboardToCsv ranks within each heat and quotes names containing commas', () => {
  const csv = leaderboardToCsv([
    { heatId: 1, startNumber: 2, name: 'Smith, Jr.', gender: 'male', heatName: 'Heat 1', rounds: 3, distanceMeters: 1200, lastLapAt: '2024-01-01T10:05:00.000Z', lastLapDurationMs: 65_000 },
    { heatId: 1, startNumber: 1, name: 'Ada', gender: 'female', heatName: 'Heat 1', rounds: 5, distanceMeters: 2000, lastLapAt: '2024-01-01T10:06:00.000Z', lastLapDurationMs: 60_000 },
    { heatId: 2, startNumber: 3, name: 'Bo', gender: 'other', heatName: 'Heat 2', rounds: 1, distanceMeters: null, lastLapAt: null, lastLapDurationMs: null },
  ]);

  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Rank,Bib,Name,Gender,Heat,Rounds,Distance (m),Last lap at,Last lap duration (s)');
  // First heat's rows keep the caller's given order (rank = position within that order).
  assert.equal(lines[1], '1,2,"Smith, Jr.",male,Heat 1,3,1200,2024-01-01T10:05:00.000Z,65');
  assert.equal(lines[2], '2,1,Ada,female,Heat 1,5,2000,2024-01-01T10:06:00.000Z,60');
  // A new heat id resets the rank counter back to 1.
  assert.equal(lines[3], '1,3,Bo,other,Heat 2,1,,,');
});
