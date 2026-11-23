// Inspector read models: a module and what it owns, or one object and its declared relations.
// Both read one model snapshot through the query API; nothing is inferred from code.
import { buildIndex, isUnresolved, refId } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import type { QueryApi } from "@vcv/query";
import type { DependencyKind, ModuleView, ObjectRef, ObjectView, OwnedObject } from "./types.ts";

export class NotFoundError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const OWNED_COLLECTIONS = ["capabilities", "data", "rules", "events", "contracts", "behaviors", "criteria"] as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ownedSummary(model: Model, names: Map<string, string>, moduleId: string): Record<string, OwnedObject[]> {
  const out: Record<string, OwnedObject[]> = {};
  const add = (o: OwnedObject) => {
    out[o.kind] = [...(out[o.kind] ?? []), o];
  };
  const name = (ref: unknown) => (typeof ref === "string" ? (names.get(ref) ?? ref) : "an unresolved reference");
  for (const coll of OWNED_COLLECTIONS) {
    for (const obj of model[coll] ?? []) {
      if (refId(obj.owner) !== moduleId) continue;
      const base = { id: obj.id, kind: obj.kind, name: obj.name ?? obj.id };
      const description = obj.description;
      switch (obj.kind) {
        case "capability":
          add({
            ...base,
            ...(description ? { text: description } : {}),
            facts: obj.initiatorActorId ? [`initiated by ${name(obj.initiatorActorId)}`] : [],
          });
          break;
        case "data":
          add({
            ...base,
            ...(description ? { text: description } : {}),
            facts: [plural(obj.attributes.length, "attribute")],
          });
          break;
        case "rule":
          add({ ...base, ...(obj.statement ? { text: obj.statement } : {}), facts: [obj.ruleKind] });
          break;
        case "criterion":
          add({
            ...base,
            text: obj.statement,
            facts: [obj.verification, `verifies ${plural(obj.verifies.length, "object")}`],
          });
          break;
        case "contract":
          add({
            ...base,
            ...(description ? { text: description } : {}),
            facts: [
              ...(obj.accepts?.length ? [`accepts ${plural(obj.accepts.length, "event")}`] : []),
              ...(obj.publishes?.length ? [`publishes ${plural(obj.publishes.length, "event")}`] : []),
            ],
          });
          break;
        case "behavior":
          add({
            ...base,
            ...(description ? { text: description } : {}),
            facts: [plural(obj.states.length, "state"), plural(obj.transitions.length, "transition")],
          });
          break;
        default:
          add({ ...base, ...(description ? { text: description } : {}), facts: [] });
      }
    }
  }
  return out;
}

type Link = ObjectRef & { kind: DependencyKind; via: string[] };

function moduleLinks(model: Model, moduleId: string): { dependsOn: Link[]; usedBy: Link[] } {
  const contractOwner = new Map(model.contracts.map((c) => [c.id, refId(c.owner)]));
  const byId = new Map(model.modules.map((m) => [m.id, m]));
  const dependsOn: Link[] = [];
  const usedBy: Link[] = [];
  const push = (list: Link[], other: string, kind: DependencyKind, via?: string) => {
    const m = byId.get(other);
    if (!m) return;
    const found = list.find((l) => l.id === other && l.kind === kind);
    if (found) {
      if (via) found.via.push(via);
      return;
    }
    list.push({ id: m.id, kind, name: m.name, via: via ? [via] : [] });
  };
  for (const m of model.modules) {
    for (const ref of m.dependsOn ?? []) {
      if (isUnresolved(ref)) continue;
      if (m.id === moduleId) push(dependsOn, ref, "dependsOn");
      else if (ref === moduleId) push(usedBy, m.id, "dependsOn");
    }
    for (const ref of m.consumes ?? []) {
      if (isUnresolved(ref)) continue;
      const owner = contractOwner.get(ref);
      if (!owner || owner === m.id) continue;
      if (m.id === moduleId) push(dependsOn, owner, "consumes", ref);
      else if (owner === moduleId) push(usedBy, m.id, "consumes", ref);
    }
  }
  return { dependsOn, usedBy };
}

export function moduleView(model: Model, query: QueryApi, moduleId: string, modelKey: string): ModuleView {
  const revision = model.project.modelRevision;
  const ctx = query.getContext({ id: moduleId, expectedRevision: revision, depth: 1, maxNodes: 200, maxEdges: 1000 });
  if (!ctx.ok) throw new NotFoundError(ctx.error.code, ctx.error.message);
  const focus = ctx.data.focus;
  if (focus.kind !== "module") throw new NotFoundError("NOT_A_MODULE", `${moduleId} is a ${focus.kind}, not a module`);
  const record = focus.record as { purpose?: string; description?: string };
  const names = new Map([...buildIndex(model).byId.values()].map((e) => [e.id, e.name]));
  return {
    revision,
    modelKey,
    module: {
      id: focus.id,
      kind: focus.kind,
      name: focus.name,
      irPath: focus.irPath,
      ...(record.purpose ? { purpose: record.purpose } : {}),
      ...(record.description ? { description: record.description } : {}),
    },
    ...moduleLinks(model, moduleId),
    owned: ownedSummary(model, names, moduleId),
    truncated: ctx.data.truncated,
  };
}

export function objectView(model: Model, query: QueryApi, id: string, modelKey: string): ObjectView {
  const revision = model.project.modelRevision;
  const ctx = query.getContext({ id, expectedRevision: revision, depth: 1, maxNodes: 200, maxEdges: 1000 });
  if (!ctx.ok) throw new NotFoundError(ctx.error.code, ctx.error.message);
  const { focus, edges, nodes } = ctx.data;
  const refs = new Map<string, ObjectRef & { moduleId?: string }>(
    nodes.map((n) => [n.id, { id: n.id, kind: n.kind, name: n.name, ...(n.moduleId ? { moduleId: n.moduleId } : {}) }]),
  );
  const relations: ObjectView["relations"] = [];
  for (const e of edges) {
    if (typeof e.to !== "string") continue;
    const outgoing = e.from === focus.id;
    const other = refs.get(outgoing ? e.to : e.from);
    if (!other) continue;
    relations.push({
      direction: outgoing ? "outgoing" : "incoming",
      relation: e.relation,
      other,
      declaredAt: e.declaredAt,
    });
  }
  return {
    revision,
    modelKey,
    object: {
      id: focus.id,
      kind: focus.kind,
      name: focus.name,
      irPath: focus.irPath,
      ...(focus.moduleId ? { moduleId: focus.moduleId } : {}),
      ...(focus.parentId ? { parentId: focus.parentId } : {}),
      record: focus.record as Record<string, unknown>,
    },
    relations,
    truncated: ctx.data.truncated,
  };
}
