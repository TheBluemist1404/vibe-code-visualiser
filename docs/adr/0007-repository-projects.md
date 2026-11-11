# ADR 0007: Repository-native projects, branch-safe revisions, source locators and freshness (M2)

Status: **proposed for review** (2026-11-11). Design contract for M2 (Issue #6). Sections 1–3
are implemented in the M2.1 PR; sections 4–6 are the contract the M2.2–M2.5 slices will build
on and are not implemented yet. Items marked *(proposed)* are implementation choices the issue
asks to keep open until this ADR is reviewed.

## Context

VCV now has to work inside a developer's own Git checkout. Code and the `.vcv/` model travel
together through ordinary commits, branches and PRs; a future hosted VCV reads `.vcv/` at a
chosen Git ref. Three authorities stay separate:

| Authority | Where | Canonical? |
|---|---|---|
| Declared intent (IR revisions) | `.vcv/HEAD`, `.vcv/revisions/` | yes, changed only by approved semantic operations |
| Observed source structure (index) | `.vcv/cache/` (git-ignored), rebuildable | no |
| Bindings: evidence-backed claims linking the two | `.vcv/bindings/` | the *claim* is shared; its *freshness* is derived |

Before this ADR the engine minted `rev-<n+1>`, so two branches that each committed one change
both produced `rev-2` with different content. Git would then either conflict on
`revisions/rev-2.yaml` or, worse, a binding or cursor that names `rev-2` would silently mean
two different models. The issue makes fixing this the gate for relying on Git branching.

## 1. `.vcv/` layout (implemented)

`.vcv/` at the working-tree root **is** the FileStore directory of ADR 0003, plus new
subdirectories. Fixed name and location, so every clone agrees without configuration.

```
.vcv/
  HEAD                    shared   commit point (ADR 0003), unchanged format 1
  revisions/<rev>.yaml    shared   immutable revisions
  changes/<id>.json       shared   proposal records
  bindings/               shared   binding claims (M2.4, section 5)
  .gitignore              shared   written by `vcv project init`
  audit.jsonl             local    attempt log (ADR 0004), per checkout   (proposed)
  orphaned/               local    recovery leftovers
  cache/                  local    source index, observation snapshots (M2.3)
```

Shared files contain **no absolute paths** and no machine- or user-specific data beyond what
the engine already records (principal IDs in change records). Paths inside bindings are
repository-relative POSIX (section 4).

*(proposed)* `audit.jsonl` becomes local because an append-only log edited on two branches
conflicts on every merge, and it records attempts on this machine, not shared intent. If a
shared audit trail is wanted later, it should be one file per event.

## 2. Loading a project (implemented: `@vcv/repo`)

`projectStatus(path)` resolves the Git working-tree root containing `path` (or uses `path`
itself outside Git), inspects `<root>/.vcv` with `inspectStore()` and reports one state:

| State | Meaning | Served? |
|---|---|---|
| `ready` | HEAD and every listed revision readable; no foreign revisions | yes |
| `absent` | no `.vcv/` | no; nothing is created (`vcv project init` is explicit) |
| `uninitialized` | `.vcv/` without `HEAD` | no |
| `conflicted` | Git conflict markers in `HEAD`, a revision or a change record | no |
| `diverged` | revision files not in HEAD's history that are not an interrupted commit | no |
| `invalid` | HEAD unreadable or inconsistent, a listed revision missing or unparsable | no |

Inspection and loading never write: no recovery, no directory creation. `RepositoryProject`
wraps a `FileStoreReader` (ADR 0006), so the served model follows whatever the checkout's
`.vcv/HEAD` says on each call. `refresh()` re-observes and classifies how the model line moved
(`unchanged`, `advanced`, `rewound`, `switched`, `appeared`, `disappeared`) by comparing HEAD
histories, which is how a branch switch is noticed without trusting branch names.

**Observation context** is returned next to the model and never persisted in shared files:
absolute root, Git commit, branch or detached state, whether the tree is dirty, which `.vcv/`
paths differ from Git HEAD, and any merge/rebase/cherry-pick/revert in progress. Git is only
read (`rev-parse`, `symbolic-ref`, `status`), with `GIT_OPTIONAL_LOCKS=0` so `git status` does
not rewrite the index. VCV never fetches, pulls, checks out or merges.

Writers are unchanged: `FileStore` on `.vcv/`, single writer (ADR 0003). UI and MCP must not
write concurrently; MCP stays read-only.

## 3. Branch-safe revision identity (implemented)

New revisions are named

```
rev-<seq>-<digest>        e.g. rev-2-3f9a1c0b7d2e
```

- `seq` = position in this store's history (parent's length + 1). For people only.
- `digest` = first 12 hex chars of `sha256("vcv-revision-v1\0" + parentId + "\0" + canonicalJson(model))`,
  where the model is round-tripped through its persisted YAML and its own `modelRevision` is
  blanked. Canonical JSON sorts keys and drops `undefined`.

