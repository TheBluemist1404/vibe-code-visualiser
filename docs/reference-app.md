# Reference app: Course Desk (M2.2)

Course Desk ([examples/reference-app](../examples/reference-app)) is a small, runnable React +
NestJS application. It is the "unknown repository" a coding agent will build a first draft
`.vcv/` model for in M2.3 ([Issue #9](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/9),
part of [#6](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/6)).

It has two domains. **Enrollment** holds courses, seats and the enrollment rules.
**Notifications** is an in-memory outbox. Each recorded enrollment decision sends the student one
notification, so Enrollment really depends on Notifications. The app's own README (inside
`template/`) describes its routes and expected behavior.

## Using it

The template lives inside this monorepo, and `@vcv/repo` resolves the Git working-tree root.
Pointing VCV at `template/` directly would therefore find this repository, not the app. Always
copy the app out first:

```sh
examples/reference-app/materialize.sh /tmp/course-desk   # standalone Git repo, one baseline commit, no .vcv/
examples/reference-app/check.sh                          # npm ci, typecheck, test, build, HTTP smoke run, VCV reports "absent"
```

`materialize.sh` fixes the commit identity, dates and Git config. The same template therefore
always produces the same baseline commit ID, and later binding tests can refer to it.

| File | Purpose | Audience |
|------|---------|----------|
| `template/` | The application as it is committed in the materialized repository | The agent, after materializing |
| `materialize.sh`, `check.sh` | Create and verify the standalone repository | Developers, CI |
| `ORACLE.md` | Facts about the app traced to code and tests, plus planned controlled changes for M2.4/M2.5 | Reviewers only. Never give it to the agent |

`packages/repo/test/reference-app.test.ts` checks the repository contract without installing
anything. The materialized repo must be its own root and clean at one baseline commit. It must
have no `node_modules/`, `dist/` or `.vcv/`, and no mention of VCV or the oracle. Its baseline
must be reproducible, and `projectStatus` must report `absent` without creating anything.

## CI and Node version

The `reference-app` job in `.github/workflows/ci.yml` runs `check.sh` on Node 22.22.2 and the
latest 22.x. 22.22.2 is the app's own minimum (its `engines`), because jsdom 31 requires it.
VCV itself still supports Node 22.18 or newer.

## Sample run

```
$ examples/reference-app/check.sh /tmp/claude-0/cd-check2
== baseline adb423c256ca72cf8242da855e6cb433655dbd1a in /tmp/claude-0/cd-check2
   server: Test Files 3 passed (3), Tests 8 passed (8)
   web:    Test Files 1 passed (1), Tests 3 passed (3)
POST /enrollments {"studentId":"stu-ada","courseId":"crs-poetry"}
  → 201 {"id":"enr-1","studentId":"stu-ada","courseId":"crs-poetry","status":"confirmed"}
POST /enrollments {"studentId":"stu-bob","courseId":"crs-poetry"}
  → 201 {"id":"enr-2","studentId":"stu-bob","courseId":"crs-poetry","status":"rejected","reason":"COURSE_FULL"}
GET /notifications?recipientId=stu-bob
  → 200 [{"id":"ntf-2","recipientId":"stu-bob","kind":"enrollment-rejected","message":"Modern Poetry is full; your enrollment was not accepted.","enrollmentId":"enr-2"}]
smoke: ok
== VCV project status (expected: absent)
{"state":"absent","root":"/tmp/claude-0/cd-check2","commit":"adb423c256ca72cf8242da855e6cb433655dbd1a","dirty":false}
reference app: ok
```

## Agent bootstrap (M2.3)

`examples/reference-app/bootstrap/run-agent.sh <out-dir>` runs an independent agent against a
freshly materialized Course Desk ([Issue #11](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/11)):

- `toolkit.sh` builds a VCV copy holding only the engine and the general guide
  [docs/agent-bootstrap.md](agent-bootstrap.md). It has no examples, tests, ADRs or oracle.
- The agent is a headless Claude Code session in the materialized repo, with:
  - an empty `HOME` and a scrubbed environment
  - only file and shell tools, writes allowed only inside the repo (never into `.vcv/`), the shell limited to `vcv`, npm and read-only Git
  - this checkout denied
- The agent reads the code, writes a draft, runs `vcv validate`, and creates `.vcv/` with
  `vcv project init`.
- The runner then records the transcript and outcome, rereads the project in a new process,
  and audits every tool call for access to this checkout or the oracle (`summarize.mjs`).

The recorded run and its independent scoring against `ORACLE.md` are in
[samples/m2.3-bootstrap/evaluation.md](samples/m2.3-bootstrap/evaluation.md).
`packages/repo/test/bootstrap.test.ts` keeps the guide and prompt free of fixture vocabulary,
checks the toolkit's contents, and replays the recorded draft through `vcv project init` on a
fresh checkout. That test needs neither `claude` nor network access.

## Binding claims (M2.4)

`examples/reference-app/bindings/demo.sh <dir>` materializes Course Desk, creates `.vcv/` from
the M2.3 agent draft, and walks through binding claims with the public CLI: an agent records
claims to `EnrollmentService.enroll`, a route and a test; a missing symbol, an unsafe path and an
unsupported selector are refused; renaming the method makes the claim `missing` (and the
controller that calls it `stale`); a person reasserts it with `--expect`; and `.vcv/HEAD` never
moves. The recorded output is [samples/m2.4-bindings/demo.txt](samples/m2.4-bindings/demo.txt).
`packages/repo/test/bindings.test.ts` runs the demo, the planned controlled changes C1–C3 from
`ORACLE.md`, and the cross-branch and path-safety scenarios. See [bindings.md](bindings.md).
