'use strict';

const statusPill = document.getElementById('statusPill');
const statusBar = document.getElementById('statusBar');
const signupView = document.getElementById('signupView');
const raceView = document.getElementById('raceView');
const themeToggle = document.getElementById('themeToggle');

const signupForm = document.getElementById('signupForm');
const nameInput = document.getElementById('nameInput');
const genderInput = document.getElementById('genderInput');
const rfidInput = document.getElementById('rfidInput');
const signupHeatInput = document.getElementById('signupHeatInput');
const signupError = document.getElementById('signupError');
const participantsByHeat = document.getElementById('participantsByHeat');
const startButton = document.getElementById('startButton');
const startHint = document.getElementById('startHint');

const heatsList = document.getElementById('heatsList');
const addHeatForm = document.getElementById('addHeatForm');
const newHeatNameInput = document.getElementById('newHeatNameInput');
const raceDateInput = document.getElementById('raceDateInput');

const leaderboardByHeat = document.getElementById('leaderboardByHeat');
const resetButton = document.getElementById('resetButton');
const stopResumeButton = document.getElementById('stopResumeButton');
const endRaceButton = document.getElementById('endRaceButton');
const newRaceButton = document.getElementById('newRaceButton');
const actionsMenuButton = document.getElementById('actionsMenuButton');
const actionsMenu = document.getElementById('actionsMenu');
const raceNotStartedNotice = document.getElementById('raceNotStartedNotice');
const raceEndedNotice = document.getElementById('raceEndedNotice');
const liveRaceNotice = document.getElementById('liveRaceNotice');

const raceHistoryButton = document.getElementById('raceHistoryButton');
const raceHistoryView = document.getElementById('raceHistoryView');
const raceHistoryEmpty = document.getElementById('raceHistoryEmpty');
const archiveTable = document.querySelector('#archiveTable tbody');
const archiveDetailCard = document.getElementById('archiveDetailCard');
const archiveDetailTitle = document.getElementById('archiveDetailTitle');
const archiveLeaderboardTable = document.querySelector('#archiveLeaderboardTable tbody');
const archiveExportJsonLink = document.getElementById('archiveExportJsonLink');
const archiveExportCsvLink = document.getElementById('archiveExportCsvLink');

const navSignupButton = document.getElementById('navSignupButton');
const navRaceButton = document.getElementById('navRaceButton');
const navLogButton = document.getElementById('navLogButton');
const logView = document.getElementById('logView');
const logParticipantFilter = document.getElementById('logParticipantFilter');
const logTable = document.querySelector('#logTable tbody');
const participantDetailCard = document.getElementById('participantDetailCard');
const participantDetailName = document.getElementById('participantDetailName');
const participantDetailMeta = document.getElementById('participantDetailMeta');
const participantDetailStats = document.getElementById('participantDetailStats');

const lapDistanceInput = document.getElementById('lapDistanceInput');
const minLapMinutesInput = document.getElementById('minLapMinutesInput');
const minLapSecondsOnlyInput = document.getElementById('minLapSecondsOnlyInput');
const raceSettingsFeedback = document.getElementById('raceSettingsFeedback');

const THEME_KEY = 'timetaker-theme';
const MIN_PARTICIPANT_ROWS = 3;

// Which top-level tab is showing: 'signup', 'race' or 'history'. This is
// independent of the race's own status (signup/started/stopped) — the
// organizer can flip back to Signup at any time, even mid-race.
let currentPage = 'signup';
let latestParticipants = [];
let latestHeats = [];
let latestStatus = 'signup';
// While a history row is in edit mode, track its scan id so the 1s poll
// loop re-rendering the table doesn't wipe out the in-progress edit.
let editingScanId = null;
// Heats start out with no start time at all. Rather than show an empty
// field, we auto-save a sensible default (today, 10:00) the first time we
// see an unset one, so the field is always prefilled with what's actually
// going to be used. Tracked here so we only do it once per heat per page
// load, even while the 1s poll loop is in flight.
const autoDefaultedHeatIds = new Set();

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.textContent = theme === 'light' ? '☀️' : '🌙';
  themeToggle.setAttribute('aria-pressed', String(theme === 'light'));
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved);
    return;
  }
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(prefersLight ? 'light' : 'dark');
}

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

initTheme();

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

function heatName(heatId) {
  const heat = latestHeats.find((h) => h.id === heatId);
  return heat ? heat.name : `Heat ${heatId}`;
}

function heatStartLabel(heat) {
  return heat.startAt ? formatDateTime(heat.startAt) : 'not set yet';
}

