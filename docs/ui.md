# The architecture explorer

`apps/ui` is the local explorer from M5 ([Issue #39](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/39)):
one canvas of the project's modules beside a structured inspector, where edits can be staged
and submitted as pending proposals. This page explains how it is built and what it
deliberately does not do. For running it, see the [README](../README.md).

```sh
npm run ui -- <checkout> [--port N] [--as <principal>]   # default port 4870, bound to 127.0.0.1 only
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
| `src/edits.ts` | Which fields are editable, the typed operation each becomes, and why the rest is read-only |
| `src/proposals.ts` | Drafts to typed changes: dry run with `previewProposal`, record with `submitProposal`, list pending |
| `src/layout.ts` | Pure, deterministic placement: layered auto layout, reconcile with stored positions, tidy |
| `src/layout-store.ts` | Positions on disk, outside the checkout |
| `src/types.ts` | The JSON contract shared with the client (types only) |
| `web/` | The client: project bar, module list, canvas, inspector, staged change tray, state screens |

The host is a caller of the existing packages. It has no model rules of its own: every read
takes one snapshot from `FileStoreReader` and answers queries through `@vcv/query` bound to that
snapshot, so a response never mixes two revisions.

## Reading a checkout

Every `GET /api/project` runs `projectStatus` again, so a branch switch, a merge or a new
revision shows up on the next read. The client polls every 3 seconds and on window focus.

Each read is consistent: the host observes the checkout, reads the model, and observes again.
It serves the model only when both observations agree on the model identity, commit and
branch, and the model read is the revision they name. If the checkout moved in between (a
branch switch mid-read), the read is retried up to three times, then answered with
`409 STATE_CHANGED`.

**Model identity** is the revision ID plus a digest of its revision file (`modelKey`), because
two branches can hold different models under the same initial ID (`rev-1`). Every module and
object answer carries the `modelKey` it was read from. The inspector shows an answer only when
it matches the canvas's current `modelKey`; after a branch switch or a new revision it shows a
loading state until the new details arrive, never the previous model's details.

- **ready**: the model is served, with the Git branch, commit and dirty state.
- **absent, uninitialized, conflicted, diverged, invalid**: no model is served. The client
  shows the state with the host's diagnostics, verbatim, and the command a person would run.
  The explorer never runs `project init`, never resolves a conflict and never rewrites a file.
- When the served model line moves (advanced, rewound, switched, appeared, disappeared), the
  response carries a `lastChange` with the revisions, branches and added or removed modules,
  and the client shows a banner.

Tests check that reading, selecting, inspecting and previewing leave every file in the checkout
unchanged.

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
- **The view never moves on its own** after the first fit: a refresh that adds or removes
  modules keeps the user's pan and zoom. **Fit** and the banner's **Locate new** move it on request.

`@vcv/core`'s in-memory `LayoutStore` is not used: positions here must survive restarts and
live outside the checkout, so they have their own small file store.

## Editing through proposals

Edits in the inspector never change the model. They become typed operations, are checked by
the engine, and are recorded as a **pending proposal** for a separate reviewer.

| Field | Objects | Typed operation |
|---|---|---|
| Name | modules and top-level objects | `renameObject` |
| Description | modules and top-level objects | `setDescription` |
| Statement | rules / criteria | `setRuleStatement` / `reviseCriterion` |
| Depends on | modules | `setModuleDependencies` |

Everything else is read-only and says why: IDs never change, a module's **purpose** has no
typed operation yet, `consumes` needs `linkContract` (not offered here), owners cannot move,
and nested elements (states, transitions, attributes) are not edited from the inspector yet.
The host decides this (`src/edits.ts`) and sends it with every module and object answer, so
the client has no rules of its own; the engine decides whether the result is valid.

- **Staging.** A draft lives in the browser and records the revision and model identity it was
  staged on. Staging a field's current value unstages it. Modules with staged edits are marked
  on the canvas.
- **Checking.** Every change to the draft, and every move of the model, runs
  `POST /api/proposals/preview`: the host builds the change with the draft's own
  `expectedRevision` and calls `previewProposal`, which runs the engine's `checkChange`. The
  tray shows the operations, errors and warnings with their hints, the fields changed and the
  modules touched. Nothing is written. An operation that does not match its schema (an empty
  name) comes back as a `SCHEMA` error on that operation.
- **Stale drafts.** When the model moves, the draft keeps its `expectedRevision`; the engine
  answers `STALE_REVISION` and submit is disabled. **Restage** is the person's explicit choice to
  check the same edits against the current model. A draft from another model under the same
  revision ID (a branch switch between two `rev-1`s) is refused with `409 STALE_DRAFT` before
  its edits are read, because the engine compares revision IDs only.
- **Submitting.** `POST /api/proposals/submit` previews again and records nothing unless the
  draft applies cleanly (`422` with the preview otherwise). Then `submitProposal` records it as
  pending under a fresh change ID (`ui-<date>-<time>-<hex>`) for the host's proposer (`--as`, else
  `VCV_HOST_PRINCIPAL`, else `local-user`), with `model:propose` only. `.vcv/HEAD` and Git HEAD
  do not move. The answer carries the `vcv proposal preview` and `vcv review approve` commands.
- **Waiting for review.** `GET /api/proposals` lists pending and stale proposals in the project
  view. Reviewing and approving them is M5.4, and approval stays outside the browser.

## Trust boundary

The browser is not a trust boundary, and neither is this host for anything beyond reading.

- The host listens on 127.0.0.1 only and refuses requests whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) or whose `Origin` is another site.
- Every write takes a JSON body (a cross-site form cannot send one). Layout changes write only
  the layout file. A submitted proposal writes only its change record under `.vcv/changes/`,
  through `submitProposal`, which holds `model:propose` and refuses to move `.vcv/HEAD`.
- There is no approve route. Approval stays the reviewer's `vcv review approve` with their own
  key ([approvals](approvals.md)); the browser shows the command, never performs it. The
  proposer named by `--as` is a label for the record, not a proof of identity, the same as on
  the CLI.

## What the canvas shows

- One node per module: name, ID, declared purpose, and counts of what it owns, coloured by kind.
  Colour tells kinds apart only; it never means a state or evidence.
- One arrow per declared relationship, from the module that declares `dependsOn` (or
  `consumes` a contract) to the module depended on. Direction comes from the declaring field,
  never from where nodes sit.
- Related objects open under the module that owns them (from the object's own record), so
  following a criterion in Web to a capability in Enrollment selects Enrollment. Project-level
  objects such as actors select no module.
- Selecting a module highlights its relationships (animated, labelled) and dims the rest. The
  module list beside the canvas is the keyboard and screen-reader path: `/` filters, `Esc`
  returns to the project.
- Motion (entrances, hover lift, flowing highlighted edges) is switched off under
  `prefers-reduced-motion`. The theme follows the system light or dark setting.

## Tests

- `apps/ui/test/layout.test.ts`: placement, determinism, cycles, reconcile and tidy.
- `apps/ui/test/host.test.ts`: the HTTP API on real Git checkouts made with `initProject` and
  `ModelEngine`: direction, inspector data, pins across a restart, a later revision on a branch,
  every non-ready state, the Host/Origin checks, model identity for same-ID revisions, retrying
  a read when the branch switches mid-read, and owner modules on relations.
- `apps/ui/test/proposals.test.ts`: the editable-field table, dry runs that write nothing,
  engine errors that block submit, a pending proposal that moves neither `.vcv/HEAD` nor Git
  HEAD, stale drafts keeping their `expectedRevision`, same-ID drafts from another model, and
  refused edits (unknown objects, read-only fields, duplicates; no approve route).
- `apps/ui/e2e/editing.e2e.ts`: stage, check and submit in Chromium (10), errors and warnings
  with submit disabled (11), and a draft that goes stale and is restaged (12).
- `apps/ui/e2e/explorer.e2e.ts`: the built client in Chromium (Playwright), covering the first
  PR's acceptance tests 1 to 5, plus: no mixed-model inspector across a branch switch, cross-module
  object links, the viewport surviving refreshes, and reduced motion. `npm run test:ui`; set
  `VCV_UI_SHOTS=<dir>` to keep screenshots (taken once finite animations have finished).
  CI runs it in the `ui` job and uploads the screenshots.

## Not yet

Editing purpose, contracts, nested elements and creating or removing objects from the
inspector; proposal review and approval (M5.4); source and test evidence (M5.5); and opening a
different checkout from the browser. Projects with more than
1000 modules show the first 1000 and say so.
