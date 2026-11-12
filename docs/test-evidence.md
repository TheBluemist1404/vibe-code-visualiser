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

# 3. Bind the report to the candidate.
vcv tests capture . --junit "$RUNNER_TEMP/junit.xml" --root server \
  --runner vitest --runner-version 5.1.0 --invocation "npx vitest run --reporter=junit" \
  --before "$BEFORE" --out "$RUNNER_TEMP/test-run.json"

# 4. Per-criterion results.
vcv criteria . --run "$RUNNER_TEMP/test-run.json" [--coverage coverage/coverage-summary.json]
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
| `candidate` | Git commit, branch, the digest of every uncommitted path's bytes, model revision, and the digest of the binding claims. `identityDigest` is the digest of all of it. |
| `observedBy` | `host` when the caller holds the `tests:observe` permission (the host itself ran the runner and read the report). Otherwise `agent`: an agent says it ran the tests. |
| `runner`, `invocation`, `root` | As the caller states them. |
| `report` | Format, sha256 and size of the exact report bytes. |
| `cases`, `summary`, `duplicates` | Every case: path, title (cut at 300 characters, with a digest), status `passed` / `failed` / `error` / `skipped`, and the failure message (cut at 500). |
| `digest` | sha256 of the canonical record. It catches accidental edits. It is **not** a signature. |

A record is data. It says who captured it, not that what it says is true. Anyone who can write
files can write one that claims `observedBy: host`. That is why the pre-merge gate (M4.4) accepts
host evidence only from a capture made in its own trusted job, never from a record the candidate
supplies.

## Reading the report strictly

The reader accepts the subset of XML that JUnit reports use. It refuses:

- a DOCTYPE or any entity declaration, so a report cannot expand or include anything;
- malformed or truncated XML;
- unknown entities, invalid UTF-8, and unsafe or escaping case paths;
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

`resultObservedBy` is `host` when the passing results come from host runs. When some passes are
agent-claimed it is `agent`, with `RESULT_AGENT_CLAIMED`.

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
