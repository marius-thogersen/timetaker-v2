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
- **`server/domain/store.js`** — loads/saves that state object as
  `data/race.json`. Atomic write (write to `.tmp`, then rename).
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
{"time": "2024-01-01T10:00:00.000", "code": "0123456789"}
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

## Domain rules (current)

- One race at a time; state machine is `signup -> started` (one-way, reset
  via `resetRace` returns to a fresh `signup`).
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

## Running locally

```powershell
node --test test/race.test.js   # domain unit tests (no deps, uses node:test)
node server\server.js           # run the server; Ctrl+C to stop
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

## Data files

- `data/race.json` — the entire race. Safe to delete between events; the
  server recreates it on next write.
- `rfid-reader/pending_scans.json` — scans the reader captured but couldn't
  yet deliver (server offline); it retries on reconnect and self-clears.
- `rfid-reader/app.log` — reader's own log when running as a frozen `.exe`.

## Distribution

- **`bootstrap.ps1`** — the single command end users run
  (`irm .../bootstrap.ps1 | iex`). Downloads the `main` branch zip from
  GitHub, installs it, runs `install.ps1`, and creates two Desktop
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

1. `node --test test/race.test.js` passes.
2. Manually: start `server.js`, drive `/api/participants`, `/api/race/start`,
   `/api/race/reset` with `Invoke-RestMethod`, and a raw TCP line to
   `45677`, and confirm `/api/leaderboard` looks right.
3. Load `http://127.0.0.1:4577` in a browser and click through signup →
   start → leaderboard → reset.
4. If you touched `bootstrap.ps1` or `install.ps1`, run them on a throwaway
   folder/account to confirm they still complete without manual fixes.

## Not implemented yet (known gaps)

- CSV import of participants.
- Editing a participant's details after signup (only add/remove exist).
- Per-lap timestamps shown in the UI (only "last lap" time is shown).
- Packaging as a single `.exe` (currently requires Node.js + Python
  installed via `install.ps1`).
