'use strict';

/**
 * Minimal CSV writer — no escaping library needed for data this simple, but
 * values are still safely quoted if they contain a comma, quote, or newline
 * so names like "Smith, Jr." or multi-word heat names never break a column.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => csvCell(c.header)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}

/** Turns a leaderboard (as returned by race.getLeaderboard) into a CSV
 *  string, one row per participant, in the given order — getLeaderboard
 *  already ranks globally across all heats (most rounds first, ties
 *  broken by least time spent), so rank here is simply position in that
 *  order, not reset per heat. */
function leaderboardToCsv(leaderboard) {
  const rows = leaderboard.map((row, index) => ({
    rank: index + 1,
    startNumber: row.startNumber,
    name: row.name,
    gender: row.gender,
    heatName: row.heatName,
    rounds: row.rounds,
    timeSpentSeconds: row.timeSpentMs !== null && row.timeSpentMs !== undefined
      ? Math.round(row.timeSpentMs / 1000)
      : '',
    distanceMeters: row.distanceMeters,
    lastLapAt: row.lastLapAt,
    lastLapDurationSeconds: row.lastLapDurationMs !== null && row.lastLapDurationMs !== undefined
      ? Math.round(row.lastLapDurationMs / 1000)
      : '',
  }));

  return toCsv(rows, [
    { key: 'rank', header: 'Rank' },
    { key: 'startNumber', header: 'Bib' },
    { key: 'name', header: 'Name' },
    { key: 'gender', header: 'Gender' },
    { key: 'heatName', header: 'Heat' },
    { key: 'rounds', header: 'Rounds' },
    { key: 'timeSpentSeconds', header: 'Time spent (s)' },
    { key: 'distanceMeters', header: 'Distance (m)' },
    { key: 'lastLapAt', header: 'Last lap at' },
    { key: 'lastLapDurationSeconds', header: 'Last lap duration (s)' },
  ]);
}

module.exports = { toCsv, leaderboardToCsv };
