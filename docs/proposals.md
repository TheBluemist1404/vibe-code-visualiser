# Model proposals and the pre-approval review (M3.1)

How a coding agent hands VCV a typed model change, and how a reviewer sees exactly what it
would change before deciding. This is the first step of the model-first path in
[Issue #17](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/17):

1. the agent reads the model and the source evidence and **authors a typed proposal** (a YAML or
   JSON file of its own, outside `.vcv/`);
2. **VCV validates** it and records it as pending: `vcv proposal submit`;
3. **a separate reviewer** previews it (`vcv proposal preview`) and decides (approval and its
   trust boundary are M3.2);
4. only an approved change becomes the next canonical `.vcv/` revision; implementation comes
   after that (M3.3).

Design notes: [ADR 0008](adr/0008-model-first-changes.md).

## Submitting: proposal-only

```sh
vcv proposal submit <checkout> <change.yaml> [--json]
```

The change file is the existing typed change shape (`ModelEngine.propose`, see
[ir-v0.2-conformance.md](ir-v0.2-conformance.md)):

```yaml
changeId: chg-cancel-enrollment      # yours to choose; used once, never reused
projectId: prj-course-desk
expectedRevision: rev-1              # the revision you read; stale proposals are refused
rationale: A student can cancel a confirmed enrollment and is notified.
operations:
  - type: createCapability
    capability: { id: cap-cancel-enrollment, kind: capability, owner: mod-enrollment, name: Cancel an enrollment, initiatorActorId: act-student }
  - type: setRuleStatement
    ruleId: rul-announce-every-decision
    statement: Each enrollment decision or cancellation results in exactly one notification to the student.
```

Operations: `createModule`, `createEvent`, `createCapability` (new in M3.1), `createRule`,
`addDataAttribute`, `addState`, `addTransition`, `renameObject`, `renameState`, `linkContract`,
`setModuleDependencies`, `removeObject`, `setRuleStatement`, `setDescription`, `approveDraft`.
There is no generic patch. The payload cannot name a proposer, approver or status.

`submit` is **proposal-only**. It narrows whatever permissions the host holds to
`model:propose` before calling the engine, so the result is always one of

| Status | Recorded? | Meaning |
|---|---|---|
| `pending` | yes | Validated against the current revision; waiting for a separate reviewer. `.vcv/HEAD` did not move. |
| `rejected` | yes, for a well-formed proposal that fails validation (the record keeps the diagnostics); no, for a schema error, a replayed change ID or an oversized proposal | Fix it and submit under a **new** change ID. |
| `denied` | no | The host may not propose. |

It never applies or approves, even for a host holding `model:apply` and `model:approve`, and the
result reports `.vcv/HEAD` before and after the call (always equal). `vcv propose <store>` keeps
its old behavior for hosts that apply directly; give agents `vcv proposal submit`.

Limits on this surface: at most 100 operations and 256 KB (canonical JSON) per proposal.

Each diagnostic has `code`, `severity`, `path`, `message` and, for the common codes, a `hint`
saying what to do (`STALE_REVISION`: re-read and resubmit against the current revision;
`DUPLICATE_CHANGE`: change IDs are immutable, pick a new one; `TARGET_MISSING`, `UNKNOWN_REF`,
`ID_IN_USE`, `REFERENCED`, `DEPENDENCY_CYCLE`, `SCHEMA`, `TOO_LARGE`, ...).

### Proposal identity

A proposal is identified by its change ID (used once; a replay never overwrites the original
record) and by its **proposal digest**: sha256 over the canonical JSON of the change exactly as
submitted. The digest is derived, never stored, and the same for a dry run and for the recorded
proposal, so a reviewer can bind a decision to the content they saw (M3.2).

## Reviewing: preview

```sh
vcv proposal preview <checkout> <changeId> [--json] [--limit n]
vcv proposal preview <checkout> --file <change.yaml> [--json]      # dry run, nothing recorded
```

MCP (`vcv-mcp --repo <checkout>`): `vcv_preview_proposal` with `{ changeId }` or `{ change }`.

Read-only: nothing is written, not even store recovery. The result has

| Section | Content |
|---|---|
| `proposal` | change ID, digest, origin (`record` or `unsubmitted`), lifecycle, proposer, base revision, rationale, one line per operation |
| `validation` | the engine's own `checkChange` against this checkout's revision **now** (`appliesToCurrent`, errors and warnings with hints), and the diagnostics stored at submission |
| `delta` | the object-level before/after change: added, removed and modified objects with the changed fields (values capped at 300 characters). Against the current revision when the change applies; against its base revision when it is stale; `null` when it applies to neither |
| `impact` | modules owning a changed object (`changed`) or a structural impact candidate (`impacted`), `crossModule`, contracts, and `@vcv/query` impact candidates with one dependency path each |
| `bindings` | binding claims on changed, removed or impacted objects: code that probably has to change too. Listed, not verified; use `vcv evidence` for their state |
| `states` | `change` (lifecycle), `approval`, `snapshotStatus` and `implementation`, kept apart |
| `assumptions` | what nobody has checked: structural impact is not semantic proof, the code was not compared, the proposer identity is a host assertion, and case-specific ones (no rationale, stale, cross-module, truncated, no claims) |

Every list is capped by `limit` (default 50, max 200) with `total` and `truncated`.

## Lifecycle and the states that must not be confused

```sh
vcv proposal list <checkout> [--states pending,stale,rejected,applied,invalid] [--json]
```

MCP: `vcv_list_proposals`. The lifecycle is derived from the record and this checkout's model
every time; it is never stored:

| Lifecycle | Meaning |
|---|---|
| `pending` | validated, awaiting a separate reviewer; base revision is the current one |
| `stale` | still pending, but the checkout's model is no longer its base: `superseded` (the base is an earlier revision of this line) or `other-line` (the base is not in this checkout's history, e.g. a record from another branch). An approval would fail with `STALE_REVISION`; submit a new proposal |
| `rejected` | failed validation at submission or when an approval rechecked it |
| `applied` | committed as a model revision; `resultInThisCheckout` says whether this checkout's history contains it |
| `invalid` | the record file does not hold a typed change |

Four things are reported separately and none implies another:

- **change approval** (`states.approval`, `recordedApproverId`): what the change record says.
  A record in a Git repository is not proof that a particular person approved it; M3.2 defines
  the trust boundary and the integrity check.
- **snapshot status** (`snapshotStatus`, draft or approved): the model's own `approveDraft`
  flag. Approving a change does not approve a draft snapshot, and vice versa.
- **binding resolution** (`vcv evidence`): whether a pointer into the code resolves. Not model
  approval, not correctness.
- **implementation**: always `not-recorded`. VCV does not infer that approved intent was
  implemented; M3.3 adds an explicit implementation report.

## What this does not do

No MCP write tools (submission is the host's CLI), no approval surface beyond the existing
`vcv approve` (M3.2 replaces it with a trusted reviewer step), no implementation handoff
(M3.3), no reconciliation of code and model (M4). VCV never writes a proposal itself: the agent
authors it, VCV validates and records it.
