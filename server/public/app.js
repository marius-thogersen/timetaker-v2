'use strict';

const statusPill = document.getElementById('statusPill');
const statusBar = document.getElementById('statusBar');
const signupView = document.getElementById('signupView');
const raceView = document.getElementById('raceView');
const themeSelect = document.getElementById('themeSelect');

const signupForm = document.getElementById('signupForm');
const nameInput = document.getElementById('nameInput');
const genderInput = document.getElementById('genderInput');
const rfidInput = document.getElementById('rfidInput');
const signupHeatInput = document.getElementById('signupHeatInput');
const signupError = document.getElementById('signupError');
const participantsByHeat = document.getElementById('participantsByHeat');
const startButton = document.getElementById('startButton');
const startHint = document.getElementById('startHint');
const autoStartCheckbox = document.getElementById('autoStartCheckbox');

const heatsList = document.getElementById('heatsList');
const addHeatForm = document.getElementById('addHeatForm');
const newHeatNameInput = document.getElementById('newHeatNameInput');
const raceDateInput = document.getElementById('raceDateInput');

const leaderboardByHeat = document.getElementById('leaderboardByHeat');
const resetButton = document.getElementById('resetButton');
const playPauseButton = document.getElementById('playPauseButton');
const endRaceButton = document.getElementById('endRaceButton');
const actionsMenuButton = document.getElementById('actionsMenuButton');
const actionsMenu = document.getElementById('actionsMenu');
const headerMenuButton = document.getElementById('headerMenuButton');
const headerMenu = document.getElementById('headerMenu');
const factoryResetButton = document.getElementById('factoryResetButton');
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
const currentRaceStatusLabel = document.getElementById('currentRaceStatusLabel');
const currentRaceLeaderboardTable = document.querySelector('#currentRaceLeaderboardTable tbody');
const newRaceFromHistoryButton = document.getElementById('newRaceFromHistoryButton');

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

const lapDetailOverlay = document.getElementById('lapDetailOverlay');
const lapDetailName = document.getElementById('lapDetailName');
const lapDetailMeta = document.getElementById('lapDetailMeta');
const lapDetailTable = document.querySelector('#lapDetailTable tbody');
const lapDetailEmpty = document.getElementById('lapDetailEmpty');
const lapDetailCloseButton = document.getElementById('lapDetailCloseButton');

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

const THEMES = ['dark', 'light'];

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeSelect.value = theme;
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (THEMES.includes(saved)) {
    applyTheme(saved);
    return;
  }
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(prefersLight ? 'light' : 'dark');
}

