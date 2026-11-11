# Bootstrapping a VCV model for an existing repository

This guide is for a coding agent (or a person) creating the **first draft model** of a
repository that has no `.vcv/` yet. It is general: it says nothing about any particular
application.

**Who does what.** You read the code, decide what it means, and write that down as a model.
VCV checks the model's shape and internal consistency, stores it in the repository, and serves
it to people and other agents. VCV does not analyse source code and does not check that your
model matches it. Everything you write is a **draft interpretation**: it is not verified code
evidence and not approved design until a person reviews it.

`vcv` below is the VCV command line. In a VCV checkout it is
`npm run vcv -- <args>` (or `node --experimental-strip-types apps/cli/src/main.ts <args>`).

## Workflow

1. **Check there is no project yet.** `vcv project status .` must report `absent`. If it
   reports anything else, stop: someone already started a model, and this guide does not apply.
2. **Inspect the repository.** Use whatever tools suit it: reading files, `grep`, the
   language's compiler or type checker, the project's tests, a parser such as Tree-sitter, a
   monorepo tool. VCV does not require any of them. Note which files support each conclusion
   and which conclusions you are unsure of.
3. **Write the draft** to a file outside `.vcv/`, for example `vcv-bootstrap/model.yaml`,
   following the rules below.
4. **Validate it**: `vcv validate vcv-bootstrap/model.yaml`. Fix every error (`✗`). Warnings
   (`!`) are allowed in a draft; read each one and keep it only if it is deliberate (for example
   an unresolved reference you could not settle).
5. **Create the project**: `vcv project init . vcv-bootstrap/model.yaml`. This is the only
   supported way to create `.vcv/`. It refuses an invalid model and an existing project.
   **Never create, edit or delete files inside `.vcv/` yourself**; later changes go through
   VCV's change operations.
6. **Check the result**: `vcv project status .` should report `ready` with the model at
   `rev-1 [draft]`. Read it back with `vcv query .vcv overview` and
   `vcv query .vcv search <words>`.
7. **Write a short report** next to the draft (for example `vcv-bootstrap/report.md`): for each
   module and important element, the files it is based on and how confident you are; open
   questions; and what you deliberately left out. Leave the draft, the report and `.vcv/`
   uncommitted for a person to review, unless you were asked to commit.

## Rules for a truthful draft

- **Model what the code does now**, not what it might do or usually does in similar apps.
  Every element should be traceable to code you read. Omitting something is better than
  inventing it.
- **One module per real unit of ownership** in the code (a package, a framework module, a
  bounded directory), named the way the code names it. `dependsOn` points from the module
  that uses another to the module it uses, as the code's imports or injections show.
- **Capabilities** are what the system lets someone do (an endpoint, a command, a UI action),
  owned by the module that implements them. **Actors** are the kinds of user or external
  system the code distinguishes.
- **Data** is what a module stores or exchanges, with the attributes the code defines.
- **Events and contracts** describe what one module announces to others through a published
  interface; **behaviors** are state machines with explicit transitions. Use them only where
  the code has them.
- **Business rules** the code enforces become `rules` with `ruleKind: invariant` (always true)
  or `policy` (a decision the code makes), with a one-sentence `statement`.
- **Say how sure you are.** Put the evidence and any doubt in `description` (for example
  "Based on src/x/y.ts; the retry limit is configured elsewhere and was not found"). A
  reference you cannot settle can be written as `{ unresolved: "<what>", diagnostic: "<why>" }`;
  drafts allow it (with a warning), approved models do not.
- **Set `project.status: draft`** and `project.modelRevision: rev-1`. Only a person approves a
  model.
- Source locations in descriptions are notes for reviewers. To make a link that VCV can check,
  record a binding claim (next section).

## Recording binding claims (optional)

After `vcv project init`, you can record which code you believe implements, exposes, persists
or tests a model element. VCV checks that the pointer resolves to exactly one thing and stores
the claim under `.vcv/bindings/`; it never checks that the code means what you claim.

```sh
vcv binding add . --source agent --object <element-id> --relation implements \
  --locator 'src/orders/order.service.ts#symbol:OrderService.place' --rationale '<why>' --confidence 0.7
vcv binding verify .
```

- Locators: a file path, `path#symbol:Class.member`, `path#route:POST /orders` (a decorated HTTP
  handler: the controller path plus the method path, without any global prefix), or
  `path#test:Suite > case`. Paths are relative to the repository root.
- A refused claim (`LOCATOR_MISSING`, `LOCATOR_AMBIGUOUS`, `LOCATOR_UNCHECKED`) means the
  pointer does not identify exactly one artifact; fix the locator rather than forcing it.
- Record claims only for code you read. A claim is your interpretation, labelled with
  `--source agent`, and stays unapproved.

## Model reference (schema 0.2)