const DEFAULT_HEAT_TIME = '10:00';

// Heats start out with no start time. Rather than show an empty field, we
// silently save a sensible default (today's date, 10:00) the first time we
// see an unset heat, so the UI never shows a blank picker — it's always
// prefilled with exactly what will actually be used if nobody touches it.
async function ensureHeatDefaults(heats) {
  for (const heat of heats) {
    if (heat.startAt || autoDefaultedHeatIds.has(heat.id)) continue;
    autoDefaultedHeatIds.add(heat.id);
    const dateValue = raceDateInput.value || todayDateValue();
    const startAt = combineDateAndTime(dateValue, DEFAULT_HEAT_TIME);
    try {
      await api(`/api/heats/${heat.id}/start-time`, {
        method: 'POST',
        body: JSON.stringify({ startAt }),
      });
      heat.startAt = startAt; // reflect immediately, don't wait for the next poll
    } catch {
      autoDefaultedHeatIds.delete(heat.id); // allow retrying next tick
    }
  }
}

// The race date is shared across every heat; it's prefilled with today's
// date, or the date of the first heat that already has a start time.
function populateRaceDateInput(heats) {
  if (document.activeElement === raceDateInput) return;
  const withStart = heats.find((h) => h.startAt);
  raceDateInput.value = withStart ? dateValueOf(withStart.startAt) : todayDateValue();
}

