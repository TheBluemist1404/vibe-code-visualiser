# Recorded run: the model-first golden path (M3.4)

One run of [docs/golden-path.md](../../golden-path.md) on 2026-11-11, in this order. Paths are
scrubbed: `<repo>` is the Course Desk checkout, `<work>` the run's work directory, `<keys>` the
reviewer's key directory, `<notes>` the agents' notes directory (outside the checkout).

The agents were fresh headless Claude Code sessions (`claude-sonnet-5-5`, Claude Code 2.1.322).
Each audit of the agents' tool calls (the `transcript.md` files) found no access to the VCV
checkout or the oracle.

| # | Step | Files |
| - | ---- | ----- |
| 0 | Baseline on `main`: draft model, eight claims, the reviewer trust list, then `chg-baseline` (`approveDraft`) proposed by `agent:bootstrap` and approved by `user:reviewer` → `rev-2` [approved] | [0-setup.txt](0-setup.txt) |
| 1 | **User request** → fresh proposer agent (`agent:proposer`, `model:propose`) reads the model, the evidence and the code, writes a typed change with an implementation request, previews and submits it → `chg-notification-rejection-reason` **pending**, digest `eb632d5c…`; `.vcv/HEAD` unchanged | [prompt](1-propose/prompt.txt), [transcript](1-propose/transcript.md), [change.yaml](1-propose/agent-notes/change.yaml), [notes](1-propose/agent-notes/proposal-notes.md), [record](1-propose/change-records/chg-notification-rejection-reason.json), [hash diff](1-propose/hash-diff.txt), [denied approval attempts](1-propose/agent-approve-attempt.txt) |
| 1b | **Pre-approval impact and diagnostics**: 4 operations, cross-module (Enrollment, Notifications, Web), 2 claims to revisit, no diagnostics | [preview.txt](1-propose/preview.txt) |
| 2 | **Separate reviewer** (`user:reviewer`, **simulated**) reads the preview, records a decision, approves exactly that digest with the key, trust list pinned to main's commit → `rev-3-a5c764161201`, change record applied, attestation signed; committed (`.vcv/` only) | [decision](2-review/decision.md), [approve output](2-review/approve.txt), [commit](2-review/approval-commit.txt) |
| 2b | **Handoff** derived for the implementer | [handoff.json](2-review/handoff.json) |
| 3 | **Explicit implementation**: fresh implementer agent (`agent:implementer`, `model:propose` + `binding:record`) changes 9 source and test files in 3 modules, reasserts the 2 flagged claims through VCV, runs typecheck and tests, records its report. The host then runs the app's checks itself (typecheck, 9 + 3 tests, build, smoke: pass) and commits source, tests and `.vcv/` together | [prompt](3-implement/prompt.txt), [transcript](3-implement/transcript.md), [source.diff](3-implement/source.diff), [report.json](3-implement/agent-notes/report.json), [VCV's report](3-implement/implementation-show.txt), [host checks](3-implement/host-checks.txt), [claims before](3-implement/bindings-before.txt)/[after](3-implement/bindings-after.txt), [commit](3-implement/implementation-commit.txt) |
| 4 | **Reopen and verify**: host gate ok; feature sees `rev-3`, main `rev-2`, a simulated merge `rev-3` without regeneration; 21 negative paths as expected | [host gate](4-verify/host-gate.txt), [branch views](4-verify/branch-views.txt), [git log](4-verify/git-log.txt), [evidence now](4-verify/evidence-refresh.json), [negative paths](4-verify/negative-paths.md) |
| 5 | **Independent assessment** by a third fresh, read-only agent | [5-independent-assessment.md](5-independent-assessment.md) |

Raw stream transcripts are kept next to the condensed ones (`transcript.jsonl`).

## Findings

- **The order and the responsibility boundaries hold, and can be reconstructed from the files.**
  - The proposal was pending before any approval.
  - The approval commit names the reviewed digest. The change record has proposer
    `agent:proposer` and approver `user:reviewer`.
  - The implementer's `baseCommit` is the approval commit.
  - One implementation commit carries source, tests, claims and the report.
  - The agents' own approval attempts were denied.
- **The proposal was right.** The independent assessment scored it 9/10:
  - a nullable `reason` on `dat-notification`, typed as a string so that Notifications gains no
    dependency on Enrollment;
  - the notification rule restated;
  - the web capability described;
  - a testable implementation request.
- **One looseness in the model wording.** `nullable: true` versus the code's absent property.
- **The implementation was correct and in scope.** It scored 8/10, with these gaps:
  - `ALREADY_ENROLLED` is tested only at the service level.
  - The server types `reason` as `string` while the web client uses a union, a hand-duplicated
    contract (oracle F4.4).
  - `notify()` does not tie `reason` to `kind`.
- **Reporting was honest, with one omission.** The implementer reported two stale claims outside
  the change (`impl.rul-seat-limit`, `test.rul-seat-limit`) and missed a third
  (`impl.cap-enroll`). VCV's implementation report does not warn about claims on objects the
  change did not affect. That gap is left to M4.
- **Limits.**
  - The reviewer is simulated: the operator of the run, with a local key.
  - The agents' test results and acceptance statuses are their claims. The host's run of the
    checks is a separate observation.
  - Nothing here reconciles the code with the model.

To reproduce without agents: `examples/reference-app/golden-path/replay.sh "$(mktemp -d)" --app-tests`.
It yields the same proposal digest and the same `rev-3-a5c764161201`.
