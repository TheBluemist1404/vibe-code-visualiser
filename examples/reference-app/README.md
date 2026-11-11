# Reference app: Course Desk (M2.2)

A small, runnable React + NestJS application used as an **unknown repository** for agent-led
`.vcv/` bootstrap (Issue #9; M2.3 runs the agent). Two domains, Enrollment and Notifications;
every enrollment decision is announced through a notification.

| Path | What | Who sees it |
|------|------|-------------|
| `template/` | The application source, exactly as it is committed in the fixture repository | The agent (after materializing) |
| `materialize.sh <dest>` | Copies `template/` into a new standalone Git repository and commits a baseline with fixed identity and dates (same template → same commit ID) | |
| `check.sh [dest]` | Materialize → `npm ci` → typecheck → test → build → HTTP smoke run → `vcv project status` must say `absent` | CI (`reference-app` job) |
| `bootstrap/` | `run-agent.sh` (independent agent bootstrap, M2.3), `toolkit.sh`, the generic `prompt.md`, `summarize.mjs` (transcript and isolation audit) | Runs the agent; the agent only sees the prompt and the toolkit |
| `bindings/demo.sh <dir>` | Scripted binding-claim walkthrough on a fresh checkout with the M2.3 draft (M2.4): record, refuse, rename, verify, reassert | Recorded in `docs/samples/m2.4-bindings/` |
| `ORACLE.md` | Facts about the app, traced to code and tests, for checking an agent's model | Reviewers only, never the agent |

```sh
examples/reference-app/check.sh               # full check in a temporary directory
examples/reference-app/materialize.sh /tmp/course-desk
cd /tmp/course-desk && npm ci && npm test && npm run build && npm start
```

The fixture must be used through `materialize.sh`, not in place: `@vcv/repo` resolves the Git
working-tree root, so pointing VCV at `template/` would find this monorepo instead of the app.
The materialized repository has no `.vcv/`, and nothing in it mentions VCV.

## For M2.3

The agent gets only the materialized repository and VCV's tools. What it should be able to
discover by reading code and running tests (without being told) is in `ORACLE.md`. At a high
level, that covers the module structure and its direction of dependency, the routes, the
enrollment rules and the notification side effect, the web client's use of the API, and what
the app does not do. `ORACLE.md` also lists the controlled source changes planned for the
binding freshness work in M2.4/M2.5.