// One management row per heat: name, an auto-saving time-of-day input
// (sharing the single race date above), an optional duration (hours +
// minutes), and a remove button (disabled while it still has participants,
// or if it's the only heat left). Rendered as a table so every heat's
// fields line up in neat columns, same as the participant/leaderboard
// tables elsewhere.
function renderHeatsList(heats) {
  // Only skip re-rendering while the user is actively typing into a field —
  // buttons (e.g. "Remove") shouldn't block the list from refreshing after
  // they're clicked.
  const active = document.activeElement;
  const editableClasses = ['heat-time-input', 'heat-duration-hours', 'heat-duration-minutes'];
  if (active && active.classList && editableClasses.some((c) => active.classList.contains(c))) return;

  const rowsHtml = heats
    .map((heat) => {
      const participantCount = latestParticipants.filter((p) => p.heatId === heat.id).length;
      const canRemove = heats.length > 1 && participantCount === 0;
      const hours = heat.durationMinutes ? Math.floor(heat.durationMinutes / 60) : '';
      const minutes = heat.durationMinutes ? heat.durationMinutes % 60 : '';
      return `
        <tr>
          <td class="heat-name">${escapeHtml(heat.name)}</td>
          <td>
            <span class="cell-inline">
              <input type="time" class="heat-time-input" data-heat-id="${heat.id}" value="${heat.startAt ? timeValueOf(heat.startAt) : DEFAULT_HEAT_TIME}" />
              <button type="button" class="link-button heat-now-button" data-heat-id="${heat.id}">now</button>
            </span>
          </td>
          <td>
            <span class="cell-inline">
              <input type="number" class="heat-duration-hours" data-heat-id="${heat.id}" min="0" max="23" placeholder="h" value="${hours}" /> h
              <input type="number" class="heat-duration-minutes" data-heat-id="${heat.id}" min="0" max="59" placeholder="m" value="${minutes}" /> m
              ${heat.durationMinutes ? `<button type="button" class="link-button heat-duration-clear-button" data-heat-id="${heat.id}">clear</button>` : ''}
            </span>
          </td>
          <td class="numeric">${participantCount}</td>
          <td>
            <button type="button" class="heat-remove-button" data-heat-id="${heat.id}" ${canRemove ? '' : 'disabled'} title="${canRemove ? 'Remove heat' : 'Move participants out first, or keep at least one heat'}">✕</button>
          </td>
        </tr>
      `;
    })
    .join('');

  heatsList.innerHTML = `
    <table class="heats-table">
      <thead>
        <tr><th>Heat</th><th>Start time</th><th>Duration (optional)</th><th>Signed up</th><th></th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

function populateSignupHeatSelect(heats) {
  if (document.activeElement === signupHeatInput) return;
  const currentValue = signupHeatInput.value;
  signupHeatInput.innerHTML = heats.map((h) => `<option value="${h.id}">${escapeHtml(h.name)}</option>`).join('');
  if (heats.some((h) => String(h.id) === currentValue)) {
    signupHeatInput.value = currentValue;
  }
}

function heatMoveSelectHtml(participant, heats) {
  const options = heats
    .map((h) => `<option value="${h.id}" ${h.id === participant.heatId ? 'selected' : ''}>${escapeHtml(h.name)}</option>`)
    .join('');
  return `<select class="heat-move-select" data-id="${participant.id}">${options}</select>`;
}

// One card per heat, each with its own participant table (padded to a
// minimum number of rows so it's obvious where new sign-ups will land).
function renderParticipantsByHeat(heats, participants) {
  // Don't rebuild (and so wipe) an in-progress edit of the start number or
  // RFID code fields — same focus-guard pattern as the heats list.
  const active = document.activeElement;
  const editableClasses = ['start-number-input', 'rfid-code-input'];
  if (active && active.classList && editableClasses.some((c) => active.classList.contains(c)) && participantsByHeat.contains(active)) {
    return;
  }

  participantsByHeat.innerHTML = '';
  for (const heat of heats) {
    const heatParticipants = participants.filter((p) => p.heatId === heat.id);
    const card = document.createElement('div');
    card.className = 'heat-group';
    const rowsHtml = heatParticipants
      .map((p) => `
        <tr>
          <td><input type="number" class="start-number-input" data-id="${p.id}" min="1" step="1" value="${p.startNumber ?? ''}" /></td>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.gender)}</td>
          <td><input type="text" class="rfid-code-input" data-id="${p.id}" placeholder="not set" value="${escapeHtml(p.rfidCode || '')}" /></td>
          <td>${heats.length > 1 ? heatMoveSelectHtml(p, heats) : ''}</td>
          <td><button data-id="${p.id}" class="danger removeButton">Remove</button></td>
        </tr>
      `)
      .join('');
    const emptyRowsHtml = Array.from(
      { length: Math.max(0, MIN_PARTICIPANT_ROWS - heatParticipants.length) },
      () => '<tr class="empty-row"><td>—</td><td>—</td><td>—</td><td>—</td><td></td><td></td></tr>'
    ).join('');
    card.innerHTML = `
      <h3 class="heat-group-title">${escapeHtml(heat.name)} <span class="heat-start-note">Start: ${heatStartLabel(heat)}</span></h3>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Gender</th><th>RFID code</th><th>${heats.length > 1 ? 'Heat' : ''}</th><th></th></tr></thead>
        <tbody>${rowsHtml}${emptyRowsHtml}</tbody>
      </table>
    `;
    participantsByHeat.appendChild(card);
  }
}

// Single combined leaderboard, ranked by rounds (ties broken by whoever's
// last lap was earliest). Each row's "time on course" cell carries its
// reference timestamp in a data attribute and is ticked forward every
// second by a single shared interval (see updateTimeOnCourse below) rather
// than needing a full re-render.
function renderLeaderboard(heats, rows) {
  const heatsById = new Map(heats.map((h) => [h.id, h]));
  const showHeatColumn = heats.length > 1;
  const sorted = rows.slice().sort((a, b) => {
    if (b.rounds !== a.rounds) return b.rounds - a.rounds;
    const aTime = a.lastLapAt ? new Date(a.lastLapAt).getTime() : Infinity;
    const bTime = b.lastLapAt ? new Date(b.lastLapAt).getTime() : Infinity;
    return aTime - bTime;
  });
  const rowsHtml = sorted
    .map((row, index) => {
      const heat = heatsById.get(row.heatId);
      const lapDuration = row.lastLapDurationMs != null ? formatDuration(row.lastLapDurationMs) : '—';
      const distance = row.distanceMeters != null ? formatDistance(row.distanceMeters) : '—';
      const reference = row.lastLapAt || (heat && heat.startAt) || null;
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${row.startNumber ?? '—'}</td>
          <td>${escapeHtml(row.name)}</td>
          ${showHeatColumn ? `<td>${escapeHtml(heatName(row.heatId))}</td>` : ''}
          <td>${row.rounds}</td>
          <td>${distance}</td>
          <td>${lapDuration}</td>
          <td class="time-on-course" data-ref="${reference || ''}">${reference ? formatDuration(Date.now() - new Date(reference).getTime()) : '—'}</td>
        </tr>
      `;
    })
    .join('');
  leaderboardByHeat.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th><th>Bib</th><th>Name</th>${showHeatColumn ? '<th>Heat</th>' : ''}<th>Rounds</th><th>Distance</th><th>Lap time</th><th>Time on course</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

