# Task: Prevent screen/PC sleep during a race (Screen Wake Lock)

> Picked up by: main session agent, implementing now (added the
> `<script src="/wakelock.js">` line to `index.html` and creating
> `wakelock.js` as a new, isolated file). Not touching anything else in
> `app.js`/`index.html`.

## Implemented

- Added `server/public/wakelock.js` (new, self-contained, no globals shared
  with `app.js`): requests `navigator.wakeLock.request('screen')` on load,
  guarded by `if ('wakeLock' in navigator)`; re-acquires on
  `visibilitychange` when the tab becomes visible again; one-time `click`
  fallback (`{ once: true }`) in case the automatic request was rejected;
  all failures are `console.warn`, never thrown.
- Added a single line to `server/public/index.html`:
  `<script src="/wakelock.js"></script>` right after the existing
  `<script src="/app.js"></script>` at the bottom of `<body>`. Nothing else
  in that file was touched.
- `node --check` passes on the new file. Not yet manually verified in a
  browser (see "Suggested manual test" above) — moving to `implemented/`,
  not `tested/`.

## Follow-up: made it optional via a header toggle

Per a later user request, added a slide toggle in the page header
(`#wakeLockToggle`, left of the light/dark button) so the user can turn the
wake lock on/off:

- `index.html`: added a `<label class="wake-lock-toggle">` with a checkbox
  styled as a track+thumb slider, placed in `<header>` between the spacer
  and `#themeToggle`.
- `styles.css`: added `.wake-lock-toggle`/`.switch`/`.switch-track`/
  `.switch-thumb` rules (plain checkbox visually hidden, styled sibling
  spans for the track/thumb — keeps it keyboard/focus accessible).
- `wakelock.js`: preference persisted in `localStorage` under
  `timetaker.wakeLockEnabled` (defaults to **on** if never set). Toggling
  off calls `wakeLock.release()`; toggling on re-requests it. The
  `visibilitychange` re-acquire and the one-time `click` fallback now both
  check the `enabled` flag before requesting. If the Wake Lock API isn't
  supported, the toggle is disabled with a tooltip explaining why.
- `node --check` passes; domain test suite (22/22) unaffected (frontend-only
  change).

Hey! 👋 Heads up before you start — there's another agent (me, in a different
session) actively working on `server/public/app.js` and `server/public/index.html`
right now with uncommitted changes. Please **pull/check `git status` first**,
and keep this change as small and isolated as possible so we don't stomp on
each other's edits. If you hit a conflict area, prefer adding new, separate
lines rather than restructuring existing ones.

## Why this matters (please read)

TimeTaker races run unattended for **up to 24 hours straight**. If the host
PC's screen locks or sleeps mid-race, RFID scans could be missed or the UI
could stop updating — which would quietly ruin a live race with no way to
recover lost laps. This is not a "nice to have" — treat it as important as
any other reliability fix. Please don't skip error handling or the
visibility-change re-acquire logic described below; those are the parts that
actually make it reliable over a full day, not just in a quick manual test.

## What to implement

Use the browser's **Screen Wake Lock API** to keep the display from sleeping
while the TimeTaker tab is open/visible (race or signup/history — any view).

1. Create a new, self-contained file: `server/public/wakelock.js`
   - No dependency on `app.js` globals — keep it isolated so it can't
     conflict with whatever else is being built in app.js.
   - Request `navigator.wakeLock.request('screen')` on load.
   - Guard with `if ('wakeLock' in navigator)` — not all browsers support it
     (notably Safari/iOS as of now), so fail silently (console.warn) rather
     than throwing.
   - Browsers auto-release the lock when the tab is hidden/backgrounded.
     Listen for `visibilitychange` and re-request the lock when the tab
     becomes visible again.
   - Some browsers want a user gesture before granting the lock. Add a
     one-time fallback: request again on the first `click` anywhere on the
     page (`{ once: true }`), in case the initial automatic request is
     rejected.

2. Add **one line** to `server/public/index.html`: a
   `<script src="/wakelock.js"></script>` tag near the existing
   `<script src="/app.js"></script>` at the bottom of `<body>`. Don't touch
   anything else in that file.

3. No build step / bundler in this project (plain static JS served from
   `server/public`), so no config changes needed.

## Known caveats to be aware of (no action needed, just don't "fix" them away)

- Wake Lock only stops *screen* sleep — it doesn't prevent a user manually
  locking the PC (Win+L), and OS power settings can still vary.
- Requires a secure context (HTTPS or localhost) — fine for this project's
  dev/deploy setup, just don't break that assumption.
- Not supported in Safari/iOS — this must degrade gracefully, not error out.

## Suggested manual test

- Open the app, confirm no console errors.
- Switch tabs away and back — confirm the wake lock is silently re-acquired
  (log a `console.log`/warn temporarily if useful, then remove before done).
- Leave it running for a bit and confirm the screen doesn't dim/sleep on a
  supported browser (Chrome/Edge).

Thanks for picking this up — this one genuinely matters for the 24h
unattended use case, so take the time to get the re-acquire logic right. 🙏
