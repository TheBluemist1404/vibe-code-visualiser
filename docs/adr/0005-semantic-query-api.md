# ADR 0005: Read-only Semantic Query API (Phase A)

Status: proposed for review (2026-11-10). Implements the candidate v0 operations of
*Core Engine — Semantic Context API & Agent Guidance* (Draft v0.1). Not a final public contract.

## Shape

`packages/query` (`@vcv/query`) depends only on `@vcv/ir`. `createQueryApi(source)` takes any
`SnapshotSource` (`{ current(): Model }`), which `ModelStore` and `ModelEngine` already satisfy,
and returns four functions:

| Operation | Request (zod-validated, strict) | Returns |
|---|---|---|
| `getProjectOverview` | `expectedRevision?`, `moduleLimit` (≤200, default 50), `cursor?` | project, one page of module summaries (purpose, dependsOn, consumes, exposed contracts each capped at 25 with full `counts`, owned counts), `modulesTotal`, `truncated`, `nextCursor`, inventory, validation counts |
| `searchObjects` | `text`, `kinds?` (≤11, one per kind), `limit` (≤100, default 20), `cursor?` | hits with score and matched fields, `total`, `truncated`, `nextCursor` |
| `getContext` | `id`, `depth` (1–2), `direction`, `relations?` (≤19, one per relation), `maxNodes` (≤200, default 25), `maxEdges` (≤1000, default 100), `maxNestedItems` (≤200, default 25) | focus object with a bounded copy of its record and `truncatedFields`, nodes with distance, every qualifying edge between returned nodes (capped), `edgesTotal`, `truncated` |
| `analyzeImpact` | `ids` (1–20), `maxDepth` (≤5, default 3), `maxResults` (≤200, default 50) | candidates with distance, `via`, one shortest dependency path and a plain-text reason |

Every result is `{ ok: true, context, data, diagnostics }` or `{ ok: false, context?, error }`
with `error.code` one of `INVALID_REQUEST`, `UNKNOWN_ID`, `REVISION_MISMATCH`, `INVALID_CURSOR`.
`context` is the §3 envelope plus `implementationChecked: false`.

Each call reads exactly one snapshot and writes nothing. Relationships come from
`buildIndex`/`collectRefs` each call; no second store or cache of relationships exists.

## Decisions that need review

1. **Provenance.** IR v0.2 has no per-object provenance (human/agent/inferred), so responses
   carry the envelope (`source: canonical-ir`, `coverage: model-only`) plus each object's
   `irPath` and each edge's `declaredAt` field path. Per-object provenance would be an IR change.
2. **`implementationChecked: false`** is added to the spec's `QueryContext` so a client cannot
   miss that nothing was compared with code.
3. **Search ranking is heuristic.** Terms are OR'd; a field match scores by field weight
   (name 6, id 4, purpose/description/statement 2), doubled at a word start, halved when only a
   crude suffix-stripped stem matches (`notify` → `Notifications`); modules get ×1.5. Ties break
   by kind order then ID, so results are deterministic. No embeddings or LLM.
4. **Cursors are `<revision>:<scope>:<offset>`.** `scope` is a hash of the query that issued
   the cursor (for search: the normalized, sorted terms and sorted kind filter; for overview: the
   operation). A cursor is refused with `INVALID_CURSOR` when its scope does not match the request,
   its offset is malformed or at/after the end of the result, and with `REVISION_MISMATCH` after
   the model changes, rather than paging over a different query or snapshot. Page size may vary
   between pages. Cursors are opaque but not signed; tampering is caught by validation, not crypto.
5. **Revision pinning is detection only.** Any request may pass `expectedRevision`; a mismatch is
   an error telling the agent to restart. There is no multi-call snapshot pinning.
6. **`getContext` lists children only for the focus object.** Following "owns"/"contains" edges
   from a node reached at depth ≥ 1 would enumerate every sibling in its module and exhaust the
   budget, so beyond the focus those edges are only followed upward (child → parent).
7. **Impact propagation rules.** Impact flows from a changed object to:
   - objects that **reference** it (`via: "dependent"`), which keep propagating;
   - its **owner or container** (`via: "container"`), which are reported but do not propagate,
     so editing one attribute does not flag every module that depends on its module.
   Owned objects are not affected by their owner changing. Only reverse dependencies are
   followed; what the seed itself depends on is out of scope (use `getContext`).
8. **Bounded summary/detail.** Lists are summaries and detail is opt-in, per object:
   `getProjectOverview` pages modules and caps each module's ID lists at 25 (`counts` gives the
   full sizes); `getContext` returns the focus record with every nested array capped at
   `maxNestedItems` and lists each cut as `{field, returned, total}` in `truncatedFields`. Nested
   elements that were cut stay reachable by `searchObjects` or `getContext` on their own ID.
   Every response is therefore bounded by its request limits, whatever the model size.
9. **Complete edge set.** `getContext` returns every edge whose source is a returned node (focus
   included) and whose target is a returned node or unresolved, filtered by `relations`, sorted
   and capped at `maxEdges` with `edgesTotal`. Edges between two non-focus nodes are included, so
   a client sees the real subgraph, not just the traversal tree.
10. **The project root** is excluded from search, traversal and impact; `getProjectOverview` covers it.

## Not included

No repository evidence, bindings or confidence; no MCP/HTTP adapter (Phase B); no mutations.
Agents must still read source code and tests before claiming the implementation matches.
