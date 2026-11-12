# The pre-merge policy gate (M4.4)

M4.4 ([Issue #22](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/22)) answers one
question for every pull request to `main`: **may this candidate merge into the protected base?** It
applies to code-first PRs (source edits, no model change) and model-first PRs (M3) alike, and it runs
before the merge. There is no post-merge step.

The gate puts together what the earlier slices establish. It adds no interpretation of code:

| Part | What is checked | From |
|---|---|---|
| Integrity | The model history against the base, pinned to the base commit, with attestation required: every new revision derived by its typed operations and approved by a key in the base's trust list | M3, [approvals.md](approvals.md) |
| Structure and bindings | Claims on objects the model does not have, and stale, missing, ambiguous or removed claims | M4.1, [reconciliation.md](reconciliation.md) |
| Criteria | Every approved criterion's mapped test cases, and their results in runs of this exact candidate | M4.2 / M4.3, [criteria.md](criteria.md), [test-evidence.md](test-evidence.md) |
| Agent observations | Bounded semantic observations written by an agent. VCV checks that what they cite exists, and labels them claims | M4.4 |

The **policy** then sorts each outcome into `block`, `warn` or off, and the gate answers `pass`,
`warn` or `block`.

Design notes: [ADR 0009, M4.4 decisions](adr/0009-pre-merge-reconciliation.md#m44-decisions).

## Running it

```sh
vcv gate <candidate> --base <full commit ID of the protected base> \
  [--junit <report.xml> --root server --runner vitest --invocation "<command>" --before <identityDigest>] \
  [--run <test-run.json>]... [--observations <file>] \
  [--policy <host-owned file> | --policy-at-base .github/vcv-policy.json] [--coverage <f>] [--json]
```

The exit code is what a CI check needs:

- `0`: pass, or pass with warnings;
- `1`: block;
- `2`: a usage or setup problem, such as a ref name instead of a commit ID, a base missing from the
  checkout, a policy that does not parse, or a candidate that moved while the gate read it. Exit 2 is
  never a pass.

`--junit` is captured inside the gate's own process, against `--before`: the identity the host read
before the tests ran. Only that combination makes a run host-observed. `--run` records are claims, whatever they declare,
and so is a capture by a caller that lacks `tests:observe`.

A candidate whose model cannot be loaded at all (a hand-edited revision file, a conflict, no `.vcv/`)
is blocked with `PROJECT_NOT_READY`. It is not a setup error.

## In CI: three jobs

The candidate's tests have to run its own code. The verifier must not run next to that code: a
step in the same job could rewrite the installed VCV, or the report, before the gate reads them. So
the supported recipe has three jobs. See
[`ci/vcv-premerge.example.yml`](ci/vcv-premerge.example.yml):

1. **`identity`** never executes PR code. The trusted VCV reads the PR head's identity before any
   test runs: its commit, uncommitted and bound bytes, model revision and claims (`vcv tests
   identity`). It hands the digest over as a job output, which no other job can write.
2. **`candidate-tests`** starts only after `identity` has finished (`needs: identity`), so no PR
   code runs before the identity is read. It checks out the PR head and runs the project's
   ordinary runner with its JUnit reporter. For Course Desk that is `npx vitest run --reporter=junit --outputFile=…`. This job
   executes PR code, so it gets no token permissions and no secrets. It uses no cache: under
   `pull_request_target`, a cache it wrote would belong to the base. It hands over exactly one file,
   the report.
3. **`vcv-gate`** never executes PR code. It installs VCV from a commit pinned in the workflow file,
   with `npm ci --ignore-scripts`. It checks out the PR head as data and fetches the base commit. It
   then runs [`scripts/vcv-premerge-gate.sh`](../scripts/vcv-premerge-gate.sh), which:
   - refuses a verifier inside the candidate, a base that is not a full commit ID, and `--as`,
     `--perm` or `--base` overrides;
   - fixes the host identity with `tests:observe`;
   - runs `vcv gate --junit … --before <identity job's digest>`. The gate captures the report
     in-process, and only if the candidate it reads now has exactly that identity. It also reads
     the policy from the base commit.

**A report is host-observed only with `--before`.** That is the identity the host read before the
tests ran, in a step no PR code had run in. The gate never makes one up. A report from an earlier
state of the code is refused (`TEST_RUN_RACED`), and a report given without `--before` is captured
as a claim, so it blocks every required criterion.

The workflow runs under `pull_request_target`, so the file comes from the base and a PR cannot edit
it. Make **`vcv-gate` a required status check** on `main`. Require code-owner review for the
workflow, for `.github/vcv-policy.json` and for `.vcv/reviewers.json`. A gate that is not a required
check enforces nothing. VCV cannot configure branch protection; a repository admin does that in the
repository's settings, under Rules (or Branches).

**The candidate checkout is data, and Git reads keep it that way.** Every Git command VCV runs:
- disables `core.fsmonitor` and hooks;
- reads attributes from the empty tree, so the checkout's `.gitattributes` cannot pick a filter;
- empties every configured filter, diff and merge driver command;
- uses no pager and no external diff.

If VCV cannot list the driver keys exactly (an unreadable or oversized config, more than 1,000 keys),
it runs no Git command on that checkout. The gate answers `SOURCE_IDENTITY_UNAVAILABLE` (exit 2), and
a failed Git read is never taken as a clean tree.

A candidate whose `.git/config` names commands, for example a checkout an agent prepared, therefore
runs none of them in the verifier's process.

[`apps/cli/test/cli.test.ts`](../apps/cli/test/cli.test.ts) has a regression test for this setup. A
candidate rewrites its own CLI and gate code to print "pass", and ships a passing run record it
captured itself and relabelled as host-observed. The trusted gate still blocks on the host run's
failing case. The shipped record counts only as a claim, and the gate passes once the host's own run
is green.

**CI is the test run.** This was the owner's decision on 2026-11-12. The `candidate-tests` job
defined by the base is the project's test run, as it is for any CI. VCV binds its report to the exact
candidate, and to the identity read before the run, but it cannot make the PR's own test code honest.
That code runs in that job and could weaken a mapped test, or make the runner print a passing report.
The gate shows the cases it can see:
- `TEST_CHANGED` makes the mapping stale when a mapped test's code changed;
- `MAPPING_CHANGED` warns when a mapping is added or reasserted, or when its test file changes.

Whether the new test still checks the criterion is the PR reviewer's judgement.

## The policy

A policy is JSON, format `vcv-policy-1`. Every key is optional, and a missing key takes the default:

```json
{
  "format": "vcv-policy-1",
  "optional": { "failed": "warn", "stale": "warn", "missing": "warn", "unknown": "warn", "unverified": "warn", "claimed": "warn" },
  "structural": "block",
  "bindings": { "related": "warn", "unrelated": "warn" },
  "coverage": "warn",
  "unsupported": "warn",
  "baseNotContained": "warn",
  "mappingChanged": "warn",
  "noCriteria": "warn",
  "observations": { "contradiction": "warn", "concern": "warn", "invalidReferences": "warn" },
  "policyChanged": "warn",
  "requireEvidence": [{ "object": "ctr-enrollment-notification", "reason": "students must always be told" }]
}
```

- **Integrity is not configurable.** An invalid, rewritten or unattested history always blocks, and
  so does an unreadable claim store.
- **Required criteria are not configurable.** Any result of a required criterion other than a
  host-observed pass blocks: failed, stale, missing, unknown, unverified, or claimed (it passed only
  in runs the gate did not capture). Whether a criterion is required is approved intent in the
  model, and it changes only through an M3 proposal and a separate human approval. A policy file
  is not that approval, so a `required` key is refused.
- **`structural`** (a claim on an object the approved model does not have) is a checked
  contradiction: `block` or `warn`.
- **`requireEvidence`** lists objects that need test evidence whenever a change touches them. An
  object counts as touched through any of:
  - the model delta, or its impact;
  - the declared context of the changed code;
  - the protected base's own claims: an object whose base-side claims point into a changed file, or
    whose claims the candidate removed or reasserted.

  Removing a claim does not take its object out of scope. At least one *required*
  criterion that verifies the object must have a host-observed pass, or the gate blocks with
  `EVIDENCE_REQUIRED`. If an impact, claim or file list was cut, or a base claim cannot be read,
  every listed object counts as touched.
- Unknown keys are refused (`POLICY_INVALID`). So is any attempt to switch integrity off.

The policy is the host's, never the candidate's:

- `--policy-at-base <path>` reads the file from the **base commit's** Git objects. Only real
  absence falls back to the defaults. An oversized file, an unreadable blob or a non-file entry is
  `POLICY_INVALID` (exit 2). If the candidate
  changes that file, the gate reports `POLICY_CHANGED` (a warning by default). The change takes effect
  only after the merge, once it has been reviewed. If the base has no such file, the defaults apply,
  and the report says so.
- `--policy <file>` is a file the host supplies. The CLI refuses one inside the candidate checkout.

Changing what a criterion means, or whether it is required, is a model change. It goes through an M3
proposal and a separate human approval, never through the policy. A merged reviewer approval of the
PR does not count as that approval.

## Agent observations

An agent that reads the code can attach what it found (`--observations <file>`):

```json
{
  "format": "vcv-observations-1",
  "observations": [
    {
      "id": "obs-reason-dropped",
      "kind": "contradiction",
      "statement": "enroll() no longer passes the rejection reason to the notification",
      "objects": ["rul-seat-limit", "crt-full-course"],
      "locations": [{ "path": "server/src/enrollment/enrollment.service.ts", "startLine": 40, "endLine": 52 }],
      "tests": [{ "path": "server/src/enrollment/enrollment.service.spec.ts", "name": "EnrollmentService > rejects an enrollment into a full course and notifies the student" }],
      "resolution": "fix-code",
      "author": "agent:coder"
    }
  ]
}
```

- `kind` is one of:
  - `contradiction`: the agent says the code disagrees with approved intent;
  - `concern`: it may;
  - `note`: context only.
- `resolution` is what the agent proposes:
  - `fix-code`;
  - `submit-model-proposal`: intent should change, through M3;
  - `inspect`: a person should look;
  - `none`.

VCV checks every reference. It checks that each object exists in the candidate's model, and that each
path is portable, exists and has the cited lines. It checks that each test case exists in its file,
whether or not any run is available, and reports whether the case is mapped and what it returned in
the fresh runs. Every cited file, ignored files included, is part of what the gate rechecks before
answering. The observation then gets one of four labels:

- `verified`: every reference holds;
- `invalid`: some reference does not, reported as `OBSERVATION_REFERENCES_INVALID`;
- `unsupported`: a contradiction that cites no source location, reported as
  `OBSERVATION_WITHOUT_LOCATION`;
- `not-checked`: some reference could not be checked (a file too large for the line check, a test
  file the resolver does not parse), reported as `OBSERVATION_REFERENCES_NOT_CHECKED`. It is never
  called verified.

Every observation stays a **claim** (`basis: "claim"`). VCV never confirms or refutes what it says.
By default, observations warn. A team can set `observations.contradiction` to `block` to stop any PR
on which an agent asserts an unresolved contradiction. The reason still says it is an agent's claim.

Observations can come from the candidate (an agent commits them) or from anywhere else. They can only
add warnings or blocks. They can never turn a block into a pass.

## The report

`--json` prints `vcv-gate-1`:

| Field | Meaning |
|---|---|
| `decision`, `headline` | `pass` / `warn` / `block`, and one line for a check summary |
| `base`, `candidate`, `change` | Commits, merge base, the candidate's identity digest. `change.kind` is `code-first`, `model-first`, `model-and-code` or `no-change` |
| `policy` | Its source, digest, whether the candidate changes it, and the effective settings |
| `reasons` | One entry per blocking or warning outcome, ordered with blocks first: `code`, `rule` (the policy setting that decided it), `basis` (`checked` / `observed` / `not-checked` / `claim`), and as many of `criterionId`, `objectIds`, `test` (file and full title), `bindingId`, `path` and `observationId` as apply |
| `criteria` | Every criterion's verification, result, provenance and `verifies` |
| `runs` | Each run: host-observed or claimed, fresh or stale (and why), the ordinary suite summary |
| `observations` | The agent observations with what VCV verified about each |
| `reconciliation` | The M4.1 summary and the integrity state, or null when the model could not be loaded |

Lists are bounded: 300 reasons, 200 criteria, 50 observations. The report as a whole fits in
512 KiB. Every cut is flagged, and `reasonsTotal` counts every reason. The decision is made before
anything is cut, and it covers every criterion: if the criteria report had to be cut, the gate
evaluates the remaining criteria in batches. The checkout's path never appears in the report. The
same candidate gives the same JSON.

The gate reads everything it depends on first: the candidate's identity, every file in `.vcv/`
(attestations and trust list included), the candidate's copy of the policy file, and every cited
file. It reads them again after the history check, again after the test results, and once more
before answering. If anything moved, it answers `STATE_CHANGED` (exit 2) instead of a decision. If
the store cannot be read whole (an unreadable entry, more than 50,000 entries, 32 levels or 256 MiB),
it answers `SOURCE_IDENTITY_UNAVAILABLE` (exit 2): it never decides on a partly observed store. The
policy is applied to every finding before any list in the report is cut, so adding lower-severity
findings can never push a blocking one out of view.

## Not established here

- That a passing test checks the right thing. A mapping is an agent's or a person's claim, and the PR
  reviewer judges test changes.
- That an agent observation is true or false.
- Branch protection itself. VCV documents the required check; the repository's settings enforce it.
- A demonstration on a real code-first PR. That is M4.5, on Course Desk.
