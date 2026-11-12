# Per-test runner evidence (M4.3)

M4.3 ([Issue #22](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/22)) answers, for each
approved acceptance criterion: did every test case mapped to it ([criteria.md](criteria.md)) run on
**this exact candidate** and pass?

VCV runs no tests. The host (CI, or a person at a shell) runs the project's ordinary runner with
its JUnit XML reporter. VCV reads that report strictly and binds it to the candidate it describes.

Design notes: [ADR 0009, M4.3 decisions](adr/0009-pre-merge-reconciliation.md#m43-decisions).

## The flow

```sh
# 1. The candidate's identity, read before the run.
BEFORE=$(vcv tests identity . --json | jq -r .identityDigest)

# 2. The project's own runner, with a per-case machine-readable report, written OUTSIDE the checkout.
(cd server && npx vitest run --reporter=junit --outputFile="$RUNNER_TEMP/junit.xml")

# 3. Capture the report HERE and evaluate it in the same process: the host-observed path.
vcv criteria . --junit "$RUNNER_TEMP/junit.xml" --root server \
  --runner vitest --runner-version 5.1.0 --invocation "npx vitest run --reporter=junit" \
  --before "$BEFORE" [--coverage coverage/coverage-summary.json]

# Or keep the record as a file (for an agent, an artifact, a later look). Read back, it is a claim.
vcv tests capture . --junit "$RUNNER_TEMP/junit.xml" --root server --runner vitest \
  --invocation "npx vitest run --reporter=junit" --before "$BEFORE" --out "$RUNNER_TEMP/test-run.json"
vcv criteria . --run "$RUNNER_TEMP/test-run.json"
```

`--root` is the directory the runner's paths are relative to. Vitest run in `server/` reports
`src/enrollment/enrollment.service.spec.ts`, so the root is `server`. A case is then matched to a
mapping by its repository path and full title (`Suite > case`), which is exactly the mapping's
`#test:` locator. Jest (with jest-junit), pytest `--junitxml` and Maven Surefire emit the same
format. Check that their `classname` or `file` is the test file's path.

Write the report and the record outside the checkout. A new untracked file inside it changes the
candidate's identity, and capture is refused as `TEST_RUN_RACED`.

## What a test-run record binds

| Field | Meaning |
|---|---|
| `candidate` | Git commit, branch, the bytes of every uncommitted path, the bytes of every **bound** path (each file a binding claim points at, including files Git ignores and the in-checkout targets of links), model revision, and the digest of the binding claims. `identityDigest` is the digest of all of it. |
| `observedBy` | What the capturing caller **declared**: `host` when it held the `tests:observe` permission, otherwise `agent`. A declaration, never trusted on its own (below). |
| `runner`, `invocation`, `root` | As the caller states them. |
| `report` | Format, sha256 and size of the exact report bytes. |
| `cases`, `summary`, `duplicates` | Every case: path, title (cut at 300 characters, with a digest), status `passed` / `failed` / `error` / `skipped`, and the failure message (cut at 500). |
| `digest` | sha256 of the canonical record. It catches accidental edits. It is **not** a signature. |

A record is data. Anyone who can write a file can write one that says `observedBy: host` and
recompute its digest. So the criteria report decides provenance itself:

- **host**: the record object was returned by `captureTestRun` in this same process, for a caller
  holding `tests:observe`, and has not changed since (`isTrustedCapture`). On the CLI this means
  `vcv criteria --junit …`. The pre-merge gate (M4.4) captures this way, in its own trusted job.
- **claimed**: everything else. That covers every imported record (`--run`, parsed JSON, a copy),
  whatever it declares and whoever captured it, and every agent capture. `declaredObservedBy` and
  `admittedAs: "imported"` show what it said about itself.

Trust never comes from a principal string, an environment label, a JSON field or a digest that
anyone can recompute.

A capture is refused (`SOURCE_IDENTITY_UNAVAILABLE`) when the candidate's source cannot be
identified exactly:

- the checkout has no Git commit;
- Git fails to list the uncommitted files (a failed read is never taken as a clean tree);
- the uncommitted or bound files exceed what is hashed (5,000 files / 512 MiB), where sizes and
  mtimes would stand in for content;
- an uncommitted or bound file, a claim file, or the claim store cannot be read, including a file
  under a directory that cannot be listed;
- an uncommitted or bound path goes through a link that leaves the checkout or cannot be resolved.
  VCV does not read outside the checkout, so it cannot say what such a run tested.

A file that is simply missing (deleted, or a link to a missing file inside the checkout) is a known
state, not a problem.

Git does not see an ignored file, or a change to the target of a tracked link. When such a file is
bound (the claimed implementation of a model object, or a mapped test), its bytes are part of the
identity, so editing it makes every earlier run stale. Other ignored files are not part of the
identity. Keep code that tests depend on either tracked or bound.

For the same reasons, a run is never fresh against such a candidate, nor when the record's own
identity is incomplete. A record that would be larger than the 16 MiB VCV reads back is refused
(`REPORT_TOO_LARGE`), so a capture never produces a file `--run` cannot read. The CLI checks
every file's size before reading it.

## Reading the report strictly

The reader accepts the subset of XML that JUnit reports use. It refuses:

- a DOCTYPE or any entity declaration, so a report cannot expand or include anything;
- malformed or truncated XML;
- unknown entities and invalid UTF-8;
- a runner path that is not already a portable relative path (absolute, drive letter, UNC, `\`, `.`
  or `..` segments). It is refused as written, never normalized into a path that could alias a
  mapped case;
- more than 16 MiB, 20,000 cases, 250,000 elements or nesting deeper than 32.

Every declared count (`tests`, `failures`, `errors`, `skipped`, per suite and for the root) must
match the cases present. A report with a case cut out, or a failure deleted without fixing its
totals, is refused as `REPORT_INCONSISTENT`. These checks catch accidents and careless edits. They do
not catch a deliberate forgery with consistent numbers; that is what provenance is for.

## Per-criterion results

`vcv criteria --run` (`criteriaEvidence(path, { runs, coverage? })`) checks each record (shape,
digest, summary; otherwise `RUN_INVALID`). It then compares each record with the candidate now. A
run is **fresh** only if the commit, the uncommitted bytes, the model revision and the claims all
match. Otherwise `staleBecause` says what differs.

Each test-case mapping gets a `result`:

| Status | When |
|---|---|
| `passed`, `failed`, `error`, `skipped` | the worst status of that case across the fresh runs |
| `not-run` | the case is in no fresh run (a filtered invocation, a renamed test) |
| `stale` | no run is fresh, so the only results describe another candidate |
| `ambiguous` | a fresh run reports the same identity twice |

Each criterion then gets a `result`:

| Result | When |
|---|---|
| `passed` | every mapped case passed in a fresh run, every mapping resolves, the assessment is complete |
| `failed` | some mapped case failed or errored. `TEST_FAILED` / `TEST_ERRORED` name the exact case and message |
| `stale` | results only from another candidate (`RESULT_STALE`), or a mapping is stale |
| `missing` | no mapping, or a mapped case was skipped, not run or ambiguous (`TEST_SKIPPED`, `TEST_NOT_RUN`, `RESULT_AMBIGUOUS`) |
| `unknown` | some claim files could not be read |
| `unverified` | no runs were supplied |

`resultObservedBy` is `host` when every passing result comes from a run captured here for a trusted
caller. Otherwise it is `claimed`, with `RESULT_CLAIMED`.

The report also lists each run (provenance, runner, freshness, the ordinary suite summary, `green`)
and counts the results for required and optional criteria. It adds two notes for the cases that
are easy to misread:

- `SUITE_GREEN_REQUIRED_NOT_PASSED`: the suite is green, but a required criterion has no passing
  result for every mapped case. A green `npm test` never stands in for a missing, skipped or
  failed mapped case.
- `COVERAGE_IS_NOT_CRITERION_COVERAGE`: `--coverage` (an Istanbul `json-summary`) reports high line
  coverage while required criteria are not verified. Coverage is supporting context only, and is
  never counted as criterion evidence.

## Not established here

- That a passing test checks the right thing. A mapping is an agent's claim (M4.2).
- That an agent-claimed run happened as described.
- A merge decision. The configured pass / warn / block policy and the trusted check are M4.4.