A model is one YAML (or JSON) document. Every object has a unique `id` (any string; short
prefixed IDs such as `mod-…`, `cap-…` read well), a `kind`, an `owner` and a `name`, and may
have a `description`. IDs are opaque: renaming an object never changes its ID.

| Collection | `kind` | `owner` must be | Extra fields |
|---|---|---|---|
| `project` (one object, no `kind`) | | | `id`, `name`, `modelRevision`, `status: draft \| approved`, `description?` |
| `actors` | `actor` | the project | |
| `modules` | `module` | the project | `purpose?`, `dependsOn?: [module]`, `consumes?: [contract]` |
| `capabilities` | `capability` | a module | `initiatorActorId?: actor` |
| `data` | `data` | a module | `attributes: [{ id, name, type, nullable?, refDataId? }]` |
| `rules` | `rule` | a module | `ruleKind: invariant \| policy` with `statement`, or `ruleKind: permission` with `actorId`, `capabilityId`, `statement?`; `name` optional |
| `events` | `event` | a module | |
| `contracts` | `contract` | a module | `accepts?: [event]`, `publishes?: [event]` |
| `behaviors` | `behavior` | a module | `realizes?: [capability]`, `initialStateId`, `states: [{ id, name }]`, `transitions` |

Attribute `type` is one of `string`, `boolean`, `integer`, `decimal`, `timestamp`, `date`,
`id`, `reference` (a `reference` needs `refDataId`).

A transition is `{ id, fromStateId, toStateId, trigger, guards?, effects? }`:

- `trigger`: `{ kind: event, eventId }`, or `{ kind: elapsed, duration: <ISO 8601, e.g. P7D>,
  anchor: { dataId, attributeId } }` where the attribute is a `timestamp` or `date`.
- `guards`: `[{ kind: permission, ruleId }]`, pointing at permission rules.
- `effects`: `[{ kind: emitEvent, eventId }]`.

Consistency checks that commonly need attention:

- Every reference must name an existing object of the right kind (`UNKNOWN_REF`, `WRONG_KIND`).
- A contract may only list events owned by its own module (`CONTRACT_FOREIGN_EVENT`).
- A behavior that reacts to another module's event (trigger) needs its module to `consume` a
  contract of the event's module that `publishes` it; emitting another module's event needs a
  consumed contract that `accepts` it (`EVENT_BOUNDARY`).
- States used by a behavior must be its own (`STATE_NOT_IN_BEHAVIOR`).
- Module dependency cycles are reported as warnings.

## Example

An invented two-module app, for the format only:

```yaml
schemaVersion: "0.2"
project:
  id: prj-lockers
  name: Parcel Lockers
  modelRevision: rev-1
  status: draft
  description: Draft bootstrapped from the repository at commit <sha>; not reviewed.
actors:
  - { id: act-courier, kind: actor, owner: prj-lockers, name: Courier }
modules:
  - id: mod-lockers
    kind: module
    owner: prj-lockers
    name: Lockers
    purpose: Assigns compartments and releases parcels.
  - id: mod-billing
    kind: module
    owner: prj-lockers
    name: Billing
    purpose: Charges for parcels collected after the free period.
    dependsOn: [mod-lockers]
    consumes: [ctr-locker-events]
capabilities:
  - { id: cap-deposit, kind: capability, owner: mod-lockers, name: Deposit parcel, initiatorActorId: act-courier }
data:
  - id: dat-parcel
    kind: data
    owner: mod-lockers
    name: Parcel
    attributes:
      - { id: att-parcel-id, name: id, type: id }
      - { id: att-deposited-at, name: depositedAt, type: timestamp }
rules:
  - id: rul-one-parcel
    kind: rule
    owner: mod-lockers
    ruleKind: invariant
    statement: A compartment holds at most one parcel.
events:
  - { id: evt-collected, kind: event, owner: mod-lockers, name: Parcel collected }
contracts:
  - { id: ctr-locker-events, kind: contract, owner: mod-lockers, name: Locker events, publishes: [evt-collected] }
behaviors:
  - id: beh-charge
    kind: behavior
    owner: mod-billing
    name: Late collection charge
    initialStateId: st-open
    states:
      - { id: st-open, name: Open }
      - { id: st-charged, name: Charged }
    transitions:
      - id: tr-charge
        fromStateId: st-open
        toStateId: st-charged
        trigger: { kind: event, eventId: evt-collected }
  - id: beh-retention
    kind: behavior
    owner: mod-lockers
    name: Retention
    initialStateId: st-held
    states:
      - { id: st-held, name: Held }
      - { id: st-returned, name: Returned to sender }
    transitions:
      - id: tr-return
        fromStateId: st-held
        toStateId: st-returned
        trigger: { kind: elapsed, duration: P3D, anchor: { dataId: dat-parcel, attributeId: att-deposited-at } }
```

## Later: keeping the model in line with the code

When the code changes after the model and claims exist, follow
[agent-maintenance.md](agent-maintenance.md): read the evidence, inspect the change, and propose
a typed model change for a person to approve.
