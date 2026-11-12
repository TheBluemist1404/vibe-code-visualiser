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

## Consequences

- A code-first PR that edits bound code shows stale claims and the exact declarations, but VCV
  does not call it a contract violation. Settling that needs test evidence mapped to approved
  criteria (M4.2, M4.3) or an agent's labelled interpretation (M4.4).
- Unmapped changed files are visible as `not-checked`, so missing coverage is never silent.
