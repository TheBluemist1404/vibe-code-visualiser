# ADR 0007: Repository-native projects, branch-safe revisions, source locators and binding verification (M2)

Status: **proposed for review** (2026-11-11; revised after review on PR #8 for the agent-first
operating model agreed on 2026-11-11). Design contract for M2 (Issue #6). Sections 1–3
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
| Observed source (the checkout itself; resolver cache in `.vcv/cache/`, git-ignored) | working tree | no |
| Bindings: agent- or human-supplied claims linking the two | `.vcv/bindings/` | the *claim* is shared; its *verification state* is derived |

**Responsibility split (agent-first operating model).** VCV is the visualiser and validation
gate for a versioned model; it does no repository-level reasoning. A coding agent analyses the
repository with tools of its own choosing (TypeScript compiler API, Tree-sitter, Nx, plain
reading), decides what to model, creates or updates `.vcv/` through VCV's supported operations,
and records which code it believes implements what. VCV represents, validates, checks
deterministically, enforces authorization/approval, versions, persists and displays. Optional
deterministic analyzers may supply objective source facts; none of them infers business
meaning. Sections 4–6 are written to this split.

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
  cache/                  local    locator-resolution cache (M2.3)
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
| `invalid` | HEAD unreadable or inconsistent, a listed revision missing or unparsable, or a `changes/*.json` file that is not a readable record for its own ID (status, reader and writer all refuse it; recovery checks it before moving anything) | no |

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

Writers use `FileStore` on `.vcv/`, still single writer (ADR 0003); UI and MCP must not write
concurrently, and MCP stays read-only. A single writer is not enough in a checkout, though:
`git checkout`/`pull` replace `.vcv/HEAD` under a writer that stays open. So:

- **What "moved" means.** A store fingerprint covers HEAD's bytes, the current revision file's
  bytes, and the name, size and mtime of every file in `revisions/` and `changes/`. A merge
  resolved to the open writer's *own* HEAD changes no HEAD byte but adds foreign revisions and
  records, so comparing HEAD's line alone is not enough.
- **Read policy (writer).** Every `FileStore` read (`current`, `revision`, `revisions`) first
  compares the fingerprint with the one last validated. If it changed, the writer re-runs the
  open-time checks (conflict, divergence, digest verification) against HEAD on disk, and adopts
  it only if they pass. The engine therefore validates a change against the checked-out line
  (a change based on the old line fails with `STALE_REVISION`). If the checks fail, the writer
  keeps the last validated state, so every later read fails the same way and every write is
  refused until a person resolves the checkout.
- **Read policy (reader).** `FileStoreReader` runs the same checks, read-only (`inspectStore`),
  whenever the fingerprint changes, so a long-lived reader (MCP, `RepositoryProject`) refuses a
  conflicted, diverged or corrupt checkout exactly as a fresh open would. It still never writes
  or recovers.
- **Reader cache.** The parsed current revision is cached by HEAD's whole line plus the SHA-256
  of the revision file's bytes, not by revision ID: the initial revision and legacy IDs are not
  content-addressed, so two branches can hold different models named `rev-1`. `projectStatus`
  exposes the same file digest, and `refresh()` reports such a swap as `switched`.
- **One snapshot per change.** The engine takes a single `snapshot()` (model, history,
  fingerprint token) before it reads anything else, then makes every decision on it: whether
  the change ID already exists (replay or approval lookup), validation, derives the new revision ID from it and
  commits with its token. It never re-reads the store in between, so a checkout landing after
  validation cannot retarget an already validated model. Independently of the engine, the store
  refuses a commit whose `record.baseRevision` is not its current HEAD (`HEAD_CHANGED`) or whose
  branch-safe ID does not verify as the model's digest after that HEAD (`BAD_COMMIT`). A refused
  commit becomes a `rejected` outcome with that code; no record is created or changed.
- **Record writes too.** Non-committing ChangeRecord writes (a new `pending` or `rejected`
  proposal, `pending` → `rejected` on a failed approval) carry the same snapshot token plus the
  record the engine expects on disk (none, for a new proposal). The store refuses with
  `STORE_CHANGED`, writing nothing, if the store moved or the record on disk differs, so a
  checkout after validation can never overwrite another branch's proposal with the same ID. The
  outcome is `rejected` without a record; the attempt is still audited locally.
- **Applied commits pin the record too.** `commit()` takes the same guard: the snapshot token
  plus the record the decision was made on, `null` for a new auto-applied proposal and the
  exact pending record read for an approval. The store checks it next to the token, before
  writing the revision or HEAD, and refuses with `STORE_CHANGED`. So a checkout after the
  existence check can neither overwrite another branch's same-ID pending proposal with an
  applied one, nor approve a pending record that is gone (or is a different record) on the new
  branch. The precondition is checked by content, so it holds even where the fingerprint cannot
  see a same-size, same-mtime record swap.
- **Write guard.** `commit()` re-checks immediately before its first write: `HEAD_CHANGED` if
  HEAD's line moved, `STORE_CHANGED` if any fingerprinted file differs from the snapshot token
  (including a same-ID revision swap that the store has since adopted). Nothing is written in either case. The writer's own
  writes update the validated fingerprint. This is check-then-rename, not a lock: a checkout
  landing inside the few milliseconds of the write itself is not prevented, and a change to a
  change record that keeps its size and mtime is not detected.

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
Git checkout would silently drop a branch's model. Recovery may now move an unlisted revision
only if it is **provably an interrupted commit of this store**; all three must hold:

1. it is the next child of HEAD: its digest verifies with HEAD as parent at `seq = len + 1`
   (legacy IDs: it is named `nextRevision(HEAD)`);
2. no change record says it was applied. The commit protocol writes the applied record only
   after HEAD names the revision, so an applied record is durable evidence that the revision was
   committed on some line of history (and Git carries that record along with the revision file);
3. it is the only such candidate: one interrupted commit leaves at most one file.

Anything else is **foreign**: inspection reports `diverged`, `FileStore` throws `DIVERGED`, and
nothing is moved. This covers resolving a merge to one branch tip, and also resolving
`.vcv/HEAD` to the branches' **common ancestor**, where every branch child verifies against HEAD
by digest (rules 2 and 3 catch it; regression tests in `core/test/revisions.test.ts` and
`repo/test/project.test.ts`). No semantic auto-merge; the person keeps one line (removes the
other line's revision files, or restores the matching HEAD).

Residual risks:

- One sibling revision whose applied change record was also deleted, merged in with HEAD at
  its parent, still looks exactly like an interrupted commit and would be moved to
  `orphaned/` (visible in `git status`, recoverable). This needs two deliberate edits to the
  store's files.
- `changes/<id>.json` uses caller-chosen IDs; two branches using the same change ID for
  different changes will conflict in Git (detected as `conflicted`), not silently merge.
- 48-bit digest: collisions are negligible at this scale; length is a constant.

**Committed revisions are verified, not trusted.** Whenever a revision listed in HEAD is read
(writer open and reads, `FileStoreReader`, `inspectStore`), its `project.modelRevision` must equal
its file name, and for branch-safe IDs after the first entry its digest must verify against the
previous history entry as parent at that position. A file edited after commit, or listed out of
place, is `CORRUPT` (`invalid` for inspection) and is never rewritten. Legacy IDs carry no digest,
so their content cannot be checked; the first history entry (the `init` model, whatever its ID)
has no parent and is exempt.

*(proposed)* encoding: `rev-<seq>-<12 hex>`; digest input and `vcv-revision-v1` domain tag.

## 4. Source locators (contract for M2.4, proposed)

A locator is what an agent (or person) writes to say *where* an artifact is; VCV only checks
that it resolves. It is not produced by VCV analysis.

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
path differs only by case from a file on disk is reported, not matched (case-insensitive
filesystems).

## 5. Bindings: three separate concerns (contract for M2.4/M2.5, proposed)

The existing `Binding` in `packages/core/src/bindings.ts` is extended, not replaced. A binding
keeps three things apart that must never be read as each other:

| Concern | Who supplies it | What it means | What it does **not** mean |
|---|---|---|---|
| **Interpretation + provenance** | the agent (or a person) | "this code implements/exposes/persists/tests that model object", with who said so, when, at which model revision and commit, and optionally a rationale/confidence | that VCV checked the meaning, or that the behaviour is correct |
| **Deterministic verification** | VCV, recomputed on demand | the locator resolves to exactly one artifact; its fingerprint matches what was recorded; the bound object still exists and has or hasn't changed since | anything about semantics; a pass is "the pointer is intact", not "the code is right" |
| **Approval** | a principal with permission, through the existing approval gate | a person accepted a *consequential model decision* | that every routine mapping needed a person |

A stored **claim** (one file per binding under `.vcv/bindings/<binding-id>.json`, so branches
rarely conflict):

```ts
type BindingClaim = {
  bindingId: string;            // persisted-ID grammar; derived from object + relation + locator
  modelObjectId: Id;            // stable IR ID
  relation: "implements" | "exposes" | "persists" | "tests";
  locator: SourceLocator;
  provenance: {
    source: "agent" | "human" | "tool";   // tool = an optional deterministic analyzer the agent ran
    principalId: string;                   // from the trusted host, never from the payload
    rationale?: string;
    confidence?: number;                   // the supplier's own estimate, never computed by VCV
  };
  modelRevision: string;        // revision the claim was made against
  commit: string | null;        // Git commit inspected; null on a repository without commits
  fingerprint: { file: string; selector?: string };
  workingTreeDirty: boolean;    // the file differed from `commit` when the claim was made
  disputed?: { by: string; reason: string };   // only by a person or evidence-based reconciliation (M4)
};
```

**Recording** a claim is a normal semantic operation through `ModelEngine`-style propose/apply
with the caller's host permissions. An agent holding the ordinary permission to record
bindings can record routine mappings directly; there is **no universal manual mapping step**.
Recording is refused (not downgraded) if the locator does not resolve at record time, so an
agent cannot store a pointer to nothing.

**Approval** follows the existing gate, not a new one: a claim is consequential, and goes to
`pending` for a principal with approve permission, when it accompanies a model change that
already needs approval (new module, contract, approved-draft change), or when policy marks a
relation as sensitive *(proposed: none by default)*. A recorded agent claim is never presented as
"approved" or "verified"; the UI and queries show its provenance verbatim.

**Derived verification state** (never stored; computed from the claim, the working tree and
the model):

| State | Precise meaning |
|---|---|
| `resolved` | path and selector resolve to exactly one artifact whose fingerprint equals the claim's, and the bound object did not change since the claim's revision |
| `stale` | it resolves, but the selector fingerprint changed, or the bound object changed in the model since the claim's revision: the supplier should re-check, not a contradiction |
| `missing` | the path or the selector no longer resolves |
| `ambiguous` | the selector resolves more than once |
| `unchecked` | the file type or selector kind is not supported by the resolver, so only the claim is reported |

`disputed` is a recorded fact about the claim, not a derived state, and is never set by these
checks. A changed Git commit alone does **not** make a binding stale. Model change is computed
by diffing the two stored revisions (replacing the current `changedObjectIds` hint).

**Fingerprints** *(proposed)*: `file` = SHA-256 of the file bytes with CRLF normalized to LF;
`selector` = SHA-256 of the selected declaration's source text with whitespace runs collapsed
and comments removed.

**Moves and renames.** VCV reports `missing`; it does not relocate. It may attach objective
hints for the agent (Git rename detection between the claim's commit and now; files containing a
declaration with the same name or the same selector fingerprint). Interpreting those hints and
recording a corrected claim is the agent's job. Nothing is rebound silently.

**Branch changes** need no special case: claims are files in `.vcv/bindings/`, so they switch
with the checkout, and verification is recomputed against the new working tree.

## 6. Locator resolution and optional analyzers (contract for M2.3, proposed)

VCV needs exactly one source capability: **resolving and fingerprinting the locators in
section 4** for supported files, deterministically. That resolver is part of the evidence
checks. It is not an architecture-discovery path and does not propose modules, mappings or
meaning.

- Resolver coverage *(proposed)*: `.ts`/`.tsx`; top-level and class-member declarations;
  NestJS `@Controller` + `@Get/@Post/...` routes; `describe`/`it`/`test` titles in
  `*.test.ts(x)`/`*.spec.ts(x)`. Parser: the TypeScript compiler API (already a dev dependency).
  Anything else is `unchecked`, never guessed (computed routes, dynamic imports, aliased
  decorators).
- Results are a rebuildable, git-ignored cache under `.vcv/cache/`, keyed by file content hash;
  never canonical, never a second model. Excluded: `node_modules`, `.git`, `.vcv`, `dist`,
  `build`, `coverage`; files over 1 MB.
- An optional **inventory tool** (list a repository's files, exports, routes and tests) may be
  offered to agents as a convenience through the same adapters (CLI, MCP). It is one tool among
  the agent's own (Tree-sitter, Nx, compiler APIs), is never required, and its output is objective
  facts only. Onboarding an uninitialized repository is: agent analyses → agent proposes a draft
  model and claims through supported operations → VCV validates → approval where the gate needs it.
- No LLM-derived inference anywhere in VCV.

## Consequences

- New package `@vcv/repo` (Git observation + project loading) depends on `@vcv/core`; Core
  stays free of Git and process spawning. The locator resolver (M2.3) belongs there too.
- CLI: `vcv project status [path] [--json]`, `vcv project init <path> <model.yaml>`.
- Tests that asserted the literal `rev-2` now assert the `rev-2-<digest>` shape.
