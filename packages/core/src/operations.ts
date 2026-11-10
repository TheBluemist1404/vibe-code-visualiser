// Typed semantic operations (IR v0.2 §7). Each operation is a discriminated-union member
// with typed parameters; there is no generic JSON patch.
import { z } from "zod";
import { buildIndex, collectRefs, refId, schemas, COLLECTIONS, persistedIdSchema } from "@vcv/ir";
import type { CollectionName, Diagnostic, Id, Model } from "@vcv/ir";

const id = z.string().min(1);
const name = z.string().min(1);

export const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("createModule"), module: schemas.module }).strict(),
  z.object({ type: z.literal("createEvent"), event: schemas.event }).strict(),
  z.object({ type: z.literal("addDataAttribute"), dataId: id, attribute: schemas.attribute }).strict(),
  z.object({ type: z.literal("addState"), behaviorId: id, state: schemas.state }).strict(),
  z.object({ type: z.literal("addTransition"), behaviorId: id, transition: schemas.transition }).strict(),
  z.object({ type: z.literal("renameObject"), objectId: id, name }).strict(),
  z.object({ type: z.literal("renameState"), behaviorId: id, stateId: id, name }).strict(),
  z.object({ type: z.literal("linkContract"), moduleId: id, contractId: id }).strict(),
  z.object({ type: z.literal("setModuleDependencies"), moduleId: id, dependsOn: z.array(id) }).strict(),
  z.object({ type: z.literal("removeObject"), objectId: id }).strict(),
  z.object({ type: z.literal("approveDraft") }).strict(),
]);

export type ModelOperation = z.infer<typeof operationSchema>;

export const proposedChangeSchema = z
  .object({
    // Change and revision IDs become file names in the store, so they use the persisted-ID grammar.
    changeId: persistedIdSchema,
    projectId: id,
    expectedRevision: persistedIdSchema,
    operations: z.array(operationSchema).min(1),
    rationale: z.string().optional(),
  })
  // Strict: a caller cannot smuggle proposer, approver or status fields into a change.
  .strict();

export type ProposedModelChange = z.infer<typeof proposedChangeSchema>;

class OpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Apply operations in order to a copy of the model. Returns the new model or the first
 * operation failure. Model-level validation happens afterwards, on the whole result,
 * so a change set may pass through intermediate states (e.g. unlink, then remove).
 */
export function applyOperations(model: Model, ops: ModelOperation[]): { model: Model } | { error: Diagnostic } {
  const next = structuredClone(model);
  for (const [i, op] of ops.entries()) {
    try {
      applyOne(next, op);
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return { error: { code: e.code, severity: "error", path: `operations[${i}]`, message: `${op.type}: ${e.message}` } };
    }
  }
  return { model: next };
}

function applyOne(m: Model, op: ModelOperation): void {
  const index = buildIndex(m);
  const fresh = (newId: Id) => {
    if (index.byId.has(newId)) throw new OpError("ID_IN_USE", `ID "${newId}" already exists`);
  };
  const behavior = (bid: Id) => m.behaviors.find((b) => b.id === bid) ?? fail("TARGET_MISSING", `behavior "${bid}" not found`);

  switch (op.type) {
    case "createModule":
      fresh(op.module.id);
      m.modules.push(op.module);
      return;
    case "createEvent":
      fresh(op.event.id);
      m.events.push(op.event);
      return;
    case "addDataAttribute": {
      const d = m.data.find((x) => x.id === op.dataId) ?? fail("TARGET_MISSING", `data "${op.dataId}" not found`);
      fresh(op.attribute.id);
      d.attributes.push(op.attribute);
      return;
    }
    case "addState":
      fresh(op.state.id);
      behavior(op.behaviorId).states.push(op.state);
      return;
    case "addTransition":
      fresh(op.transition.id);
      behavior(op.behaviorId).transitions.push(op.transition);
      return;
    case "renameState": {
      const s = behavior(op.behaviorId).states.find((x) => x.id === op.stateId) ?? fail("TARGET_MISSING", `state "${op.stateId}" not in "${op.behaviorId}"`);
      s.name = op.name;
      return;
    }
    case "renameObject": {
      const entry = index.byId.get(op.objectId) ?? fail("TARGET_MISSING", `"${op.objectId}" not found`);
      if (entry.kind === "transition") fail("NOT_RENAMEABLE", "transitions have no display name");
      if (entry.kind === "project") m.project.name = op.name;
      else (findRecord(m, op.objectId) as { name: string }).name = op.name;
      return;
    }
    case "linkContract": {
      const mod = m.modules.find((x) => x.id === op.moduleId) ?? fail("TARGET_MISSING", `module "${op.moduleId}" not found`);
      mod.consumes ??= [];
      if (!mod.consumes.includes(op.contractId)) mod.consumes.push(op.contractId);
      return;
    }
    case "setModuleDependencies": {
      const mod = m.modules.find((x) => x.id === op.moduleId) ?? fail("TARGET_MISSING", `module "${op.moduleId}" not found`);
      mod.dependsOn = [...op.dependsOn];
      return;
    }
    case "removeObject":
      removeObject(m, op.objectId);
      return;
    case "approveDraft":
      if (m.project.status === "approved") fail("ALREADY_APPROVED", "snapshot is already approved");
      m.project.status = "approved";
      return;
  }
}

