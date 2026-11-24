# The architecture explorer

`apps/ui` is the local explorer from M5 ([Issue #39](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/39)):
one canvas of the project's modules beside a structured inspector, where edits can be staged
into local drafts and handed off to a coding agent ([Issue #41](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/41)).
This page explains how it is built and what it deliberately does not do. For running it, see
the [README](../README.md).

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
| `src/edits.ts` | Which fields are editable, the typed operation each becomes, and why the rest is read-only |
| `src/drafts/format.ts` | The draft file format (`vcv-ui-draft-1`), limits, and the checks every file passes on load |
| `src/drafts/store.ts` | Draft files outside the checkout: scoped directories, version-checked atomic writes, discard |
| `src/drafts/service.ts` | The draft workflow: create, stage, unstage, rationale, discard, dry run, export |
| `src/drafts/preview.ts` | The dry-run adapter over `@vcv/repo` `previewProposal` |
| `src/drafts/handoff.ts` | The export: a strict proposed change plus separate metadata |
| `src/drafts/routes.ts` | The `/api/drafts` routes |
| `src/layout.ts` | Pure, deterministic placement: layered auto layout, reconcile with stored positions, tidy |
| `src/layout-store.ts` | Positions on disk, outside the checkout |
| `src/types.ts` | The JSON contract shared with the client (types only) |
| `web/` | The client: project bar, module list, canvas, inspector, draft panel and handoff dialog, state screens |

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

## Drafts and the agent handoff

Edits in the inspector never change the model. They are staged as typed operations into a
**local draft**, checked by the engine's dry run, and handed off to an external coding agent as
a proposed change. Integrating it with code and tests, and submitting it, is the agent's work;
approving it is a reviewer's, with `vcv review approve` and their own key.

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

**Draft files.** `$VCV_UI_STATE_DIR/drafts/<key>/<draftId>.json` (same state directory as the
layout, never under the checkout or `.vcv/`). `<key>` hashes the checkout root and project ID,
so another checkout or project never sees the draft. A file holds the format
(`vcv-ui-draft-1`), the draft ID, a version, the checkout root and project ID, the **base**
model (revision, full `modelKey`, branch, commit), the ordered steps and the rationale. Each
step stores the typed operation built **when it was staged**, against the base model, plus
display context (object, field, before and after).

- **Writes** go to a temporary file and are renamed into place. Every change names the version
  it was made on; a mismatch is `409 DRAFT_CONFLICT` with the current draft, and nothing is
  overwritten. Two tabs on one draft therefore get an explicit conflict (the client reloads the
  draft and says the edit was not applied); a tab can also start its own draft. The host is one
  process, so its version check and write do not interleave; two hosts on one state directory
  are not guarded beyond that.
- **Reads** check size (256 KiB), format, scope and shape. A corrupt, oversized, foreign or
  unknown-format file is reported (`DRAFT_CORRUPT`, `DRAFT_TOO_LARGE`, `DRAFT_FOREIGN`,
  `DRAFT_UNSUPPORTED_FORMAT`), left as it is, and deleted only when someone discards it.
- **Limits:** 50 steps, 4000-character rationale and text values, 20 drafts per project, 64 KiB
  request bodies.
- **Correcting** a field replaces its step in place; staging the model's own value removes it.

**Staleness is information.** A draft whose base `modelKey` differs from the checkout's (a new
revision, or a branch switch to another model with the same revision ID) is **stale: needs
agent integration**. Its base and operations stay exactly as staged: the host refuses new edits
to it (`409 DRAFT_STALE`), there is no restage, and the dry run and export stay on the original
base revision, where the engine answers `STALE_REVISION`. Switching back to the base makes it
current again.

**Dry run.** `POST /api/drafts/:id/preview` builds the change from the stored operations and
calls `previewProposal`, the engine's `checkChange`. The panel shows errors and warnings with
hints, the before and after of each changed field, the modules touched and what was not
verified, labelled as an unsubmitted draft. An operation that does not match its schema (an
empty name) comes back as a `SCHEMA` error on that operation; it stays in the draft for repair.

**Handoff.** `GET /api/drafts/:id/export` returns:

- `change`: a strict `ProposedModelChange` (`changeId`, `projectId`, `expectedRevision` = the
  base, `rationale`, `operations`), which `vcv proposal preview --file` and `vcv proposal submit`
  read as is. The change ID is `ui-<draft>-v<version>`, so a later version is a new change. No
  proposer, approver, status or signature.
- `metadata`, kept apart: draft ID and version, checkout root, base and current model identity,
  and the dry run's verdict (`valid`, `warnings`, `invalid` or `stale`) with `needsAgent`. An
  invalid or stale export is labelled as needing repair or integration, never as valid.

The dialog shows both, with Copy and Download and the CLI command to check the file.

## Trust boundary## Trust boundary

The browser is not a trust boundary, and neither is this host for anything beyond reading.

- The host listens on 127.0.0.1 only and refuses requests whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) or whose `Origin` is another site.
- Every write takes a JSON body (a cross-site form cannot send one) and writes only files in
  the UI state directory: the layout file and draft files. Nothing under the checkout, `.vcv/`
  or Git is written; tests compare the checkout byte for byte.
- There is no submit, apply or approve route. Recording a proposal is the agent's step (`vcv
  proposal submit`); approval stays the reviewer's `vcv review approve` with their own key
  ([approvals](approvals.md)).
- `FileStore`'s fingerprint and HEAD check is not an inter-process lock. Serialized canonical
  writes are M5.6, and no endpoint that writes the model may be added before them.

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
- `apps/ui/test/drafts.test.ts`: the editable-field table; a multi-module draft of ordered typed
  operations whose dry run matches `@vcv/repo` and writes nothing; an export that passes
  `proposedChangeSchema` and the real CLI's `proposal preview --file`; invalid operations kept
  and labelled; stale drafts after a new revision and after a same-ID branch switch; recovery
  after a host restart, discard of one draft only, and isolation from another checkout; two-tab
  version conflicts; corrupt, oversized and foreign files; refused input and the absence of any
  submit or approve route.
- `apps/ui/e2e/editing.e2e.ts`: in Chromium, the golden path from inspector edits across two
  modules to the handoff (10), an error and a warning (11), reload, host restart and a second
  tab (12), a stale draft (13), and an unreadable draft file (14).
- `apps/ui/e2e/explorer.e2e.ts`: the built client in Chromium (Playwright), covering the first
  PR's acceptance tests 1 to 5, plus: no mixed-model inspector across a branch switch, cross-module
  object links, the viewport surviving refreshes, and reduced motion. `npm run test:ui`; set
  `VCV_UI_SHOTS=<dir>` to keep screenshots (taken once finite animations have finished).
  CI runs it in the `ui` job and uploads the screenshots.

## Not yet

Editing purpose, contracts, nested elements and creating or removing objects from the
inspector; submitting, reviewing and approving proposals (M5.4); serialized canonical writes
(M5.6); source and test evidence (M5.5); and opening a
different checkout from the browser. Projects with more than
1000 modules show the first 1000 and say so.
