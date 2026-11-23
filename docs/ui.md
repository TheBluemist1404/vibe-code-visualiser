# The architecture explorer

`apps/ui` is the local, read-only explorer from M5 ([Issue #39](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/39)):
one canvas of the project's modules beside a structured inspector. This page explains how it
is built and what it deliberately does not do. For running it, see the [README](../README.md).

```sh
npm run ui -- <checkout> [--port N]   # default port 4870, bound to 127.0.0.1 only
```

## Shape

```
browser (React, @xyflow/react)  ──HTTP JSON──▶  host (Node, apps/ui/src)  ──▶  @vcv/repo  projectStatus
        apps/ui/web                                  127.0.0.1 only               @vcv/core  FileStoreReader
                                                                                   @vcv/query overview, context
                                                                                   layout file (outside the checkout)
```

| File | Role |
|---|---|
| `src/main.ts` | Entry point: arguments, start the host, print the URL |
| `src/server.ts` | HTTP routing, static files, Host/Origin checks |
| `src/session.ts` | One checkout: observe it on every read, serve the model only when ready, track model-line changes |
| `src/graph.ts` | Module graph from one model snapshot (nodes from the query overview, edges from `dependsOn`/`consumes`) |
| `src/inspector.ts` | Module and object read models, from `getContext` on the same snapshot |
| `src/layout.ts` | Pure, deterministic placement: layered auto layout, reconcile with stored positions, tidy |
| `src/layout-store.ts` | Positions on disk, outside the checkout |
| `src/types.ts` | The JSON contract shared with the client (types only) |
| `web/` | The client: project bar, module list, canvas, inspector, state screens |

The host is a caller of the existing packages. It has no model rules of its own: every read
takes one snapshot from `FileStoreReader` and answers queries through `@vcv/query` bound to that
snapshot, so a response never mixes two revisions.

## Reading a checkout

Every `GET /api/project` runs `projectStatus` again, so a branch switch, a merge or a new
revision shows up on the next read. The client polls every 3 seconds and on window focus.

- **ready**: the model is served, with the Git branch, commit and dirty state.
- **absent, uninitialized, conflicted, diverged, invalid**: no model is served. The client
  shows the state with the host's diagnostics, verbatim, and the command a person would run.
  The explorer never runs `project init`, never resolves a conflict and never rewrites a file.
- When the served model line moves (advanced, rewound, switched, appeared, disappeared), the
  response carries a `lastChange` with the revisions, branches and added or removed modules,
  and the client shows a banner.

Tests check that reading, selecting and inspecting leave every file in the checkout unchanged.

## Layout

Placement is presentation state. It never touches `.vcv/` and never creates a revision.

- **Automatic placement** is layered, top to bottom: a module sits one row below every module
  that depends on it, so arrows point down to dependencies. Rows are ordered by module ID, so
  the same model always gives the same picture. A cycle is broken at the closing edge.
- **Stored positions** are kept for every placed module, keyed by stable IR ID, in
  `$VCV_UI_STATE_DIR`, else `$XDG_STATE_HOME/vcv/ui`, else `~/.local/state/vcv/ui`, one file per
  checkout path and project ID. A missing or unreadable file reads as empty.
- **On a model change**, modules that still exist keep their positions (pinned or not), so
  unrelated nodes never jump. A new module gets its automatic slot, moved along its row to the
  first free spot. Removed modules are dropped.
- **Dragging** a module pins it where it was dropped. **Unpin** keeps it in place until the next
  **Tidy layout**, which returns every unpinned module to its automatic slot and leaves pinned
  ones alone.
- An edge whose straight path would cross another module bows out to the side.

`@vcv/core`'s in-memory `LayoutStore` is not used: positions here must survive restarts and
live outside the checkout, so they have their own small file store.

## Trust boundary

The browser is not a trust boundary, and neither is this host for anything beyond reading.

- The host listens on 127.0.0.1 only and refuses requests whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) or whose `Origin` is another site.
- The only writes are layout changes, which take a JSON body (a cross-site form cannot send
  one) and write only the layout file.
- Model edits, approval and evidence are not in this slice. When they come, semantic edits will
  go through typed proposals, and approval stays the reviewer's `vcv review approve` with their
  own key ([approvals](approvals.md)); the browser will show the command, not perform it.

## What the canvas shows

- One node per module: name, ID, declared purpose, and counts of what it owns, coloured by kind.
  Colour tells kinds apart only; it never means a state or evidence.
- One arrow per declared relationship, from the module that declares `dependsOn` (or
  `consumes` a contract) to the module depended on. Direction comes from the declaring field,
  never from where nodes sit.
- Selecting a module highlights its relationships (animated, labelled) and dims the rest. The
  module list beside the canvas is the keyboard and screen-reader path: `/` filters, `Esc`
  returns to the project.
- Motion (entrances, hover lift, flowing highlighted edges) is switched off under
  `prefers-reduced-motion`. The theme follows the system light or dark setting.

## Tests

- `apps/ui/test/layout.test.ts`: placement, determinism, cycles, reconcile and tidy.
- `apps/ui/test/host.test.ts`: the HTTP API on real Git checkouts made with `initProject` and
  `ModelEngine`: direction, inspector data, pins across a restart, a later revision on a branch,
  every non-ready state, and the Host/Origin checks.
- `apps/ui/e2e/explorer.e2e.ts`: the built client in Chromium (Playwright), covering the first
  PR's acceptance tests 1 to 5. `npm run test:ui`; set `VCV_UI_SHOTS=<dir>` to keep screenshots.
  CI runs it in the `ui` job and uploads the screenshots.

## Not yet

Editing from the inspector (M5.3), proposal review and approval (M5.4), source and test
evidence (M5.5), and opening a different checkout from the browser. Projects with more than
1000 modules show the first 1000 and say so.