Properties:

- Two branches that commit different changes on the same parent get different IDs, so their
  revision files never collide in Git and no identifier means two models.
- The same change on the same parent yields the same ID and byte-identical file: identical
  state, no false conflict.
- The parent is part of identity, so ancestry is checkable from the file plus HEAD.
- IDs still satisfy the persisted-ID grammar (ADR 0003); no schema change.

**Ancestry** stays where it already was: HEAD's `history` is the ordered chain. No HEAD format
change and no migration: legacy IDs (`rev-1`, `rev-2`, `v7`) remain valid, are read as-is, and
the next commit continues with `rev-<n+1>-<digest>`. `nextRevision()` is kept, deprecated.

**Divergence detection.** After `git merge`, both branches' HEADs conflict (revision files
don't, since their names differ). VCV reports `CONFLICTED` and refuses to write. If the
conflict is resolved by keeping one side's HEAD, the other side's revisions remain on disk
without being in HEAD's history. Recovery used to move any such file to `orphaned/`, which in a
Git checkout would silently drop a branch's model. Now an unlisted revision is treated as an
interrupted-commit **leftover** only if it is exactly the next child of HEAD (branch-safe: its
digest verifies against HEAD as parent at `seq = len + 1`; legacy: its name is
`nextRevision(HEAD)`). Anything else is **foreign**: inspection reports `diverged`, `FileStore`
throws `DIVERGED`, and nothing is moved. No semantic auto-merge; the person keeps one line
(removes the other line's revision files, or restores the matching HEAD).

Residual risks:

- A sibling revision from another branch with the *same* parent as HEAD verifies as a
  leftover and would be moved to `orphaned/` (visible in `git status`, recoverable). This needs a
  deliberate resolution that keeps an older HEAD while adding a sibling's files.
- `changes/<id>.json` uses caller-chosen IDs; two branches using the same change ID for
  different changes will conflict in Git (detected as `conflicted`), not silently merge.
- 48-bit digest: collisions are negligible at this scale; length is a constant.

*(proposed)* encoding: `rev-<seq>-<12 hex>`; digest input and `vcv-revision-v1` domain tag.

## 4. Source locators (contract for M2.3/M2.4, proposed)

```ts
type SourceLocator = {
  path: string;                 // repository-relative POSIX, normalized; no "..", no leading "/", no "\\"
  selector:
    | { kind: "file" }
    | { kind: "symbol"; name: string; declaration?: "class" | "function" | "method" | "const" | "interface" | "type" }
    | { kind: "route"; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; route: string; handler?: string }
    | { kind: "test"; name: string };      // describe/it title path, " > " separated
};
```

Serialized for people as `path#symbol:EnrollmentService.reject`,
`path#route:POST /enrollments/:id/reject`, `path#test:Enrollment > rejects`. `symbol.name` is the
dotted container path (`Class.method`). Paths are compared case-sensitively; a locator whose
path differs only by case from an indexed file is reported, not matched (case-insensitive
filesystems).

## 5. Bindings: claim vs derived freshness (contract for M2.4/M2.5, proposed)

The existing `Binding` in `packages/core/src/bindings.ts` is extended, not replaced. A stored
**claim** (one file per binding under `.vcv/bindings/<binding-id>.json`, so branches rarely
conflict):

```ts
type BindingClaim = {
  bindingId: string;            // persisted-ID grammar; derived from object + relation + locator
  modelObjectId: Id;            // stable IR ID
  relation: "implements" | "exposes" | "persists" | "tests";
  locator: SourceLocator;
  confirmation: "confirmed" | "suggested" | "disputed";
  provenance: "human" | "agent" | "inferred";
  confirmedBy?: string;         // host principal; required for "confirmed"
  modelRevision: string;        // revision the claim was made against
  commit: string | null;        // Git commit inspected; null if made on an uncommitted tree
  fingerprint: { file: string; selector?: string };   // see below
  workingTreeDirty: boolean;    // the inspected file differed from `commit`
};
```

- Only an explicit confirmation by a principal with permission makes a claim `confirmed`. An
  agent may create `suggested` claims; it may not confirm its own suggestion (same rule as
  self-approval, ADR 0004).
- `disputed` is only ever set by a person or reconciliation with evidence (M4), never by a
  freshness check.

**Freshness is derived, never stored**, by comparing the claim with the current index:

| Freshness | Precise meaning |
|---|---|
| `current` | path and selector resolve to exactly one artifact whose fingerprint equals the claim's, and the bound object did not change between the claim's revision and the current one |
| `stale` | it resolves, but the selector fingerprint changed, or the bound object changed in the model since the claim's revision: needs revalidation, not a contradiction |
| `missing` | the path or the selector no longer resolves anywhere in the index |
| `ambiguous` | the selector resolves more than once, or it is missing and there are several relocation candidates |
| `unverified` | the claim is `suggested`, or the artifact is in an unsupported/unindexed file |

A changed Git commit alone does **not** make a binding stale: only a fingerprint change or a
model change to the bound object does (model change computed by diffing the two stored
revisions, which replaces the current `changedObjectIds` hint).

**Fingerprints** *(proposed)*: `file` = SHA-256 of the file bytes with CRLF normalized to LF;
`selector` = SHA-256 of the selected declaration's source text with whitespace runs collapsed
and comments removed. Structural fingerprints are candidate-finding signals, not identities.

**Moves and renames**: when a locator is `missing`, candidates come from (a) Git rename
detection between the claim's commit and now, (b) index entries with the same selector
fingerprint, (c) the same symbol name in another file. One candidate with an equal selector
fingerprint is offered as a `suggested` relocation; anything else is `ambiguous`. Nothing is
rebound without a confirmation.

**Branch changes** need no special case: claims are files in `.vcv/bindings/`, so they switch
with the checkout, and freshness is recomputed against the new working tree.

## 6. Index (contract for M2.3, proposed)

Rebuildable, deterministic, stored under `.vcv/cache/index.json`, never canonical. Coverage:
`.ts`/`.tsx` files; imports/exports; top-level and class-member declarations; NestJS
`@Controller` + `@Get/@Post/...` routes and `@Injectable` providers; React components
(exported functions returning JSX) and entry points; test files (`*.test.ts(x)`, `*.spec.ts(x)`)
with `describe`/`it`/`test` titles. Excluded: `node_modules`, `.git`, `.vcv`, `dist`, `build`,
`coverage`, files over 1 MB, more than 5,000 files. Parser: the TypeScript compiler API
(already a dev dependency) *(proposed)*. Unsupported constructs are reported, not guessed:
computed route paths, dynamic imports, re-export cycles, decorators from aliases. Ordering is
by path, then source position. No LLM-derived inference.

## Consequences

- New package `@vcv/repo` (Git observation + project loading) depends on `@vcv/core`; Core
  stays free of Git and process spawning.
- CLI: `vcv project status [path] [--json]`, `vcv project init <path> <model.yaml>`.
- Tests that asserted the literal `rev-2` now assert the `rev-2-<digest>` shape.
