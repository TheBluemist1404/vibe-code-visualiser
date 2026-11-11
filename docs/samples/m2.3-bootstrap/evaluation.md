# M2.3: independent agent bootstrap of Course Desk, and its evaluation

An agent was given an unfamiliar repository and VCV's public guide, and asked to create a draft
model. This page records that run
([Issue #11](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/11)) and then scores
the result against the reviewer oracle,
[examples/reference-app/ORACLE.md](../../../examples/reference-app/ORACLE.md).

The agent never saw the oracle. The evaluation was written afterwards by a different session: the
one that built and ran the experiment.

## The run

| | |
|---|---|
| Command | `examples/reference-app/bootstrap/run-agent.sh <out-dir>` |
| Repository | Course Desk, materialized by `materialize.sh` at baseline `adb423c256ca72cf8242da855e6cb433655dbd1a`. `vcv project status` reported `absent` and Git was clean |
| Agent | Claude Code 2.1.322, headless (`claude -p`), model `claude-sonnet-5-5`. 25 turns, 59 s, $0.21 |
| Input | [prompt.txt](prompt.txt) (generic, no fixture details) and `AGENT_GUIDE.md`, which is a copy of [docs/agent-bootstrap.md](../../agent-bootstrap.md) |
| Output | [agent-output/model.yaml](agent-output/model.yaml), [agent-output/report.md](agent-output/report.md), and `.vcv/` created by `vcv project init` |
| Transcript | [transcript.jsonl](transcript.jsonl) (raw stream-json) and [transcript.md](transcript.md) (condensed, with the isolation audit) |

### Isolation

- **Environment.** The session started with:
  - an empty `HOME` and a scrubbed environment
  - `--setting-sources project`, in a repository with no `CLAUDE.md`

  So it had no user settings, memory or project instructions. Its init record shows a fresh memory path and `additional_directories: []`.
- **Tools.** Exactly `Bash, Edit, Glob, Grep, Read, Write`, with no MCP servers and no web tools.
- **Permissions.**
  - Writes only inside the repository, and never into `.vcv/`.
  - Shell commands only for the VCV CLI, npm scripts, and read-only Git and `ls`.
  - Read, Grep and Glob denied on the VCV checkout.
- **VCV copy.** The `vcv` command came from a separate toolkit holding only the engine sources and the guide (`toolkit.sh`). It had no `examples/`, tests, ADRs or oracle.
- **Audit.** The isolation audit in [transcript.md](transcript.md) checked all 24 tool calls for the VCV checkout path, `ORACLE` and `reference-app`, and found none.

### What the agent did

It made 24 tool calls:
1. Read the guide.
2. Listed the files and ran `vcv project status .`, which reported `absent`.
3. Read the README, `app.module.ts`, `app.setup.ts`, every Enrollment and Notifications source file, and the web client.
4. Wrote `vcv-bootstrap/model.yaml`. Its first attempt used a shell heredoc, which the permission rules refused, so it wrote the file with the Write tool instead.
5. Ran `vcv validate`, then `vcv project init . vcv-bootstrap/model.yaml`, then `vcv project status .` and `vcv query .vcv overview`.
6. Wrote a report.

It did not edit `.vcv/` or commit anything. It did not run the app's tests and did not read the test files in detail, and it said so.

### After the run

A new process ran `vcv project status`, `vcv validate` and `vcv query <repo>/.vcv overview`. They found:
- the project `ready` at `rev-1 [draft]`, with 0 errors and 0 warnings ([project-status.json](project-status.json), [validate.txt](validate.txt), [query-overview.json](query-overview.json))
- Git still at the baseline commit, with only `.vcv/` and `vcv-bootstrap/` untracked ([git-status.txt](git-status.txt))

On every CI run, `packages/repo/test/bootstrap.test.ts` replays the recorded draft through `vcv project init` on a fresh checkout. It then reopens the project and queries it.

## Three different things

| | What it is | Status after this run |
|---|---|---|
| **Agent interpretation** | The draft model and report: a claim about what the code means | 1 actor, 3 modules, 5 capabilities, 3 data, 5 rules. `status: draft`; not reviewed or approved |
| **VCV checks** | Shape, typed references, ownership and consistency (schema 0.2). The project is created through `project init` only | Valid, with no warnings. The store reopens and answers queries (`implementationChecked: false`). VCV did **not** compare the model with the code; bindings come in M2.4 |
| **Fixture tests** | What Course Desk's own tests prove about its behavior | 11 app tests, a build and an HTTP smoke run pass in `examples/reference-app/check.sh` (CI job `reference-app`). The agent ran none of them |

## Score against the oracle

✓ covered, ◐ partly, ✗ missed. "Where" names the model element or report line.

| Fact | | Where / note |
|---|---|---|
| **F1.1** Two server modules, Enrollment and Notifications | ✓ | `mod-enrollment`, `mod-notifications`. The agent also added `mod-web` (see below) |
| **F1.2** Notifications owns its controller and service, and exports the service | ✓ | `mod-notifications` ("Exports NotificationsService; has no dependencies"), `cap-list-notifications` |
| **F1.3** Enrollment imports Notifications | ✓ | `mod-enrollment.dependsOn: [mod-notifications]`, "injected via NotificationsModule import" |
| **F1.4** EnrollmentService uses the catalog, the repository and NotificationsService | ✓ | The catalog and repository are named in the module and data descriptions; the injected service in `mod-enrollment` |
| **F1.5** Notifications does not depend on Enrollment; `enrollmentId` is a plain string | ✓ | Notifications "has no dependencies"; `att-ntf-enrollment` is typed `id` "rather than reference" |
| **F2.1** `GET /api/courses` | ◐ | `cap-list-courses` says `GET /courses`. Capability paths are controller-relative. The report notes the global `api` prefix and `mod-web` uses `/api`, but no capability has the served path |
| **F2.2** `POST /api/enrollments`: 201 with the decision, otherwise 400 or 404 | ✓ | `cap-enroll` (same prefix caveat) |
| **F2.3** `GET /api/enrollments/:id` | ✓ | `cap-get-enrollment` (same prefix caveat) |
| **F2.4** `GET /api/notifications?recipientId=`, 400 without it, oldest first | ✓ | `cap-list-notifications` |
| **F3.1** Statuses `confirmed`/`rejected`; reasons `COURSE_FULL`/`ALREADY_ENROLLED` | ✓ | `dat-enrollment`. Typed `string`, because the schema has no enumerations, as the agent noted |
| **F3.2** Confirmed while seats are left; a confirmation takes a seat | ✓ | `rul-seat-limit`; `dat-course` ("seatsLeft … derived") |
| **F3.3** A full course is rejected with `COURSE_FULL` | ✓ | `rul-seat-limit` |
| **F3.4** `ALREADY_ENROLLED` is checked before capacity, and no seat is taken | ✓ | `rul-no-double-enroll`: "takes no seat … checked before capacity" |
| **F3.5** Every recorded decision sends exactly one notification | ✓ | `rul-announce-every-decision`: "exactly one notification" |
| **F3.6** Unknown course: 404, and nothing is recorded or notified | ✓ | `cap-enroll`; `rul-announce-every-decision` description |
| **F3.7** A rejection is a recorded `201` outcome, not an error | ✓ | `cap-enroll` |
| **F3.8** Seeded catalog: Linear Algebra (2 seats), Modern Poetry (1 seat) | ✓ | `dat-course` |
| **F3.9** In-memory storage; sequential `enr-N` and `ntf-N` IDs | ✓ | Data descriptions |
| **F4.1** The App renders the form, then the student's notifications | ✓ | `cap-use-ui` |
| **F4.2** After enrolling, the UI re-reads notifications and courses | ✓ | `cap-use-ui` |
| **F4.3** The client calls three routes and never `GET /enrollments/:id` | ✓ | `cap-get-enrollment`: "Not used by the web client" |
| **F4.4** The client types duplicate the server contracts by hand | ✗ | Not mentioned |
| **F4.5** In development, Vite proxies `/api` to port 3000 | ✗ | Build config left out, as the agent stated |
| **F5** Absent on purpose: no database, auth/roles, queue or external channel, pending/approval/waitlist state, withdrawal, administration or read state | ◐ | No permission rules, events, behaviors or persistence are claimed. The agent explained that "no authorization", "direct call, not an event" and enrollments "immutable once saved". **However**, it modelled a `Student` actor, although the code has no roles beyond a free-text `studentId`. The actor is flagged as medium confidence and raised as an open question ("Is 'Student' a real actor, given that there is no authentication?") |

### Coverage

- 20 of the 23 F1–F4 facts are covered fully.
- F2.1 is covered partly.
- F4.4 and F4.5 are missed.
- F5 is covered partly, because of the `Student` actor.

### False or unsupported claims

No statement in the model contradicts the code. Four points need a reviewer's attention:

- **`act-student` and the initiators.** `act-student` and the `initiatorActorId` on four capabilities are inferred, not shown in the code. The agent says so in the actor and capability descriptions and in an open question.
- **Route paths.** The capability descriptions give controller-relative paths (`/courses`), while the served path is `/api/courses`. This is an imprecision, not an invention.
- **`mod-web` and its dependencies.** Making the web client a module that `dependsOn` both server modules is an interpretation. The link is HTTP, not imports. The agent explained this and asked whether it is right.
- **The concurrency remark.** The `rul-seat-limit` description says "Check-then-save is synchronous, so no race in this in-memory setup". This holds for this single-process Node server, but no test shows it.

### Uncertainty

The agent was honest and specific about uncertainty:
- The report gives sources and a confidence level for each element.
- It names the files that were not read in detail, and says the tests were not run.
- It raises two real questions: whether `Student` is an actor, and whether Web is a module.

## Guide revision and trial runs (not the recorded run)

The guide was written by the same session that wrote the oracle. To check whether that leaked anything, `packages/repo/test/bootstrap.test.ts` fails if the guide or the prompt uses any of the fixture's vocabulary.

Before the recorded run, a review of the guide found two phrases that, while generic, matched this fixture's answers:
- "a free-text user ID is not a role"
- "a direct method call is a `dependsOn`, not an event"

Both were removed. The replacement text is general: model only what the code has, and use events, contracts and behaviors only where the code has them.

**Trial 3** used the earlier wording. That agent modelled no actors and quoted the "free-text" reasoning. The recorded run, without the hint, modelled a `Student` actor. So the old wording measurably steered the result, and it is right that it is gone.

Two earlier trials were made while the runner was being fixed:

- **Trial 1** stopped before writing anything. The runner's permission rules used single-slash absolute paths, which Claude Code reads as relative, so the agent's first `Write` was refused. The fix was to use `//` in the rules.
- **Trial 2** completed with a similar draft. It also noted that the client "hand-copies its types" (F4.4). Along the way, `vcv validate` on a file that had not been written yet printed a raw Node stack trace. That led to the one CLI change in this work: unreadable input files are now reported as `✗ INPUT: cannot read <path>: no such file` with exit code 2.

  The agent also blamed a "Parser skipped input" message on the VCV validator. That message actually came from the agent host's shell-permission check refusing a heredoc, not from VCV.

## What this says about VCV

- **No new VCV operations were needed.** `validate`, then `project init`, then `project status` and `query` was enough. `.vcv/` was never edited by hand in any run.
- **The schema has no enumerated attribute type.** Every run typed closed value sets (`status`, `reason`, `kind`) as `string` and listed the allowed values in descriptions. This is a possible IR follow-up.
- **Provenance only lives in free-text descriptions.** The model cannot yet say in a checkable way which file backs an element. M2.4 bindings are for that.
- **`vcv project init` accepts any valid model**, including one marked `approved`. The agent set `draft` because the guide asks for it, but nothing enforces that. Making init create drafts only, unless a person says otherwise, is a candidate follow-up.
- **Actor modelling is the least stable part of the guide.** Whether a free-text user ID should become an actor depends on the wording, so the guide's definition of an actor may need a decision from the project owner.