themeSelect.addEventListener('change', () => {
  const next = THEMES.includes(themeSelect.value) ? themeSelect.value : 'dark';
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

// One management row per heat: an auto-saving name input, an auto-saving
// time-of-day input (sharing the single race date above), and a remove
// button (disabled while it still has participants, or if it's the only
// heat left). Rendered as a table so every heat's fields line up in neat
// columns, same as the participant/leaderboard tables elsewhere.
function renderHeatsList(heats, { force = false } = {}) {
  // Only skip re-rendering while the user is actively typing into a field —
  // buttons (e.g. "Remove") shouldn't block the list from refreshing after
  // they're clicked. `force` bypasses this: used right after the user's own
  // heat edit, so the tables reflect what they just did even if focus
  // hasn't moved on (e.g. Tab landed on an adjacent guarded field).
  const active = document.activeElement;
  const editableClasses = ['heat-name-input', 'heat-time-input'];
  if (!force && active && active.classList && editableClasses.some((c) => active.classList.contains(c))) return;

  const rowsHtml = heats
    .map((heat) => {
      const participantCount = latestParticipants.filter((p) => p.heatId === heat.id).length;
      const canRemove = heats.length > 1 && participantCount === 0;
      return `
        <tr>
          <td><input type="text" class="heat-name-input" data-heat-id="${heat.id}" value="${escapeHtml(heat.name)}" /></td>
          <td>
            <span class="cell-inline">
              <input type="time" step="300" class="heat-time-input" data-heat-id="${heat.id}" value="${heat.startAt ? timeValueOf(heat.startAt) : DEFAULT_HEAT_TIME}" />
              <button type="button" class="link-button heat-now-button" data-heat-id="${heat.id}">now</button>
            </span>
          </td>
          <td class="numeric">${participantCount}</td>
          <td>
            <button type="button" class="heat-remove-button" data-heat-id="${heat.id}" ${canRemove ? '' : 'disabled'}>✕</button>
          </td>
        </tr>
      `;
    })
    .join('');

  heatsList.innerHTML = `
    <table class="heats-table">
      <thead>
        <tr><th>Heat</th><th>Start time</th><th>Signed up</th><th></th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  if (document.activeElement !== newHeatNameInput) {
    newHeatNameInput.placeholder = `Heat ${heats.length + 1}`;
  }
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
function renderParticipantsByHeat(heats, participants, { force = false } = {}) {
  // Don't rebuild (and so wipe) an in-progress edit of the start number,
  // RFID code, or heat-move fields — same focus-guard pattern as the heats
  // list. `force` bypasses this after the user's own heat edit, so these
  // cards (heat names, heat-move options, counts) reflect it immediately.
  const active = document.activeElement;
  const editableClasses = ['start-number-input', 'rfid-code-input', 'heat-move-select'];
  if (!force && active && active.classList && editableClasses.some((c) => active.classList.contains(c)) && participantsByHeat.contains(active)) {
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
          <td><button type="button" data-id="${p.id}" class="participant-remove-button">🗑</button></td>
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
    // Compare actual time spent completing their rounds, not the
    // absolute clock time of their last lap — otherwise a faster runner
    // from a later-starting heat would wrongly rank below a slower one
    // from an earlier heat just because their heat started later.
    const aTime = a.timeSpentMs != null ? a.timeSpentMs : Infinity;
    const bTime = b.timeSpentMs != null ? b.timeSpentMs : Infinity;
    return aTime - bTime;
  });
  const rowsHtml = sorted
    .map((row, index) => {
      const heat = heatsById.get(row.heatId);
      const lapDuration = row.lastLapDurationMs != null ? formatDuration(row.lastLapDurationMs) : '—';
      const timeSpent = row.timeSpentMs != null ? formatDuration(row.timeSpentMs) : '—';
      const distance = row.distanceMeters != null ? formatDistance(row.distanceMeters) : '—';
      const reference = row.lastLapAt || (heat && heat.startAt) || null;
      return `
        <tr class="clickable-row" data-participant-id="${row.id}">
          <td>${index + 1}</td>
          <td>${escapeHtml(row.name)}</td>
          ${showHeatColumn ? `<td>${escapeHtml(heatName(row.heatId))}</td>` : ''}
          <td>${row.rounds}</td>
          <td>${timeSpent}</td>
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
          <th>#</th><th>Name</th>${showHeatColumn ? '<th>Heat</th>' : ''}<th>Rounds</th><th>Time spent</th><th>Distance</th><th>Lap time</th><th>Time on course</th>
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

// Clicking a leaderboard row opens a modal with that participant's full
// lap-by-lap breakdown — the detail behind their round count.
async function openLapDetail(participantId) {
  const numericId = Number(participantId);
  const participant = latestParticipants.find((p) => p.id === numericId);
  if (!participant) return;

  lapDetailName.textContent = participant.name;
  lapDetailMeta.textContent = `Gender: ${participant.gender} · RFID code: ${participant.rfidCode || '—'} · Heat: ${heatName(participant.heatId)}`;
  lapDetailOverlay.hidden = false;

  const laps = await api(`/api/participants/${numericId}/laps`);
  lapDetailEmpty.hidden = laps.length > 0;
  lapDetailTable.innerHTML = laps
    .map(
      (lap) => `
        <tr>
          <td>${lap.lapNumber}</td>
          <td>${formatTime(lap.time)}</td>
          <td>${lap.durationMs != null ? formatDuration(lap.durationMs) : '—'}</td>
        </tr>
      `
    )
    .join('');
}

function closeLapDetail() {
  lapDetailOverlay.hidden = true;
}

leaderboardByHeat.addEventListener('click', (event) => {
  const row = event.target.closest('.clickable-row');
  if (!row) return;
  openLapDetail(row.dataset.participantId);
});

lapDetailCloseButton.addEventListener('click', closeLapDetail);
lapDetailOverlay.addEventListener('click', (event) => {
  if (event.target === lapDetailOverlay) closeLapDetail();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !lapDetailOverlay.hidden) closeLapDetail();
});

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

const STATUS_LABELS = { signup: 'Signup', started: 'Race running', stopped: 'Race stopped', ended: 'Race ended' };

async function refreshState({ force = false } = {}) {
  const state = await api('/api/state');
  latestStatus = state.status;
  latestHeats = state.heats;
  latestParticipants = state.participants;

  statusPill.textContent = STATUS_LABELS[state.status] || state.status;
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
  renderHeatsList(state.heats, { force });
  populateSignupHeatSelect(state.heats);
  populateParticipantFilter(state.participants);
  renderParticipantsByHeat(state.heats, state.participants, { force });

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
  participantsByHeat.querySelectorAll('.participant-remove-button').forEach((btn) => {
    btn.disabled = !canEditParticipants;
  });

  const hasParticipants = state.participants.length > 0;
  const now = new Date();
  const notYetDueHeat = state.heats.find((h) => h.startAt && new Date(h.startAt) > now);
  const notStarted = state.status === 'signup';
  startButton.closest('.start-race-row').hidden = !notStarted;
  startButton.disabled = !hasParticipants || Boolean(notYetDueHeat);
  startHint.classList.remove('error');
  if (!hasParticipants) {
    startHint.textContent = 'Add at least one participant to start the race.';
    startHint.hidden = !notStarted;
  } else if (notYetDueHeat) {
    startHint.textContent = `${notYetDueHeat.name} is scheduled to start at ${new Date(notYetDueHeat.startAt).toLocaleString()} — wait until then, or adjust its start time on the Signup tab.`;
    startHint.hidden = !notStarted;
  } else {
    startHint.hidden = true;
  }

  raceNotStartedNotice.hidden = state.status !== 'signup';
  raceEndedNotice.hidden = state.status !== 'ended';

  // The ⋮ control panel only makes sense once there's actually a race in
  // progress (or paused/ended) to control — before that, "Start race" above
  // is the only available action.
  actionsMenuButton.closest('.menu-wrapper').hidden = notStarted;
  if (notStarted) closeActionsMenu();
  playPauseButton.textContent = state.status === 'started' ? '⏸ Pause race' : '▶ Resume race';
  playPauseButton.classList.toggle('control-button--pause', state.status === 'started');
  playPauseButton.classList.toggle('control-button--play', state.status !== 'started');
  // Ending only makes sense while a race is actually running or paused —
  // once it's already ended, this is correctly disabled (not hidden, so
  // it's clear the action exists but isn't applicable right now).
  endRaceButton.disabled = state.status !== 'started' && state.status !== 'stopped';

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
  const button = event.target.closest('.participant-remove-button');
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
      await refreshState({ force: true });
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

async function attemptStartRace() {
  try {
    await api('/api/race/start', { method: 'POST' });
    await refreshState();
    setPage('race');
    return true;
  } catch (error) {
    // Rare: the disabled-state check above already covers "no participants"
    // and "a heat isn't due yet", but a heat's start time can tick over
    // between render and click — show it right here on the race page,
    // not in the (now hidden) signup page's error box.
    startHint.textContent = error.message;
    startHint.classList.add('error');
    startHint.hidden = false;
    return false;
  }
}

startButton.addEventListener('click', attemptStartRace);

// Auto-start: once "Auto-start when due" is checked, don't make the user
// sit there and click Start race the instant a scheduled heat time
// arrives — check every second (purely a local clock comparison against
// the already-fetched heats, no network call) and start automatically the
// moment the button would've become enabled anyway.
const AUTO_START_PREF_KEY = 'timetaker.autoStart';
autoStartCheckbox.checked = localStorage.getItem(AUTO_START_PREF_KEY) === 'true';
autoStartCheckbox.addEventListener('change', () => {
  localStorage.setItem(AUTO_START_PREF_KEY, String(autoStartCheckbox.checked));
});

let autoStarting = false;
async function checkAutoStart() {
  if (autoStarting || !autoStartCheckbox.checked) return;
  if (latestStatus !== 'signup') return;
  if (latestParticipants.length === 0) return;
  const now = new Date();
  const notYetDue = latestHeats.some((h) => h.startAt && new Date(h.startAt) > now);
  if (notYetDue) return;
  autoStarting = true;
  try {
    await attemptStartRace();
  } finally {
    autoStarting = false;
  }
}
setInterval(checkAutoStart, 1000);

// Generic dropdown-menu wiring, shared by the race-actions menu (⋮) and the
// header menu (☰): clicking the button toggles its menu (closing any other
// open menu first), clicking anywhere outside a menu's own wrapper closes
// it, and Escape closes all of them.
const registeredMenus = [];
function registerMenu(button, menu) {
  const wrapper = button.closest('.menu-wrapper');
  function close() {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = !menu.hidden;
    closeAllMenus();
    if (!isOpen) {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    }
  });
  registeredMenus.push({ wrapper, menu, close });
  return close;
}

function closeAllMenus() {
  registeredMenus.forEach((m) => m.close());
}

document.addEventListener('click', (event) => {
  registeredMenus.forEach((m) => {
    if (!m.menu.hidden && !m.wrapper.contains(event.target)) m.close();
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeAllMenus();
});

const closeActionsMenu = registerMenu(actionsMenuButton, actionsMenu);
registerMenu(headerMenuButton, headerMenu);

factoryResetButton.addEventListener('click', async () => {
  closeAllMenus();
  if (
    !confirm(
      'Reset EVERYTHING? This removes all participants, heats, and times, and archives the current race into Race History first so nothing is lost. This cannot be undone from here.'
    )
  ) {
    return;
  }
  try {
    await api('/api/race/factory-reset', { method: 'POST' });
    await refreshState();
    setPage('signup');
  } catch (error) {
    alert(error.message);
  }
});

resetButton.addEventListener('click', async () => {
  closeActionsMenu();
  if (!confirm("Reset rounds? This clears all scans and everyone's lap count back to zero, and returns to signup so you can adjust heat start times. Participants, heats, and race settings are kept.")) return;
  await api('/api/race/reset', { method: 'POST' });
  await refreshState();
});

playPauseButton.addEventListener('click', async () => {
  closeActionsMenu();
  const action = playPauseButton.textContent.includes('Resume') ? 'resume' : 'stop';
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

async function startNewRaceFromTemplate() {
  if (!confirm('Start a new race from this template? This archives the ended race into Race History, then clears scans/rounds for a fresh run — heats and participants carry over as they are.')) return;
  try {
    await api('/api/race/new-from-template', { method: 'POST' });
    await refreshState();
    setPage('signup');
  } catch (error) {
    alert(error.message);
  }
}

newRaceFromHistoryButton.addEventListener('click', startNewRaceFromTemplate);

addHeatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/heats', {
      method: 'POST',
      body: JSON.stringify({ name: newHeatNameInput.value.trim() }),
    });
    newHeatNameInput.value = '';
    await refreshState({ force: true });
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
    await refreshState({ force: true });
  } catch (error) {
    alert(error.message);
  }
});

heatsList.addEventListener('change', async (event) => {
  const nameInput = event.target.closest('.heat-name-input');
  if (nameInput) {
    try {
      await api(`/api/heats/${nameInput.dataset.heatId}/name`, {
        method: 'POST',
        body: JSON.stringify({ name: nameInput.value.trim() }),
      });
      // For a text input, 'change' only fires on blur, so focus has
      // already moved elsewhere by the time we get here — always safe
      // (and necessary, per the Tab-to-another-field case) to force a
      // re-render.
      await refreshState({ force: true });
    } catch (error) {
      alert(error.message);
    }
    return;
  }
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
      // Unlike a text input, a native time input fires 'change' as soon
      // as a segment (e.g. the minutes) is completed — while the user is
      // still mid-edit and the field is still focused, not just on blur.
      // Forcing a full re-render right then would tear down and rebuild
      // this very input, killing its focus/cursor position while typing.
      // Only force once focus has actually moved elsewhere (e.g. via Tab
      // to another field) — same guard, just conditional on that instead
      // of blanket-forcing.
      await refreshState({ force: document.activeElement !== timeInput });
    } catch (error) {
      alert(error.message);
    }
    return;
  }
});

