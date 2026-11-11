# ADR 0008: Model-first changes: proposals, review, approval and implementation handoff (M3)

Status: **proposed for review** (2026-11-11). Design record for M3
([Issue #17](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/17)). Only the
M3.1 decisions are settled here; M3.2–M3.4 add their own sections. User-facing description:
[docs/proposals.md](../proposals.md).

## Context

The model-first path is: the coding agent authors a typed proposal → VCV validates it → a
separate, authorized human approves that specific proposal → VCV persists the approved change as
the next canonical `.vcv/` revision in the feature branch → the agent implements it and updates
binding claims → one PR carries code and `.vcv/`. M4 owns pre-merge reconciliation.

The engine already had the pieces for the middle: `ModelEngine.propose` / `approve`, typed
operations, branch-safe revisions and guarded FileStore writes (ADR 0003, 0004, 0007). What was
missing for an agent was a surface that can only ever propose, and for a reviewer a way to see
what a proposal changes before deciding.

## M3.1 decisions

- **No second writer.** Submission calls `ModelEngine.propose`; previews call `checkChange`, the
  pure function `propose` and `approve` now decide on (extracted from the engine's private dry
  run, behavior unchanged). There is no JSON patch and no path that writes revisions.
- **Proposal-only by narrowing, not by trust.** `submitProposal` passes the engine a host
  context whose permissions are the host's intersected with `{model:propose}`. Whatever flags or
  environment the caller has, this surface cannot apply or approve; it asserts afterwards that
  `.vcv/HEAD` did not move. This does not make the *other* surfaces (`vcv propose`,
  `vcv approve`) safe from a shell-capable agent: that is M3.2's threat model.
- **Proposal identity** = change ID (immutable; replays are rejected and never overwrite) plus a
  derived content digest, `sha256("vcv-proposal-v1\0" + canonicalJson(change))`. Not stored: a
  stored digest would be rewritten by anyone able to rewrite the record. M3.2 binds an approval
  to the digest the reviewer saw.
- **Lifecycle is derived, never stored**: `pending`, `stale` (`superseded` | `other-line`),
  `rejected`, `applied`, `invalid`, computed from the record and the checkout's HEAD line on each
  call. A pending record carried to another branch, or left behind after a merge, therefore
  shows as stale there without anyone rewriting it. `denied` is never persisted (ADR 0004).
- **Preview is bounded and read-only** (FileStoreReader; no recovery). The delta is
  object-level with field values capped; impact reuses `@vcv/query`'s `analyzeImpact` on the
  model after the change (removed objects on the model before it); modules and contracts are
  grouped with `crossModule`. A stale proposal is shown against its base revision so a
  reviewer can still see what it meant. Binding claims on touched objects are listed, not
  verified (verification is `vcv evidence`, and is not the reviewer's question here).
- **Four states kept apart** in every preview: change lifecycle, change approval as recorded,
  model snapshot `draft|approved`, and implementation (always `not-recorded`).
- **One new operation, `createCapability`.** The cross-module demonstration needs a new
  capability, and there was no typed way to add one (`createModule`, `createEvent` and
  `createRule` existed). Same rules as the others: fresh ID, owner must resolve, whole-model
  validation after all operations.
- **MCP stays read-only.** `vcv_list_proposals` and `vcv_preview_proposal` join the `--repo`
  tools; submission is the host's CLI. An MCP write tool needs a host-fixed principal at launch
  and the M3.2 threat model first.
- **One observation per call** (review of PR #18). Preview and list read status, model, history,
  change records (and claims) once, build `context` from that same model, then recheck the store
  fingerprint, Git commit, change-record contents and claim digests; any difference is
  `STATE_CHANGED` (retry), as for source evidence in M2.5. No locks or watchers.
- **Safe store reads** (review of PR #18). One reader, `readStoreFile`, for HEAD, revisions and
  change records everywhere (inspection, recovery, writer, listings, binding freshness): lstat,
  regular files only, `O_NOFOLLOW | O_NONBLOCK`, re-checked on the descriptor, size-bounded
  (HEAD 4 MB, revision 8 MB, record 1 MB); `revisions/` and `changes/` must be plain
  directories; the fingerprint lstat()s instead of following. Consistency rule kept from ADR
  0007: an *unreadable* record (unsafe, not JSON, wrong ID) makes the store invalid for every
  surface, because recovery must read every applied record; a readable record with an untyped
  `change` is only lifecycle `invalid`.
- **Approval wording**: `none` / `applied-by-host` (no separate approver: direct apply or an
  allowed self-approval) / `approved-by-separate-reviewer` (record names a different approver).
  Never an authenticated identity; that is M3.2. `crossModule` is `yes` / `no` /
  `not-determined` (one module seen, candidate list cut).
- **Diagnostics carry hints** for the common codes, so an agent can correct a proposal without
  reading the engine.
- **Limits on the agent surface**: 100 operations and 256 KB per proposal; the CLI also refuses
  a file over 1 MB before parsing. Oversized proposals are rejected without a record and, unlike
  engine refusals, without an audit line (they never reach the engine).

## M3.2 decisions

- **Identity is a key, not a claim.** Flags (`--as`, `--perm`), `VCV_HOST_*` and principal IDs in
  change records are all writable by a shell agent in the same checkout. `vcv review approve`
  refuses the first two outright and derives the approver from the trust-list entry whose
  Ed25519 public key matches the reviewer's private key. `node:crypto` only; no new dependency.
- **Trust needs an explicit anchor outside the candidate branch** (review round 1).
  `.vcv/reviewers.json` is read from `--trust-ref <base>` or `--trust <file outside the
  checkout>`; there is no default. `HEAD`, `@`, the checked-out branch, a commit only it
  contains, and any file whose resolved path (parent symlinks followed) is in the checkout are
  refused for approval (`UNPROTECTED_TRUST`) and are an error for a strict integrity check
  (`TRUST_FROM_CHECKOUT`). A ref is reported as a pinned commit with protection *asserted by the
  caller*: Git cannot verify branch protection. `--trust-working-tree` remains as an explicit
  unsafe development mode that cannot produce a trusted approval.
- **Approval authority is established outside the checkout, never inferred from refs** (review
  round 2). Any local ref (tag, branch, remote-tracking ref) can be created or moved by a shell
  agent, so reachability from "another ref" is not independence. `vcv review approve|finalize`
  accept only `pinned-commit` (`--trust-commit <full ID>` copied from the hosting service; the
  ref, if given, must resolve to it: `TRUST_PIN_MISMATCH`) or `external-file` (a reviewer-owned
  list outside the checkout). An unpinned `--trust-ref` is `local-ref` authority: accepted by
  `vcv integrity`, whose CI use relies on the host providing the base ref, and reported as such.
- **Local approval is caller-asserted; the host gate authorizes** (review round 3). A standalone
  CLI cannot authenticate where a pin or a file came from: an agent can commit its own key, tag
  it, and pass that tag with that SHA. So every local anchor is labelled `caller-asserted`, each
  approval result carries `authorization: not established by this command…`, and each
  integrity report says `ok` authorizes only when the host supplied the anchor. With `--base`,
  a Git trust anchor must be the base or an ancestor of it (`TRUST_NOT_FROM_BASE`), so the gate
  cannot be pointed at a branch-chosen list. The documented gate is a required CI check on the
  protected branch whose workflow and trust list are code-owner protected.
- **The host gate runs a trusted verifier on candidate data** (review round 4). A gate that
  installs and runs the PR's own checkout executes candidate-controlled code (`package.json`
  scripts, dependencies, the verifier itself). `scripts/vcv-host-gate.sh` runs VCV from a
  base checkout (installed with `--ignore-scripts`) against the candidate as data, with the
  host-supplied base commit as both `--base` and the pinned trust anchor;
  `docs/ci/vcv-gate.example.yml` wires it into `pull_request_target`. A pinned anchor skips the
  "only reachable from the checked-out branch" heuristic, since a CI checkout may hold the base
  by ID only; that heuristic only ever refused, and pins are caller-asserted anyway.
- **Preflight, exclusive write, explicit repair** (review round 1). The attestation destination
  is checked before the model commit; the file is created exclusively (link, never rename over).
  If the write still fails after the commit, `ATTESTATION_NOT_WRITTEN` names `vcv review
  finalize`, which lets only the recorded approver, with a trusted key and the reviewed digest,
  write the missing attestation for an applied change in the current history; idempotent, never
  overwriting. A two-file transaction was considered and rejected: it would change FileStore's
  commit protocol for one file, and recovery is still needed after a crash.
- **The base's evidence is preserved** (review round 1). With `--base`, every base attestation
  and every settled (applied/rejected) base change record must be byte-identical in the checkout,
  so a branch cannot delete the proof of an earlier approval while integrity passes.
- **Approval binds to `proposalDigest`.** `ModelEngine.approve` takes `expectedDigest`; a
  mismatch is a refusal (`DIGEST_MISMATCH`) that leaves the record pending and is audited, so a
  proposal re-submitted or edited after preview cannot ride on an earlier review. The digest
  stays derived, never stored (M3.1).
- **Attestation beside the record, not inside it.** `.vcv/approvals/<changeId>.json` signs
  `"vcv-approval-v1\0" + canonicalJson(body)` and repeats the record's fields so integrity can
  compare them. Keeping it separate leaves the change-record format and revision IDs unchanged
  and lets unattested history (legacy `vcv approve`, direct apply, all of M1/M2) stay readable,
  reported as `missing` provenance.
- **Integrity is a replay, read-only.** `vcv integrity` replays each applied record's typed
  operations with `checkChange` on the parent revision and compares `revisionDigest`, so a
  hand-written or edited revision fails regardless of signatures. With `--base`, the base's
  history must be a prefix of the checkout's. An attestation that is present but does not
  verify is always an error; a missing one is a warning unless `--require-attestation`. Reads
  use the M2.4/M3.1 safe reader; nothing is written, not even an audit line.
- **Honest limits in the output.** Every report lists what it cannot prove (who held a key, the
  trust list's own correctness, the initial revision's origin, code vs model, the local audit
  log), so a green check is not read as more than it is.
- **No MCP approval tool**, no revocation list or key expiry (remove the entry on the protected
  branch); both can come later without changing the attestation format (`format: 1`).

## M3.3 decisions

- **The implementation request is part of the proposal.** `behavior`, `acceptanceCriteria`,
  `suggestedTests` and `scope` ride in an optional, strict `implementation` field of the
  proposed change, so the proposal digest covers them. The reviewer approves the criteria and
  the scope together with the operations, and the handoff cannot invent either. The engine
  never reads the field; existing proposals and their digests are unchanged.
- **The handoff is derived, not stored.** `vcv handoff` is read-only. It is deterministic (no
  timestamps, stable order, a digest), bounded (capped lists, 128 KB) and redacted (no absolute
  paths, no home directory). It is built from one observation, like every read surface. It
  requires an applied change whose attestation signature matches the record. Key trust stays
  with the host gate (M3.2), so the handoff says `caller-asserted`.
- **The report keeps claims and observations apart.** One file per change,
  `.vcv/implementations/<changeId>.json`, holds four sections:
  - `approvedIntent` (from the record);
  - `agentClaims` (the agent's tests, outcomes, criteria, gaps and confidence; `verifiedByVcv:
    false`);
  - `vcvObserved` (files changed since the base commit, scope matches, `.vcv/` areas, and
    affected bindings verified now, with a `reasserted` flag);
  - `notReconciled`.

  VCV runs no tests and infers nothing from code. Warnings are explicit instead of a pass/fail
  verdict: out-of-scope files, an undeclared scope, unresolved or unreasserted bindings, failed or
  missing tests, unmet or unaddressed criteria, a moved model.
- **"Reasserted" is a revision fact, not a judgment.** A claim counts as reasserted when it was
  made at the approved revision or later. That is the only thing VCV can tell about the agent
  having looked again. It says nothing about whether the claim is right.
- **Writes are explicit and guarded.** A report is created exclusively and replaced only with the
  current file's digest (`--expect`), like binding claims. The directory must be plain. The
  base commit must be an ancestor of HEAD. Recording never touches the model.
- **No new trust claims.** `claimedBy` is the host-asserted principal; nothing in a report is
  authorization. The integrity gate is unaffected by reports.
- Not done: MCP tools for the handoff or the report (the agent already has the CLI), test
  execution, a universal verifier, and anything that triggers code generation.

## Consequences

- New: `readStoreFile` / `STORE_FILE_LIMITS` in core (now used by every store read), `packages/repo/src/proposals.ts` (`submitProposal`, `listProposals`, `previewProposal`,
  `createProposalReadApi`), `listChangeRecords` and `FileStoreReader.revision` in core,
  `checkChange` / `proposalDigest` exported from the engine, CLI `vcv proposal submit|preview|list`,
  MCP `vcv_list_proposals` / `vcv_preview_proposal`.
- Unchanged: `vcv propose` / `vcv approve`, the store format, change records, revision IDs.
- M3.2 new: `packages/repo/src/approval.ts` (`createReviewerKey`, `addTrustedReviewer`,
  `loadTrust`, `reviewApprove`, `readAttestation`), `packages/repo/src/integrity.ts`
  (`checkIntegrity`), `reviewFinalize`, `ApproveOptions.expectedDigest` in the engine, `resolveCommit` /
  `fileAtCommit` git helpers, CLI `vcv reviewer init`, `vcv review approve|finalize`, `vcv integrity`.
  New store files: `.vcv/reviewers.json`, `.vcv/approvals/`. Unchanged: change records,
  revision IDs, `vcv approve`.
- M3.3 new: `implementation` request in `proposedChangeSchema` (core), `packages/repo/src/handoff.ts`
  (`buildHandoff`), `packages/repo/src/implementation.ts` (`recordImplementation`,
  `implementationStatus`, `globMatcher`), `changedFilesSince` git helper, CLI `vcv handoff`,
  `vcv implementation record|show`, preview shows the request. New store directory:
  `.vcv/implementations/`.
