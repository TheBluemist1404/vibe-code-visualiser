# Source bindings (M2.4)

A **binding claim** says that a piece of source code implements, exposes, persists or tests an
object in the model. An agent or a person makes the claim. VCV stores it, checks it and shows it.
VCV does **not** decide whether the code does what the claim says.

Design contract: [ADR 0007 §§4–6](adr/0007-repository-projects.md). Tracking issue:
[#13](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/13).

## Three different things

| | Who supplies it | What it means | What it does not mean |
|---|---|---|---|
| **Claim** | an agent or a person, through `vcv binding add` / `reassert` | "this code is that model object", plus who said so, when (model revision, Git commit) and why | that VCV checked the meaning, or that the code is correct |
| **Verification** | VCV, recomputed on every `vcv binding verify` | the pointer resolves to exactly one artifact, and whether that artifact or the model object changed since the claim | anything about behaviour. Every result carries `meaning: "unverified"` and `approved: false` |
| **Approval** | a person, through the model engine | a consequential model decision was accepted | binding claims are never approved by verification, and recording a claim never changes the model |

Recording a claim does not make a draft model approved, and does not set the query API's
`implementationChecked` (it stays `false`).

## Where claims live

One file per claim: `.vcv/bindings/<bindingId>.json`, tracked by Git like the code. Git is the
only history: there is no binding revision counter, and no binding operation touches
`.vcv/HEAD`, the model revisions or the change records. A source edit and the matching claim
update can go into one commit.

```json
{
  "format": 1,
  "bindingId": "impl.cap-enroll",
  "modelObjectId": "cap-enroll",
  "relation": "implements",
  "locator": { "path": "server/src/enrollment/enrollment.service.ts", "selector": { "kind": "symbol", "name": "EnrollmentService.enrollStudent" } },
  "provenance": { "source": "human", "principalId": "user:reviewer" },
  "modelRevision": "rev-1",
  "observed": {
    "commit": "917dffb9a9d4…",
    "workingTree": "modified",
    "fingerprint": { "algorithm": "vcv-fp-1", "file": "ceb0308c…", "selector": "418a1198…" }
  }
}
```

(full file: [samples/m2.4-bindings/impl.cap-enroll.json](samples/m2.4-bindings/impl.cap-enroll.json))

- `bindingId` uses the persisted-ID grammar. If you leave it out, it is derived from the relation,
  the object ID and a hash of the locator, so the same claim made on two branches has the same ID
  and the same bytes. It is kept when the claim is reasserted.
- `provenance.source` and `principalId` come from the host (the CLI's `--source` and `--as`),
  never from the claim payload. `confidence` is the claimant's own estimate; VCV never computes it.
- `observed` records what was inspected: the Git commit, whether the file differed from it, and
  fingerprints. There are no absolute paths and no timestamps; files are byte-for-byte
  deterministic (fixed key order).
- `disputed` is only set by `vcv binding dispute`; verification never sets it.

## Locators

A locator is a repository-relative POSIX path plus a selector:

| Form | Selector | Checked in |
|---|---|---|
| `path` | whole file | any regular file |
| `path#symbol:Class.member` | named declaration: top-level `class`, `function`, `interface`, `type`, `enum`, variable; class methods, properties, accessors and `constructor`; interface members | `.ts` `.tsx` `.mts` `.cts` |
| `path#route:POST /orders/:id` | NestJS handler: `@Controller(path)` + `@Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All(path)` with literal paths | `.ts` `.tsx` `.mts` `.cts` |
| `path#test:Suite > case` | `describe`/`suite` and `it`/`test` titles with literal strings, outermost first (`.only`, `.skip`, `.todo`, `.concurrent` are fine) | `*.test.*` and `*.spec.*` |

In JSON, a symbol selector can name its declaration kind (`"declaration": "class"`) and a route
selector its handler (`"handler": "OrdersController.place"`), to tell same-named artifacts apart.

**Paths.** A path must already be normalized. These are refused with `UNSAFE_PATH`: an absolute
path, `..`, `.`, `//`, a backslash, anything under `.git/`, `.vcv/` or `node_modules/`, and a
symlink that leads out of the checkout. A path that differs from a file only by letter case is
reported, not matched, so case-insensitive filesystems behave like Linux.

**Parser.** Only syntax is read, with the TypeScript 6 compiler API (`createSourceFile`), pinned
in `@vcv/repo`. There is no type checking, import following or project configuration. The
repository's own type checker is TypeScript 7, whose JS API is unstable and runs a native binary
over IPC, so it is not used here.

## Verification states

| State | Meaning |
|---|---|
| `resolved` | the selector matches exactly one artifact, its code matches the recorded fingerprint, and the bound model object did not change since the claim's revision |
| `stale` | it still resolves, but the selected code changed (`source: changed`), or the model object changed or was removed (`model: changed`/`removed`). Someone should look again; it is not a contradiction |
| `missing` | the path or selector does not resolve (renamed, moved, deleted), or the path is no longer safe |
| `ambiguous` | the selector matches more than one artifact; none is picked |
| `unchecked` | the file type or the construct is outside the subset above, so only the claim is reported |
| `invalid` | the claim file itself is unreadable (conflict markers, bad JSON, wrong shape, or a file name that does not match its `bindingId`) |

Each result has a separate `source` and `model` freshness, each with a cause:

- **Source** compares the selected declaration's fingerprint: the sequence of its syntax tokens,
  including decorators but not comments, JSDoc or formatting. An edit elsewhere in the same file
  is reported as `fileChanged: true` with the cause "not evidence about this claim", and the
  claim stays `resolved`. A `file` selector compares the whole file (CRLF normalized to LF).
- Uncommitted edits count: verification reads the working tree, not the commit.
- **Model** compares the bound object between the claim's revision and the current one. If the
  claim's revision is not in this checkout's history (another branch), the state is `unknown`.
- **Git** context is reported (`commitMoved`, the file's working-tree state), but a moved commit
  alone never makes a claim stale.

VCV never relocates a claim. After a rename or move, the claim reports `missing` until an agent
or a person reasserts it.

## Writes are checkout-safe

Every write names the claim it expects to find on disk: no claim for `add`, and the claim's
digest (from `vcv binding list`) for `reassert`, `remove` and `dispute`. The operation then:

1. takes one snapshot: the project must be `ready`, and the snapshot holds the model store's
   fingerprint, the Git commit and the claim file's digest;
2. refuses unless the claim on disk is the expected one (`BINDING_EXISTS` for a create,
   `BINDING_CHANGED` or `NOT_FOUND` otherwise). This is how a claim read on one branch cannot
   overwrite another branch's same-ID claim after `git checkout`;
3. validates the claim: the model object exists at the current revision and at the claim's
   revision, the revision is in HEAD's history, the path is safe, and the locator resolves to
   exactly one artifact (`LOCATOR_MISSING`, `LOCATOR_AMBIGUOUS`, `LOCATOR_UNCHECKED`);
4. immediately before writing, re-checks the store fingerprint, the Git commit, the claim file and
   the source file's bytes. If any changed, it refuses with `STATE_CHANGED` and writes nothing;
5. writes through a temporary file and rename. It refuses to write through a symlinked
   `.vcv/bindings/`.

As with model commits, this is check-then-rename, not a lock: a checkout landing inside the
rename itself is not prevented.

Permissions (from the host): `binding:record` to add, reassert and remove; `binding:dispute` to
dispute. The CLI grants both by default, like the model permissions.

## CLI

```sh
vcv binding add <repo> --source agent --as agent:me --object cap-enroll --relation implements \
  --locator 'server/src/enrollment/enrollment.service.ts#symbol:EnrollmentService.enroll' \
  [--id impl.cap-enroll] [--rationale '…'] [--confidence 0.8] [--revision rev-1] [--allow-unchecked]
vcv binding list <repo> [--json]                       # IDs, digests, locators
vcv binding verify <repo> [bindingId] [--json]         # exit 0 only if every claim is resolved
vcv binding reassert <repo> <bindingId> --source human --expect <digest> --locator '<new locator>'
vcv binding dispute <repo> <bindingId> --reason '…' --expect <digest>
vcv binding remove <repo> <bindingId> --expect <digest>
```

`--source` is required: every claim says whether an agent, a person or a tool made it.
`--allow-unchecked` stores a claim whose selector cannot be checked; it then verifies as
`unchecked`, never as `resolved`.

A scripted run on Course Desk with the M2.3 agent draft:
[examples/reference-app/bindings/demo.sh](../examples/reference-app/bindings/demo.sh), recorded
output in [samples/m2.4-bindings/demo.txt](samples/m2.4-bindings/demo.txt).

## What works today, and what stays unchecked

Checked deterministically:
- the file exists inside the checkout, with exact case and without symlink escapes;
- the selector kinds and constructs in the table above resolve to exactly one artifact;
- the selected code changed or not (token fingerprint), including uncommitted edits;
- the bound model object changed or not between revisions in the checkout's history;
- the claim on disk is the one the writer read.

Reported as `unchecked` (never guessed):
- selectors in other languages and file types (only `file` works there);
- files over 1 MB;
- non-literal paths in Nest decorators, aliased or namespace imports of `@nestjs/common`,
  `@Controller` with `host` or `version`, and computed member names;
- `describe.each` / `it.each` and non-literal test titles;
- namespaces and destructuring declarations, where they could hide the named symbol.

Not done by design (or deferred to M2.5):
- **Route paths are controller-relative.** A global prefix (`app.setGlobalPrefix("api")`),
  versioning or `RouterModule` is not applied, so `GET /courses` is the locator for a route
  served at `/api/courses`.
- **Test titles are matched syntactically.** `describe`/`it`/`test` calls are recognized by
  name, without checking where they are imported from.
- **No rename following.** Hints (Git rename detection, same-fingerprint declarations), a rich
  query or MCP surface for claims, and a full revalidation workflow are M2.5.
- **No resolver cache.** Everything is recomputed on each call. A cache, if added, goes under the
  git-ignored `.vcv/cache/`.
- **No audit entries for binding writes.** Git history is the record of who changed a claim.
- **Claims are not part of project status.** A conflicted claim file shows up as `invalid` in
  `binding list`/`verify`; the model is still served.
