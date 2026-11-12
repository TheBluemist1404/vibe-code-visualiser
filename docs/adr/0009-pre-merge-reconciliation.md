# ADR 0009: Pre-merge code ↔ model reconciliation (M4)

Status: **proposed for review** (2026-11-12). Design record for M4
([Issue #22](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/22)). Each slice adds
its own section. User-facing description: [docs/reconciliation.md](../reconciliation.md).

## Context

M3 gave the model-first path: a typed proposal, a separately authorized human approval with a
signed attestation, a handoff and an implementation report. M4 assesses *every* PR to `main`,
including ordinary code-first edits, before the merge, against the protected base. Agents
interpret code; VCV validates the model, lineage, claim identity and freshness, test evidence
against approved criteria, and a configured policy. There is no second model database, no
post-merge rewrite and no inference.

## M4.1 decisions

- **Read-only API first, CLI on top, no MCP tool yet.** `reconcile(path, { base, trust?,
  requireAttestation? })` in `@vcv/repo` and `vcv reconcile`. An agent with a shell already reads
  the JSON; an MCP read tool can follow if the M4.4 report needs one. The command reports and
  exits 0; blocking is policy (M4.4), so one function does not both describe and decide.
- **Two base points.** Model lineage and integrity are checked against the base commit itself
  (`checkIntegrity` with `--base`), because the merged history must extend it. Source changes,
  claim comparisons and the model delta are measured from the merge base, because that is what
  the PR changes (GitHub's diff uses the same point). When they differ, `BASE_NOT_CONTAINED`.
- **The base is caller-named.** A full commit ID given as `--base` is reported `pinned: true`; a
  ref name is resolved once, reported `pinned: false`, and re-resolved by the coherency guard. The
  report never claims the base is protected (M3.2's lesson: local refs are spoofable).
- **Five findings never merge.** Changed file (`observed`), stale claim (`checked`: fingerprints
  moved), missing binding (`observed`: nothing locates the code), structural contradiction
  (`checked`: integrity errors, `CLAIM_ON_MISSING_OBJECT`), semantic concern (none from VCV). Every
  finding carries `category`, `basis` and `checked` (what was compared), so M4.4's policy can
  block only on `checked` failures and warn on the rest.
- **Structural contradictions are limited to what VCV can check.** In M4.1: the model history
  (derivation, approval, base prefix) and claims on objects the approved model lacks. Code
  behaviour is never a structural fact.
- **Relevance, not volume.** Claims are listed when they relate to the change (bound file changed,
  claim added/reasserted/removed, object in the delta or impact) or are not `resolved`; the rest
  are counted as `unaffected`. Findings about untouched things carry `related: false`, so policy
  can warn instead of block on stale claims the PR did not cause.
- **Claim history from Git only.** The merge base's claim files are read with `git cat-file`
  (bounded by `MAX_CLAIM_BYTES`); no claim history is stored. A claim present at the merge base
  and absent now is `CLAIM_REMOVED`; a different digest is `reasserted`.
- **Coherency like every read surface since M2.4.** One observation (`observed`/`finish` from
  proposals.ts) plus a guard over the claim files, the committed and uncommitted change lists,
  `worktreeState` of every changed and bound file, and the base ref's resolution. Any movement
  gives `STATE_CHANGED`.
- **Bounded, deterministic, redacted.** Fixed list limits with totals and `LIST_TRUNCATED`; stable
  ordering; `redact` removes the checkout path and home directory.

### Review round 1 (PR #23)

- **Integrity inputs are part of the observation.** `worktreeState` does not read inside `.vcv/`
  and `storeFingerprint` does not cover `approvals/`, so the guard also hashes every attestation,
  `.vcv/reviewers.json`, every changed `.vcv/` file (safe store reader) and the trust source's
  identity (external file bytes, ref commit). An already-dirty attestation edited mid-read is
  `STATE_CHANGED`.
- **An unreadable claim store is an explicit unknown.** It is reported as `bindings.available:
  false` with `CLAIM_STORE_UNREADABLE`, and nothing is inferred from it (no removed claims, no
  unaffected count, no unmapped count, no source impact).
- **Source impact is separate from model impact.** Seeds are objects with claims into changed
  code (or claims added, reasserted or unresolved). The impact runs on the candidate model with the
  existing query graph and is labelled `declared-model-context`.
- **A byte budget, not just item counts.** Display strings are cut (a locator then carries the
  digest of its full text), every emitted list is bounded, and the serialized report is fitted to
  512 KiB by halving the longest lists, or refused with `REPORT_TOO_LARGE`.

## M4.2 decisions

- **Criteria are intent; mappings are evidence.** An acceptance criterion is an IR object in an
  optional `criteria` collection, changed only by `createCriterion` / `reviseCriterion` (a typed
  proposal and a separate approval, as in M3). It has an ID, an observable statement, refs to
  what it is about (`verifies`) and a `required`/`optional` verification policy. Changing the
  statement, the refs or the policy is a model change. Which test cases check a criterion is not
  in the model: it is a `tests` binding claim on the criterion's ID that names one test case
  (file + full title). Reasserting it after a rename or move is routine binding maintenance that
  needs no approval and does not move `.vcv/HEAD`.
- **No duplicate truth.** We reuse the existing claim store, locator grammar (`#test:Suite > case`),
  fingerprints and `verifyBinding` instead of adding a second mapping file. One claim per
  (criterion, test case) pair, so the relation is many-to-many: a test can check several criteria
  and a criterion can need several tests.
- **A criterion only takes test-case claims.** `recordBinding` refuses any other relation or
  selector on a criterion (`INVALID_CLAIM`). New test names are bounded (1000 characters).
- **The four hard cases are reported, not guessed.** No mapping gives `NO_MAPPING`. A renamed,
  moved or removed test gives `TEST_MISSING`. A duplicated title gives `TEST_AMBIGUOUS`. An edited
  test body gives `TEST_CHANGED` (comment-only edits do not, since the selector fingerprint is
  token-based). A revised criterion gives `CRITERION_CHANGED` on every mapping until it is
  reasserted, because a mapping claimed against the old statement may no longer hold.
- **An unreadable claim store is `unknown`, never `none`.** Counts of unmapped criteria then stay 0
  and `mappingsAvailable` is false.
- **The absent collection keeps digests stable.** `criteria` has no schema default, so a model
  with no criteria has no `criteria` key, and every revision ID written before M4.2 is unchanged.
- **Runner identities are deferred to M4.3.** A JUnit `testcase` (`classname`, `name`) maps onto
  the claim's file and title. M4.2 stores no runner-specific ID.
- **Read surface.** `criteriaEvidence` / `vcv criteria` is one observation over the store, the
  claim files and the bytes of every mapped test file (`STATE_CHANGED` otherwise). It is bounded,
  deterministic and redacted, and it is not a test result.

### Review round 1 (PR #24)

- **Unreadable claim files are never attributed by name.** Binding IDs are arbitrary, so an
  unreadable file may be about any criterion. It is listed in `invalidClaims`, and every
  criterion's `assessment` becomes `incomplete`. `none` becomes `unknown`, and
  `requiredNotResolved` counts every required criterion that is not both resolved and complete.
  A readable mapping that verifies as `invalid` is reported too (`MAPPING_INVALID`).
- **Every nested list is bounded, plus a byte budget.** `alsoMapsTo` and the per-test criteria
  lists are capped with totals. Per-criterion mappings and problems carry totals and truncation
  flags. The serialized report is fitted to 512 KiB by halving the longest list, or refused with
  `REPORT_TOO_LARGE`, as for reconciliation.
- **`verifies` is a query filter.** `getContext` accepts the relation it returns. A compile-time
  check now keeps the accepted relations equal to every relation the snapshot can emit.

## M4.3 decisions

- **The runner's own per-case report, not a new format.** VCV reads JUnit XML, which Vitest, Jest
  (jest-junit), pytest and Surefire already emit, and runs no tests itself. The fixtures are real
  Vitest reports of the Course Desk server. The reader is a strict, bounded subset parser: no DTD or
  entities, explicit size, case, element and depth limits, and declared counts that must match the
  cases (`REPORT_INCONSISTENT`), so truncated or carelessly edited reports are refused.
- **A result is bound to a candidate identity.** A test-run record carries the commit, the bytes of
  every uncommitted path, the model revision and the claims digest. A result counts only while all
  four still match. Anything else is `stale` with the reason, so a run from commit A never passes B.
  `testIdentity` read before the run and passed as `before` closes the gap between running and
  capturing (`TEST_RUN_RACED`).
- **Provenance from the host's permission, not from the record.** `observedBy` is `host` only when
  the capturing caller holds `tests:observe`. The CLI's local user does by default; an agent wrapper
  (`VCV_HOST_PERMISSIONS`) does not. The record's digest detects edits but is not a signature, so
  M4.4's gate captures in its own trusted job instead of trusting candidate-supplied records.
- **Results are per test case, verdicts per criterion.** Precedence is failed, stale, missing,
  unknown, then passed. Skipped, not-run and ambiguous cases are `missing`, never passed. The suite
  summary is shown next to the verdicts but never decides them. Line coverage is accepted only as
  labelled context.
- **Faster verification.** The criteria read reuses M4.2's per-read `verifyMemo`. Adding runs adds
  one identity read to the guard.

### Review round 1 (PR #25)

- **Provenance is decided by the consumer, not by the record.** A record's `observedBy` is only what
  its capturer declared. The criteria report treats a run as host-observed only for the record
  object `captureTestRun` returned in the same process to a `tests:observe` caller, unmodified (a
  module-private WeakMap keyed by that object). Every imported record is `claimed`, including a
  correctly re-digested agent→host forgery. `vcv criteria --junit` is the CLI's in-process path;
  `--run` files are claims.
- **No exact source identity, no evidence.** No Git commit, a failed Git listing, or an exhausted
  hashing budget refuses capture (`SOURCE_IDENTITY_UNAVAILABLE`) and makes every run stale. A
  failed read is never coalesced into a clean tree.
- **Report reading.** The root `skipped` total is checked like the others. A runner path is
  validated as written before it is joined to the root, with no normalization, so `/src/a.ts` can
  never alias `server/src/a.ts`.
- **Sizes that round-trip.** Capture refuses a record larger than the 16 MiB VCV reads back. The
  CLI checks a file's size before reading it, for reports and records alike.

## Consequences

- A code-first PR that edits bound code shows stale claims and the exact declarations, but VCV
  does not call it a contract violation. Settling that needs test evidence mapped to approved
  criteria (M4.2, M4.3) or an agent's labelled interpretation (M4.4).
- Unmapped changed files are visible as `not-checked`, so missing coverage is never silent.
