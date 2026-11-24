# The M5 acceptance walkthrough on Course Desk (M5.7)

The end-to-end workflow check for [Issue #46](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/46),
the last slice of M5 ([Issue #39](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/39)).
It runs on the real [Course Desk](https://github.com/TheBluemist1404/course-desk) repository, not
a fixture made for the test. The owner works in the explorer, a coding agent works in its own clone,
a **test-only** reviewer signs in a separate process, and the pre-merge gate runs at each step.

It is an engineering package for the architecture reviewer. It adds no product features. It decides
nothing on the reviewer's behalf, and its fixture signature is not the owner's approval.

The recorded run, with every gate output and the agent's notes, is in
[docs/samples/m5.7-acceptance/](samples/m5.7-acceptance/README.md). The CI job `acceptance` runs
the same scripts on every pull request and uploads the run, including its screenshots, as the
`m5.7-acceptance` artifact.

## Who does what

| Role | Process and place | Identity | Can | Cannot |
| ---- | ----------------- | -------- | --- | ------ |
| Owner | the explorer (`apps/ui`, its own process) on `<work>/course-desk`, driven by [`walkthrough.ts`](../examples/reference-app/acceptance/walkthrough.ts) in Chromium, as OS user `vcv-acc-workspace` | the person at the screen | explore, pin, stage a local draft, export the handoff, read the inbox, evidence and pre-merge pages | submit, approve, write `.vcv/` (the explorer has no route for any of these) |
| Coding agent | [`agent.sh`](../examples/reference-app/acceptance/agent.sh) in its **own clone**, `<work>/agent/course-desk`, as OS user `vcv-acc-workspace` | `agent:coder`, fixed by `VCV_HOST_PRINCIPAL` (`model:propose`, `binding:record`) | integrate, submit a proposal, change code and tests, reassert claims, record its report | approve (refused, see below); `--as`/`--perm` (refused); read the reviewer key or the explorer's state |
| Fixture reviewer | [`reviewer.sh`](../examples/reference-app/acceptance/reviewer.sh), as OS user `vcv-acc-reviewer`, in its own clone `<work>/reviewer/course-desk` | `user:fixture-reviewer` (**TEST ONLY**) | open the key; preview, then sign one exact digest against the pinned test base; commit the approval in its clone | run as any other OS user or under an agent identity (it refuses) |
| Host | [`premerge/ci.sh`](../examples/reference-app/premerge/ci.sh): identity, then the app's own Vitest, then `vcv gate`, as OS user `vcv-acc-workspace` | the trusted CLI | capture the run it started (host-observed) and decide by the base's policy | run the candidate's code next to the verifier |

The agent's decisions are recorded work, replayed: [`agent/`](../examples/reference-app/acceptance/agent/)
holds its own earlier draft, its integration (`integrate.mjs`), its code and test edits
(`implement.mjs`), the claims it reasserts and its report. They were written by the Claude Code
session that built M5.7, acting as `agent:coder`, as the M4.5 coding agent was. A replay is
reproducible in CI. It is not a fresh, independent agent session.

## The trust setup

- **Upstream:** Course Desk `main` at
  [`5d966ed`](https://github.com/TheBluemist1404/course-desk/commit/5d966ed599e401cd92a04436245998e1aca6a57b),
  rev-4, approved by the owner (`user:hoang`). Its `.vcv/reviewers.json` lists only the owner.
- **Test base:** one local commit, `test-base`, adds the fixture reviewer's public key **next to** the
  owner's. It is the protected base of this rehearsal only. The gate, `vcv integrity`, the reviewer's
  `--trust-commit` and the explorer's `--protected-base`/`--base-commit` are all pinned to it. It is
  never pushed.
- **The key is behind an OS boundary.** `setup.sh` (as root) creates two users with no sudo and no
  group in common. `vcv-acc-reviewer` creates the key in `<work>/reviewer/key/` (mode 0700, file 0600,
  its own), and only the public entry leaves that directory. Everything else runs as
  `vcv-acc-workspace`: the explorer host and its browser, the agent, the owner's Git and the gate.
  The kernel refuses that user the key (`EACCES`). The run checks this three ways before any step
  ([integrity/key-isolation.txt](samples/m5.7-acceptance/integrity/key-isolation.txt)):
  - the workspace cannot read the key;
  - the workspace has no sudo;
  - the reviewer can read its own key.

  Every browser phase also opens the key from the explorer's process and requires `EACCES`, and it
  records the user IDs of a host process it starts (`keyIsolation` in `ui/*.json`). `agent.sh`
  refuses to continue if it can open the key. The orchestrating scripts run as root only to start
  each context as its user; root is the machine's administrator, so this is a boundary between the
  contexts, not against root.
- **The fixture approval is not the owner's.** The run checks the approved branch against the real
  repository's trust anchor (`5d966ed`) and requires it to fail. It does:
  `APPROVAL_NOT_ATTESTED … approval untrusted-key: key … is not listed for user:fixture-reviewer`.

## Running it

Needs Linux, root (through `sudo`), Node 22.22.2+ (Course Desk's minimum), `npm ci` in this
checkout, Playwright's Chromium in a directory both users can read (`PLAYWRIGHT_BROWSERS_PATH`), and
network access to GitHub for the clone. Both users must be able to traverse to this checkout and to
the work directory (for example `/tmp/...`); `setup.sh` checks.

```sh
run() { sudo env PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" "$@"; }
run examples/reference-app/acceptance/setup.sh /tmp/acceptance              # users, key, clone, test base, npm ci
run examples/reference-app/acceptance/run.sh   /tmp/acceptance /tmp/my-run  # the walkthrough; about 3 minutes
```

`COURSE_DESK_URL` and `COURSE_DESK_COMMIT` point setup at another clone or commit. A proxy and its CA
file (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, …) are passed through to both users.

The output directory must not exist, so nothing left from an earlier run can count for this one.
Each step must succeed, or the run stops with exit 3 and prints no summary. A gate verdict (exit 0
for pass or warn, 1 for block) is a result, compared with the one the step expects. It also has to
agree with the verdict file the gate wrote in that run. Any other exit, or a missing verdict, is an
execution error and stops the run. The owner-anchor check requires exactly one error,
`APPROVAL_NOT_ATTESTED … untrusted-key … user:fixture-reviewer`, so an unrelated failure does not
count as the trust boundary holding. Screenshots go to `my-run/shots/`, and what each browser phase asserted goes to
`my-run/ui/<phase>.json`.

To look around yourself after a run, start the explorer on the same checkout and state:

```sh
sudo -u vcv-acc-workspace env PATH="$PATH" VCV_UI_STATE_DIR=/tmp/acceptance/state npm run ui -- /tmp/acceptance/course-desk \
  --protected-base test-base --base-commit "$(cat /tmp/acceptance/main.sha)" --policy /tmp/my-run/gate/base-policy.json
```

## The walkthrough

The change: today (rev-4) only a confirmed enrollment is announced. The owner wants a rejection
because the course is full announced too, while a repeat request stays quiet.

| # | Step | Who | What is checked | Screens |
| - | ---- | --- | --------------- | ------- |
| 0 | The base passes its own gate | host | `vcv gate` PASS, 2/2 required criteria passed, host-observed | |
| 1 | Open the project | owner | Ready, branch `test-base`, `rev-4-d704dd46aee2`. Edges are `mod-enrollment → mod-notifications` and never the reverse, and Enrollment sits above Notifications. Following *Depends on → Notifications* and then *Used by → Enrollment* lands back on Enrollment, selected in the canvas and the module list, at the same zoom. Web is dragged and pinned. The checkout is byte-identical afterwards. | 01–04 |
| 2 | Stage a draft | owner | Three inspector edits: the rule's statement and name, and the criterion's statement. They stage as `setRuleStatement`, `renameObject` and `reviseCriterion`, with a rationale. The engine's dry run says *Valid on rev-4*. The draft file is under the state directory, outside the checkout, and the checkout is unchanged. | 05 |
| 3 | Restart and recover | owner | The host process and the browser are both stopped and started again. The draft file is byte-equal, with the same three operations in the same order and the same base (revision, `modelKey`, branch, commit). The export is a strict `ProposedModelChange` labelled `valid`, with no proposer, approver, status or signature, plus separate metadata. There is no submit or approve button. | 06–07 |
| 4 | Integrate and submit | agent | In its own clone, the agent has its own earlier draft (never submitted). It takes the owner's three operations verbatim and fixes the labels they would leave contradictory: the criterion was still named *A rejected enrollment is not announced*, and the project description said only confirmations are announced. It keeps one operation from its own draft and rewrites another. It adds an implementation request and submits **one fresh proposal**, `chg-full-course-notice`, with 7 operations. VCV merged nothing ([integration note](samples/m5.7-acceptance/agent/integration.md)). The agent's attempt to approve is refused. | |
| 5 | Review | owner | The inbox shows *Pending review*, the same digest as `vcv proposal preview` (`ad613a3d…`), the five lifecycle facts, the claims that move, what is still unverified, and the reviewer's own command. There is no approve control. A pending proposal moves nothing, so the draft stays current. | 08–09 |
| 6 | Approve (TEST ONLY) | fixture reviewer | While the pages are open, `reviewer.sh approve` runs as its own user in its own clone. It fetches the owner's branch, checks that its own preview has the same digest, signs and commits. The owner fast-forwards to that commit, and the inbox follows to *Applied to model*. The signature verifies, and integrity under the test base passes, labelled *caller-asserted*. Integrity against the owner's real anchor fails (above). | 10 |
| 7 | Model refresh | owner | The canvas shows `rev-5-6a1f0d8df2df` with a change banner. The pinned Web keeps its exact position. The draft turns *Stale: needs agent integration*. Switching the checkout back to `test-base` makes the draft current again and leaves the pin alone. Switching forward makes it stale again. | 11–12 |
| 8 | Gate: approved, not implemented | host | **BLOCK** `CRITERION_STALE` on `crt-rejection-notified`, with `SUITE_GREEN_REQUIRED_NOT_PASSED`. The suite is 8/8 green, but the passing test still asserts the *old* behaviour. This is the honest discrepancy: approved intent is ahead of the code, and VCV does not call it a pass. | |
| 9 | Implement | agent | `vcv handoff`, then edits to `enroll()`, the unit and e2e tests, the README and the smoke script. The app's typecheck, tests, build and smoke pass in the agent's clone; that is the agent's claim. | |
| 10 | Gate: claims not updated (negative case) | host | **BLOCK** `TEST_NOT_RUN` on both required criteria and `EVIDENCE_REQUIRED`. The suite is again 8/8 green, but the mapped cases were renamed, so the mappings point at tests that no longer exist (`LOCATOR_MISSING`). | |
| 11 | Claims and report | agent | 9 claims reasserted and the implementation report recorded. VCV lists its tests and acceptance statuses as **claims** (`CLAIMS_UNVERIFIED`) next to what it observes: 5 files changed, 0 out of scope. | |
| 12 | Gate: implemented | host | **WARN, passes**: 2/2 required criteria passed, host-observed. It warns `UNMAPPED_CHANGES` (README, smoke) and 5× `MAPPING_CHANGED`, which a person should read. `vcv reconcile` and `implementation show` are recorded too. | |
| 13 | Evidence and pre-merge page | owner | The implementation section keeps three layers apart: approved intent, the agent's report as claims, and what VCV observes now. Rule and criterion evidence show the claims as resolved. The pre-merge page, given CI's base commit, the base's own policy and the host's run record, says **Blocked: `RESULT_CLAIMED`**, because a run handed to the explorer is a claim. See *UI and CI* below. | 13–16 |
| 14 | Empty, invalid, conflicted | owner | Three copies of the real checkout: no `.vcv/` (`NO_PROJECT`), a corrupt revision (`INVALID_STORE`), and a merge of a competing `.vcv/HEAD` edit (`CONFLICTED`). Each shows its diagnostic and no graph, and none is written to. | 17 |

The gate on the explorer's pre-merge page and the gate in CI are the same `preMergeGate`. They differ
only in where the test result comes from.

## UI and CI: the same gate, different evidence

In CI (step 12) the gate captures the JUnit report from the run it started, against the identity it
read before the tests ran. That makes the result host-observed, and the gate passes with warnings.

The explorer captures nothing and runs nothing (docs/ui.md). A run record handed to it with `--run`
is a claim whatever it declares, so the same candidate is **Blocked** there with `RESULT_CLAIMED`.
That is truthful, but it means the explorer's page can never show a pass for required criteria.
Whether to keep it this way, or to let the page show CI's verdict, is open for the architecture
reviewer. Showing CI's verdict would need a way to verify a CI-signed record, and that is new
scope, not part of M5.7.

## Mapping each checklist item of #46 to evidence

| #46 checklist item | Where |
| ------------------ | ----- |
| Fresh checkout and UI restart; ready, branch and revision; dependency direction; click through and return | steps 1 and 3; `ui/explore.json`, `ui/recover.json`; shots 01–04, 06 |
| Two or more inspector edits; human draft outside the checkout; restart host and browser; identical order and base; no canonical writes | steps 2–3; `ui/draft.json`, `ui/recover.json`, `ui/draft-before-restart.json` |
| Independent agent-owned draft in a distinct context; the exported typed proposal to an agent; a fresh typed proposal; VCV does not merge drafts | step 4; `agent/own-draft.json`, `agent/integration.md`, `agent/proposal.json`, `agent/submit.txt`, `agent/self-approve.txt` |
| `previewProposal` on the submitted record; the same digest for review; outcome and what is unverified | step 5; `review/preview.txt`, `ui/inbox.json`; shots 08–09 |
| A separate reviewer process with a fixture key, pinned test anchor, not called owner approval | step 6 and *The trust setup*; `integrity/key-isolation.txt`, `ui/*.json` (`keyIsolation`), `review/approval.txt`, `integrity/test-anchor.txt`, `integrity/owner-anchor.txt`; shot 10 |
| Handoff to an agent; code and tests changed; claim kept apart from evidence | steps 9–11; `agent/handoff.json`, `agent/source.diff`, `agent/report.json`, `agent/implementation-record.txt`, `agent/implementation-show.txt` |
| Binding freshness and criteria mapping; the M4 gate on a protected-base fixture; a stale/missing negative case; accurate blocked results | steps 8, 10, 12, 13; `gate/*/gate.txt`, `gate/3-implemented/reconcile.txt`, `ui/evidence.json`; shots 13–16 |
| Pin persistence, stable positions across refresh, empty/invalid/conflicted states, a stale-draft branch switch | steps 1, 7, 14; `ui/approve.json`, `ui/states.json`; shots 04, 11, 12, 17 |
| A concise repeatable walkthrough | this page; `run.sh`; the CI job `acceptance` |

## Limits and uncertainties

- **The reviewer is a fixture.** Its key is a file on the same machine, behind a Unix user boundary.
  Root, and anyone with sudo, can still read it. It rehearses the protocol. A real approval is the
  owner's, with their own key, as in M4.5.
- **The agent is a replay.** The integration, implementation and report are recorded decisions of the
  session that built this slice. A fresh agent might integrate differently. The scripts check the
  handoff they receive is the one the recording was written for, and stop if it is not.
- **The owner is a browser script.** `walkthrough.ts` clicks what a person would and asserts what the
  screen shows. It does not judge whether the screens are clear. That is the PO's product feedback,
  which is optional and not part of this acceptance.
- **The test base is local.** `--protected-base test-base` is a local ref, and the pages say so
  (*caller-asserted*). Nothing here is the hosting service's verdict.
- **Mappings change without approval.** Step 12 passes with 5 `MAPPING_CHANGED` warnings. As in M4.5
  (negative 8), an agent could re-point a required criterion at the wrong test and the gate would only
  warn. That decision is still open.
- **Smoke and build run only in the agent's clone.** The host's gate runs Vitest only. The agent's
  build and smoke results are its claim.
- **The web page was not changed or checked in a browser.** It lists whatever the API returns. The
  agent's report says so as a gap.
- **Line endings.** Course Desk is CRLF. The agent's edits keep CRLF.

## Findings for the reviewer

Things this walkthrough surfaced that it does not fix (M5.7 adds no features):

1. The pre-merge page blocks wherever CI passes, because it only ever has claimed runs (*UI and CI*
   above).
2. In the inspector, while a long staged statement is open, a fragment of the staged text shows above
   the field list (shot 05, right panel). This is cosmetic.
3. `vcv --help` throws `ERR_PARSE_ARGS_UNKNOWN_OPTION` instead of printing the usage.
