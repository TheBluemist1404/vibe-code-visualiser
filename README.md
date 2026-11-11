# Vibe Code Visualiser

*Working name.* Vibe Code Visualiser (VCV) is a local-first tool for building software with
coding agents **module by module**, with a model of the app that people and agents share,
instead of one-shot generation of code nobody can follow.

At its centre is a versioned, typed model of the application: its modules, capabilities, data,
rules, events, contracts and behaviour. Agents read that model to understand what a change
touches. Humans review and approve changes to it. Later milestones bind it to real source code,
so VCV can show what was implemented and flag where the code no longer matches the agreed design.

> Vibe coding with a software engineering team, not just a coding agent.

## Why

Coding agents are good at writing code and bad at keeping a whole system in their head.
Once an app grows past a few files, a person who can't read the code loses track of what it
does, and the agent guesses at structure it can't see. VCV keeps three things apart and makes
them visible:

- **Intent**: the approved model, changed only through typed, reviewable proposals.
- **Code**: what the repository actually contains, observed at a specific commit.
- **Evidence**: tests and checks that connect the two.

When they disagree, VCV reports it and asks for a decision. It never silently rewrites
approved intent to match the code, or the other way round.

## Status

Early and pre-release. The engine works from the command line and from coding agents over
MCP, and a model can now live in a `.vcv/` folder inside your Git repository. There is no
visual interface yet, and the model is not yet linked to source code.

