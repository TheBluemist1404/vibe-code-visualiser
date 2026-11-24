# The architecture explorer

`apps/ui` is the local explorer from M5 ([Issue #39](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/39)):
one canvas of the project's modules beside a structured inspector, where edits can be staged
into local drafts and handed off to a coding agent ([Issue #41](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/41)),
and a read-only proposal inbox shows recorded proposals and how a reviewer approves one
([Issue #44](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/44)).
This page explains how it is built and what it deliberately does not do. For running it, see
the [README](../README.md).

```sh
npm run ui -- <checkout> [--port N] [--protected-base <ref>]   # default port 4870, bound to 127.0.0.1 only
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
| `src/proposals.ts` | The proposal inbox over `listProposals`, `previewProposal` and `checkIntegrity`, read-only |
| `src/evidence.ts` | Evidence, implementation and pre-merge views over `@vcv/repo`, read-only |
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

## The proposal inbox

`#/proposals` (the **Proposals** tab, with the pending count) lists what `listProposals` finds in
`.vcv/changes/`, whoever submitted it, polled every 3 s. Selecting one shows
`previewProposal` and `checkIntegrity` results and nothing else (`src/proposals.ts`):

- Header: change ID, lifecycle, the full `proposalDigest`, proposer and approver **as recorded**
  (labelled as not proof), base revision and the model now.
- **Where it stands**, five facts from five sources, each `done`, `not yet`, `failed` or
  `unknown`, and none implying another:
  1. *Submitted*: the record exists (rejected records say they are final).
  2. *Reviewer signature*: `checkIntegrity` without a trust source. Done means an attestation for
     this digest verifies and matches the record; whether the key is trusted is not checked.
     No attestation is a failure, whatever approver the record names.
  3. *Integrity under protected base*: `checkIntegrity` with `--base <ref>` and the trust list
     from `<ref>`, only when the host was started with `--protected-base <ref>`. Otherwise
     **unknown**, never green. When it passes, the step is relabelled *Integrity, checked locally
     (caller-asserted base)*, and its detail says the ref was named by whoever started the
     explorer and can be moved locally. It is not the hosting service's verdict; CI's check
     against the protected branch is the authority.
  4. *Model applied*: the resulting revision is in this checkout's history. Shown as done only on that positive evidence, taken from the record's own summary in the same read as the preview (`previewProposal`'s `record`), never from the capped list. A record that names no resulting revision, or one this history lacks, is unknown.
  5. *Implementation*: always unknown here (reconciliation is M4's `vcv reconcile`).
- The engine's check and delta, as for drafts. An applied change is shown against its base and
  not rechecked (a recheck would always say `STALE_REVISION`).
- Binding claims on changed or impacted objects, and what the integrity check cannot establish.
- **Pending**: "Approve in your own terminal" with `vcv proposal preview` and `vcv review approve
  … --digest <this digest> --key <your reviewer key file> --trust-commit <protected base commit>`.
  The key path and the commit are placeholders: the host knows neither, and the commit must come
  from the hosting service, not from this checkout.
- **Stale, rejected or unreadable**: "Back to an agent", with what the agent reads. Nothing
  offers a rebase, a retry or an edit of the recorded proposal.

Each answer (the list, or one review) is composed from one observed state (`src/observe.ts`).
An identity of the checkout is taken before the first read and after the last, and the reads
are discarded and retried if the two differ. The identity covers:
- the model key;
- the Git commit, branch and dirty state;
- every byte under `.vcv/` except `cache/`: records, attestations, the trust list, HEAD and
  revisions;
- the protected base's resolved commit.

A checkout that keeps moving is `409 STATE_CHANGED`, so a review never shows a pending preview
next to an applied summary or a signature from another state. The revision ID alone is not
trusted, because two branches can share it and records change without HEAD moving.

The identity is exact or it is refused with `422 OBSERVATION_LIMIT`; nothing is served then.
- File contents are hashed in full. Size and mtime never stand in for bytes, since both can be
  kept while the content changes.
- A symlink is hashed by its link text.
- A FIFO, socket or device, or an entry that cannot be read, is refused rather than skipped.
- Past the budget (5,000 files or 64 MiB under `.vcv/`, outside `cache/`) the store is refused.
- Files are opened by descriptor, never through a final symlink and never blocking on a FIFO
  (`O_NOFOLLOW | O_NONBLOCK`). They are re-checked with `fstat` and streamed, and the bytes
  actually read count against the budget. A swap after the `lstat` to a symlink, a FIFO or a
  file that grew past the budget is refused, as is a directory replaced while it was listed.
- Every read is contained during path resolution, not checked afterwards.
  - The checkout's real root is opened once as a directory descriptor.
  - Each folder below it is opened relative to its parent's descriptor (`/proc/self/fd/<fd>/<name>`) with `O_NOFOLLOW`, so no part of the path is ever followed through a symlink.
  - A folder swapped for a symlink fails to open and is refused.
  - A folder swapped after it was opened is still read through the descriptor that was opened, which is inside the checkout.
  - Listings, `lstat`, `readlink` and file opens all go through the held descriptors.
- Where the platform has no descriptor-relative open (no `/proc/self/fd`: macOS, Windows), nothing is observed. The inbox answers `422 OBSERVATION_LIMIT` there rather than fall back to a weaker path-based read.

The answer itself is read under the same boundary, not only the identity, for the inbox and the
evidence views alike. Both identity checks
and the read between them run inside one contained scope (`withContainedReads` in
`packages/core/src/contained.ts`):
- While the scope is active, the repository readers behind the inbox (store files, change
  records, attestations, the trust list, implementation reports, binding claims, source files
  and the pre-merge worktree walk) resolve every path under the checkout from the root's descriptor, one folder at a time
  with `O_NOFOLLOW`, as the identity walk does.
- A folder on the way that is a symlink when it is reached is a containment violation. The whole
  answer is then refused with `422 OBSERVATION_LIMIT`, even if a reader caught the error, so no
  answer is built from a partial read.
- A symlink inside the checkout that a binding legitimately goes through is still resolved: its
  target is checked to be inside the checkout, and the read then walks the real path.
- Where the scope cannot be enforced, the inbox serves nothing (`422 OBSERVATION_LIMIT`).
- Outside the host, for example in the CLI, the readers are the plain filesystem calls they were
  before.
- Git runs as a subprocess and is not inside the boundary. What the inbox takes from Git (the
  commit, branch, dirty state and the protected base's commit) is part of the identity, and Git
  objects are content-addressed.

When a reviewer approves in their terminal, the page follows on its next poll: the record turns
applied, the signature step verifies, and the pending count drops.

There is no browser submit in this version. Issue #44 allows one only after the writer lock
(#43) is merged; when it comes, it must go through `submitProposal` (proposal-only, `model:propose`)
and so through the same lock as the CLI (ADR 0010).

## Evidence and the pre-merge page

`src/evidence.ts` is a thin adapter over functions the CLI already uses. It decides nothing
itself, and every answer is a new observation of the checkout. Each part labels what kind of
thing it shows: a claim (something an agent or person asserted) or an observation (what VCV
checked just now, with the limits of that check).

- **Object evidence** (`GET /api/evidence/objects/:id`, in the inspector under *Code and test
  evidence*) comes from `getObjectEvidence`. It lists every binding claim about the object, up to
  50, and labels how many it found when the list is cut. For each claim it shows:
  - the claim's state (resolved, stale, missing, ambiguous, unchecked, indeterminate or
    unreadable);
  - the locator as written;
  - who claimed it and how, *as the claim says*;
  - whether the pointer resolves now (line and match count);
  - whether the code and the model object changed since the claim, each with its cause;
  - whether it is disputed.

  A footnote repeats that "resolved and fresh" is not evidence that the code does what the model
  says.
- **Criteria** add `criteriaEvidence`: the mapping state, each mapped test case, and a result from
  the test-run records given at start (`--run`). Without runs the result is *unverified*, and the
  page says that it runs nothing. A record handed to the host is always a claim, whatever it
  declares (`RESULT_CLAIMED`). The host has no `tests:observe` permission and captures nothing.
- **Module evidence** (`GET /api/evidence/modules/:id`) is `getEvidenceOverview`, up to 200
  claims, grouped by the module's owned objects and counted by state. It says when the overview
  was cut.
- **Implementation** (`GET /api/proposals/:id/implementation`, on an applied proposal) shows
  three layers that are kept apart:
  - *approved intent*: `buildHandoff`, meaning the request, the scope and the claims that
    probably move with the change;
  - *the agent's report*: the recorded report, shown as claims with the report's own note that
    VCV verified none of it;
  - *what VCV observes now*: from `implementationStatus`, the files changed, out-of-scope paths,
    claim states, and whether each claim was re-claimed after implementing.

  Then come the warnings and the "not reconciled" note. A change that is not applied and
  attested here has no handoff, and the page says why.
- **Before merging** (`#/gate`, `GET /api/gate`) runs `reconcile` (pinned to the base,
  attestation required) and `preMergeGate` against `--base-commit <sha>`.
  - The base must be a full commit ID that the person starting the explorer copied from the
    hosting service. It is never guessed from local branch names. Without it, nothing runs and
    the page names the missing flag.
  - The decision, headline, reasons (with severity, basis and rule), criteria and runs are the
    gate's own. Reconciliation findings are listed as facts with their category and basis, and
    are not coloured as a verdict.
  - Integrity says *caller-asserted*: CI's gate against the protected branch is the authority.
  - A policy file can be given with `--policy`. Test-run and policy files are read once at
    start; the host never re-reads or writes them.
  - The page reads when it opens and whenever the model moves. **Check again** re-reads after a
    code edit; it is still only a read.

Each answer runs its reads between two checkout identities, as the inbox does (`src/observe.ts`).
Because these views inspect source and test files, their identity also covers the source state.
This is the supported source path model:

| Path | How it is observed |
|---|---|
| Committed, unchanged files | the commit ID |
| Every path `git status` reports as changed or untracked (not ignored) | its bytes |
| A symlink among those | its link text, plus where the binding verifier resolves it and the bytes there; or the fact that it leaves the checkout (which the resolver refuses) |
| Every file a binding claim's locator names, including ignored files and files behind symlinked folders | the bytes the resolver would read, resolved by the resolver's own `resolveInside` |
| A submodule or nested repository with changes | refused: its working tree is not observed here |

A dirty→dirty edit, a retargeted symlink, or a change to an ignored file a claim reads is
therefore seen between two reads. The reads are then retried, or refused with `STATE_CHANGED`.
As a result, the reconciliation and the gate on the pre-merge page always describe the same
source state.

These cases are `422 OBSERVATION_LIMIT`, and the answer is refused, not guessed:
- more than 2000 such paths, or more than 32 MB of them;
- a special file (FIFO, device);
- an unreadable file;
- a changed submodule;
- a file that turns into a symlink or a special file between the listing and the read.

Each path is first resolved by the binding verifier's own rules (`resolveInside` in
`@vcv/repo`): names match case exactly, and a symlink anywhere in the path is followed only if it
stays inside the checkout. So a locator through an in-checkout symlinked folder is observed where
the resolver reads it, and one that leaves is recorded as unsafe and never read. The resolved
path is then read like the store: from the root descriptor, one folder at a time with
`O_NOFOLLOW`, non-blocking and `fstat`-checked, with the bytes actually read counted against the
32 MB budget.

Ignored files that no claim names are outside the model. No evidence view reads them.

On the pre-merge page, a passing integrity check reads "checks passed locally against the base
commit given at start (caller-asserted; not an authorization)". The check establishes
consistency and attestation under that anchor only. CI's gate against the protected branch is
the authority.

The client sends the model key it is showing (`?model=<key>`). If the checkout has moved on, the
host answers `409 STATE_CHANGED` rather than describing a model the page is not showing. The
next poll brings the new model, and the panels reload for it. The evidence routes answer GET
only, and any other method is `405 READ_ONLY`. There is no reassert, record, capture or run route.

## Trust boundary

The browser is not a trust boundary, and neither is this host for anything beyond reading.

- The host listens on 127.0.0.1 only and refuses requests whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) or whose `Origin` is another site.
- Every write takes a JSON body (a cross-site form cannot send one) and writes only files in
  the UI state directory: the layout file and draft files. Nothing under the checkout, `.vcv/`
  or Git is written; tests compare the checkout byte for byte.
- There is no submit, apply or approve route. `/api/proposals`, `/api/evidence` and `/api/gate`
  answer GET only; any other method is `405 READ_ONLY`. Recording a proposal is the agent's step (`vcv proposal submit`);
  approval stays the reviewer's `vcv review approve` with their own key
  ([approvals](approvals.md)). The host never reads, receives or stores a private key.
- Cooperating VCV writers are serialized by the store's writer lock (ADR 0010). A future
  browser-triggered write must use the `@vcv/repo` functions that take it, never its own mutex.

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
- `apps/ui/test/proposals.test.ts`: the inbox over HTTP with the real CLI and a test-only
  reviewer key: an agent's proposal with the CLI's digest and operations; no write route
  (`POST`/`PUT`/`DELETE` → 405, no `approve`); stale and rejected proposals with agent hand-offs;
  a wrong digest refused by the CLI; after the reviewer's approval, applied + signed with
  integrity unknown, then checked under `main`; an untrusted key never shown as attested.
  Consistency is tested with a hook between the reads:
  - an approval landing between them yields a wholly applied review;
  - records changing on every read, or a branch switch, are `STATE_CHANGED`.

  With the identity check removed, that test fails.
- `apps/ui/test/observe.test.ts`: the identity itself.
  - A store file rewritten with the same size and mtime between reads is retried.
  - Past a lowered budget the read is `OBSERVATION_LIMIT` (422 over HTTP), and nothing is read.
  - A symlink with a same-length new target changes the identity; a FIFO is refused.
  - `Host.close()` resolves while a keep-alive client is connected.
  - A hook between `lstat` and open swaps a store file for a symlink to an outside file, for a
    FIFO, or appends past the budget. Each is refused, and a swapped directory is refused too.
    With a plain path open and no directory re-check, both tests fail.
  - A store folder swapped for a symlink before it is opened is refused.
  - A parent folder swapped out of the checkout after it was opened is never read through. The outside name is a FIFO, so following it would fail, and the identity equals the clean one.
  - Without `O_NOFOLLOW` on folder opens, both tests fail.
  - A platform without descriptor-relative opens gets `OBSERVATION_LIMIT`.

  With the old size/mtime and skip fallbacks put back, three of these fail.
- `apps/ui/test/contained.test.ts`: the boundary, over HTTP.
  - `GET /api/evidence/objects/:id`: a claim through an in-checkout symlinked folder still
    resolves. The source folder swapped for a symlink to an outside copy just before the evidence
    read opens the file, and put back before the closing identity check, is `422
    OBSERVATION_LIMIT`. With the scope turned off, the read goes through the swap.
  - `GET /api/proposals/:id` with the records folder swapped for a symlink to an outside copy
    just before the proposal read opens the record, and put back before the closing identity
    check: `422 OBSERVATION_LIMIT`, and nothing from the outside copy is in the body. With the
    scope turned off, the test fails.
  - Where contained reads are unavailable, `GET /api/proposals` and `GET /api/proposals/:id`
    answer `422 OBSERVATION_LIMIT`.
- `apps/ui/e2e/proposals.e2e.ts`: the same in Chromium, with the page open while the reviewer
  approves in a terminal (20 to 25), keyboard reachability, and a check that no button on the
  page approves, signs, submits, applies, rejects or rebases.
- `apps/ui/test/evidence.test.ts`: evidence over HTTP on a Course Desk with claims, mapped
  criteria, an approved change with an agent's report, and a run the agent captured:
  - claim states, freshness causes and provenance as `@vcv/repo` reports them;
  - a criterion unverified without runs, and *claimed* with one;
  - module counts;
  - the implementation layers;
  - the gate without a base (nothing run, the missing input named) and with one (equal to
    `preMergeGate` called directly);
  - 405 on writes, with no reassert or run route;
  - `STATE_CHANGED` for a model the page no longer shows;
  - a model change landing between reconciliation and the gate yields one consistent answer, and
    a checkout that keeps moving is `STATE_CHANGED`;
  - a dirty→dirty source edit landing mid-read is retried for the gate, the implementation view
    and object evidence, an edit on every read is `STATE_CHANGED`, and 2001 untracked files are
    `OBSERVATION_LIMIT`. With the source fingerprint switched off, that test fails;
  - the source path model: an ignored file read through a committed, claimed symlink and a
    symlink retargeted to a same-length link text are both seen mid-read, and a changed nested
    repository is `OBSERVATION_LIMIT`. Without the claimed-path fingerprint, that test fails;
  - an unchanged checkout.
- `apps/ui/e2e/evidence.e2e.ts`: the same in Chromium (screenshots 30 to 35). It also checks
  that the pre-merge page follows the model when it moves, and that no button on these pages
  reasserts, records, runs, approves or merges.
- `apps/ui/e2e/explorer.e2e.ts`: the built client in Chromium (Playwright), covering the first
  PR's acceptance tests 1 to 5, plus: no mixed-model inspector across a branch switch, cross-module
  object links, the viewport surviving refreshes, and reduced motion. `npm run test:ui`; set
  `VCV_UI_SHOTS=<dir>` to keep screenshots (taken once finite animations have finished).
  CI runs it in the `ui` job and uploads the screenshots.

## Not yet

Editing purpose, contracts, nested elements and creating or removing objects from the
inspector; submitting from the browser (after #43 merges, if at all) and approving in it (never:
approval stays the reviewer's CLI step); capturing test runs or reasserting claims from the
browser (never: those stay the host's and the agent's steps); and opening a
different checkout from the browser. Projects with more than
1000 modules show the first 1000 and say so.
