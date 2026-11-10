# Vibe Code Visualiser: IR v0.2 engine spike

The first slice of the plan in Notion: a typed IR, a validator, and a model engine that
applies typed changes with revision checks and approvals, tested against the Enrollment
fixture from *IR v0 — Conceptual Specification* (Draft v0.2).

```
packages/ir     IR types, shape schema (zod), reference index, validation, YAML load/dump, tree/graph projections
packages/core   typed operations, ModelEngine (propose/approve), Memory/File stores, bindings, layout store
apps/cli        thin CLI over the engine (no domain logic)
examples/enrollment   model.rev-1.yaml (valid fixture), change.timeout.yaml (the spec's 7-day timeout change)
docs/adr        decision records 0001–0003
```

Requires Node 22.18+ (runs TypeScript directly, no build step).

```sh
npm install
npm test            # 25 tests
npm run typecheck
npm run vcv -- validate examples/enrollment/model.rev-1.yaml
npm run vcv -- init .vcv-store examples/enrollment/model.rev-1.yaml
npm run vcv -- propose .vcv-store examples/enrollment/change.timeout.yaml --as agent:mcp --perm propose
npm run vcv -- approve .vcv-store ch-timeout-01 --as hoang
npm run vcv -- show .vcv-store --tree
```

## Spec acceptance cases (§10)

| # | Case | Where |
|---|------|-------|
| 1 | Serialize/load keeps IDs, names, meaning | ir `AC1` |
| 2 | Reject duplicate IDs (incl. state, attribute) and wrong-kind refs | ir `AC2` |
| 3 | Reject multiple parents, wrong-kind or missing owners | ir `AC3` |
| 4 | Reject unknown initial/from/to state | ir `AC4` |
| 5 | State rename keeps references | core `AC5/AC14` |
| 6 | Reject nonexistent event IDs | ir `AC6` |
| 7 | Reject external event without contract boundary | ir `AC7` |
| 8 | Permission guard must hit a permission rule with real actor/capability | ir `AC8` |
| 9 | Timer anchor must be an existing temporal attribute | ir `AC9` |
| 10 | Unresolved refs only in drafts; can't approve while unresolved | ir + core `AC10` |
| 11 | Atomic change sets | core `AC11` |
| 12 | ChangeRecord outcomes with host-verified proposer/approver | core `AC12` (×2) |
| 13 | Revalidate approvals; reject stale and replayed changes | core `AC13` (×2) |
| 14 | Rename/remove with referential integrity, incl. nested | core `AC14` |
| 15 | Bindings carry modelRevision + commit; stale, not disputed | core `AC15` |
| 16 | Layout edits never create revisions | core `AC16` |

Not covered yet: detecting a divergent code change (needs the repository indexer, Slice 3).

## Decisions the spec left open (made here, review them)

1. **Rule `name` is optional.** The spec's own permission-rule example has no name.
2. **Emitting another module's event** requires a consumed contract of that module that
   `accepts` it (triggers on a foreign event need `publishes`). The spec only describes
   the publish direction.
3. **Fixing a draft needs targeted operations.** Added `setModuleDependencies`. The spec's
   `updateObject` is not implemented because a generic version is a JSON patch in disguise.
4. **`approveDraft` needs approve rights** even for principals that can apply changes.
5. **Self-approval is forbidden by default** (`allowSelfApproval` policy flag).
6. The rejection event still carries no reason, so timeout and lecturer rejections look the
   same to consumers (spec open question 2).