// Ticks every "time on course" cell forward by a second, purely client-side
// from the cached reference timestamp — decoupled from the network refresh
// so it stays smooth even if a state fetch is briefly delayed.
function updateTimeOnCourse() {
  document.querySelectorAll('#leaderboardByHeat .time-on-course[data-ref]').forEach((cell) => {
    const ref = cell.dataset.ref;
    if (!ref) return;
    cell.textContent = formatDuration(Date.now() - new Date(ref).getTime());
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// 24-hour clock with colons (e.g. 14:05:32), regardless of the browser's own locale.
function formatTime(isoString) {
  const date = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Short date + time for the small start-time bar, e.g. "01/06 14:05".
// Start time is only meaningful to the minute, so seconds are omitted.
function formatDateTime(isoString) {
  const date = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Elapsed duration as H:MM:SS or M:SS, for lap times.
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

// Distance covered, e.g. "1.6 km" for 1600m, or "400 m" for short distances.
function formatDistance(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(meters % 1000 === 0 ? 0 : 1)} km`;
  }
  return `${meters} m`;
}

// Today's date, local time, as a <input type="date"> value (YYYY-MM-DD).
function todayDateValue() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The date portion of an ISO timestamp, local time, as a <input
// type="date"> value.
function dateValueOf(isoString) {
  const date = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The time-of-day portion of an ISO timestamp, local time, as a <input
// type="time"> value (HH:MM).
function timeValueOf(isoString) {
  const date = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Combines a <input type="date"> value and a <input type="time"> value
// (both local time, no timezone info) into a full ISO timestamp.
function combineDateAndTime(dateValue, timeValue) {
  return new Date(`${dateValue}T${timeValue}`).toISOString();
}

// Local time, to the second, as a <input type="datetime-local" step="1">
// value (YYYY-MM-DDTHH:MM:SS) — used for editing a scan's exact timestamp.
function datetimeLocalValueOf(isoString) {
  const date = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function showError(message) {
  signupError.textContent = message;
  signupError.hidden = !message;
}

async function refreshState() {
  const state = await api('/api/state');
  latestStatus = state.status;
  latestHeats = state.heats;
  latestParticipants = state.participants;

  const statusLabels = { signup: 'Signup', started: 'Race running', stopped: 'Race stopped', ended: 'Race ended' };
  statusPill.textContent = statusLabels[state.status] || state.status;
  statusPill.classList.toggle('started', state.status === 'started');
  statusPill.classList.toggle('stopped', state.status === 'stopped');
  statusPill.classList.toggle('ended', state.status === 'ended');
  statusBar.classList.toggle('started', state.status === 'started');
  statusBar.classList.toggle('stopped', state.status === 'stopped');
  statusBar.classList.toggle('ended', state.status === 'ended');

  // Don't overwrite the lap distance field while the user is actively
  // editing it — only sync in when it's not currently focused.
  if (document.activeElement !== lapDistanceInput) {
    lapDistanceInput.value = state.lapDistanceMeters || '';
  }
  if (document.activeElement !== minLapMinutesInput && document.activeElement !== minLapSecondsOnlyInput) {
    const total = state.minLapSeconds || 0;
    minLapMinutesInput.value = total ? Math.floor(total / 60) || '' : '';
    minLapSecondsOnlyInput.value = total ? total % 60 : '';
  }

  await ensureHeatDefaults(state.heats);
  populateRaceDateInput(state.heats);
  renderHeatsList(state.heats);
  populateSignupHeatSelect(state.heats);
  populateParticipantFilter(state.participants);
  renderParticipantsByHeat(state.heats, state.participants);

  // Signups are only allowed while the race hasn't started, or while it's
  // paused (stopped) — never while it's actively live or ended (data is
  // frozen once ended; use "New race from this template…" for a fresh run).
  const isLive = state.status === 'started' || state.status === 'ended';
  liveRaceNotice.hidden = state.status !== 'started';
  const canEditParticipants = !isLive;
  nameInput.disabled = !canEditParticipants;
  genderInput.disabled = !canEditParticipants;
  rfidInput.disabled = !canEditParticipants;
  signupHeatInput.disabled = !canEditParticipants;
  signupForm.querySelector('button[type="submit"]').disabled = !canEditParticipants;
  participantsByHeat.querySelectorAll('.removeButton').forEach((btn) => {
    btn.disabled = !canEditParticipants;
  });

  const hasParticipants = state.participants.length > 0;
  startButton.hidden = state.status !== 'signup';
  startButton.disabled = !hasParticipants;
  startHint.hidden = !(state.status === 'signup' && !hasParticipants);

  raceNotStartedNotice.hidden = state.status !== 'signup';
  raceEndedNotice.hidden = state.status !== 'ended';
  stopResumeButton.hidden = state.status === 'signup';
  stopResumeButton.textContent = state.status === 'stopped' || state.status === 'ended' ? '▶ Resume race' : '⏸ Stop race';
  endRaceButton.hidden = state.status !== 'started' && state.status !== 'stopped';
  newRaceButton.hidden = state.status !== 'ended';

  const leaderboard = await api('/api/leaderboard');
  renderLeaderboard(state.heats, leaderboard);
}

signupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  try {
    await api('/api/participants', {
      method: 'POST',
      body: JSON.stringify({
        name: nameInput.value,
        gender: genderInput.value,
        rfidCode: rfidInput.value,
        heatId: signupHeatInput.value ? Number(signupHeatInput.value) : undefined,
      }),
    });
    nameInput.value = '';
    rfidInput.value = '';
    nameInput.focus();
    await refreshState();
  } catch (error) {
    showError(error.message);
  }
});

participantsByHeat.addEventListener('click', async (event) => {
  const button = event.target.closest('.removeButton');
  if (!button) return;
  await api(`/api/participants/${button.dataset.id}`, { method: 'DELETE' });
  await refreshState();
});

participantsByHeat.addEventListener('change', async (event) => {
  const select = event.target.closest('.heat-move-select');
  if (select) {
    try {
      await api(`/api/participants/${select.dataset.id}/heat`, {
        method: 'POST',
        body: JSON.stringify({ heatId: Number(select.value) }),
      });
      await refreshState();
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  const startNumberInput = event.target.closest('.start-number-input');
  if (startNumberInput) {
    try {
      await api(`/api/participants/${startNumberInput.dataset.id}/start-number`, {
        method: 'POST',
        body: JSON.stringify({ startNumber: startNumberInput.value || null }),
      });
      await refreshState();
    } catch (error) {
      alert(error.message);
      await refreshState(); // revert the input back to the last valid value
    }
    return;
  }

  const rfidCodeInput = event.target.closest('.rfid-code-input');
  if (rfidCodeInput) {
    try {
      await api(`/api/participants/${rfidCodeInput.dataset.id}/rfid-code`, {
        method: 'POST',
        body: JSON.stringify({ rfidCode: rfidCodeInput.value }),
      });
      await refreshState();
    } catch (error) {
      alert(error.message);
      await refreshState(); // revert the input back to the last valid value
    }
  }
});

startButton.addEventListener('click', async () => {
  showError('');
  try {
    await api('/api/race/start', { method: 'POST' });
    await refreshState();
    setPage('race');
  } catch (error) {
    showError(error.message);
  }
});

function closeActionsMenu() {
  actionsMenu.hidden = true;
  actionsMenuButton.setAttribute('aria-expanded', 'false');
}

actionsMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const isOpen = !actionsMenu.hidden;
  if (isOpen) {
    closeActionsMenu();
  } else {
    actionsMenu.hidden = false;
    actionsMenuButton.setAttribute('aria-expanded', 'true');
  }
});

document.addEventListener('click', (event) => {
  if (!actionsMenu.hidden && !event.target.closest('.menu-wrapper')) {
    closeActionsMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeActionsMenu();
});

resetButton.addEventListener('click', async () => {
  closeActionsMenu();
  if (!confirm("Reset rounds? This clears all scans and everyone's lap count back to zero, and returns to signup so you can adjust heat start times. Participants, heats, and race settings are kept.")) return;
  await api('/api/race/reset', { method: 'POST' });
  await refreshState();
});

stopResumeButton.addEventListener('click', async () => {
  closeActionsMenu();
  const action = stopResumeButton.textContent.includes('Resume') ? 'resume' : 'stop';
  try {
    await api(`/api/race/${action}`, { method: 'POST' });
    await refreshState();
  } catch (error) {
    alert(error.message);
  }
});

endRaceButton.addEventListener('click', async () => {
  closeActionsMenu();
  if (!confirm('End the race? Scans stop counting, and the final results are frozen for export. You can still resume it afterwards if this was a mistake.')) return;
  try {
    await api('/api/race/end', { method: 'POST' });
    await refreshState();
  } catch (error) {
    alert(error.message);
  }
});

newRaceButton.addEventListener('click', async () => {
  closeActionsMenu();
  if (!confirm('Start a new race from this template? This archives the ended race into Race History, then clears scans/rounds for a fresh run — heats and participants carry over as they are.')) return;
  try {
    await api('/api/race/new-from-template', { method: 'POST' });
    await refreshState();
    setPage('signup');
  } catch (error) {
    alert(error.message);
  }
});

addHeatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!newHeatNameInput.value.trim()) return;
  try {
    await api('/api/heats', {
      method: 'POST',
      body: JSON.stringify({ name: newHeatNameInput.value.trim() }),
    });
    newHeatNameInput.value = '';
    await refreshState();
  } catch (error) {
    alert(error.message);
  }
});

raceDateInput.addEventListener('change', async () => {
  if (!raceDateInput.value) return;
  try {
    for (const heat of latestHeats) {
      const timeInput = heatsList.querySelector(`.heat-time-input[data-heat-id="${heat.id}"]`);
      const timeValue = (timeInput && timeInput.value) || DEFAULT_HEAT_TIME;
      const startAt = combineDateAndTime(raceDateInput.value, timeValue);
      await api(`/api/heats/${heat.id}/start-time`, {
        method: 'POST',
        body: JSON.stringify({ startAt }),
      });
    }
    await refreshState();
  } catch (error) {
    alert(error.message);
  }
});

heatsList.addEventListener('change', async (event) => {
  const timeInput = event.target.closest('.heat-time-input');
  if (timeInput) {
    if (!timeInput.value) return;
    try {
      const dateValue = raceDateInput.value || todayDateValue();
      const startAt = combineDateAndTime(dateValue, timeInput.value);
      await api(`/api/heats/${timeInput.dataset.heatId}/start-time`, {
        method: 'POST',
        body: JSON.stringify({ startAt }),
      });
      await refreshState();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const durationHoursInput = event.target.closest('.heat-duration-hours');
  const durationMinutesInput = event.target.closest('.heat-duration-minutes');
  if (durationHoursInput || durationMinutesInput) {
    const heatId = (durationHoursInput || durationMinutesInput).dataset.heatId;
    const row = event.target.closest('tr');
    const hoursValue = Number(row.querySelector('.heat-duration-hours').value) || 0;
    const minutesValue = Number(row.querySelector('.heat-duration-minutes').value) || 0;
    const totalMinutes = hoursValue * 60 + minutesValue;
    try {
      await api(`/api/heats/${heatId}/duration`, {
        method: 'POST',
        body: JSON.stringify({ durationMinutes: totalMinutes > 0 ? totalMinutes : null }),
      });
      await refreshState();
    } catch (error) {
      alert(error.message);
    }
  }
});

heatsList.addEventListener('click', async (event) => {
  const nowButton = event.target.closest('.heat-now-button');
  if (nowButton) {
    try {
      await api(`/api/heats/${nowButton.dataset.heatId}/start-time`, {
        method: 'POST',
        body: JSON.stringify({ startAt: new Date().toISOString() }),
      });
      await refreshState();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const removeButton = event.target.closest('.heat-remove-button');
  if (removeButton && !removeButton.disabled) {
    if (!confirm('Remove this heat?')) return;
    try {
      await api(`/api/heats/${removeButton.dataset.heatId}`, { method: 'DELETE' });
      await refreshState();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const clearDurationButton = event.target.closest('.heat-duration-clear-button');
  if (clearDurationButton) {
    try {
      await api(`/api/heats/${clearDurationButton.dataset.heatId}/duration`, {
        method: 'POST',
        body: JSON.stringify({ durationMinutes: null }),
      });
      await refreshState();
    } catch (error) {
      alert(error.message);
    }
  }
});

let settingsSavedTimeout;
function showSettingsSaved() {
  raceSettingsFeedback.textContent = 'Saved.';
  raceSettingsFeedback.hidden = false;
  clearTimeout(settingsSavedTimeout);
  settingsSavedTimeout = setTimeout(() => {
    raceSettingsFeedback.hidden = true;
  }, 1500);
}

async function saveLapDistance() {
  try {
    await api('/api/race/lap-distance', {
      method: 'POST',
      body: JSON.stringify({ lapDistanceMeters: lapDistanceInput.value || null }),
    });
    showSettingsSaved();
    await refreshState();
  } catch (error) {
    raceSettingsFeedback.textContent = error.message;
    raceSettingsFeedback.hidden = false;
  }
}

async function saveMinLapSeconds() {
  const minutes = Number(minLapMinutesInput.value) || 0;
  const seconds = Number(minLapSecondsOnlyInput.value) || 0;
  const totalSeconds = minutes * 60 + seconds;
  try {
    await api('/api/race/min-lap-seconds', {
      method: 'POST',
      body: JSON.stringify({ minLapSeconds: totalSeconds > 0 ? totalSeconds : null }),
    });
    showSettingsSaved();
    await refreshState();
  } catch (error) {
    raceSettingsFeedback.textContent = error.message;
    raceSettingsFeedback.hidden = false;
  }
}

// The lap distance field saves itself as soon as the user moves away from
// it (or presses Enter) — there's no separate "Save" button to press.
lapDistanceInput.addEventListener('change', saveLapDistance);
minLapMinutesInput.addEventListener('change', saveMinLapSeconds);
minLapSecondsOnlyInput.addEventListener('change', saveMinLapSeconds);

function populateParticipantFilter(participants) {
  const currentValue = logParticipantFilter.value;
  const options = ['<option value="">All participants</option>']
    .concat(participants.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`));
  logParticipantFilter.innerHTML = options.join('');
  if (participants.some((p) => String(p.id) === currentValue)) {
    logParticipantFilter.value = currentValue;
  }
}

function renderLog(rows) {
  logTable.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.scanId = row.id;
    if (row.id === editingScanId) {
      tr.innerHTML = `
        <td><input type="datetime-local" step="1" class="scan-edit-time" value="${datetimeLocalValueOf(row.time)}" /></td>
        <td>${row.participantId ? escapeHtml(row.participantName) : '<span class="hint">Unknown code</span>'}</td>
        <td><input type="text" class="scan-edit-code" value="${escapeHtml(row.code)}" /></td>
        <td></td>
        <td></td>
        <td class="cell-inline">
          <button type="button" class="link-button scan-save-button" data-id="${row.id}">Save</button>
          <button type="button" class="link-button scan-cancel-button" data-id="${row.id}">Cancel</button>
        </td>
      `;
    } else {
      const participantCell = row.participantId
        ? `<button type="button" class="participant-link" data-id="${row.participantId}">${escapeHtml(row.participantName)}</button>`
        : '<span class="hint">Unknown code</span>';
      const badge = row.counted
        ? '<span class="badge counted">Counted</span>'
        : '<span class="badge excluded">Excluded</span>';
      const reasonCell = row.counted ? '' : escapeHtml(reasonLabel(row.reason));
      tr.innerHTML = `
        <td>${formatTime(row.time)}</td>
        <td>${participantCell}</td>
        <td>${escapeHtml(row.code)}</td>
        <td>${badge}</td>
        <td class="hint">${reasonCell}</td>
        <td class="cell-inline">
          <button type="button" class="link-button scan-edit-button" data-id="${row.id}">Edit</button>
          <button type="button" class="link-button scan-delete-button" data-id="${row.id}">Delete</button>
        </td>
      `;
    }
    logTable.appendChild(tr);
  }
}

function reasonLabel(reason) {
  const labels = {
    unknown_code: 'Unknown code',
    code_assigned_after_scan: 'Code assigned later',
    race_not_started: 'Not started',
    before_start: 'Before start',
    after_end: 'After end',
    paused: 'Paused',
    bounce: 'Too soon',
  };
  return labels[reason] || 'Not counted';
}

async function renderParticipantDetail(participantId) {
  if (!participantId) {
    participantDetailCard.hidden = true;
    return;
  }
  const numericId = Number(participantId);
  const participant = latestParticipants.find((p) => p.id === numericId);
  if (!participant) {
    participantDetailCard.hidden = true;
    return;
  }
  const leaderboard = await api('/api/leaderboard');
  const row = leaderboard.find((r) => r.id === numericId);
  participantDetailCard.hidden = false;
  participantDetailName.textContent = participant.name;
  participantDetailMeta.textContent = `Gender: ${participant.gender} · RFID code: ${participant.rfidCode}`;
  if (row) {
    const distance = row.distanceMeters != null ? formatDistance(row.distanceMeters) : '—';
    const lastLap = row.lastLapAt ? formatTime(row.lastLapAt) : '—';
    participantDetailStats.textContent = `Rounds: ${row.rounds} · Distance: ${distance} · Last lap: ${lastLap}`;
  } else {
    participantDetailStats.textContent = '';
  }
}

async function refreshLog() {
  const participantId = logParticipantFilter.value;
  const query = participantId ? `?participantId=${encodeURIComponent(participantId)}` : '';
  const rows = await api(`/api/scans${query}`);
  // Don't rebuild the table while a row is mid-edit — it would overwrite
  // whatever the user is currently typing on every 1s poll.
  if (editingScanId === null) {
    renderLog(rows);
  }
  await renderParticipantDetail(participantId);
}

function setPage(page) {
  currentPage = page;
  signupView.hidden = page !== 'signup';
  raceView.hidden = page !== 'race';
  logView.hidden = page !== 'log';
  raceHistoryView.hidden = page !== 'raceHistory';
  navSignupButton.classList.toggle('active', page === 'signup');
  navRaceButton.classList.toggle('active', page === 'race');
  navLogButton.classList.toggle('active', page === 'log');
  if (page === 'log') refreshLog();
  if (page === 'raceHistory') refreshRaceHistory();
}

raceHistoryButton.addEventListener('click', () => setPage('raceHistory'));

async function refreshRaceHistory() {
  const archives = await api('/api/archive');
  raceHistoryEmpty.hidden = archives.length > 0;
  archiveTable.innerHTML = archives
    .map(
      (a) => `
        <tr>
          <td>${formatDateTime(a.archivedAt)}</td>
          <td>${a.participantCount}</td>
          <td>
            <button type="button" class="menu-item archive-view-button" data-id="${a.id}" data-label="${escapeHtml(a.label)}">View results</button>
            <a class="menu-item" href="/api/archive/${a.id}/export.json">⬇ JSON</a>
            <a class="menu-item" href="/api/archive/${a.id}/export.csv">⬇ CSV</a>
          </td>
        </tr>
      `
    )
    .join('');
  if (!archives.some((a) => String(a.id) === archiveDetailCard.dataset.archiveId)) {
    archiveDetailCard.hidden = true;
  }
}

archiveTable.addEventListener('click', async (event) => {
  const button = event.target.closest('.archive-view-button');
  if (!button) return;
  const id = button.dataset.id;
  const leaderboard = await api(`/api/archive/${id}/leaderboard`);
  archiveDetailCard.hidden = false;
  archiveDetailCard.dataset.archiveId = id;
  archiveDetailTitle.textContent = `Results — ${button.dataset.label}`;
  archiveExportJsonLink.href = `/api/archive/${id}/export.json`;
  archiveExportCsvLink.href = `/api/archive/${id}/export.csv`;
  archiveLeaderboardTable.innerHTML = leaderboard
    .map((row, index) => {
      const lapDuration = row.lastLapDurationMs != null ? formatDuration(row.lastLapDurationMs) : '—';
      const distance = row.distanceMeters != null ? formatDistance(row.distanceMeters) : '—';
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${row.startNumber ?? '—'}</td>
          <td>${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.heatName || '')}</td>
          <td>${row.rounds}</td>
          <td>${distance}</td>
          <td>${lapDuration}</td>
        </tr>
      `;
    })
    .join('');
});

navSignupButton.addEventListener('click', () => setPage('signup'));
navRaceButton.addEventListener('click', () => setPage('race'));
navLogButton.addEventListener('click', () => setPage('log'));
logParticipantFilter.addEventListener('change', refreshLog);

logTable.addEventListener('click', async (event) => {
  const link = event.target.closest('.participant-link');
  if (link) {
    logParticipantFilter.value = link.dataset.id;
    refreshLog();
    return;
  }

  const editButton = event.target.closest('.scan-edit-button');
  if (editButton) {
    editingScanId = Number(editButton.dataset.id);
    refreshLog();
    return;
  }

  const cancelButton = event.target.closest('.scan-cancel-button');
  if (cancelButton) {
    editingScanId = null;
    refreshLog();
    return;
  }

  const saveButton = event.target.closest('.scan-save-button');
  if (saveButton) {
    const id = Number(saveButton.dataset.id);
    const tr = saveButton.closest('tr');
    const timeValue = tr.querySelector('.scan-edit-time').value;
    const codeValue = tr.querySelector('.scan-edit-code').value;
    try {
      await api(`/api/scans/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ time: new Date(timeValue).toISOString(), code: codeValue }),
      });
      editingScanId = null;
      await refreshLog();
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  const deleteButton = event.target.closest('.scan-delete-button');
  if (deleteButton) {
    const id = Number(deleteButton.dataset.id);
    if (!confirm('Delete this scan? This cannot be undone.')) return;
    try {
      await api(`/api/scans/${id}`, { method: 'DELETE' });
      await refreshLog();
    } catch (error) {
      alert(error.message);
    }
  }
});

(async () => {
  try {
    const state = await api('/api/state');
    setPage(state.status === 'signup' ? 'signup' : 'race');
  } catch {
    setPage('signup');
  }
  await refreshState();
})();

setInterval(async () => {
  await refreshState();
  if (currentpage === 'log') await refreshLog();
}, 1000);

// One shared interval ticks every row's "time on course" cell forward every
// second, independent of the (also 1s) network refresh above, so the
// numbers keep advancing smoothly even if a fetch is briefly delayed.
setInterval(updateTimeOnCourse, 1000);
