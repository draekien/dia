---
status: "accepted"
date: 2026-07-11
decision-makers: William Pei
---

# Use local file-based persistence for pane layout and session state

## Context and Problem Statement

dia's MVP must restore pane layout and each pane's conversation history on relaunch. Where and in what format should this state be persisted?

## Decision Drivers

* Single-user, single-machine app (cross-device sync is explicitly out of scope for the MVP) — no need for a queryable multi-user store.
* Simplicity first: avoid introducing a database dependency the current scope doesn't justify.
* State is structurally simple: a pane tree (layout) plus, per pane, a linear conversation history.

## Considered Options

* Local JSON file(s) on disk (e.g. under Electron's `app.getPath('userData')`)
* SQLite (e.g. via `better-sqlite3`)

## Decision Outcome

Chosen option: "Local JSON file(s) on disk", because the state being persisted (a pane tree plus per-pane linear message history) has no relational or query needs, and a plain file read/write on launch/save avoids adding a database dependency and its native-module packaging concerns to the single-package app (ADR-0006).

### Consequences

* Good, because there's no database engine to bundle, migrate, or package for each platform.
* Good, because the persisted shape (layout tree + per-pane message arrays) maps directly to JSON with no schema translation layer.
* Bad, because there's no built-in query/indexing if a future feature needs to search across sessions — would need to be added separately.

## Pros and Cons of the Options

### Local JSON file(s)

* Good, because it requires no new runtime dependency beyond Node's own `fs`.
* Good, because it matches the data's actual shape (tree + arrays) with no ORM or query layer needed.
* Bad, because large conversation histories are read/written in full rather than incrementally.

### SQLite

* Good, because it would support efficient partial reads/writes and future querying across sessions.
* Bad, because it adds a native-module dependency (`better-sqlite3` or similar) with per-platform binaries to package, for a data shape that doesn't need relational querying yet.

## More Information

Revisit if conversation history size or a cross-session search feature makes full-file read/write impractical.
