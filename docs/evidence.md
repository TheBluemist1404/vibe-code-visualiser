# Source evidence queries (M2.5)

Read-only queries over [binding claims](bindings.md): which claims exist for a model object,
what each one says, whether its pointer still resolves, and whether its code or model object
changed since the claim. The same API serves the CLI (`vcv evidence`) and MCP
(`vcv-mcp --repo`), with one request schema and one result shape.

Tracking issue: [#15](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/15).
Design notes: [ADR 0007, "M2.5 decisions"](adr/0007-repository-projects.md#m25-decisions).
For agents: [agent-maintenance.md](agent-maintenance.md).

## What it is, and what it is not

VCV is not autonomous. Evidence is recomputed when someone asks for it, against the working
tree as it is at that moment. VCV does not watch the repository, infer what a change means,
interpret drift, edit the model, create proposals or approve anything. An agent or a person
reads the evidence, inspects the code, and proposes a typed model change through the existing
operations; a person approves it.

## Operations

| Operation | CLI | MCP tool | Returns |
|---|---|---|---|
| `getEvidenceOverview` | `vcv evidence <path> overview [--states s,..]` | `vcv_get_evidence_overview` | counts by state plus `disputed`; model objects that claims name but the model no longer has; one page of one-line summaries |
| `getObjectEvidence` | `vcv evidence <path> object <id> [--relations r,..] [--selector-kinds k,..] [--states s,..]` | `vcv_get_object_evidence` | the object (kind, name, whether it is in the current model), counts, and one page of full evidence items |
| `getBindingEvidence` | `vcv evidence <path> binding <bindingId>` | `vcv_get_binding_evidence` | one full evidence item |
| `refreshEvidence` | `vcv evidence <path> refresh [bindingId..] [--since <token>]` | `vcv_refresh_evidence` | counts, one page of summaries, an `observationToken`, `changedSince`, `writes: "none"` |

Every operation takes `expectedRevision`; the paged ones take `limit` (1–200, default 50) and
`cursor`. The CLI's `--request '<json>'` passes the request object exactly as MCP receives it.
The CLI prints the result as JSON and exits 0 for `ok: true`, 1 otherwise.

Each call is one observation: the project status, every claim and its verification are read
once, then the model store, the Git commit, the claim files and every bound source file are
checked again. If any changed in between (a checkout, or an uncommitted edit of a bound file
during the read), the call fails with `STATE_CHANGED` instead of mixing two generations of
evidence. Source files are fingerprinted through the resolver's own checkout-bounded path walk
(a missing, moved or unsafe file counts as its reason), and a file no claim binds is not part of
the observation.

## An evidence item

```jsonc
{
  "bindingId": "impl.cap-enroll",
  "file": ".vcv/bindings/impl.cap-enroll.json",
  "digest": "…",                    // what `vcv binding reassert|remove|dispute --expect` takes
  "state": "stale",
  "claim": {                        // the claimant's interpretation, as stored; not checked
    "modelObjectId": "cap-enroll", "relation": "implements",
    "locator": { "text": "server/…/enrollment.service.ts#symbol:EnrollmentService.enroll", "path": "…", "selector": { … } },
    "provenance": { "source": "agent", "principalId": "agent:bootstrap", "rationale": "…", "confidence": 0.8 },
    "modelRevision": "rev-1",
    "observed": { "commit": "…", "workingTree": "clean", "fingerprint": { "algorithm": "vcv-fp-1", "file": "…", "selector": "…" } }
  },
  "locator": {                      // existence, now
    "state": "resolved", "detail": "symbol … resolves to method … at line 23",
    "matches": [{ "label": "EnrollmentService.enroll", "declaration": "method", "line": 23 }], "matchesTotal": 1
  },
  "freshness": {                    // what changed since the claim, each with a cause
    "source": { "state": "changed", "cause": "the selected declaration's code differs from the recorded fingerprint", "fileChanged": true },
    "model":  { "state": "unchanged", "cause": "claim was made against the current revision rev-1" },
    "git":    { "commitMoved": true, "workingTree": "modified" }
  },
  "disputed": null,
  "approval": { "approved": false, "note": "binding claims are never approved; context.snapshotStatus is the model's own status" }
}
```

The four concerns stay apart: **claim** (interpretation and confidence, supplied by whoever made
it), **locator** (does the pointer resolve), **freshness** (did code or model change, and why
VCV thinks so) and **approval** (never). An `invalid` item has `claim`, `locator` and
`freshness` set to `null` and a `problem`.

Every result's `context` carries `projectId`, `modelRevision`, `snapshotStatus` (the model's
draft/approved status, unrelated to pointer verification), `implementationChecked: false`,
`meaning: "unverified"`, and what was observed: the Git commit, branch, whether the working tree
is dirty, the resolver version and the fingerprint algorithm. States are those of
[bindings.md](bindings.md#verification-states).

Results contain no source text and no absolute paths (the checkout path is replaced by `.`
wherever a message would include it).

## Ordering, pagination, refresh

- Items are ordered by binding ID. The same checkout gives byte-identical results.
- A `nextCursor` is bound to the model revision, the request's filters and the set of claim
  files (IDs and digests). After a claim is added, removed or edited, an old cursor gives
  `INVALID_CURSOR` instead of skipping or repeating a claim; from another revision,
  `REVISION_MISMATCH`.
- `refreshEvidence` is the explicit "recheck everything now" call. Its `observationToken` is a
  hash of the model revision and every reported item; pass it back as `since` to learn whether
  anything an agent would see has changed. Every other call recomputes too: there is no cache.

## Errors

`{ ok: false, context?, error: { code, message, details? } }`:

| Code | When | What to do |
|---|---|---|
| `INVALID_REQUEST` | the request does not match the schema (`details` lists each problem) | fix the request |
| `UNKNOWN_ID` | no model object with that ID, and no claim names it | search the model (`vcv query … search`) |
| `UNKNOWN_BINDING` | no claim file with that binding ID | list claims with the overview |
| `REVISION_MISMATCH` | `expectedRevision` or the cursor's revision is not the current one | restart from the current revision |
| `INVALID_CURSOR` | not a cursor from this request, past the end, or the claims changed | start again without a cursor |
| `PROJECT_NOT_READY` | no `.vcv/`, or the project is uninitialized, conflicted, diverged or invalid (`details` has the diagnostics) | `vcv project status` |
| `UNSAFE_PATH` | `.vcv/` or `.vcv/bindings/` is a symlink or not a directory; nothing was read | repair the checkout; model queries still work |
| `STATE_CHANGED` | the store, commit or claim files changed during the call | retry |

A claim file that cannot be read (conflict markers, bad JSON, a symlink, an oversized file) is
an `invalid` item, not an error: it is counted, listed, and reported to object queries as
`unreadableClaims`, and model queries keep working. The reader is the one from M2.4.

## Where it lives

`packages/repo/src/bindings/evidence.ts` (with the request schemas). Git and source inspection stay in
`@vcv/repo`; `@vcv/query` stays model-only. `apps/cli` and `apps/mcp` only forward requests;
the MCP input schemas are generated from the same zod contracts, and
`apps/mcp/test/evidence.test.ts` checks that both give identical results for the same requests.

## Limits

Inherited from the resolver ([bindings.md](bindings.md#what-works-today-and-what-stays-unchecked)):
TypeScript syntax only, controller-relative routes, test titles matched by name, no rename
following, files over 1 MB unchecked. `stale` says that the selected code or the model object
changed, not how or whether the model is now wrong.
