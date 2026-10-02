# DEVELOPER.md

Technical notes for working on TimeTaker v2. `README.md` is for end users —
keep it free of this kind of detail.

## Architecture

Two independent pieces, talking over a loopback TCP socket:

```
rfid-reader/rfid_reader.py  --(TCP 127.0.0.1:45677, line-delimited JSON)-->  server/server.js
                                                                                 |
                                                                                 v
                                                                    data/race.json (state)
                                                                                 |
                                                                                 v
                                                              server/public/*  (HTTP 127.0.0.1:4577)
```

- **`server/domain/race.js`** — all business logic (participants, scans,
  leaderboard, race status). Pure functions operating on a plain state
  object. No I/O. This is the file to change when the *rules* of the race
  change.
- **`server/domain/sqlite-store.js`** — loads/saves that state object using
  Node's built-in `node:sqlite` module, as `data/race.db`. Normalized tables
  (`participants`, `scans`, `paused_intervals`, `race_meta`) so the file is
  easy to open and query directly with any SQLite browser, but the app itself
  still reads the whole race into memory and rewrites it wholesale on every
  change (same simple pattern the old JSON-file store used — just backed by
  SQLite now). Requires Node.js 22.5+ (ships with `node:sqlite` built in).
- **`server/server.js`** — wires it together: a `net.Server` for RFID scans
  and an `http.Server` for the API + static frontend. No frameworks, no
  external npm packages — deliberately, so `npm install` is never a step a
  user has to run or debug.
- **`server/public/`** — vanilla HTML/CSS/JS frontend. Polls `/api/state`
  and `/api/leaderboard` every second; no build step, no bundler.
- **`rfid-reader/`** — copied unmodified from the original `timetaker`
  project (the Tauri/Rust based app). It listens for global keystrokes (the
  USB RFID reader acts like a keyboard typing digits + Enter) and forwards
  each scan to whatever is listening on port 45677. **Do not edit this
  folder's protocol expectations** without also updating `server/server.js`
  — they must stay wire-compatible.

## Scan protocol (must stay compatible with `rfid_reader.py`)

Client (reader) → server, one JSON object per line:
```json
{"time": "2026-10-02T11:42:05.955+02:00", "code": "0123456789"}
```

Server → client, one JSON object per line, always sent as a reply to each
scan:
```json
{"status":"ok","id":3}
{"status":"error","message":"invalid payload: ..."}
```

The server currently accepts (and stores) *any* non-empty code, even before
the race has started or for a code with no matching participant — this
prevents scans from ever being silently lost. Matching a code to a
participant, and deciding whether it counts as a new lap, happens later in
`getLeaderboard()`.

### Timezone handling (important)

Every timestamp this app compares (heat start times, paused intervals, scan
times) is stored as a real UTC `...Z` ISO string (`new Date().toISOString()`),
and eligibility checks compare these as plain strings — so any timestamp fed
into the system **must** carry an explicit UTC offset, or it will silently
compare wrong against everything else (this caused a real bug: a scan during
a pause wasn't recognized as paused because the reader's timestamp had no
timezone and was being compared, as a string, against a UTC one).

- **`rfid_reader.py`** sends `datetime.now(LOCAL_TZ).isoformat(...)` where
  `LOCAL_TZ = ZoneInfo("Europe/Copenhagen")` — this always includes a UTC
  offset (`+02:00` summer / `+01:00` winter, DST handled automatically by
  `zoneinfo`). **If a reader PC is ever used outside Denmark, change
  `LOCAL_TZ` at the top of `rfid_reader.py` to the correct IANA zone name**
  (e.g. `"Europe/London"`), or scans will be timestamped with the wrong
  offset even though they'll still be internally consistent.
- `zoneinfo` needs the `tzdata` package on Windows (Windows doesn't ship the
  IANA timezone database the way Linux/macOS do) — it's listed in
  `rfid-reader/requirements.txt` and installed by `install.ps1`.
