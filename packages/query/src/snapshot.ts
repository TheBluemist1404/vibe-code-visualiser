// A read-only view over one model snapshot. Everything here is derived on demand from the
// canonical IR via buildIndex/collectRefs; no relationship is stored a second time.
import { COLLECTIONS, buildIndex, collectionOf, collectRefs, isUnresolved, refId, validateModel } from "@vcv/ir";
import type { CollectionName, Diagnostic, Id, IndexEntry, Kind, Model, RefRole } from "@vcv/ir";
import type { Edge, ObjectSummary, QueryContext, Relation, RelationCategory } from "./types.ts";

const CATEGORY: Record<Relation, RelationCategory> = {
  owner: "ownership",
  contains: "ownership",
  dependsOn: "dependency",
  consumes: "contract",
  contractAccepts: "contract",
  contractPublishes: "contract",
  initiator: "permission",
  permissionActor: "permission",
  permissionCapability: "permission",
  guardRule: "permission",
  attributeRef: "data",
  anchorData: "data",
  anchorAttribute: "data",
  realizes: "traceability",
  initialState: "behavior",
  fromState: "behavior",
  toState: "behavior",
  triggerEvent: "behavior",
  effectEvent: "behavior",
  verifies: "traceability",
};

/** Stable order for kinds in results (architecture first, nested elements last). */
export const KIND_ORDER: Kind[] = [
  "project",
  "module",
  "contract",
  "event",
  "capability",
  "behavior",
  "data",
  "rule",
  "criterion",
  "actor",
  "state",
  "transition",
  "attribute",
];

export class Snapshot {
  readonly model: Model;
  readonly index: Map<Id, IndexEntry>;
  readonly records = new Map<Id, Record<string, unknown>>();
  readonly edges: Edge[];
  readonly outgoing = new Map<Id, Edge[]>();
  readonly incoming = new Map<Id, Edge[]>();
  readonly diagnostics: Diagnostic[];

  constructor(model: Model) {
    this.model = model;
    this.index = buildIndex(model).byId;
    for (const coll of Object.keys(COLLECTIONS) as CollectionName[]) {
      for (const o of collectionOf(model, coll)) this.records.set(o.id, o as Record<string, unknown>);
    }
    for (const d of model.data) for (const a of d.attributes) this.records.set(a.id, a as Record<string, unknown>);
    for (const b of model.behaviors) {
      for (const s of b.states) this.records.set(s.id, s as Record<string, unknown>);
      for (const t of b.transitions) this.records.set(t.id, t as Record<string, unknown>);
    }

    const edges: Edge[] = collectRefs(model).map((s) => ({
      from: s.fromId,
      to: isUnresolved(s.ref) ? { unresolved: s.ref.unresolved } : s.ref,
      relation: s.role as RefRole,
      category: CATEGORY[s.role],
      declaredAt: s.path,
    }));
    for (const e of this.index.values()) {
      if (e.kind === "state" || e.kind === "transition" || e.kind === "attribute") {
        edges.push({ from: e.parentId!, to: e.id, relation: "contains", category: "ownership", declaredAt: e.path });
      }
    }
    edges.sort(compareEdges);
    this.edges = edges;
    for (const e of edges) {
      push(this.outgoing, e.from, e);
      if (typeof e.to === "string") push(this.incoming, e.to, e);
    }
    this.diagnostics = validateModel(model);
  }

  context(): QueryContext {
    const p = this.model.project;
    return {
      projectId: p.id,
      modelRevision: p.modelRevision,
      snapshotStatus: p.status,
      source: "canonical-ir",
      coverage: "model-only",
      implementationChecked: false,
    };
  }

  has(id: Id): boolean {
    return this.index.has(id);
  }

  moduleOf(id: Id): Id | undefined {
    let e = this.index.get(id);
    while (e) {
      if (e.kind === "module") return e.id;
      if (!e.parentId) return undefined;
      e = this.index.get(e.parentId);
    }
    return undefined;
  }

  summary(id: Id): ObjectSummary {
    const e = this.index.get(id)!;
    const rec = this.records.get(id);
    const description = typeof rec?.description === "string" ? rec.description : undefined;
    const moduleId = this.moduleOf(id);
    return {
      id,
      kind: e.kind,
      name: e.name,
      ...(description ? { description } : {}),
      ...(moduleId ? { moduleId } : {}),
      ...(e.parentId ? { parentId: e.parentId } : {}),
      irPath: e.path,
    };
  }

  /** Diagnostics declared at or under the object's IR path. */
  diagnosticsFor(ids: Iterable<Id>): Diagnostic[] {
    const paths = [...ids].map((i) => this.index.get(i)?.path).filter((p): p is string => !!p);
    return this.diagnostics.filter((d) =>
      paths.some((p) => d.path === p || d.path.startsWith(p + ".") || d.path.startsWith(p + "[")),
    );
  }
}

export function compareObjects(a: { kind: Kind; id: Id }, b: { kind: Kind; id: Id }): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || cmp(a.id, b.id);
}

function compareEdges(a: Edge, b: Edge): number {
  return (
    cmp(a.from, b.from) || cmp(a.relation, b.relation) || cmp(target(a), target(b)) || cmp(a.declaredAt, b.declaredAt)
  );
}

export const target = (e: Edge): string => (typeof e.to === "string" ? e.to : `?${e.to.unresolved}`);
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}
