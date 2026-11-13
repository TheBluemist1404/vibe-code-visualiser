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
