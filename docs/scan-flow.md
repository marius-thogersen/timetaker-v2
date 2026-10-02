# Scan decision flow

This documents how an incoming RFID scan is turned into (or excluded from)
a counted lap on the leaderboard. **Both fixes below are now implemented**
in `server/domain/race.js` (as of 2026-10-02).

## Diagram

```mermaid
flowchart TD
    A[Reader sends a scan: code + timestamp] --> B[Always stored in raw scan log<br/>— nothing is ever dropped]
    B --> C{Does the code match<br/>a current participant?}

    C -- no --> D[Reason: unknown_code<br/>shown in history, never counts]
    D --> D2{Later, a participant is<br/>added/edited with this code?}
    D2 -- yes --> C
    D2 -- no --> D3[Stays unknown_code forever]

    C -- yes --> E0{Was this code already<br/>assigned to this participant<br/>at the time of the scan?<br/>scan.time >= participant.rfidAssignedAt}
    E0 -- no --> F0[Reason: code_assigned_after_scan<br/>NEVER counts — matching is not retroactive]
    E0 -- yes --> E{"Is the race currently started/<br/>stopped/ended (i.e. NOT in signup)?<br/>(heat.startAt alone isn't enough —<br/>Reset rounds deliberately keeps it<br/>for next time, see below)"}
    E -- "no (still signup)" --> F[Reason: race_not_started<br/>NEVER counts, no matter the code match]
    E -- yes --> G{scan.time >= heat.startAt ?}
    G -- no --> H[Reason: before_start<br/>e.g. scan happened before Start was pressed]
    G -- yes --> I{Heat has a duration set<br/>AND scan.time >= heatEndAt ?}
    I -- yes --> J[Reason: after_end]
    I -- no --> K{Is scan.time inside<br/>a paused interval?}
    K -- yes --> L[Reason: paused]
    K -- no --> M{"Time since this participant's<br/>last COUNTED lap >= minLapSeconds?<br/>(or this is their first eligible scan)"}
    M -- no --> N[Reason: bounce<br/>collapsed into previous lap, doesn't reset it]
    M -- yes --> O[✅ Counts as a new lap<br/>→ leaderboard rounds +1]

    style F fill:#552222,color:#fff
    style F0 fill:#552222,color:#fff
    style H fill:#552222,color:#fff
    style J fill:#552222,color:#fff
    style L fill:#552222,color:#fff
    style N fill:#554422,color:#fff
    style O fill:#225533,color:#fff
    style D fill:#333,color:#fff
```

## Fixed bug #1: "race not started" was leaking through

`eligibleScansForParticipant` in `server/domain/race.js` used to filter
scans with:

```js
.filter((s) => !cutoff || s.time >= cutoff)
```

where `cutoff` is the participant's heat `startAt`. When the heat had
**never started** (`startAt` is `null`), `!cutoff` was `true`, so the
filter let the scan through instead of blocking it — "no start time yet"
was treated as "no restriction" instead of "nothing is eligible yet."

Repro: scan a code with no race live and no matching participant yet (shows
as `unknown_code` in history) → add a participant with that exact code →
the old scan immediately got counted as a lap, even though the race was
never live when it happened.

**Why checking `heat.startAt` alone still isn't enough:** "Reset rounds"
deliberately *keeps* each heat's `startAt` so the organizer doesn't have to
re-enter it (see the "Reset race should only clear rounds" decision). That
means after a reset, `heat.startAt` can be non-null while the race is back
in `signup` — so a pure `heat.startAt` check would let scans count again
the moment the race is reset, before "Start race" is even pressed a second
time. **The actual fix checks `race.status !== 'signup'` first**, and only
then falls back to the heat's own `startAt`/`durationMinutes` window. This
is implemented as an early return in `eligibleScansForParticipant`, and
mirrored in `getScanHistory`'s reason logic (`race_not_started` is reported
whenever `race.status === 'signup'`, regardless of what `heat.startAt`
happens to still hold).

## Fixed bug #2 (by design): matching is NOT retroactive

Confirmed with the project owner (2026-10-02): a scan may only count for a
participant if that participant's RFID code was **already assigned at the
time the scan was received** (node `E0` above). A scan received before the
code existed in the system stays `unknown_code` forever, even if a
matching participant/code shows up afterwards — and if a code is
*reassigned* from one participant to another, old scans don't suddenly
start counting for the new holder either.

**Implementation:** every participant now has an `rfidAssignedAt` field —
stamped to "now" whenever `addParticipant` creates them with a code, or
whenever `setParticipantRfidCode` assigns a new non-empty code (cleared
back to `null` when the code itself is cleared). `eligibleScansForParticipant`
gates on `!participant.rfidAssignedAt || s.time >= participant.rfidAssignedAt`
— the `!rfidAssignedAt` half is a backward-compatibility fallback for
participants that existed in a database from before this field existed
(an added `rfid_assigned_at` SQLite column that's `NULL` for old rows is
treated as "always assigned," preserving their existing behavior rather
than retroactively locking out an event that's already mid-race).

## Other reasons in `getScanHistory`

| Reason | Meaning |
|---|---|
| `unknown_code` | No participant currently holds this code |
| `code_assigned_after_scan` | Code now matches a participant, but was assigned to them after this scan happened |
| `race_not_started` | The race is still in `signup` (hasn't been started since the last reset/new race) |
| `before_start` | Scan happened before the heat's `startAt` |
| `after_end` | Scan happened at/after the heat's `startAt + durationMinutes` |
| `paused` | Scan happened while the race was stopped/paused/ended |
| `bounce` | Too soon after the same participant's last counted lap (< `minLapSeconds`) |
| *(none — counted)* | Everything checks out; counts toward `rounds` |