// Catch-up: once focus actually leaves a heat name/time field (e.g. the
// user clicks away, or tabs past it to something that isn't itself a
// guarded field), force one re-render so any secondary displays that
// depend on it — the "Start: ..." note in the participants table, the
// start-button's "not due yet" hint — reflect the saved value, even if
// the 'change' handler above deliberately skipped forcing one while the
// field was still focused.
heatsList.addEventListener(
  'focusout',
  (event) => {
    const field = event.target.closest('.heat-name-input, .heat-time-input');
    if (!field) return;
    refreshState({ force: true });
  },
  true
);

heatsList.addEventListener('click', async (event) => {
  const nowButton = event.target.closest('.heat-now-button');
  if (nowButton) {
    try {
      await api(`/api/heats/${nowButton.dataset.heatId}/start-time`, {
        method: 'POST',
        body: JSON.stringify({ startAt: new Date().toISOString() }),
      });
      await refreshState({ force: true });
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
      await refreshState({ force: true });
    } catch (error) {
      alert(error.message);
    }
    return;
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

async function refreshLog(force = false) {
  const participantId = logParticipantFilter.value;
  const query = participantId ? `?participantId=${encodeURIComponent(participantId)}` : '';
  const rows = await api(`/api/scans${query}`);
  // Don't rebuild the table while a row is mid-edit — it would overwrite
  // whatever the user is currently typing on every 1s poll. `force` opts
  // out of that guard for user-triggered actions (e.g. actually entering or
  // leaving edit mode), which must always render immediately.
  if (force || editingScanId === null) {
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
  currentRaceStatusLabel.textContent = STATUS_LABELS[latestStatus] || latestStatus;
  currentRaceStatusLabel.classList.toggle('started', latestStatus === 'started');
  currentRaceStatusLabel.classList.toggle('stopped', latestStatus === 'stopped');
  currentRaceStatusLabel.classList.toggle('ended', latestStatus === 'ended');
  newRaceFromHistoryButton.disabled = latestStatus !== 'ended';

  const currentLeaderboard = await api('/api/leaderboard');
  currentRaceLeaderboardTable.innerHTML = currentLeaderboard
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
    refreshLog(true);
    return;
  }

  const cancelButton = event.target.closest('.scan-cancel-button');
  if (cancelButton) {
    editingScanId = null;
    refreshLog(true);
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

// Live updates via Server-Sent Events: the server pushes a message the
// moment anything actually changes (a scan comes in, someone signs up,
// a heat gets edited, ...), instead of the browser blindly asking on a
// timer. EventSource reconnects on its own if the connection drops; we
// also force one resync right after (re)connecting, in case an update
// was missed while disconnected.
const liveUpdates = new EventSource('/api/events');
async function handleLiveUpdate() {
  await refreshState();
  if (currentPage === 'log') await refreshLog();
}
liveUpdates.addEventListener('update', handleLiveUpdate);
liveUpdates.addEventListener('open', handleLiveUpdate);

// One shared interval ticks every row's "time on course" cell forward every
// second, purely client-side math (no network call) — it's not tied to
// server updates at all, so the numbers keep advancing smoothly between
// them.
setInterval(updateTimeOnCourse, 1000);
