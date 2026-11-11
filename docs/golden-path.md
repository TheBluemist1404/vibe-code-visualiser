# The model-first golden path on Course Desk (M3.4)

The end-to-end demonstration for [Issue #17](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/17).
A user's request becomes an approved architectural change and then an implementation, on a fresh,
standalone checkout of the Course Desk reference app. Each step is done by a different party:

| Step | Who | With | Result |
| ---- | --- | ---- | ------ |
| 0. Baseline | the fixture | `golden-path/setup.sh` | `main`: Course Desk, `.vcv/` from the M2.3 agent draft, binding claims, the reviewer trust list, and an approved baseline (`chg-baseline`, `approveDraft`, signed by the reviewer) |
| 1. Propose | a fresh coding agent, `agent:proposer` (`model:propose` only) | `golden-path/propose.sh` | a typed proposal with an implementation request, **pending**; `.vcv/HEAD` unchanged |
| 2. Review | a separate reviewer, `user:reviewer` (**simulated**) | `golden-path/review.sh show`, then `approve <digest>` | the exact reviewed digest approved; new canonical revision, change record and signed attestation committed on the feature branch |
| 3. Implement | a second fresh coding agent, `agent:implementer` (`model:propose`, `binding:record`) | `golden-path/implement.sh` | source and tests across Enrollment, Notifications and Web; claims reasserted through VCV; implementation report recorded; one commit with code and `.vcv/` |
| 4. Verify | the host | `golden-path/verify.sh` | host authorization gate, model per checkout (feature, main, simulated merge), negative paths |
| 5. Assess | a third fresh agent, read-only | `golden-path/evaluate.sh` | an independent assessment of the run |

The recorded run is in [docs/samples/m3.4-golden-path/](samples/m3.4-golden-path/README.md).

## The change

The request is in [request.md](../examples/reference-app/golden-path/request.md). In short: a
rejection notification should carry the machine-readable reason (`COURSE_FULL`,
`ALREADY_ENROLLED`) as its own field, and the web page should show it. It is cross-module on
purpose. Notifications owns the data, Enrollment owns the rule that sends notifications, and Web
shows them. The request names no model objects. The proposing agent decides what it means for the
model.

## Running it

Running it needs Node 22.22.2+, `npm ci` in this checkout, and, for the agent steps, the `claude` CLI
signed in.

```sh
work=$(mktemp -d); out=my-run
examples/reference-app/golden-path/propose.sh   "$work" "$out"   # fresh proposer agent
examples/reference-app/golden-path/review.sh    "$work" "$out" show
# read the preview; if you approve it:
examples/reference-app/golden-path/review.sh    "$work" "$out" approve <digest>
examples/reference-app/golden-path/implement.sh "$work" "$out"   # fresh implementer agent
examples/reference-app/golden-path/verify.sh    "$work" "$out"
examples/reference-app/golden-path/evaluate.sh  "$work" "$out"   # optional independent assessment
```

The steps are separate commands on purpose. Nothing starts the next one. Approval does not start
the implementer; the person invokes it. Without an agent, the recorded run can be reproduced from a
fresh checkout and a fresh reviewer key:

```sh
examples/reference-app/golden-path/replay.sh "$(mktemp -d)" --app-tests
```

`replay.sh` submits the recorded proposal as `agent:proposer`. It approves the digest it previewed,
and checks that this is the recorded digest. It applies the recorded source diff and remakes the
recorded claims through `vcv binding reassert`/`add` as `agent:implementer`, then records the
recorded report and commits. Finally it runs the app's own checks and `verify.sh`. CI runs it in the
`reference-app` job. The resulting revision ID is the recorded one (`rev-3-…`), because revision IDs
derive from content, not from keys or time.

## The agents' sandbox

Both agents run as fresh, headless Claude Code sessions, as in M2.3 and M2.5. Each gets:

- an empty `HOME` and a scrubbed environment;
- no MCP and no web;
- a toolkit copy of the engine and the guides (no examples, tests, samples or oracle);
- a `vcv` on its `PATH` whose identity is fixed by the host (`VCV_HOST_PRINCIPAL` /
  `VCV_HOST_PERMISSIONS`), so `--as`/`--perm` are refused and `review approve` refuses to run at
  all.

Its tools are denied this VCV checkout, the reviewer's key directory, writes under `.vcv/`, and
`git commit`, `checkout`, `reset`, `stash`, `apply` and `merge`.

The proposer may write only its notes, which live outside the checkout. The implementer may also
edit `server/` and `web/`. Its shell allows `vcv`, the app's `npm test`, `typecheck` and `build`,
and read-only Git.

## What it demonstrates

- **Order.** The Git history of the feature branch is: approved baseline (main), then
  `vcv: approve <id> (reviewed proposal digest …)`, then the implementation commit. The approval
  commit holds only `.vcv/`. The implementation commit holds the source, the tests, the reasserted
  claims and `.vcv/implementations/<id>.json`. The change record's `proposerId` is
  `agent:proposer` and its `approverId` is `user:reviewer`. The attestation signs the proposal
  digest the reviewer previewed.
- **Responsibility.** The agents' own approval attempts are denied (`1-propose/agent-approve-attempt.txt`).
  The hash diff after proposing shows only the new pending change record. After implementing it
  shows only source files, two claim files and the report.
- **Git is the model's source of truth.** On the feature branch, `vcv project status` reports the
  approved revision. On `main` it reports the old one. After a simulated local merge it reports the
  new one, with nothing regenerated. `vcv integrity` on the merged checkout, against the old main
  and its trust list, is ok.
- **The host gate.** `scripts/vcv-host-gate.sh` (trusted CLI, candidate as data, base and trust
  list from main's commit ID) accepts the feature branch.
- **Negative paths.** Each runs in a throwaway clone, with its expected outcome and reason checked
  (`4-verify/negative-paths.md`):
  - The proposer cannot approve, cannot pass `--as`/`--perm`, and cannot run `review approve`.
  - A `model:apply` shortcut only records a pending change.
  - These are rejected:
    - a stale `expectedRevision`;
    - a missing reference;
    - an invariant violation;
    - a replayed change ID.
  - Pending and rejected proposals leave HEAD and the revisions unchanged.
  - These approvals fail:
    - self-approval;
    - an untrusted key;
    - a digest that was not reviewed.
  - These all fail the host gate:
    - a hand-made revision with an edited HEAD;
    - a forged applied record;
    - an edited approved revision;
    - a missing attestation.
  - A failed test, an unknown criterion and an out-of-scope edit are reported as warnings, and a
    second report without `--expect` is refused.

## What it does not demonstrate

- **The reviewer is simulated.** The reviewer's key is a file on the same machine as the agents.
  It is outside the checkout and denied to their tools, but it is readable by the same OS user, and
  the decision is made by whoever runs `review.sh approve`. In the recorded run, that was the
  operator of the run, a Claude Code session that took part in neither agent session. This shows the
  protocol and its checks. It is not a production trust boundary. The authorization is the host's
  integrity gate on a protected base (docs/approvals.md).
- **The agents' claims are claims.** The tests the implementer reports, its acceptance statuses
  and its reassertions are its own account. VCV records them as such and ran nothing. The host's
  own run of the app's checks (`3-implement/host-checks.txt`) is a separate observation, and passing
  tests do not mean VCV proved behaviour.
- **Only affected claims are checked.** The implementation report checks the claims on objects
  the approved change touched or structurally impacts. A claim on another object whose code also
  changed is not a warning there. In the recorded run, `vcv evidence refresh` shows three such
  claims as stale: `impl.cap-enroll`, `impl.rul-seat-limit` and `test.rul-seat-limit`, because
  `enroll()` and its spec changed. The implementing agent reported two of them and missed
  `impl.cap-enroll`; the independent assessment caught it. Catching this is M4's reconciliation.
- **No reconciliation.** Nothing here establishes that the code implements the model (M4).