/**
 * Remove a top-level object or a nested element. Rejected while anything outside the
 * removed subtree still references it; no cascading deletion of meaning.
 */
function removeObject(m: Model, targetId: Id): void {
  const index = buildIndex(m);
  const entry = index.byId.get(targetId) ?? fail("TARGET_MISSING", `"${targetId}" not found`);
  if (entry.kind === "project") fail("NOT_REMOVABLE", "the project cannot be removed");

  // The removed subtree: the target plus everything it (transitively) contains or owns.
  const removed = new Set<Id>([targetId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of index.byId.values()) {
      if (e.parentId && removed.has(e.parentId) && !removed.has(e.id)) {
        removed.add(e.id);
        grew = true;
      }
    }
  }
  const owned = [...removed].filter((x) => x !== targetId && !isNested(index.byId.get(x)!.kind));
  if (owned.length) fail("HAS_OWNED_OBJECTS", `"${targetId}" still owns ${owned.join(", ")}; transfer or remove them first`);

  const incoming = collectRefs(m).filter((s) => {
    const to = refId(s.ref);
    return to !== undefined && removed.has(to) && !removed.has(s.fromId);
  });
  if (incoming.length) {
    fail("REFERENCED", `"${targetId}" is still referenced from ${incoming.map((s) => s.path).join(", ")}`);
  }

  switch (entry.kind) {
    case "state":
    case "transition": {
      const b = m.behaviors.find((x) => x.id === entry.parentId)!;
      if (entry.kind === "state") b.states = b.states.filter((s) => s.id !== targetId);
      else b.transitions = b.transitions.filter((t) => t.id !== targetId);
      return;
    }
    case "attribute": {
      const d = m.data.find((x) => x.id === entry.parentId)!;
      d.attributes = d.attributes.filter((a) => a.id !== targetId);
      return;
    }
    default: {
      const coll = collectionOf(entry.kind);
      (m[coll] as { id: Id }[]) = (m[coll] as { id: Id }[]).filter((o) => o.id !== targetId);
    }
  }
}

const isNested = (k: string) => k === "state" || k === "transition" || k === "attribute";

function collectionOf(kind: string): CollectionName {
  return (Object.keys(COLLECTIONS) as CollectionName[]).find((c) => COLLECTIONS[c] === kind)!;
}

function findRecord(m: Model, objectId: Id): { name?: string } {
  for (const c of Object.keys(COLLECTIONS) as CollectionName[]) {
    const hit = (m[c] as { id: Id; name?: string }[]).find((o) => o.id === objectId);
    if (hit) return hit;
  }
  for (const d of m.data) for (const a of d.attributes) if (a.id === objectId) return a;
  for (const b of m.behaviors) for (const s of b.states) if (s.id === objectId) return s;
  return fail("TARGET_MISSING", `"${objectId}" not found`);
}

function fail(code: string, message: string): never {
  throw new OpError(code, message);
}
