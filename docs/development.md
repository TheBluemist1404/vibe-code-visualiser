# Development

Notes for working on VCV itself. For using VCV, start at the [README](../README.md).

## Workspace

An npm workspace with no build step: Node 22.18+ runs the TypeScript sources directly
(`--experimental-strip-types`), and each package's `exports` points at `src/index.ts`.

| Package | Depends on | Role |
|---|---|---|
| `@vcv/ir` | – | IR types, zod schema, validation, graph projections, YAML |
| `@vcv/core` | ir | Typed operations, `ModelEngine`, model stores, binding shapes |
| `@vcv/query` | core, ir | Read-only semantic queries |
| `@vcv/repo` | core, ir, query | `.vcv/` in a Git checkout: bindings, proposals, review, pre-merge |
| `@vcv/cli` (`apps/cli`) | all packages | The `vcv` command |
| `@vcv/mcp` (`apps/mcp`) | core, query, repo | The stdio MCP server |

Every package lists the `@vcv/*` packages it imports in its `package.json`, and code imports
other packages only by name (`@vcv/core`), never by a relative path into their `src/`.
`@vcv/repo` pins TypeScript 6 for its syntax-only compiler API use; the repository's type
checker is TypeScript 7 (see [bindings](bindings.md#locators)).

### Inside `@vcv/repo`

| Folder | What lives there |
|---|---|
| `src/project.ts` | Finding `.vcv/` in a checkout and its readiness |
| `src/git/` | The read-only Git driver and working-tree identity |
| `src/bindings/` | Binding claims: locators, the TypeScript resolver, verification, evidence queries |
| `src/changes/` | The model-first path: proposals, reviewer approval, history integrity, handoff, implementation reports |
| `src/premerge/` | The code-first path: reconciliation, acceptance criteria, JUnit capture, test runs, the gate |
| `src/shared/` | What every area uses: the `RepoResult` envelope, consistent observations, model diffs, claim reads, redaction |

Dependencies point one way: `premerge/` builds on `changes/` (integrity) and `bindings/`;
`changes/` builds on `bindings/`; everything may use `git/`, `shared/` and `project.ts`; nothing
imports `premerge/`.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | All package and app tests (`node --test`) |
| `npm run typecheck` | `tsc` over every package and app |
| `npm run lint` | Biome lint, warnings included |
| `npm run format` | Format with Biome (2 spaces, 120 columns) |
| `npm run check` | What CI runs: formatting and lint errors |

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(repo): …`, `fix(core): …`, `docs: …`).
- The README is for users; design notes, specs and conformance go under `docs/`.
- Mechanical reformat commits are listed in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once to skip them in `git blame`.
