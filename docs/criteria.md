# Acceptance criteria and test-case mappings (M4.2)

M4.2 ([Issue #22](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/22)) lets the
approved model say what must be true, and lets agents say which individual test cases check it.
These two things have different authority, so they are stored separately:

| | Where it lives | Who changes it | What a change needs |
|---|---|---|---|
| **Criterion** (intent) | the model: `criteria` in `.vcv/revisions/*.yaml` | a typed proposal (`createCriterion`, `reviseCriterion`, `removeObject`) | a separate human approval, as for every model change (M3) |
| **Mapping** (evidence) | a `tests` binding claim: `.vcv/bindings/<id>.json` | an agent or a person, with `vcv binding add` / `reassert` | nothing more. Reasserting after a test is renamed does not move `.vcv/HEAD` |

A mapping is a claim that a test case checks a criterion. It is not a test result (runner evidence
is M4.3), and it does not show that the test is enough.

Design notes: [ADR 0009, M4.2 decisions](adr/0009-pre-merge-reconciliation.md#m42-decisions).

## A criterion

```yaml
criteria:
  - id: crt-full-course
    kind: criterion
    owner: mod-enrollment
    name: Full course is rejected
    statement: A full course is rejected with COURSE_FULL and the student is notified.
    verifies: [rul-seat-limit, cap-enroll]
    verification: required
```

- `statement` is one observable behaviour or invariant, in plain words (up to 2000 characters).
- `verifies` lists 1 to 20 objects the criterion is about: capabilities, rules, contracts, events,
  behaviours, transitions, data or modules. Each ref must exist.
- `verification` is `required` or `optional`. It is policy, so changing it is a model change.

A model with no criteria has no `criteria` key. This keeps every model written before M4.2, and
its revision ID, exactly as it was.

Propose one like any other model change:

```yaml
changeId: chg-full-course-criterion
projectId: prj-course-desk
expectedRevision: rev-3
operations:
  - type: createCriterion
    criterion: { id: crt-full-course, kind: criterion, owner: mod-enrollment, name: Full course is rejected,
                 statement: "A full course is rejected with COURSE_FULL and the student is notified.",
                 verifies: [rul-seat-limit], verification: required }
  # later: change only what changed
  # - type: reviseCriterion
  #   criterionId: crt-full-course
  #   verification: optional
```

## Mapping a test case

A criterion takes only `tests` claims that name one test case, by file and full title (outermost
suite first, joined with ` > `):

```sh
vcv binding add . --object crt-full-course --relation tests --source agent \
  --locator 'server/src/enrollment/enrollment.service.spec.ts#test:EnrollmentService > rejects an enrollment into a full course and notifies the student' \
  --rationale "asserts COURSE_FULL and the notification"
```

Any other relation or selector on a criterion is refused with `INVALID_CLAIM`. Test names longer
than 1000 characters are refused too. Add one claim per (criterion, test case) pair: a test can
check several criteria, and a criterion can need several tests.

## Reading the evidence

```sh
vcv criteria .                    # every criterion
vcv criteria . crt-full-course    # some of them
vcv criteria . --json             # the full report (format vcv-criteria-1)
```

For each criterion, the report gives its statement, policy and `verifies`, and every mapping as
`verifyBinding` sees it now. `mapping` is `none`, `resolved` (every mapping resolves and is fresh),
`partial`, `unresolved` or `unknown` (the claims could not be read). The problems are:

| Code | When |
|---|---|
| `NO_MAPPING` | no test case is mapped |
| `TEST_MISSING` | the test no longer resolves: renamed, moved or removed. Reassert the mapping to the test that now checks the criterion |
| `TEST_AMBIGUOUS` | the title matches more than one test case in the file |
| `TEST_CHANGED` | the test's code changed since the mapping was claimed (comment-only edits do not count) |
| `CRITERION_CHANGED` | the criterion was revised since the mapping was claimed. Check the test still matches, then reassert |
| `MAPPING_NOT_CHECKED` | the mapping could not be checked (e.g. claimed at a revision from another branch) |
| `DUPLICATE_MAPPING` | two claims map the same test case to the criterion |
| `NOT_A_TEST_MAPPING` | a hand-written claim on the criterion that is not a test-case claim |
| `MAPPING_INVALID` | a claim file about the criterion cannot be read, or the claim store cannot be read at all |

The report also has a many-to-many `tests` index (each mapped test case and its criteria) and
counts: `requiredUnmapped`, `requiredNotResolved`, `optionalUnmapped`. When `.vcv/bindings/` cannot
be read, `mappingsAvailable` is false and every criterion is `unknown`, never `none`.

The read is one observation: if the store, a claim file or a mapped test file changes while it
runs, the answer is `STATE_CHANGED`. Lists are bounded (200 criteria, 50 mappings each, 500 tests).
Long test names are cut to 300 characters, with the sha256 of the full name. The checkout's path
never appears.

In `vcv reconcile`, a criterion the candidate adds or revises without a mapping gives
`OBJECT_UNBOUND` ("no test case is mapped to it").

## Not established here

- Whether any mapped test passed. That is runner evidence (M4.3).
- Whether a test is enough to show the criterion holds. That stays an agent's or a person's
  judgement.
- A pre-merge decision. The gate is M4.4.
