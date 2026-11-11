# Maintaining a VCV model after the code changed

This guide is for a coding agent (or a person) keeping an existing VCV model in line with a
repository whose code has changed. It is general: it says nothing about any particular
application. It assumes the repository already has a `.vcv/` project and binding claims.

**Who does what.**

| | does | does not |
|---|---|---|
| **You** | read the evidence, inspect the code, decide what the change means, and propose a typed model change | edit `.vcv/` files, approve your own change, or present a guess as a fact |
| **VCV** | reports which claims still resolve and whether their code or model object changed; validates your proposal and stores it as pending | analyse what code means, infer a model change, edit the model by itself, or watch the repository |
| **A person** | reviews and approves (or rejects) the pending proposal | |

`vcv` below is the VCV command line. In a VCV checkout it is
`npm run vcv -- <args>` (or `node --experimental-strip-types apps/cli/src/main.ts <args>`).
The same evidence is available over MCP (`vcv-mcp --repo <checkout>`, tools
`vcv_get_evidence_overview`, `vcv_get_object_evidence`, `vcv_get_binding_evidence`,
`vcv_refresh_evidence`) with identical requests and results.

## Workflow

1. **Check the project.** `vcv project status .` must report `ready`. Note the model revision
   (for example `rev-1 [draft]`) and whether the working tree is dirty.
2. **Recheck the evidence.** `vcv evidence . refresh` recomputes every claim against the working
   tree now and prints counts by state and an `observationToken`. Nothing runs in the background:
   evidence is only as new as your last call.
3. **List what needs a look.** `vcv evidence . overview --states stale,missing,ambiguous,indeterminate,invalid`.
   For each model object named there, `vcv evidence . object <id>` shows every claim about it,
   and `vcv query .vcv context <id>` shows the model's current record of it.
4. **Inspect the code yourself.** `git status`, `git diff` and `git log` show what changed; read
   the files named in the claims' locators and the tests. Evidence tells you *where* to look and
   *that* something changed, never *what it means*. A claim's `locator.detail` and
   `freshness.*.cause` say why it is in its state.
5. **Decide what is no longer true in the model.** Compare each affected object's record (its
   statement, description, attributes, states) with the code. Model what the code does now. If
   the code and its tests disagree, or you cannot tell, say so instead of choosing.
6. **Write one proposed change** to a file outside `.vcv/` (for example
   `vcv-maintenance/change.yaml`) using the operations below, with `expectedRevision` set to the
   current model revision and a `rationale` that cites the code.
7. **Submit it**: `vcv propose .vcv vcv-maintenance/change.yaml`. As an agent you can propose but
   not apply, so a valid change is stored as `pending` for a person. `rejected` comes with
   diagnostics: fix the change file and submit again under a new `changeId`. Do not try to
   approve it; an approval attempt by the proposer is denied.
8. **Check again.** `vcv evidence . refresh --since <token>` should still report the same
   claims as stale or missing: a pending proposal changes nothing, and claims are never updated
   by a model change. A person re-records or reasserts claims after reviewing the code.
9. **Write a report** next to the change (for example `vcv-maintenance/report.md`) that keeps
   four kinds of statement apart:
   - **Source observed**: what the code and its history show, with file paths;
   - **Agent inferred**: what you concluded it means for the model, and how sure you are;
   - **VCV validated**: what VCV reported (evidence states and causes, the proposal's status
     and diagnostics), quoted from its output;
   - **Needs a person**: the approval, claims to reassert or remove, and open questions.

Never create, edit or delete files inside `.vcv/` yourself, and do not change the source code
or the claims unless you were asked to.

## Evidence states

| State | Meaning | Usual next step |
|---|---|---|
| `resolved` | the pointer resolves to exactly one artifact, and neither its code nor the model object changed since the claim | nothing, but it is not proof the code is correct |
| `stale` | it resolves, but the selected code changed (`source: changed`) or the model object changed or was removed (`model: changed/removed`) | read the code; propose a model change if the model is now wrong |
| `missing` | the file or selector no longer resolves (renamed, moved, deleted) | find where it went; a person reasserts or removes the claim |
| `ambiguous` | the selector matches more than one artifact | a person makes the locator more specific |
| `unchecked` | outside the supported subset (see below); only the claim is reported | inspect by hand |
| `indeterminate` | it resolves but some evidence is unknown (for example the claim's revision is from another branch) | treat as unknown, never as a pass |
| `invalid` | the claim file itself cannot be read (conflict markers, bad JSON, unsafe entry) | a person repairs the claim file |

Every result says `meaning: "unverified"` and every claim `approval.approved: false`. The model's
own status (`context.snapshotStatus`, draft or approved) is a separate fact: a draft model with
resolved claims is still a draft, and an approved model with stale claims is still approved.

An edit elsewhere in a bound file is reported as `fileChanged: true` with the cause "not
evidence about this claim"; only a change to the selected declaration (its tokens, not comments
or formatting) makes a symbol, route or test claim stale.

## Change operations

A change file:

```yaml
changeId: ch-maint-01            # lowercase letters, digits, '.', '-', '_'; new for every submission
projectId: <the project id>      # from `vcv project status .`
expectedRevision: <current rev>  # e.g. rev-1
rationale: <why, citing the code>
operations:
  - type: setRuleStatement
    ruleId: rul-order-limit
    statement: An order of more than ten items is split into parcels of at most ten.
```

| Operation | Parameters |
|---|---|
| `setRuleStatement` | `ruleId`, `statement` |
| `setDescription` | `objectId`, `description` (any object with a description, and the project; not attributes, states or transitions) |
| `createRule` | `rule`: a full rule object (`id`, `kind: rule`, `owner`, `name?`, `ruleKind`, `statement` …) |
| `renameObject` | `objectId`, `name` |
| `addDataAttribute` | `dataId`, `attribute: { id, name, type, nullable?, refDataId? }` |
| `createEvent` | `event: { id, kind: event, owner, name, description? }` |
| `createModule` | `module`: a full module object |
| `addState` / `renameState` | `behaviorId`, `state: { id, name }` / `behaviorId`, `stateId`, `name` |
| `addTransition` | `behaviorId`, `transition` (see the bootstrap guide's model reference) |
| `linkContract` | `moduleId`, `contractId` (adds a consumed contract) |
| `setModuleDependencies` | `moduleId`, `dependsOn: [module ids]` |
| `removeObject` | `objectId` (refused while anything still references it) |

Operations apply in order, all or nothing, and the result must be a valid model. Prefer the
smallest change that makes the model true again; say in the rationale what you left unchanged
on purpose.

## What evidence can and cannot tell you

- Selectors are checked only in TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`): named declarations,
  decorated HTTP handlers with literal paths, and `describe`/`it`/`test` titles. Everything else
  is `unchecked`. Only syntax is read; there is no type checking or import following.
- Routes are controller-relative: a global prefix or versioning is not applied.
- Test titles are matched by name; a renamed test is `missing`, even if it tests the same thing.
- VCV never follows a rename or a move. It reports `missing` and leaves the claim alone.
- `stale` says the code changed, not how. The diff and your reading decide what it means.
- A claim made against a model revision from another branch is `indeterminate` here.
- Evidence never contains source text or absolute paths, and reading it never writes anything.
