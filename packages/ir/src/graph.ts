// Indexing and reference extraction. One function (collectRefs) defines every typed
// reference in the IR; validation, removal safety and graph projection all use it.
import { COLLECTIONS, isUnresolved } from "./types.ts";
import type { CollectionName, Id, Kind, Model, Ref } from "./types.ts";

export type IndexEntry = {
  id: Id;
  kind: Kind;
  /** Canonical parent: owner for top-level objects, containing object for nested elements. */
  parentId: Id | undefined;
  path: string;
  name: string;
};

export type ModelIndex = {
  byId: Map<Id, IndexEntry>;
  /** IDs declared more than once, with every path they appear at. */
  duplicates: Map<Id, string[]>;
};

export function buildIndex(model: Model): ModelIndex {
  const byId = new Map<Id, IndexEntry>();
  const duplicates = new Map<Id, string[]>();
  const add = (e: IndexEntry) => {
    const prev = byId.get(e.id);
    if (prev) {
      const list = duplicates.get(e.id) ?? [prev.path];
      list.push(e.path);
      duplicates.set(e.id, list);
      return;
    }
    byId.set(e.id, e);
  };

  add({ id: model.project.id, kind: "project", parentId: undefined, path: "project", name: model.project.name });
  for (const coll of Object.keys(COLLECTIONS) as CollectionName[]) {
    model[coll].forEach((obj, i) => {
      const path = `${coll}[${i}]`;
      add({ id: obj.id, kind: COLLECTIONS[coll], parentId: refId(obj.owner), path, name: obj.name ?? obj.id });
    });
  }
  model.data.forEach((d, i) =>
    d.attributes.forEach((a, j) =>
      add({ id: a.id, kind: "attribute", parentId: d.id, path: `data[${i}].attributes[${j}]`, name: a.name }),
    ),
  );
  model.behaviors.forEach((b, i) => {
    b.states.forEach((s, j) => add({ id: s.id, kind: "state", parentId: b.id, path: `behaviors[${i}].states[${j}]`, name: s.name }));
    b.transitions.forEach((t, j) =>
      add({ id: t.id, kind: "transition", parentId: b.id, path: `behaviors[${i}].transitions[${j}]`, name: t.id }),
    );
  });
  return { byId, duplicates };
}

export function refId(ref: Ref | undefined): Id | undefined {
  return ref === undefined || isUnresolved(ref) ? undefined : ref;
}

export type RefRole =
  | "owner"
  | "dependsOn"
  | "consumes"
  | "initiator"
  | "attributeRef"
  | "permissionActor"
  | "permissionCapability"
  | "contractAccepts"
  | "contractPublishes"
  | "realizes"
  | "initialState"
  | "fromState"
  | "toState"
  | "triggerEvent"
  | "anchorData"
  | "anchorAttribute"
  | "guardRule"
  | "effectEvent";

export type RefSite = {
  /** The object (or nested element) holding the reference. */
  fromId: Id;
  path: string;
  ref: Ref;
  role: RefRole;
  expected: Kind[];
};

