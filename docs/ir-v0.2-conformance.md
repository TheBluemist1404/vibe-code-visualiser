# IR v0.2 conformance and open decisions

This page records how the engine maps to *IR v0 — Conceptual Specification* (Draft v0.2):
which tests cover the spec's acceptance cases, what was hardened beyond them, and which
decisions the spec left open that the implementation made. It moved here from the root
README, which now describes the project as a whole.

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

Not covered yet: detecting a divergent code change (needs the repository indexer, M2/M4).

## Hardening beyond §10

| Area | Tests |
|------|-------|
| Crash before each write/rename of each commit step, recovery, retry | `packages/core/test/store.test.ts` |
| Persisted-ID grammar (lowercase only), structured errors, nothing written outside the store | `packages/core/test/ids.test.ts` |
| Which attempts create records, attempt log, pending preserved on denied approvals | `packages/core/test/audit.test.ts` |

The file store assumes a **single writer**; see [ADR 0003](adr/0003-persistence.md) for the
commit protocol and its limits.

## Decisions the spec left open (made here, review them)

1. **Rule `name` is optional.** The spec's own permission-rule example has no name.
2. **Emitting another module's event** requires a consumed contract of that module that
   `accepts` it (triggers on a foreign event need `publishes`). The spec only describes
   the publish direction.
3. **Fixing a draft needs targeted operations.** Added `setModuleDependencies`, and in M2.5
   `createRule`, `setRuleStatement` and `setDescription` (keeping a model true after a code change
   needs to change a rule's statement or an object's description without remove-and-recreate),
   and in M3.1 `createCapability` (a model-first change that adds a capability had no typed way in).
   The spec's `updateObject` is not implemented because a generic version is a JSON patch in
   disguise.
4. **`approveDraft` needs approve rights** even for principals that can apply changes.
5. **Self-approval is forbidden by default** (`allowSelfApproval` policy flag).
6. The rejection event still carries no reason, so timeout and lecturer rejections look the
   same to consumers (spec open question 2).
