# M2.5: agent-led model maintenance on Course Desk, and its evaluation

The M2 exit proof ([Issue #15](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/15)).
A coding agent was given a repository whose code had changed since its VCV model and binding
claims were made. It used VCV's read-only evidence to find what to look at, inspected the code
itself, and submitted a typed model change. VCV validated it and stored it as **pending**. No
one approved it: that is for a person.

Two separate evaluations follow the run: an **independent review** by a second fresh session
that saw only the outputs, the patch and the oracle
([independent-evaluation.md](independent-evaluation.md)), and this page, written by the session
that built the experiment.

## The run

| | |
|---|---|
| Command | `examples/reference-app/maintenance/run-agent.sh <out-dir> --model claude-sonnet-5-5` |
| Repository | Course Desk from `setup.sh`: the M2.3 draft (`prj-course-desk` at `rev-1 [draft]`) and eight claims by `agent:bootstrap`, committed as baseline `a580bd7fbede50b228c62f2c1ae2dcc2a90eec54`; then [`waitlist.patch`](../../../examples/reference-app/changes/waitlist.patch) applied, **uncommitted** (11 files) |
| App tests | Run by `setup.sh --app-tests` on the changed tree, before the agent: typecheck clean, server 9/9 and web 3/3 tests pass, build and HTTP smoke run pass ([setup.txt](setup.txt)). The agent did not run them itself |
| Agent | Claude Code 2.1.322, headless, model `claude-sonnet-5-5`. 13 turns, 12 tool calls, 56 s, $0.22 |
| Identity | The agent's `vcv` is a wrapper that sets `VCV_HOST_PRINCIPAL=agent:maintainer` and `VCV_HOST_PERMISSIONS=model:propose`; `--as`/`--perm` are refused |
| Input | [prompt.txt](prompt.txt) (generic) and `AGENT_GUIDE.md` = [docs/agent-maintenance.md](../../agent-maintenance.md) |
| Output | [agent-output/change.yaml](agent-output/change.yaml), [agent-output/report.md](agent-output/report.md), and the pending record VCV wrote, [change-records/ch-maint-01.json](change-records/ch-maint-01.json) |
| Evidence | [evidence/](evidence/): `before-refresh`, `before-overview`, `before-object-rul-seat-limit`, `after-refresh` (with `since` = the before token) |
| Transcript | [transcript.jsonl](transcript.jsonl) and [transcript.md](transcript.md) (condensed, with the isolation audit) |

### Isolation and authority

- **Fresh context**, as in M2.3: empty `HOME`, scrubbed environment, `--setting-sources project`
  in a repository without `CLAUDE.md`, no MCP servers, no web tools. The toolkit holds the engine
  and the guide only (no examples, tests, ADRs or oracle). The audit found none of the 12 calls
  touching the VCV checkout, `ORACLE` or `reference-app`.
- **Writes** were allowed only under `vcv-maintenance/`. The hash comparison of `.vcv/` and
  every tracked or modified source file before and after the run ([hash-diff.txt](hash-diff.txt))
  shows one added file, `.vcv/changes/ch-maint-01.json`, written by `vcv propose`. Source, tests,
  claims, `HEAD` and revisions are byte-identical; [git-status.txt](git-status.txt) shows the
  patch's 11 files plus the agent's two files.
- **Two commands were denied** by the permission rules (a `for` loop and a `cat > file` heredoc);
  the agent re-ran the queries one by one and used the Write tool instead.
- **No approval authority.** After the run, the runner tried to approve as the agent's identity
  ([agent-approve-attempt.txt](agent-approve-attempt.txt)): `denied … NOT_AUTHORIZED`, and the
  same with `--perm approve`: refused because the host fixes the identity. The project is still
  at `rev-1 [draft]` with the change pending ([project-status.json](project-status.json)).

### What the agent did

1. Read the guide; ran `vcv project status .`, `vcv evidence . refresh` and
   `vcv evidence . overview --states stale,missing,ambiguous,indeterminate,invalid`.
2. Read `vcv query .vcv context` for the five objects with stale or missing claims, then
   `git diff -- server README.md scripts` and `git log`.
3. Read the model revision file and the missing test claim, and listed the spec's test titles.
4. Wrote `change.yaml` (8 operations), ran `vcv propose .vcv vcv-maintenance/change.yaml`
   → `ch-maint-01: pending (proposed by agent:maintainer; record is pending)`.
5. Ran `vcv evidence . refresh --since <before token>` → `changedSince: false`, same counts.
6. Wrote `report.md`.

## Four kinds of statement

| | What | Where it is recorded |
|---|---|---|
| **Source observed** | The waitlist patch: `enroll()` saves a full-course request as `waitlisted` with `waitlistPosition`, no seat; `COURSE_FULL` removed; new `ALREADY_WAITLISTED`; new notification kind `enrollment-waitlisted`; tests, types and README updated. App tests pass on it | [`waitlist.patch`](../../../examples/reference-app/changes/waitlist.patch), [setup.txt](setup.txt); the agent's own reading in the report's "Source observed" |
| **Agent inferred** | Which model statements became false, and the eight operations that fix them; a separate rule for the waitlist duplicate check; confidence "high for the server, web unreviewed" | [change.yaml](agent-output/change.yaml), report "Agent inferred" |
| **VCV validated** | Before: 2 resolved, 5 stale (`impl.cap-enroll`, `impl.rul-seat-limit`, `impl.rul-no-double-enroll`, `persist.dat-enrollment`, `persist.dat-notification`), 1 missing (`test.rul-seat-limit`, its test was renamed). The proposal is schema-valid, applies to `rev-1` and yields a valid model, so it is stored `pending` with no diagnostics. After: evidence unchanged (`changedSince: false`) | [evidence/](evidence/), [change-records/ch-maint-01.json](change-records/ch-maint-01.json) |
| **Human approved** | Nothing. The change waits for a person with `model:approve` | — |

VCV did not interpret the diff, propose anything or touch the model: every operation was written
by the agent and only checked by VCV.

## Evaluation

Scored against the patch (ground truth) and [ORACLE.md](../../../examples/reference-app/ORACLE.md)
(F3.3, a full course is rejected, is what C3 makes false).

| Operation | Verdict |
|---|---|
| `setRuleStatement rul-seat-limit`: a full-course request is waitlisted with a 1-based position, takes no seat | Correct (patch `enroll()`, spec "waitlists … in request order") |
| `setDescription rul-seat-limit`: never promoted, no cancellation | Correct (README patch; no promotion code) |
| `createRule rul-no-double-waitlist` (`ALREADY_WAITLISTED`) | Correct; a modelling choice (a new rule rather than widening `rul-no-double-enroll`), stated as such |
| `setRuleStatement rul-announce-every-decision`: three outcomes, one notification each | Correct; not flagged by any claim (no claim binds that rule), found by reading the code |
| `setDescription cap-enroll`, `dat-enrollment`, `dat-notification` | Correct |
| `addDataAttribute att-enr-waitlist-position` (integer, nullable) | Correct |

- **Missed:** nothing false is left. `rul-no-double-enroll`'s description ("ALREADY_ENROLLED wins
  when both apply") is still true but was written for `COURSE_FULL`; both reviews suggest
  rewording it. The web client's display of the position (`App.tsx`) is not reflected in
  `cap-use-ui`, whose generic wording stays true; the agent said it did not review `web/`.
- **Over-reach:** none.
- **Evidence use:** the agent treated stale/missing as "look here", not as findings, and found
  one affected rule with no claim at all. It did not present `resolved` claims as correct.
- **Report:** keeps the four kinds of statement apart, and its VCV figures match the evidence
  files. It recommends that a person repoint the missing test claim to the renamed test and
  re-record the stale claims after review, which is the documented workflow (VCV never rebinds).

**Independent review** ([independent-evaluation.md](independent-evaluation.md)): a fresh,
headless `claude-opus-5-5` session with only Read/Glob/Grep, in a staging directory holding the
patch, the model before, the oracle and the run's outputs (no VCV checkout, no shell). It rated
all eight operations correct, found no over-reach and no false statement left, confirmed the
authority and isolation claims from the files, and would **approve with one optional edit** (the
`rul-no-double-enroll` description). Scores: correctness 9/10, completeness 8/10. Its one
caveat about the report ("the 'VCV validated' heading slightly oversells" because
`validationResults` is empty) is a misreading: an empty list on a pending record means validation
found no errors or warnings, since errors would have rejected the change.

## Limits of this proof

- One run, one model, one controlled change. The change is small and its tests are explicit.
- The app tests were run by the harness, not by the agent.
- No approval was performed. A person can review and apply it with
  `vcv approve .vcv ch-maint-01 --as <you> --perm propose,approve` in a checkout made by
  `setup.sh` with the change resubmitted (`maintenance.test.ts` replays it).
- After approval the stale claims stay stale (now also for model reasons) until a person
  reasserts or re-records them: claims are never updated by a model change.

## Reproduce

```sh
examples/reference-app/maintenance/run-agent.sh /tmp/m25 --model claude-sonnet-5-5   # needs a signed-in claude
examples/reference-app/maintenance/evaluate.sh /tmp/m25 --model claude-opus-5-5
node --test --experimental-strip-types packages/repo/test/maintenance.test.ts           # no claude, no npm
```
