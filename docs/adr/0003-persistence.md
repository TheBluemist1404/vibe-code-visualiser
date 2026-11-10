# ADR 0003: Persist revisions as files, with HEAD as the single commit point

Status: accepted (2026-11-10; commit protocol and identifiers revised in the hardening pass)

## Layout

```
HEAD                      {format, revision, history[], lastCommit}  ← commit point
revisions/<rev>.yaml      one immutable file per committed model revision
changes/<changeId>.json   current state of each proposal
audit.jsonl               append-only attempt log (ADR 0004)
orphaned/                 uncommitted leftovers moved aside by recovery
```

A model revision is not a Git commit. Committing this folder to Git is a separate, optional
step. Layout/presentation state lives in `LayoutStore` and never creates model revisions.

## Commit protocol

Every file is written as temp file → fsync → rename (→ directory fsync where supported).

1. `revisions/<rev>.yaml`
2. `HEAD`, now listing `<rev>` and carrying the applied ChangeRecord — **the commit point**
3. `changes/<changeId>.json`

**A revision exists if and only if HEAD lists it.** `revision()` and `current()` never read a
revision file HEAD does not list, so an interrupted commit cannot be mistaken for a
successful one. Step 3 is derivable from HEAD, so losing it loses nothing.

## Recovery

Runs every time a `FileStore` is opened (and via `recover()`); idempotent:

- delete `*.tmp-*` files (never committed content);
- move revision files HEAD does not list into `orphaned/` (kept for inspection);
- move "applied" change records whose revision HEAD does not list into `orphaned/`;
- rewrite the last commit's change record from HEAD if it is missing or out of date;
- fail with `StoreError("CORRUPT")` if HEAD is unreadable or lists a missing revision file.

After a crash before step 2 the proposal is unchanged (absent, or still pending) and can be
retried. After a crash after step 2 the change is applied and a retry reports
`DUPLICATE_CHANGE`. Tests inject a crash before each write and rename of each step.

## Identifiers

Change IDs and model revision IDs become file names. They must match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, not end in `.`, and not be a Windows device name
(`CON`, `NUL`, `COM1`…). The same rule is enforced by the change schema, the model schema
(`project.modelRevision`), the engine's `approve()`, and the store itself, so bad input gives
a structured `SCHEMA`/`INVALID_ID` result rather than an exception or a path outside the
store. Canonical object IDs are not file names and stay opaque, as the spec requires.

## Limitations

- **Single writer.** Two processes committing to the same directory can race (both read
  HEAD at rev-N and the second rename wins). There is no lock file yet. Concurrent writers
  need a lock or a different backend (event log or transactional store; spec open question 9).
- Durability depends on the filesystem honouring fsync and atomic rename. Network mounts
  may not.
- The audit log is appended after the commit; a crash between the two can drop one audit
  line, never a committed revision.
