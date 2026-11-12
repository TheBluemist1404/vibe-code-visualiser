# Pre-merge reconciliation (M4)

M4 ([Issue #22](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/22)) compares every
pull request targeting `main` with the protected base it would merge into, **before** the merge:
code-first PRs (source edits, no model change) and model-first PRs (M3) alike. There is no
post-merge step. Once Git merges the PR, checking out `main` loads the already-merged `.vcv/`.

VCV is the harness here, not an interpreter of code. It checks what it can check deterministically
(the model history, claim shapes, locators, fingerprints, the model delta) and labels everything
else. Coding agents read the code, maintain the claims and judge behaviour.

Design notes: [ADR 0009](adr/0009-pre-merge-reconciliation.md).

## M4.1: the reconciliation baseline

```sh
vcv reconcile <checkout> --base <full commit ID of the protected base> [--json]
vcv reconcile <checkout> --base <sha> --trust-ref <sha> --trust-commit <sha> --require-attestation
```

The candidate is the checkout as it is now, committed and uncommitted. The base should be the
commit ID the hosting service names (in GitHub Actions, `github.event.pull_request.base.sha`). A
ref name such as `origin/main` works locally, but it is resolved in the checkout, so the report
marks it `pinned: false`. The trust options are passed straight to the integrity check
([approvals.md](approvals.md)).

The command reads and reports. It does not decide anything, and it exits 0 whenever it produced a
report (1 for a request it cannot answer, such as an unknown base). The policy gate that blocks a
merge comes in M4.4.

### What the report contains

| Section | What it says | Where it comes from |
| --- | --- | --- |
| `base`, `candidate` | Base commit, whether it was pinned, the merge base, whether the candidate contains the base; candidate commit, branch, dirty state and a digest of the working-tree bytes read | Git, read-only |
| `model.lineage` | `unchanged`, `extends`, `new-model` (no `.vcv/` at the base) or `rewritten` | Base `.vcv/HEAD` from Git objects, plus the integrity check |
| `model.introduced`, `model.integrity` | Each revision the candidate adds, how it was derived, its approval state; integrity errors and warnings | `checkIntegrity` with the base |
| `model.delta`, `model.impact` | Object-level changes from the merge base's model, and structural impact candidates (modules, contracts, cross-module) | The same diff and impact the proposal preview uses |
| `source.files` | Each changed file since the merge base: committed, uncommitted or both; its area (source, test, `.vcv/` model, claims, other); the claims that point into it | Git |
| `bindings.items` | Every claim that is related to the change (its file changed, it was added, reasserted or removed, or its object is in the delta or impact) or is not `resolved`, verified now, with how the claim file compares with the merge base | `verifyBinding`, Git |
| `sourceImpact` | For source changes: the objects whose claims point into changed code, or whose claims were added, reasserted or no longer resolve (seeds), and the modules, contracts, rules and impact candidates the declared model connects to them. Kept apart from `model.impact`, labelled `declared-model-context` | Claims plus `@vcv/query` impact on the candidate model |
| `findings` | One list, sorted by category | All of the above |
| `budget` | The serialized size and whether lists were cut further to fit | |

Source changes are measured from the **merge base**, so work that landed on `main` after the
branch point is not counted as the candidate's (`BASE_NOT_CONTAINED` says so and asks for an
updated branch). The model lineage and integrity are always checked against the base itself.

### Findings: category and basis

Every finding has a `category` and a `basis`. The basis says how much it is worth:

- `checked`: VCV compared something deterministically (a replayed derivation, a fingerprint, a
  locator, a model object ID);
- `observed`: a fact about files and commits, never a judgement about behaviour;
- `not-checked`: VCV could not check it and says so.

| Category | Codes | Basis | Meaning |
| --- | --- | --- | --- |
| `integrity` | the integrity check's codes (`UNEXPLAINED_REVISION`, `BASE_REVISION_CHANGED`, `APPROVAL_NOT_ATTESTED`…), `BASE_MODEL_UNREADABLE` | checked | The `.vcv/` history is not what the approval path produces |
| `structural` | `CLAIM_ON_MISSING_OBJECT` | checked | A claim binds an object the candidate's approved model does not have: claim and model contradict each other |
| `binding` | `CLAIM_STALE`, `LOCATOR_MISSING`, `LOCATOR_AMBIGUOUS`, `CLAIM_INVALID`, `CLAIM_REMOVED`, `CLAIM_DISPUTED` | checked / observed | The state of a claim. Stale means the bound code or the object moved since the claim, nothing more |
| `coverage` | `OBJECT_UNBOUND` | observed | An object the candidate added or changed in the model has no claim, so its code is not located |
| `source` | `BOUND_FILE_CHANGED`, `UNCOMMITTED_CHANGES`, `BASE_NOT_CONTAINED`, `MODEL_INTRODUCED` | observed | Facts about the change. A changed file is not drift |
| `unsupported` | `UNMAPPED_CHANGES`, `CLAIM_NOT_CHECKED`, `DELTA_UNAVAILABLE`, `LIST_TRUNCATED` | not-checked | What VCV could not relate to the model or check |

If the claim store itself cannot be read (`.vcv/bindings` is a file, a symlink or unreadable),
the report says `bindings.available: false` with `CLAIM_STORE_UNREADABLE` (not-checked). It then
infers nothing: no claim is reported removed or unaffected, `source.unmapped` is `null`, and there
is no source impact.

`related: false` marks a finding about something the candidate did not touch, such as a claim
that was already unresolved on the base.

Five things stay apart on purpose:

1. **A changed file or commit** is `observed`. Editing a comment in a bound file gives
   `BOUND_FILE_CHANGED` and no stale claim, because claim fingerprints ignore comments and
   whitespace.
2. **A stale claim** (`CLAIM_STALE`) means the selected declaration's tokens, or the bound model
   object, changed since the claim. It does not say the code is now wrong.
3. **A missing binding** (`OBJECT_UNBOUND`, `CLAIM_REMOVED`, `LOCATOR_MISSING`) means VCV cannot
   locate the code of something.
4. **A checked structural contradiction** (`integrity`, `structural`) is established by VCV.
5. **A semantic concern** ("this code no longer announces rejections") is an interpretation. VCV
   makes none; `semantic.observations` is always empty here. M4.4 adds agent-authored observations
   to the pre-merge report, labelled as claims with their source locations.

### Source impact for code-first changes

A code-first PR changes no model object, so `model.impact` is empty. `sourceImpact` gives the
reviewer and the agent the structural context anyway. Example: the change to
`EnrollmentService.enroll` seeds `cap-enroll` and `rul-seat-limit` and lists the Enrollment
module and the objects the model says depend on them (in this draft model, which declares no
contracts, that is the Enrollment module only). This is where to look, not a finding.
Changed files that no claim points into contribute nothing, and a comment-only edit still seeds
context while producing no stale claim and no contradiction.

### Coherent reads

The report is one observation. Before answering, VCV reads again the model store, Git HEAD, the
base ref, every claim file and the bytes of every changed or bound file
([worktree.ts](../packages/repo/src/worktree.ts)). It also rereads every input of the integrity
result: each attestation file, the checkout's trust list, every changed `.vcv/` file, and the
trust source (an external trust file's bytes, a trust ref's commit). If any of them moved (a branch switch, a
same-path edit in the working tree, a moved ref), the call fails with `STATE_CHANGED` instead of
mixing two states. Retry it.

### Bounds and redaction

At most 500 files, 500 claims, 200 model changes, 500 findings, 200 introduced revisions and 100
integrity errors and warnings each are listed; the summary and the `…Total` fields count
everything, and `LIST_TRUNCATED` says what was cut. Display strings are bounded too: a locator is
cut at 300 characters and then carries `locatorDigest`, the sha256 of the full text (the claim
file keeps the identity), and messages are cut at 1000. The whole report must fit 512 KiB: if it
does not, the longest lists are halved until it does and flagged as truncated (`budget.shrunk`).
If it still cannot fit, the call fails with `REPORT_TOO_LARGE`. Paths are repository-relative; the checkout's
absolute path and the home directory never appear. The same checkout state gives the same JSON.

### Example: a code-first change

On Course Desk, a branch drops the rejection notification from `EnrollmentService.enroll` and
leaves an unrelated README edit uncommitted (`C` committed, `W` uncommitted; recorded with the CLI, the `not established here` list cut):

```text
reconciliation of prj-course-desk: candidate 9762b1541bbd (feature) + uncommitted edits against base d84df9bfd62a
  model: unchanged, rev-1 → rev-1; integrity ok; 0 object change(s)
  source: 2 changed file(s), 1 file(s) outside .vcv/ unmapped
     W source       README.md
    C  source       server/src/enrollment/enrollment.service.ts  ← impl.cap-enroll, impl.rul-seat-limit
  source impact (declared-model context, not evidence of drift): seeds cap-enroll, rul-seat-limit; modules mod-enrollment; 1 impact candidate(s); cross-module no
    rules: rul-seat-limit (seed)
  bindings: 2 shown, 2 unaffected and resolved
    impl.cap-enroll: stale; claim unchanged; object unchanged; bound file changed
    impl.rul-seat-limit: stale; claim unchanged; object unchanged; bound file changed
  findings (5):
    [binding/checked] CLAIM_STALE: claim impl.cap-enroll (cap-enroll at server/src/enrollment/enrollment.service.ts#symbol:EnrollmentService.enroll) is stale (code: the selected declaration's code differs from the recorded fingerprint). The code or object moved since the claim; whether it still does what the model says is for an agent or a person to judge
    [binding/checked] CLAIM_STALE: claim impl.rul-seat-limit (…) is stale (…)
    [source/observed] BOUND_FILE_CHANGED: server/src/enrollment/enrollment.service.ts changed; claims impl.cap-enroll, impl.rul-seat-limit point into it. A changed file is not drift: see each claim's freshness.
    [source/observed] UNCOMMITTED_CHANGES: 1 path(s) differ from HEAD; this report describes those working-tree bytes (candidate.worktree), not only commit 9762b1541bbd
    [unsupported/not-checked] UNMAPPED_CHANGES: 1 changed file(s) outside .vcv/ are not pointed at by any claim, so VCV cannot relate them to the model: README.md
  semantic: VCV makes no semantic observations. Agent-authored interpretations are added to the pre-merge report (M4.4) and labelled as claims.
```

VCV shows where to look: two claims on `enroll()` are stale and the route and test claims are
not. It does not say the rejection notice is missing. Deciding that is the agent's job, and M4.2
and M4.3 add the evidence that settles it: the approved acceptance criteria and the individual
test cases mapped to them.

## M4.2: acceptance criteria and test-case mappings

Approved criteria, and the test cases mapped to them, are described in
[criteria.md](criteria.md). In the reconciliation report, a criterion the candidate adds or
revises without a mapped test case gives `OBJECT_UNBOUND` with the message "no test case is mapped
to it".

## Not established by this report

- Whether the code does what the model says. A resolved, fresh claim is not evidence of that.
- Anything about files no claim points into.
- Which base is protected. Only a commit ID supplied by the hosting service, in a check the
  candidate cannot edit, identifies it; M4.4 adds that gate.
