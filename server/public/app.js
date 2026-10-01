'use strict';

const statusPill = document.getElementById('statusPill');
const signupView = document.getElementById('signupView');
const raceView = document.getElementById('raceView');

const signupForm = document.getElementById('signupForm');
const nameInput = document.getElementById('nameInput');
const genderInput = document.getElementById('genderInput');
const rfidInput = document.getElementById('rfidInput');
const signupError = document.getElementById('signupError');
const participantsTable = document.querySelector('#participantsTable tbody');
const startButton = document.getElementById('startButton');

const leaderboardTable = document.querySelector('#leaderboardTable tbody');
const scanInfo = document.getElementById('scanInfo');
const resetButton = document.getElementById('resetButton');

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

function renderParticipants(participants) {
  participantsTable.innerHTML = '';
  for (const p of participants) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.gender)}</td>
      <td>${escapeHtml(p.rfidCode)}</td>
      <td><button data-id="${p.id}" class="danger removeButton">Remove</button></td>
    `;
    participantsTable.appendChild(row);
  }
}

function renderLeaderboard(rows) {
  leaderboardTable.innerHTML = '';
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    const lastLap = row.lastLapAt ? new Date(row.lastLapAt).toLocaleTimeString() : '—';
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(row.gender)}</td>
      <td>${row.rounds}</td>
      <td>${lastLap}</td>
    `;
    leaderboardTable.appendChild(tr);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function showError(message) {
  signupError.textContent = message;
  signupError.hidden = !message;
}

async function refreshState() {
  const state = await api('/api/state');

  statusPill.textContent = state.status === 'started' ? 'Race running' : 'Signup';
  statusPill.classList.toggle('started', state.status === 'started');

  const isSignup = state.status === 'signup';
  signupView.hidden = !isSignup;
  raceView.hidden = isSignup;

  if (isSignup) {
    renderParticipants(state.participants);
    startButton.disabled = state.participants.length === 0;
  } else {
    const lastScan = state.lastScanReceivedAt
      ? new Date(state.lastScanReceivedAt).toLocaleTimeString()
      : 'none yet';
    scanInfo.textContent = `${state.scanCount} scan(s) received — last at ${lastScan}`;
    const leaderboard = await api('/api/leaderboard');
    renderLeaderboard(leaderboard);
  }
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

participantsTable.addEventListener('click', async (event) => {
  const button = event.target.closest('.removeButton');
  if (!button) return;
  await api(`/api/participants/${button.dataset.id}`, { method: 'DELETE' });
  await refreshState();
});

startButton.addEventListener('click', async () => {
  showError('');
  try {
    await api('/api/race/start', { method: 'POST' });
    await refreshState();
  } catch (error) {
    showError(error.message);
  }
});

resetButton.addEventListener('click', async () => {
  if (!confirm('Reset the race? This clears all participants and scans.')) return;
  await api('/api/race/reset', { method: 'POST' });
  await refreshState();
});

refreshState();
setInterval(refreshState, 1000);
