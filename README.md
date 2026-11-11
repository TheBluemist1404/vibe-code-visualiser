# Vibe Code Visualiser: IR v0.2 engine spike

The first slice of the plan in Notion: a typed IR, a validator, and a model engine that
applies typed changes with revision checks and approvals, tested against the Enrollment
fixture from *IR v0 — Conceptual Specification* (Draft v0.2).

```
packages/ir     IR types, shape schema (zod), reference index, validation, YAML load/dump, tree/graph projections
packages/query  read-only Semantic Query API: overview, search, context, impact (ADR 0005)
packages/repo   repository-native .vcv/ projects: project loading, Git observation, branch tracking (ADR 0007)
packages/core   typed operations, ModelEngine (propose/approve), Memory/File stores with crash recovery, audit log, bindings, layout store
apps/cli        thin CLI over the engine (no domain logic)
apps/mcp        local stdio MCP server exposing the four read-only queries to coding agents (ADR 0006)
examples/enrollment   model.rev-1.yaml (valid fixture), change.timeout.yaml (the spec's 7-day timeout change)
docs/adr        decision records 0001–0007
docs/samples    sample query results and the recorded agent demo on the Enrollment fixture
```

Requires Node 22.18+ (runs TypeScript directly, no build step).

```sh
npm install
npm test            # 116 tests
npm run typecheck
npm run vcv -- validate examples/enrollment/model.rev-1.yaml
npm run vcv -- init .vcv-store examples/enrollment/model.rev-1.yaml
npm run vcv -- propose .vcv-store examples/enrollment/change.timeout.yaml --as agent:mcp --perm propose
npm run vcv -- approve .vcv-store ch-timeout-01 --as hoang
npm run vcv -- show .vcv-store --tree
npm run vcv -- query .vcv-store search enrollment notifications --kind module
npm run vcv -- query .vcv-store impact evt-enrollment-rejected
node --experimental-strip-types apps/mcp/src/main.ts --store .vcv-store   # MCP over stdio
npm run vcv -- project init <checkout> examples/enrollment/model.rev-1.yaml # create <checkout>/.vcv explicitly
npm run vcv -- project status <checkout>                                    # model + Git state, read-only
```

## Repository projects (M2)

A project lives in `.vcv/` at the root of a Git checkout and is committed with the code.
`vcv project status` finds it from any subdirectory and reports `ready`, `absent`,
`uninitialized`, `conflicted`, `diverged` or `invalid`, with the checkout's commit, branch and
dirty state as observation context. Nothing is created or repaired by looking. New model
revisions are named `rev-<seq>-<digest>` so two branches never mint the same ID, and a merged
or half-merged `.vcv/` is refused rather than silently reset. See ADR 0007.

## Agent access (MCP)

`apps/mcp` lets any MCP client (Claude Code, Codex, others) read the model of one local store
(draft or approved) through `vcv_get_project_overview`, `vcv_search_objects`, `vcv_get_context` and
`vcv_analyze_impact`. It is a transport adapter over `@vcv/query`; results are model intent only
(`implementationChecked: false`). Client configs, opt-in `AGENTS.md`/`CLAUDE.md` guidance and
the agent workflow are in [apps/mcp/README.md](apps/mcp/README.md); a recorded Claude Code run is
in [docs/samples/mcp-agent-demo.md](docs/samples/mcp-agent-demo.md).

## Spec acceptance cases (§10)

| # | Case | Where |
|---|------|-------|
| 1 | Serialize/load keeps IDs, names, meaning | ir `AC1` |
| 2 | Reject duplicate IDs (incl. state, attribute) and wrong-kind refs | ir `AC2` |
| 3 | Reject multiple parents, wrong-kind or missing owners | ir `AC3` |
| 4 | Reject unknown initial/from/to state | ir `AC4` |
| 5 | State rename keeps references | core `AC5/AC14` |
| 6 | Reject nonexistent event IDs | ir `AC6` |
| 7 | Reject external event without contract boundary | ir `AC7` |
| 8 | Permission guard must hit a permission rule with real actor/capability | ir `AC8` |
| 9 | Timer anchor must be an existing temporal attribute | ir `AC9` |
| 10 | Unresolved refs only in drafts; can't approve while unresolved | ir + core `AC10` |
| 11 | Atomic change sets | core `AC11` |
| 12 | ChangeRecord outcomes with host-verified proposer/approver | core `AC12` (×2) |
| 13 | Revalidate approvals; reject stale and replayed changes | core `AC13` (×2) |
| 14 | Rename/remove with referential integrity, incl. nested | core `AC14` |
| 15 | Bindings carry modelRevision + commit; stale, not disputed | core `AC15` |
| 16 | Layout edits never create revisions | core `AC16` |

Not covered yet: detecting a divergent code change (needs the repository indexer, Slice 3).

## Hardening (beyond §10)

| Area | Tests |
|------|-------|
| Crash before each write/rename of each commit step, recovery, retry | `core/test/store.test.ts` |
| Persisted-ID grammar (lowercase only), structured errors, nothing written outside the store | `core/test/ids.test.ts` |
| Which attempts create records, attempt log, pending preserved on denied approvals | `core/test/audit.test.ts` |

The file store assumes a **single writer**; see ADR 0003 for the commit protocol and its
limits. CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck and tests on Node 22.18.0
and the latest 22.x for pushes to `main` and every pull request.

## Decisions the spec left open (made here, review them)

1. **Rule `name` is optional.** The spec's own permission-rule example has no name.
2. **Emitting another module's event** requires a consumed contract of that module that
   `accepts` it (triggers on a foreign event need `publishes`). The spec only describes
   the publish direction.
3. **Fixing a draft needs targeted operations.** Added `setModuleDependencies`. The spec's
   `updateObject` is not implemented because a generic version is a JSON patch in disguise.
4. **`approveDraft` needs approve rights** even for principals that can apply changes.
5. **Self-approval is forbidden by default** (`allowSelfApproval` policy flag).
6. The rejection event still carries no reason, so timeout and lecturer rejections look the
   same to consumers (spec open question 2).
