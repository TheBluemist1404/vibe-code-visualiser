# ADR 0004: Durable ChangeRecords for real proposals, an append-only log for every attempt

Status: accepted (2026-11-10)

Two external records, both outside the canonical IR:

**ChangeRecord** (`changes/<id>.json`): the current state of one proposal. Created only when
the proposer holds `model:propose`, the change is well formed, and its change ID is unused.
Its status is then `applied`, `pending` or `rejected` (invalid, stale, wrong project). An
approval later moves `pending` to `applied`, or to `rejected` if revalidation fails.

**AuditEvent** (`audit.jsonl`): one line per `propose` or `approve` call, whatever the
result: time, action, host principal, change ID if any, status and error codes.

Attempts that are logged but never create or modify a ChangeRecord:

- proposals from a principal without `model:propose` (`denied`);
- malformed proposals, including smuggled fields and unsafe IDs (`rejected`, `SCHEMA`);
- replays of a used change ID (`rejected`, `DUPLICATE_CHANGE`);
- approval attempts without `model:approve` or by the proposer (`denied`), and approvals
  of unknown or non-pending changes (`rejected`).

Why: an unauthorized or careless caller must not be able to claim a change ID or disturb a
pending proposal, and the person reviewing still sees every attempt. The principal on every
record and event comes from the host context, never from the payload.

API: `propose()` and `approve()` return an `Outcome` `{status, changeId, diagnostics,
record?}`, where `record` is the persisted state. For a denied approval the outcome is
`denied` while `record.status` remains `pending`.

Proportionality: a local single-user prototype needs no tamper-evidence, retention or
rotation. The log is plain JSON lines; a torn final line from a crash is skipped on read.
