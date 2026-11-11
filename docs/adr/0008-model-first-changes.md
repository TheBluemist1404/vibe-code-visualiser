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
- **Diagnostics carry hints** for the common codes, so an agent can correct a proposal without
  reading the engine.
- **Limits on the agent surface**: 100 operations and 256 KB per proposal; the CLI also refuses
  a file over 1 MB before parsing. Oversized proposals are rejected without a record and, unlike
  engine refusals, without an audit line (they never reach the engine).

## Consequences

- New: `packages/repo/src/proposals.ts` (`submitProposal`, `listProposals`, `previewProposal`,
  `createProposalReadApi`), `listChangeRecords` and `FileStoreReader.revision` in core,
  `checkChange` / `proposalDigest` exported from the engine, CLI `vcv proposal submit|preview|list`,
  MCP `vcv_list_proposals` / `vcv_preview_proposal`.
- Unchanged: `vcv propose` / `vcv approve`, the store format, change records, revision IDs.
