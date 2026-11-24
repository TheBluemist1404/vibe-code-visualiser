# Recorded run: the M5.7 acceptance walkthrough

One run of [`examples/reference-app/acceptance/`](../../../examples/reference-app/acceptance/) on
2026-11-24, from a fresh clone of the real Course Desk at
[`5d966ed`](https://github.com/TheBluemist1404/course-desk/commit/5d966ed599e401cd92a04436245998e1aca6a57b).
How it works and what it shows are explained in [docs/acceptance.md](../../acceptance.md). In the
files, `<repo>` is the owner's checkout, `<agent>` the agent's clone and `<work>` the run's work
directory.

**The approval in this run is a TEST-ONLY fixture signature (`user:fixture-reviewer`). It is not
the owner's approval.** Against the real repository's trust list it fails
([integrity/owner-anchor.txt](integrity/owner-anchor.txt)).

## Result

[summary.txt](summary.txt): every step ran, and every verdict matched what the step expected.

| | Commit | What |
| - | ------ | ---- |
| upstream | `5d966ed` | Course Desk `main`, rev-4, approved by `user:hoang` |
| test base | `test-base` (local, new each run) | adds the fixture reviewer to the trust list; the gate's base and the trust anchor |
| 1 | `vcv: propose chg-full-course-notice` | agent:coder, 7 operations, digest `ad613a3d7d4a…` |
| 2 | `vcv: approve chg-full-course-notice` | fixture reviewer → `rev-5-6a1f0d8df2df` |
| 3 | `feat: announce full-course rejections` | agent:coder: `enroll()`, unit and e2e tests, README, smoke |
| 4 | `vcv: reassert claims and record the implementation` | agent:coder: 9 claims, the report |

The proposal digest and the resulting revision are the same in every run: both derive from content,
not from keys, times or commit IDs.

| Gate | On | Suite | Verdict | File |
| ---- | -- | ----- | ------- | ---- |
| 0 | the test base | 8/8 | **PASS**, 2/2 required host-observed | [gate](gate/0-base/gate.txt) |
| 1 | approved, not implemented | 8/8 green | **BLOCK** `CRITERION_STALE`: the green test still asserts the old behaviour | [gate](gate/1-approved/gate.txt) |
| 2 | implemented, claims not updated | 8/8 green | **BLOCK** `TEST_NOT_RUN` ×3, `EVIDENCE_REQUIRED`, `LOCATOR_MISSING` | [gate](gate/2-implemented-claims-stale/gate.txt) |
| 3 | implemented, claims reasserted | 8/8 | **WARN, passes**: 2/2 required host-observed; `UNMAPPED_CHANGES`, 5× `MAPPING_CHANGED` | [gate](gate/3-implemented/gate.txt), [reconcile](gate/3-implemented/reconcile.txt) |
| UI | the same candidate on the explorer's pre-merge page | (record handed in) | **Blocked** `RESULT_CLAIMED`: a run given to the explorer is a claim | [ui/evidence.json](ui/evidence.json) |

## Files

- **Browser** (what each phase asserted): [explore](ui/explore.json), [draft](ui/draft.json),
  [draft file before the restart](ui/draft-before-restart.json), [recover](ui/recover.json),
  [inbox](ui/inbox.json), [approve](ui/approve.json), [evidence](ui/evidence.json),
  [states](ui/states.json).
- **Handoff** exported by the owner: [change](handoff/change.json), [metadata](handoff/metadata.json).
- **Agent**: [own draft](agent/own-draft.json) and [its dry run](agent/own-draft-preview.txt),
  [integration note](agent/integration.md), [proposal](agent/proposal.json) and
  [its dry run](agent/preview-file.txt), [submit](agent/submit.txt),
  [refused self-approval](agent/self-approve.txt), [handoff](agent/handoff.json),
  [source diff](agent/source.diff), [its own checks](agent/agent-checks.txt),
  [reassertions](agent/reassert.txt), [report](agent/report.json),
  [record](agent/implementation-record.txt), [show](agent/implementation-show.txt).
- **Review**: [the owner's CLI preview](review/preview.txt), [the fixture approval](ui/approval.txt).
- **Integrity**: [against the test base](integrity/test-anchor.txt) (ok),
  [against the owner's real anchor](integrity/owner-anchor.txt) (fails, as required).

## Screenshots

The run's 19 screenshots are not committed; they are in the `m5.7-acceptance` artifact of the CI
job `acceptance` (`shots/`), named by step:

01 overview · 02 Enrollment selected · 03 followed to Notifications · 04 Web pinned ·
05 draft staged · 06 draft recovered after restart · 07 handoff export · 08–09 inbox, pending ·
10 inbox, applied · 11 model changed, draft stale · 12 branch switch, draft current ·
13 implementation · 14 rule evidence · 15 criterion evidence · 16 pre-merge page ·
17 empty, invalid, conflicted.
