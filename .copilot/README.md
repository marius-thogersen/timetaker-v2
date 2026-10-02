# Coordination board (for multiple agents working on this repo)

This folder is a lightweight kanban-style board + feature log so two (or
more) agents can work on the project at the same time without stepping on
each other.

## Board workflow (`board/`)

Each task is **one markdown file** that moves between folders as its status
changes. The filename stays the same the whole time (just `git mv`/move it),
so history/links don't break.

```
board/
  todo/           new task, not started
  in-progress/    an agent is actively working on it
  implemented/    code written, not yet verified
  tested/         verified working — ready to be folded into features/
```

Rules of thumb:
- **Before picking up a task**: move its file from `todo/` → `in-progress/`.
  Add a line at the top noting which agent/session picked it up and when,
  so the other agent doesn't duplicate work.
- **Before touching shared files** (e.g. `app.js`, `index.html`): run
  `git status` and check the `in-progress/` folder for overlapping work.
  Prefer small, additive, isolated changes over large refactors when another
  task is in flight.
- **When code is written**: move the file to `implemented/` and briefly note
  what was done / how to test it.
- **When manually verified**: move it to `tested/`.
- **Once a tested feature is stable**: summarize it as a new file in
  `features/` (see below) and delete the board file (or leave it in
  `tested/` as history — either is fine).

## Feature log (`features/`)

One markdown file per implemented, working feature — a short-term
"documentation of what exists" so any agent can quickly understand prior
decisions without reading the whole diff history. Keep entries brief:
what it does, which files it touches, and any gotchas/caveats.

## Current status

See `board/todo/`, `board/in-progress/`, etc. for active work.