- **`server/domain/race.js`**'s `recordScan()` and `editScan()` both
  defensively re-normalize *any* incoming timestamp via
  `new Date(x).toISOString()` before storing it, converting it to UTC
  regardless of what offset (or lack thereof) it arrived with. This means a
  timezone-less timestamp is interpreted as the **server PC's own local
  time** (JS `Date` parsing behavior) — correct only if the reader and
  server happen to share a clock/timezone, which is why the reader should
  always send an explicit offset rather than relying on this fallback.

## Domain rules (current)

- One race at a time; state machine is
  `signup -> started <-> stopped -> ended`, with `ended` resumable back to
  `started` (unusual, but not hard-locked — see "Ending a race" below).
  `resetRace`/`newRaceFromTemplate` both return to a fresh `signup`.
- A participant is `{ id, name, gender, rfidCode }`. `rfidCode` must be
  unique. `gender` must be one of `GENDERS` (`female`, `male`, `other`).
- Adding/removing participants is only allowed in `signup` status.
- Scans before `race.startedAt` don't count toward the leaderboard, but are
  still stored.
- Two scans of the same code closer together than `minLapSeconds` (default
  5s) count as one lap — filters out reader bounce. This is a parameter to
  `getLeaderboard()`, not baked into scan recording, so it can be tuned
  without losing data.
- Leaderboard sort: rounds desc, then earliest `lastLapAt` (whoever reached
  that lap count first ranks higher), then name.

### Ending a race, exporting, and starting a new one from a template

- `endRace(race)` (allowed from `started` or `stopped`) sets status to
  `ended` and reuses the same `pausedIntervals` mechanism `stopRace` uses
  (pushes an open interval if the race was still running) — so scans
  received after ending never count, exactly like scans during a pause.
  Nothing is deleted; the race is just frozen.
- `resumeRace(race)` now also accepts `ended` (not just `stopped`), so
  clicking "End race" by mistake is recoverable.
- `GET /api/export/leaderboard.json` / `.csv` export the *live* race's
  current leaderboard (most useful once it's ended, but works any time).
- `POST /api/race/new-from-template` is only allowed when status is `ended`.
  It (1) deep-clones the current race state, (2) archives that clone into
  the `race_archive` SQLite table via `store.addArchive()` — label is an
  auto-generated local date/time string, e.g. "2026-10-02 14:30" — then
  (3) calls `newRaceFromTemplate(state)`, which is just `resetRace` gated on
  `status === 'ended'`. Heats (including start times/durations) and
  participants (names/genders/RFID codes/start numbers/heat assignments)
  all carry over untouched; only scans/paused-intervals/status are cleared.
- Archived races are listed via `GET /api/archive` (id/label/archivedAt/
  participantCount only — cheap, no JSON parsing) and viewed/exported via
  `GET /api/archive/:id/leaderboard`, `/export.json`, `/export.csv` — each
  parses that one archive's full JSON blob out of the `data` column.
- CSV shaping lives in `server/domain/csv.js` (`leaderboardToCsv`) — ranks
  reset per heat, matching the order `getLeaderboard()` already returns.

## Running locally

```powershell
node --test test/race.test.js test/csv.test.js   # domain unit tests (no deps, uses node:test)
node server\server.js                            # run the server; Ctrl+C to stop
```

There is no `npm install` step for the server — it has zero dependencies by
design. If you're tempted to add one, prefer extending
`server/domain/race.js` or `server/server.js` with a few more lines of core
Node.js first.

The RFID reader needs Python + the `keyboard` package (see
`rfid-reader/requirements.txt`). `py -m pip install -r rfid-reader\requirements.txt`.

To exercise the scan socket without real hardware, open a TCP connection to
`127.0.0.1:45677` and write a JSON line, e.g. from PowerShell:

```powershell
$client = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 45677)
$writer = New-Object System.IO.StreamWriter($client.GetStream())
$writer.AutoFlush = $true
$writer.WriteLine('{"time":"2024-01-01T10:00:00.000","code":"0000000001"}')
```

For a whole race's worth of realistic, concurrent scans (useful for demos
and load-testing the leaderboard), use the standalone simulator instead —
see "Race simulator" below.

## Race simulator

