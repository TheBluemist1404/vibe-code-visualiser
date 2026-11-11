# Implementation handoff and the implementation report (M3.3)

The third step of the model-first path in
[Issue #17](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/17). Once a change is
approved ([approvals.md](approvals.md)), the person invokes their coding agent, with its normal
tools, to implement it in the feature checkout. VCV gives that agent a bounded brief, the
**handoff**. Afterwards it records the agent's account next to what VCV can observe, in the
**implementation report**. VCV never starts the agent, never runs the tests, and never turns code
into model operations.

Design notes: [ADR 0008](adr/0008-model-first-changes.md#m33-decisions).

## The implementation request, approved with the change

What should be implemented is part of the proposal, so the reviewer approves it together with the
operations and the proposal digest covers it:

```yaml
changeId: chg-capacity
projectId: prj-course-desk
expectedRevision: rev-1
rationale: students asked why they were rejected
operations:
  - { type: setRuleStatement, ruleId: rul-seat-limit, statement: "…" }
implementation:
  behavior: When a course is full, the rejection tells the student the course's capacity.
  acceptanceCriteria:
    - A COURSE_FULL rejection includes the course capacity
    - Enrolling into a course with free seats is unchanged
  suggestedTests:
    - "EnrollmentService: rejects an enrollment into a full course and reports the capacity"
  scope: ["server/src/enrollment/**"]
```

`scope` holds repository-relative paths or globs (`*`, `**`, `?`; a plain path also covers
everything below it). Absolute paths, `..` and backslashes are refused. The request is strict and
bounded: behavior up to 4000 characters, at most 30 criteria, 30 tests and 50 scope entries. The
engine never reads it. `vcv proposal preview` shows it, and warns when it is missing or declares no
scope.

## The handoff: `vcv handoff <path> <changeId>`

The handoff is printed as JSON. It is read-only and needs an **applied change with an
attestation whose signature verifies against its record**. Otherwise you get `NOT_APPLIED`,
`NOT_ATTESTED` or `NOT_IN_HISTORY` (check out the branch the change was approved on). Key trust
is not decided here; that is the host gate's job.

It contains:

| Field | What it is |
| ----- | ---------- |
| `change` | Change ID, proposal digest, base and approved revision, proposer, approver, rationale and operation summaries (display text, cut with `rationaleTruncated` / `operationsTruncated`; the proposal digest covers the full text) |
| `approval` | `valid-signature`, the key fingerprint, and `trustVerification: caller-asserted` |
| `modelNow` | The current revision; whether it is still the approved one; any later revisions (not covered) |
| `delta`, `impact` | The object-level before/after of the approved revisions, plus structural impact (modules, contracts, cross-module) |
| `request` | The approved implementation request, or null (a caveat then says there are no approved criteria) |
| `scope` | `declared` (the approved scope), and `fromBindings`: files that binding claims on changed or impacted objects point at |
| `tests` | Requested tests, plus `tests` claims on the affected objects |
| `bindings` | Each affected claim verified now (`resolved` / `stale` / `missing` …, with source and model freshness). `reassertAfterImplementing` marks claims on changed objects |
| `git` | Base commit, branch and dirty flag of the checkout the agent starts from, and `worktree`: a digest of the bytes seen (bound source files and files changed since HEAD) |
| `steps`, `caveats` | Fixed instructions and what the handoff does not establish |
| `digest` | sha256 over the canonical JSON of everything above |

Properties:

- **Deterministic.** There are no timestamps and the ordering is stable, so the same checkout
  state gives the same bytes and the same digest.
- **Bounded.** Strings and lists are capped, each cut marked. The printed handoff (2-space JSON,
  digest included) never exceeds 128 KiB: derived lists are halved until it fits, and if it still
  does not, the call fails with `HANDOFF_TOO_LARGE` instead.
- **Redacted.** Only repository-relative paths appear. The checkout's absolute path and the home
  directory are scrubbed from every string, including free text.
- **One observation.** Like every read surface, it reads the checkout once and rechecks before
  answering (`STATE_CHANGED`). The recheck covers the model store, the Git commit, the change
  records, the binding claims, the change's attestation, and the working tree: the set of changed
  files and the bytes of every changed or bound file. An edit during binding verification is
  never mixed into the result.

## Implementing (the agent's job)

The handoff's `steps` say it. The agent:

- works in this checkout and inspects the code itself;
- stays in the declared scope;
- never edits `.vcv/HEAD`, `revisions/`, `changes/` or `approvals/`;
- if the approved model turns out to be wrong, stops and starts a **new** proposal and review;
- re-inspects and **reasserts** every claim marked `reassertAfterImplementing`
  (`vcv binding reassert … --expect <digest>`, or `vcv binding add` for new code). Reassertion is
  its claim, not an approval;
- runs the tests and writes down what really happened.

## The report: `vcv implementation record <path> --report <file> [--expect <digest>]`

The agent writes a JSON file of its own:

```json
{
  "changeId": "chg-capacity",
  "baseCommit": "<git.baseCommit from the handoff>",
  "handoffDigest": "<digest from the handoff>",
  "testsRun": [{ "command": "npm test -w server", "outcome": "passed", "summary": "12 passed" }],
  "acceptance": [{ "criterion": "A COURSE_FULL rejection includes the course capacity", "status": "met", "evidence": "enrollment.service.ts" }],
  "gaps": ["the web UI does not show the capacity yet"],
  "outOfScope": [{ "path": "README.md", "reason": "documented the new message" }],
  "confidence": "medium"
}
```

VCV records `.vcv/implementations/<changeId>.json` (commit it with the code). The report keeps
four sections apart, and none implies another:

- **`approvedIntent`**: the approved request and operations, from the change record.
- **`agentClaims`**: tests, outcomes, criteria, gaps, explanations and confidence, with
  `claimedBy` (the host-asserted principal) and `verifiedByVcv: false`. VCV ran nothing and
  verified none of it.
- **`vcvObserved`**: what VCV sees:
  - source files changed since the base commit (committed, staged, unstaged and untracked);
  - those outside the approved scope;
  - `.vcv/` changes by area;
  - `worktree`: a digest of the bytes of every changed and bound file (content hashes, or size and
    mtime past the budget, then `complete: false`), so the report names one concrete dirty source
    state, not only file names;
  - each affected binding claim verified now, with `reasserted` (claimed at the approved revision
    or later).
- **`notReconciled`**: always `not-reconciled`. Whether the code implements the model is M4's
  reconciliation.

It **warns rather than passes silently**:

| Warning | When |
| ------- | ---- |
| `OUT_OF_SCOPE` | A file changed outside the approved scope; listed even when the agent explains it |
| `SCOPE_NOT_DECLARED` | The approved request declared no scope |
| `NO_IMPLEMENTATION_REQUEST` | The approved change carried no request |
| `NO_SOURCE_CHANGES` | No source file changed since the base commit |
| `BINDING_NOT_RESOLVED` | An affected claim is not `resolved` now |
| `BINDING_NOT_REASSERTED` | A claim on a changed object was last made before the approved revision |
| `NO_BINDINGS` | No claim points at the affected objects |
| `TEST_FAILED` | A reported test failed or errored |
| `NO_TESTS_RUN` | The agent reports no test run |
| `CRITERION_NOT_MET` / `CRITERION_UNKNOWN` | The agent reports a criterion as not met or unknown |
| `CRITERION_UNADDRESSED` | An approved criterion is not addressed in the report |
| `GAP` | The agent's own gaps |
| `MODEL_MOVED` | The model is past the approved revision |
| `STORE_FILES_CHANGED` | Unexpected `.vcv/` files changed |
| `CLAIMS_UNVERIFIED` | Always present |

Recording changes no model state. The base commit must be in the repository and an ancestor of
HEAD (`UNKNOWN_COMMIT`). A second report is refused (`REPORT_EXISTS`). To replace a report, pass
the current file's digest with `--expect` (`REPORT_CHANGED` if it moved, including when another
report is written while the replacement is prepared: the file is re-read right before the
rename). A symlinked or non-directory `.vcv/implementations/` is refused (`UNSAFE_PATH`). Reports
are bounded to 256 KB and redacted like the handoff. Recording rechecks the same state as the
handoff (store, commit, records, claims, attestation, changed files and their bytes) before it
writes (`STATE_CHANGED`).

`vcv implementation show <path> <changeId>` reads a report and recomputes VCV's observations now.
The stored report is validated against the full report schema first; a malformed or foreign file
is `INVALID_RECORD`, with the failing fields. `changedSinceReport` says whether the files, their
bytes, the scope or the binding states moved on since the report was recorded (an edit of an
already-dirty file counts), and `warningsNow` lists the warnings as they stand now.

## What this does not do

- No universal implementation verifier.
- No agent orchestration or hidden trigger of code generation.
- No test execution by VCV.
- No automatic model operations from code.
- No MCP tools for these (the agent uses the CLI it already has).
- No reconciliation (M4).

The report is evidence for a human reviewer of the PR, not a gate.
