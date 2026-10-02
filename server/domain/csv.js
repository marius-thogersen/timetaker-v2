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
 *  string, one row per participant, ranked within their heat. */
function leaderboardToCsv(leaderboard) {
  let lastHeatId;
  let rank = 0;
  const rows = leaderboard.map((row) => {
    if (row.heatId !== lastHeatId) {
      lastHeatId = row.heatId;
      rank = 0;
    }
    rank += 1;
    return {
      rank,
      startNumber: row.startNumber,
      name: row.name,
      gender: row.gender,
      heatName: row.heatName,
      rounds: row.rounds,
      distanceMeters: row.distanceMeters,
      lastLapAt: row.lastLapAt,
      lastLapDurationSeconds: row.lastLapDurationMs !== null && row.lastLapDurationMs !== undefined
        ? Math.round(row.lastLapDurationMs / 1000)
        : '',
    };
  });

  return toCsv(rows, [
    { key: 'rank', header: 'Rank' },
    { key: 'startNumber', header: 'Bib' },
    { key: 'name', header: 'Name' },
    { key: 'gender', header: 'Gender' },
    { key: 'heatName', header: 'Heat' },
    { key: 'rounds', header: 'Rounds' },
    { key: 'distanceMeters', header: 'Distance (m)' },
    { key: 'lastLapAt', header: 'Last lap at' },
    { key: 'lastLapDurationSeconds', header: 'Last lap duration (s)' },
  ]);
}

module.exports = { toCsv, leaderboardToCsv };