`tools/simulate-race.js` is a standalone script that plays the part of a
room full of RFID readers: it talks to an already-running server purely
through its existing HTTP API (`/api/participants`, `/api/race/start`) and
the same TCP scan socket `rfid_reader.py` uses, generating randomized laps
for every participant in parallel until the simulated duration elapses.

It requires **zero changes anywhere else in the codebase** — no imports
from `server/domain`, no special-cased routes, nothing. To remove the
feature entirely, delete `tools/simulate-race.js` (and the `tools/` folder
if nothing else is in it).

```powershell
node server\server.js                 # in one terminal
node tools\simulate-race.js --help     # in another, see all flags
node tools\simulate-race.js --duration 2 --speed 20
```

If the race has no participants yet, it creates some fake ones first;
otherwise it reuses whoever is already signed up. Pass `--no-start` to
layer simulated scans onto an already-live race instead of starting a new
one. **Always point it at a throwaway `data/race.db`** (or back yours up
first) — it creates real participants/scans through the real API.

## Data files

- `data/race.db` — a real SQLite database (via Node's built-in
  `node:sqlite`), holding the live race (`race_meta`/`heats`/`participants`/
  `scans`/`paused_intervals` tables) plus any archived ended races
  (`race_archive`, one row per archived race, storing a full JSON snapshot).
  Safe to delete between events; the server recreates it with a fresh race
  on next start (this also wipes race history — back the file up first if
  you want to keep it).
- `rfid-reader/pending_scans.json` — scans the reader captured but couldn't
  yet deliver (server offline); it retries on reconnect and self-clears.
- `rfid-reader/app.log` — reader's own log when running as a frozen `.exe`.

## Distribution

- **`bootstrap.ps1`** — the single command end users run
  (`irm .../bootstrap.ps1 | iex`). Downloads the `master` branch zip from
  GitHub (this repo's default branch — if you ever rename it, update the
  branch name in `bootstrap.ps1`'s URLs and `$repoZipUrl`, and in
  `README.md`'s install command, all at once), installs it, runs
  `install.ps1`, and creates two Desktop
  shortcuts. **The GitHub owner/repo is hardcoded near the top of this file
  and in `README.md`'s install command** — update both if the repo moves.
  Install location resolves in this order: the `-InstallPath` parameter,
  then the `TIMETAKER_INSTALL_PATH` environment variable (the only way to
  override it non-interactively through the piped one-liner), then an
  interactive `Read-Host` prompt defaulting to `Desktop\TimeTaker`. Installs
  under `Program Files`/`Program Files (x86)`/the Windows folder are
  rejected, same reasoning as the original TimeTaker's `ship/install.ps1`:
  the app stores `data/race.json` next to itself and needs a writable
  location. Re-running against an existing install path updates everything
  except `data/`.
- **`install.ps1`** — idempotent local setup: installs Node.js and Python
  via `winget` if missing, then installs the reader's pip dependencies.
  Safe to re-run.
- **`Start.cmd`** / **`Start-RFID-Reader.cmd`** — what the Desktop shortcuts
  point to.

When changing either script, keep `README.md`'s instructions (the install
command and the shortcut names) in sync — that document assumes zero
technical background.

## Testing checklist before shipping a change

1. `node --test test/race.test.js test/csv.test.js` passes.
2. Manually: start `server.js`, drive `/api/participants`, `/api/race/start`,
   `/api/race/reset` with `Invoke-RestMethod`, and a raw TCP line to
   `45677`, and confirm `/api/leaderboard` looks right.
3. Load `http://127.0.0.1:4577` in a browser and click through signup →
   start → leaderboard → reset.
4. If you touched the end-race/export/race-history/new-race flow: end a
   race, export JSON/CSV, open Race History, click "New race from this
   template…", and confirm heats/participants survived while scans reset.
5. If you touched `bootstrap.ps1` or `install.ps1`, run them on a throwaway
   folder/account to confirm they still complete without manual fixes.

## Not implemented yet (known gaps)

- CSV import of participants.
- Editing a participant's details after signup (only add/remove exist).
- Per-lap timestamps shown in the UI (only "last lap" time is shown).
- Packaging as a single `.exe` (currently requires Node.js + Python
  installed via `install.ps1`).