export function collectRefs(model: Model): RefSite[] {
  const out: RefSite[] = [];
  const push = (fromId: Id, path: string, ref: Ref | undefined, role: RefRole, expected: Kind[]) => {
    if (ref !== undefined) out.push({ fromId, path, ref, role, expected });
  };

  model.actors.forEach((a, i) => push(a.id, `actors[${i}].owner`, a.owner, "owner", ["project"]));
  model.modules.forEach((m, i) => {
    const p = `modules[${i}]`;
    push(m.id, `${p}.owner`, m.owner, "owner", ["project"]);
    m.dependsOn?.forEach((r, j) => push(m.id, `${p}.dependsOn[${j}]`, r, "dependsOn", ["module"]));
    m.consumes?.forEach((r, j) => push(m.id, `${p}.consumes[${j}]`, r, "consumes", ["contract"]));
  });
  model.capabilities.forEach((c, i) => {
    push(c.id, `capabilities[${i}].owner`, c.owner, "owner", ["module"]);
    push(c.id, `capabilities[${i}].initiatorActorId`, c.initiatorActorId, "initiator", ["actor"]);
  });
  model.data.forEach((d, i) => {
    push(d.id, `data[${i}].owner`, d.owner, "owner", ["module"]);
    d.attributes.forEach((a, j) => push(a.id, `data[${i}].attributes[${j}].refDataId`, a.refDataId, "attributeRef", ["data"]));
  });
  model.rules.forEach((r, i) => {
    push(r.id, `rules[${i}].owner`, r.owner, "owner", ["module"]);
    if (r.ruleKind === "permission") {
      push(r.id, `rules[${i}].actorId`, r.actorId, "permissionActor", ["actor"]);
      push(r.id, `rules[${i}].capabilityId`, r.capabilityId, "permissionCapability", ["capability"]);
    }
  });
  model.events.forEach((e, i) => push(e.id, `events[${i}].owner`, e.owner, "owner", ["module"]));
  model.contracts.forEach((c, i) => {
    push(c.id, `contracts[${i}].owner`, c.owner, "owner", ["module"]);
    c.accepts?.forEach((r, j) => push(c.id, `contracts[${i}].accepts[${j}]`, r, "contractAccepts", ["event"]));
    c.publishes?.forEach((r, j) => push(c.id, `contracts[${i}].publishes[${j}]`, r, "contractPublishes", ["event"]));
  });
  model.behaviors.forEach((b, i) => {
    const p = `behaviors[${i}]`;
    push(b.id, `${p}.owner`, b.owner, "owner", ["module"]);
    b.realizes?.forEach((r, j) => push(b.id, `${p}.realizes[${j}]`, r, "realizes", ["capability"]));
    push(b.id, `${p}.initialStateId`, b.initialStateId, "initialState", ["state"]);
    b.transitions.forEach((t, j) => {
      const tp = `${p}.transitions[${j}]`;
      push(t.id, `${tp}.fromStateId`, t.fromStateId, "fromState", ["state"]);
      push(t.id, `${tp}.toStateId`, t.toStateId, "toState", ["state"]);
      if (t.trigger.kind === "event") push(t.id, `${tp}.trigger.eventId`, t.trigger.eventId, "triggerEvent", ["event"]);
      else {
        push(t.id, `${tp}.trigger.anchor.dataId`, t.trigger.anchor.dataId, "anchorData", ["data"]);
        push(t.id, `${tp}.trigger.anchor.attributeId`, t.trigger.anchor.attributeId, "anchorAttribute", ["attribute"]);
      }
      t.guards?.forEach((g, k) => push(t.id, `${tp}.guards[${k}].ruleId`, g.ruleId, "guardRule", ["rule"]));
      t.effects?.forEach((e, k) => push(t.id, `${tp}.effects[${k}].eventId`, e.eventId, "effectEvent", ["event"]));
    });
  });
  return out;
}

// ---- Derived projections (never stored, never written back) ----

export type TreeNode = { id: Id; kind: Kind; name: string; children: TreeNode[] };

/** Ownership hierarchy derived from `owner` fields and nesting. */
export function ownershipTree(model: Model): TreeNode {
  const index = buildIndex(model);
  const nodes = new Map<Id, TreeNode>();
  for (const e of index.byId.values()) nodes.set(e.id, { id: e.id, kind: e.kind, name: e.name, children: [] });
  for (const e of index.byId.values()) {
    if (e.parentId) nodes.get(e.parentId)?.children.push(nodes.get(e.id)!);
  }
  return nodes.get(model.project.id)!;
}

export type GraphEdge = { from: Id; to: Id; relation: RefRole | "contains" };

/** Typed graph derived from every resolvable reference plus nesting. */
export function referenceGraph(model: Model): { nodes: IndexEntry[]; edges: GraphEdge[] } {
  const index = buildIndex(model);
  const edges: GraphEdge[] = [];
  for (const site of collectRefs(model)) {
    const to = refId(site.ref);
    if (to && index.byId.has(to)) edges.push({ from: site.fromId, to, relation: site.role });
  }
  for (const e of index.byId.values()) {
    if (e.kind === "attribute" || e.kind === "state" || e.kind === "transition") {
      edges.push({ from: e.parentId!, to: e.id, relation: "contains" });
    }
  }
  return { nodes: [...index.byId.values()], edges };
}
