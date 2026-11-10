# ADR 0002: One typed command API for every write surface

Status: accepted for the first spike (2026-11-10)

All writes go through `ModelEngine.propose(change, hostContext)` and
`ModelEngine.approve(changeId, hostContext)`. A change is a strict, typed
`ProposedModelChange` (unknown fields are rejected). Operations are a discriminated union;
there is no generic JSON patch.

Identity and permissions (`model:propose`, `model:apply`, `model:approve`) come only from
the host context. Without `apply`, a valid change is stored as `pending`. Approvals are
revalidated against the current revision. A proposer cannot approve their own change by
default. `approveDraft` needs `approve` even for principals who can `apply`.

Outcomes: `applied`, `pending`, `rejected` (invalid, stale, replayed) and `denied`
(authorization). A multi-operation change is applied in full or not at all.
