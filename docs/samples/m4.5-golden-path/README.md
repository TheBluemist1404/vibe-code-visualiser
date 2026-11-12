# Recorded run: the code-first pre-merge golden path (M4.5)

This is the M4.5 demonstration of Issue #22. It was recorded on 2026-11-12 in two forms:

- **Live:** [TheBluemist1404/course-desk](https://github.com/TheBluemist1404/course-desk), a standalone Course Desk repository. It uses the pre-merge workflow from [docs/ci/vcv-premerge.example.yml](../../ci/vcv-premerge.example.yml), pinned to VCV df9452c (M4.4), and `vcv-gate` is a required check on `main`. Every result below is a GitHub Actions run on a real pull request.
- **Local:** [`examples/reference-app/premerge/`](../../../examples/reference-app/premerge/) runs the same three jobs on a fresh fixture checkout, together with the negative cases that cannot be pull requests. See [local/](local/).

In the files, `<repo>` is the Course Desk checkout, `<work>` is the run's work directory and `<vcv>` is this checkout.

## Who did what

| Role | Who | What they did |
| ---- | --- | ------------- |
| Coding agent | this session, as `agent:coder` (`model:propose`, `binding:record`) | Wrote every code change. Wrote the observations, submitted the proposals and reasserted the claims. It never held a reviewer key. |
| M3 reviewer (intent) | the owner, `user:hoang`, the only entry in `.vcv/reviewers.json` | Approved `chg-quiet-rejections-2` in his own words, naming the change ID and digest (2026-11-12 14:56Z). Codex signed it with his key on his machine, at his instruction. The setup's baseline approval was signed the same way. |
| PR reviewer | Codex, posting as TheBluemist1404 | Independently reviewed each PR at its exact head, read the CI logs and merged. Its reviews are the independent assessment of this run (see below). A GitHub approval is not an intent approval. |
| Host | GitHub Actions on `pull_request_target`, three jobs | `identity` runs no PR code. `candidate-tests` runs the PR's own Vitest with a read-only token. `vcv-gate` runs the trusted, pinned VCV and treats the candidate as data. |

**Enforcement chronology.** Ruleset 27111291 ([ruleset-main.json](live/ruleset-main.json)) became active on `main` at about 11:00Z, after the repository was made public. It requires `vcv-gate`, a pull request, no force-push and no deletion, and has no bypass actors. The runs on #1 predate it, so #1 shows validation but not GitHub refusing a merge. #4 shows GitHub refusing a merge: while its gate was red, GitHub reported `mergeable_state: blocked`.

## The path

The model is `prj-course-desk`. It has three criteria with test-case mappings:
- `crt-rejection-notified`: required. It verifies `rul-announce-every-decision`, `rul-seat-limit` and `cap-enroll`.
- `crt-confirmation-notified`: required. It verifies `rul-announce-every-decision` and `cap-enroll`.
- `crt-repeat-rejected`: optional.

One e2e case is mapped to both required criteria. The base policy blocks confirmed contradictions and requires host-observed evidence for `rul-announce-every-decision`.

| # | PR | Change | `npx vitest run` | `vcv-gate` | Files |
| - | -- | ------ | ---------------- | ---------- | ----- |
| 1 | [#1](https://github.com/TheBluemist1404/course-desk/pull/1) | **Broken, code-first.** `enroll()` stops notifying rejected students. No model edit. | 6/8, exit 1 | **BLOCK** ([run 43204839976](https://github.com/TheBluemist1404/course-desk/actions/runs/43204839976)): `TEST_FAILED` for both required criteria, naming the exact case, file and assertion; `EVIDENCE_REQUIRED` on the rule; 3× `CLAIM_STALE` | [gate](live/1-broken/ci-gate.txt), [diff](live/1-broken/source.diff) |
| 2 | #1 | **Explained.** The agent's `contradiction` observation (resolution: fix code), with source lines and the two failing cases. Run locally, because CI takes no observations. | same | **BLOCK**, plus `AGENT_CONTRADICTION [claim]` with "references verified". VCV checks what the observation cites, not what it says. | [gate](live/2-explained/gate.txt), [observation](live/2-explained/observations.json) |
| 3 | #1 | **Fixed.** A later commit restores the notification. | 8/8 | **PASS** ([run 43205161554](https://github.com/TheBluemist1404/course-desk/actions/runs/43205161554)). Merged; the net tree diff is empty ("no-change change"). | [gate](live/3-fixed/ci-gate.txt), [diff](live/3-fixed/source.diff) |
| 4 | [#3](https://github.com/TheBluemist1404/course-desk/pull/3) | **Harmless, related source.** A comment reworded in the bound `EnrollmentService`. | 8/8 | **WARN** `BASE_NOT_CONTAINED` (the branch predated main) on [run 43205473610](https://github.com/TheBluemist1404/course-desk/actions/runs/43205473610), then **PASS** with no warnings after merging main ([run 43205842424](https://github.com/TheBluemist1404/course-desk/actions/runs/43205842424)) | [gate](live/4-harmless-related/ci-gate.txt), [diff](live/4-harmless-related/source.diff) |
| 5 | [#5](https://github.com/TheBluemist1404/course-desk/pull/5) | **Harmless, unrelated file.** One line of README. | 8/8 | **WARN, passes** ([run 43205953222](https://github.com/TheBluemist1404/course-desk/actions/runs/43205953222)): `UNMAPPED_CHANGES [unsupported; not-checked]`. VCV declines to relate the file; it does not call it harmless. | [gate](live/5-harmless-unrelated/ci-gate.txt), [diff](live/5-harmless-unrelated/source.diff) |
| 6 | [#6](https://github.com/TheBluemist1404/course-desk/pull/6) | **Weak evidence.** The 400 message for a missing `recipientId` changed. No criterion covers it, no test asserts it, and no claim points at the file. | 8/8 | **WARN, passes** ([run 43243898730](https://github.com/TheBluemist1404/course-desk/actions/runs/43243898730); again after merging main, on rev-4, in [run 43244159615](https://github.com/TheBluemist1404/course-desk/actions/runs/43244159615)): `UNMAPPED_CHANGES` only. No contradiction is invented, and no compatibility is established. The local run with the agent's `concern` adds `AGENT_CONCERN [claim]` with references verified. That is author evidence, not part of the CI proof. | [gate](live/6-weak-evidence/ci-gate.txt), [local](live/6-weak-evidence/local-gate.txt), [diff](live/6-weak-evidence/source.diff) |
| 7 | [#4](https://github.com/TheBluemist1404/course-desk/pull/4) | **Intent change, model-first.** The same behaviour as #1, now intended. Code and tests change, and the agent submits a typed proposal. | **8/8, green** | **BLOCK** while the proposal is pending ([run 43205722344](https://github.com/TheBluemist1404/course-desk/actions/runs/43205722344)): the renamed cases are `TEST_NOT_RUN` and `EVIDENCE_REQUIRED` applies. A green suite does not stand in for the mapped cases (`SUITE_GREEN_REQUIRED_NOT_PASSED`). GitHub reported `mergeable_state: blocked`. | [gate](live/7-intent/ci-gate.txt), [local, with `PROPOSAL_PENDING`](live/7-intent/local-gate-pending-branch-vcv.txt), [proposal](live/7-intent/proposal.yaml), [preview](live/7-intent/preview.txt) |
| 7b | #4 | **Proposal repaired.** Codex found contradictory labels in `chg-quiet-rejections`: the rule's name and the project description still said every decision is announced. That proposal was withdrawn before anyone approved it, its pending record was removed in a visible commit, and `chg-quiet-rejections-2` replaced it. The README and smoke script were aligned as well. | 8/8 | BLOCK (runs 43206369859, 43206485285) | [withdrawn](live/7-intent/withdrawn/), [new proposal](live/7-intent/proposal.yaml) |
| 7c | #4 | **Approved by the owner** (5e5aef7, rev-4-d704dd46aee2, signed `user:hoang`, trust pinned to main 5afcc30) | 8/8 | **BLOCK** ([run 43243270365](https://github.com/TheBluemist1404/course-desk/actions/runs/43243270365)): approval alone is not enough, because the mappings still pointed at the old test names | [ci](live/7-intent/ci-gate.txt) |
| 7d | #4 | **Mappings reasserted.** The agent reasserts 4 test mappings and refreshes 3 `enroll()` claims (f8b94a3). No approval is needed for this. | 8/8 | **WARN, passes** ([run 43243546237](https://github.com/TheBluemist1404/course-desk/actions/runs/43243546237)): 2/2 required passed host-observed; lineage extends by one approved revision; `UNMAPPED_CHANGES` (README, smoke) and 5× `MAPPING_CHANGED` for review | [reassert](live/7-intent/approved/reassert.txt), [ci](live/7-intent/ci-gate.txt), [diff](live/7-intent/source.diff) |
| 8 | — | **Merge comparison.** #4 was squash-merged as 366607d. | — | Base 5afcc30 is at rev-3; candidate f8b94a3 and merged main 366607d are at rev-4. The candidate and merged trees are identical. `integrity --require-attestation` is ok on all three. The rule and criterion read as approved, with no regeneration or post-merge rewrite. | [comparison](live/8-merge/comparison.txt) |

The `npx vitest run` column shows what an ordinary CI would report. It is red only in step 1. In step 7 it is green while a required criterion's intent is unapproved and its mapped cases are missing. That case is the one the gate exists for.

## Local run and negative cases

[local/](local/) holds a full `scenarios.sh` run of this checkout's VCV on a fresh fixture. It covers every step above plus the negatives that cannot be pull requests.

The harness fails closed. Every required operation must succeed, or the run stops with exit 3 and never prints a success summary. Those operations are the edits, the Git steps, the proposal, the approval, the reassertions and the integrity checks. Each negative case must match its expected exit code and reason codes. The merge step asserts three things: the merged model equals the candidate's, `.vcv/` is unchanged, and the merged tree equals the candidate.

The `stale-report` step leaves main's passing JUnit report in the output directory and then runs the broken commit twice:
- with a runner that cannot start, it blocks with the required criteria unverified;
- with the real, failing runner, it blocks with `TEST_FAILED` from the new report.

[local/selfcheck.log](local/selfcheck.log) shows that a failed `git merge` and a failed approval each stop `scenarios.sh` with exit 3. The approval in that run is **simulated**: it uses the fixture's reviewer key and is labelled so in `approved/approval.txt`. [local/negatives/summary.txt](local/negatives/summary.txt) lists each negative case and its exit code:

1. The broken code with an agent-supplied passing record: the gate **blocks**, because an agent's record is not host-observed.
2. That record relabelled as host-observed: **refused** (exit 2), because the digest does not match.
3. Main's report replayed on the broken commit: **refused**, because the candidate changed between identity and capture.
4. Main's report without a pre-run identity: **blocks**.
5. A revision file edited in place, with no proposal and no approval: **blocks** (`PROJECT_NOT_READY`).
6. The candidate relaxes `.github/vcv-policy.json`: still **blocks**, because policy is read from the base.
7. The intended change with its proposal still pending: **blocks**.
8. The agent re-points a required criterion's mappings to tests that assert the opposite, without changing the model: **passes with `MAPPING_CHANGED` warnings**. This is the documented limit below.

## Independent assessment

Codex reviewed each pull request independently at its exact head, and its comments on #1, #3, #4, #5 and #6 are the assessment of this run. In short:

- **#1:** the fix exactly restores the base tree. 8/8 passed on run 43205161554, and the block on run 43204839976 shows broken → explained → restored validation with unchanged approved intent.
- **#3, #5:** both are harmless, and VCV invents no contradiction. The actual verdicts (WARN `BASE_NOT_CONTAINED`, then PASS; WARN `UNMAPPED_CHANGES`) are kept as they are.
- **#6:** only the message changes, and the handler still answers 400 for the same input. Codex accepted the wording within this demo. Compatibility with consumers that match the exact text is unverified, and VCV does not claim it.
- **#4:** Codex independently previewed the digest and caught the contradictory labels in the first proposal. It confirmed that the signed approval was the owner's own instruction. It reopened the exact head and found integrity ok against the pinned base, with all 13 claims resolving. It read the six warnings and judged the renamed assertions to match the revised criteria.

## Limitations

- **Observations are not given in CI.** The `explained` and weak-evidence observations were run locally against the same heads. The live workflow takes none.
- **Mappings change without approval (negative 8).** An agent can re-point a required criterion at tests that check the opposite and the gate only warns `MAPPING_CHANGED`. A person has to read those warnings. Whether this should block is an open decision for the owner.
- **One e2e case is shared** by both required criteria. A failure in it fails both, which is correct, but the two criteria are not independently evidenced over HTTP.
- **Smoke and build are not in CI.** The workflow runs Vitest only. `npm run build && npm run smoke` passed locally on #4.
- **The live gate is the pinned M4.4 VCV.** `PROPOSAL_PENDING` exists only in this branch, so the live block on #4 does not show it. The local run on the same head does.
- **Stable ids keep old wording.** `rul-announce-every-decision` keeps its id after the rule changed meaning. The base policy's `requireEvidence` reason ("every enrollment decision must reach the student") is now stale. That text is the owner's to change.
- **Line endings.** The live repository was set up on Windows, so its files are CRLF. Every edit preserved CRLF, and the recorded diffs keep it.
- **Trust.** The trust anchor is `.vcv/reviewers.json` at a pinned commit, and the ruleset is the hosting service's. As in M3, there is no key revocation, and the approval proves that the key signed, not who typed the command.