| Milestone | What it delivers | Status |
|---|---|---|
| **M0** Semantic foundation | Typed IR, validation, change/approval engine, file store with crash recovery, audit log, read-only query API, CLI | ✅ Done |
| **M1** Local MCP for agents | stdio MCP server with four read-only query tools, opt-in agent guidance, Claude Code demo | ✅ Done ([#5](https://github.com/TheBluemist1404/vibe-code-visualiser/pull/5)) |
| **M2** Repository integration | `.vcv/` in the repo, TypeScript indexer, portable model↔code bindings | 🚧 In progress ([#6](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/6)): `.vcv/` projects and branch-safe revisions done ([#8](https://github.com/TheBluemist1404/vibe-code-visualiser/pull/8)); reference app for agent-led bootstrap in review ([#10](https://github.com/TheBluemist1404/vibe-code-visualiser/pull/10)) |
| **M3** Approved model → code | Agent proposes model changes, human approves, coding agent implements, VCV records diff and tests | Planned |
| **M4** Code → model reconciliation | Detect stale bindings and real contract drift after direct code edits | Planned |
| **M5** Local visual product | Module graph, change review and evidence panels in a local UI | Planned |

M0 to M4 make up the technical MVP; M5 makes it usable without reading code. Everything is
single-user and local for now. The file store assumes one writer at a time.

## Quick start

Requires **Node 22.18 or newer**. TypeScript runs directly; there is no build step.

```sh
git clone https://github.com/TheBluemist1404/vibe-code-visualiser.git
cd vibe-code-visualiser
npm install
npm test             # run the test suite
npm run typecheck
```

### Try the engine on the sample model

The repository ships a small LMS model (Enrollment and Notifications modules) and one change
to it: rejecting an enrollment request automatically after seven days.

```sh
# Check the model and start a store from it
npm run vcv -- validate examples/enrollment/model.rev-1.yaml
npm run vcv -- init .vcv-store examples/enrollment/model.rev-1.yaml

# An agent proposes the change; a human approves it, creating a new revision
npm run vcv -- propose .vcv-store examples/enrollment/change.timeout.yaml --as agent:mcp --perm propose
npm run vcv -- approve .vcv-store ch-timeout-01 --as hoang

# Look at the result
npm run vcv -- show .vcv-store --tree
npm run vcv -- query .vcv-store search enrollment notifications --kind module
npm run vcv -- query .vcv-store impact evt-enrollment-rejected
```

Revision IDs after the first look like `rev-2-84dfbfe94209`: the digest keeps two Git
branches from minting the same ID. Run `npm run vcv` with no arguments for the full command list. `--as` and `--perm` simulate
the identity a real host would supply; they are not authentication.

### Keep the model in your repository

A VCV project lives in `.vcv/` at the root of a Git checkout and is committed with the code.

```sh
npm run vcv -- project init <checkout> examples/enrollment/model.rev-1.yaml   # create <checkout>/.vcv
npm run vcv -- project status <checkout>                                      # model and Git state, read-only
```

`project status` works from any subdirectory and reports whether the project is ready,
absent, conflicted, diverged or invalid, along with the checkout's commit, branch and dirty
state. It never creates or repairs anything. A merged or half-merged `.vcv/` is refused rather
than silently reset. See [ADR 0007](docs/adr/0007-repository-projects.md).

### Reference app

[examples/reference-app](examples/reference-app) holds Course Desk, a small runnable React +
NestJS app (Enrollment and Notifications) that a coding agent will build a first model for.
It is meant to be used as an unfamiliar repository, so copy it out first:

```sh
examples/reference-app/materialize.sh /tmp/course-desk   # its own Git repo, baseline commit, no .vcv/
examples/reference-app/check.sh                          # install, test, build and run it; VCV must report "absent"
```

### Connect a coding agent

```sh
node --experimental-strip-types apps/mcp/src/main.ts --store .vcv-store
```

This starts a read-only MCP server over stdio for one store. Any MCP client (Claude Code,
Codex and others) can then call `vcv_get_project_overview`, `vcv_search_objects`,
`vcv_get_context` and `vcv_analyze_impact`. Results describe the model only
(`implementationChecked: false`), so agents still need to check the code itself.
Client configs, opt-in `CLAUDE.md` / `AGENTS.md` guidance and the recommended agent workflow
are in [apps/mcp/README.md](apps/mcp/README.md).

## Repository layout

```
packages/ir        The model (IR): types, schema, validation, YAML load/dump, tree and graph views
packages/core      Typed operations, ModelEngine (propose/approve), file and memory stores, audit log, bindings, layout
packages/query     Read-only semantic queries: overview, search, context, impact
packages/repo      Repository projects: find and load .vcv/, observe Git state, track branches
apps/cli           `vcv` command-line tool, a thin layer over the engine
apps/mcp           Local stdio MCP server for coding agents
examples/          Sample Enrollment model and a proposed change; Course Desk reference app
docs/adr/          Architecture decision records
docs/samples/      Sample query output and a recorded Claude Code session
```

Every interface (CLI, MCP, and the future canvas) calls the same engine operations. None of
them holds its own copy of the model or its own rules.

## Documentation

- **Architecture decisions** in [docs/adr](docs/adr):
  [0001](docs/adr/0001-ir-first-scope.md) IR first, Enrollment as the only domain ·
  [0002](docs/adr/0002-semantic-command-api.md) one typed command API for every write ·
  [0003](docs/adr/0003-persistence.md) file persistence and crash recovery ·
  [0004](docs/adr/0004-audit.md) change records and audit log ·
  [0005](docs/adr/0005-semantic-query-api.md) semantic query API ·
  [0006](docs/adr/0006-mcp-adapter.md) MCP adapter ·
  [0007](docs/adr/0007-repository-projects.md) repository projects, revisions and bindings
- [IR v0.2 conformance](docs/ir-v0.2-conformance.md): which tests cover the spec's acceptance
  cases, extra hardening, and decisions the spec left open
- [Sample semantic queries](docs/samples/semantic-queries.md) and the
  [recorded agent demo](docs/samples/mcp-agent-demo.md)
- [MCP server](apps/mcp/README.md): tools, configuration and agent guidance

## Development

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `npm ci`, typecheck and tests on
Node 22.18.0 and the latest 22.x for pushes to `main` and every pull request. A second job runs
`examples/reference-app/check.sh` on the app's own minimum (Node 22.22.2) and the latest 22.x. Commit messages
follow [Conventional Commits](https://www.conventionalcommits.org).
