// Object-level model deltas and their structural impact, for previews, handoffs and reconciliation.
import { canonicalJson } from "@vcv/core";
import type { ProposedModelChange } from "@vcv/core";
import { buildIndex } from "@vcv/ir";
import type { Id, Model } from "@vcv/ir";
import { LIMITS as QUERY_LIMITS, createQueryApi } from "@vcv/query";
import type { ImpactCandidate } from "@vcv/query";

export const DIFF_LIMITS = {
  /** Field values longer than this are cut in a delta (and marked truncated). */
  valueChars: 300,
} as const;

export type FieldChange = { field: string; before?: string; after?: string; truncated?: true };

export type ObjectChange = {
  id: Id;
  kind: string;
  name: string;
  /** Module the object belongs to (after the change, or before it for removals). */
  moduleId: Id | null;
  change: "added" | "removed" | "modified";
  fields: FieldChange[];
};

/** Structural impact of a model delta: modules and contracts touched, and impact candidates. */
export type ModelImpact = {
  /** Modules owning a changed object ("changed") or a structural impact candidate ("impacted"). */
  modules: { id: Id; name: string; via: "changed" | "impacted" }[];
  /** "not-determined": one module seen, but the impact list was cut, so others may be affected. */
  crossModule: "yes" | "no" | "not-determined";
  contracts: { id: Id; name: string; moduleId: Id | null; via: "changed" | "impacted" }[];
  candidates: ImpactCandidate[];
  total: number;
  truncated: boolean;
  impactClass: "structural-candidate";
  note: string;
};

type Item = { id: Id; kind: string; name: string; fields: Record<string, unknown> };

/** Field-level records for every object, nested elements as their own items. */
function items(m: Model): Map<Id, Item> {
  const out = new Map<Id, Item>();
  const { project } = m;
  const { modelRevision: _rev, ...projectFields } = project;
  out.set(project.id, { id: project.id, kind: "project", name: project.name, fields: projectFields });
  const put = (kind: string, o: { id: Id; name?: string }, omit: string[] = []) => {
    const fields = Object.fromEntries(Object.entries(o).filter(([k]) => !omit.includes(k)));
    out.set(o.id, { id: o.id, kind, name: o.name ?? o.id, fields });
  };
  for (const x of m.actors) put("actor", x);
  for (const x of m.modules) put("module", x);
  for (const x of m.capabilities) put("capability", x);
  for (const x of m.rules) put("rule", x);
  for (const x of m.events) put("event", x);
  for (const x of m.contracts) put("contract", x);
  for (const d of m.data) {
    put("data", d, ["attributes"]);
    for (const a of d.attributes) put("attribute", a);
  }
  for (const x of m.criteria ?? []) put("criterion", x);
  for (const b of m.behaviors) {
    put("behavior", b, ["states", "transitions"]);
    for (const s of b.states) put("state", s);
    for (const t of b.transitions) put("transition", t);
  }
  return out;
}

export function moduleOf(m: Model, id: Id): Id | null {
  const index = buildIndex(m).byId;
  let e = index.get(id);
  while (e) {
    if (e.kind === "module") return e.id;
    if (!e.parentId) return null;
    e = index.get(e.parentId);
  }
  return null;
}

const show = (v: unknown): { text?: string; truncated?: true } => {
  if (v === undefined) return {};
  const text = typeof v === "string" ? v : canonicalJson(v);
  return text.length > DIFF_LIMITS.valueChars
    ? { text: `${text.slice(0, DIFF_LIMITS.valueChars)}…`, truncated: true }
    : { text };
};

/** Object-level before/after delta, in a stable order (kind, then ID). */
export function diffModels(before: Model, after: Model): ObjectChange[] {
  const a = items(before);
  const b = items(after);
  const out: ObjectChange[] = [];
  const ids = [...new Set([...a.keys(), ...b.keys()])];
  for (const id of ids) {
    const x = a.get(id);
    const y = b.get(id);
    const fields: FieldChange[] = [];
    const keys = [...new Set([...Object.keys(x?.fields ?? {}), ...Object.keys(y?.fields ?? {})])].sort();
    for (const k of keys) {
      const bv = x?.fields[k];
      const av = y?.fields[k];
      if (canonicalJson(bv ?? null) === canonicalJson(av ?? null)) continue;
      const bs = show(bv);
      const as = show(av);
      fields.push({
        field: k,
        ...(bs.text !== undefined ? { before: bs.text } : {}),
        ...(as.text !== undefined ? { after: as.text } : {}),
        ...(bs.truncated || as.truncated ? { truncated: true as const } : {}),
      });
    }
    if (x && y && !fields.length) continue;
    const item = (y ?? x)!;
    out.push({
      id,
      kind: item.kind,
      name: item.name,
      moduleId: y ? moduleOf(after, id) : moduleOf(before, id),
      change: !x ? "added" : !y ? "removed" : "modified",
      fields,
    });
  }
  return out.sort((p, q) => (p.kind === q.kind ? (p.id < q.id ? -1 : p.id > q.id ? 1 : 0) : p.kind < q.kind ? -1 : 1));
}

export function impactOf(before: Model, after: Model, changes: ObjectChange[], limit: number): ModelImpact {
  const seen = new Map<Id, ImpactCandidate>();
  let truncated = false;
  const changedIds = new Set(changes.map((c) => c.id));
  const run = (m: Model, ids: Id[]) => {
    for (let i = 0; i < ids.length; i += QUERY_LIMITS.impact.maxSeeds) {
      const r = createQueryApi({ current: () => m }).analyzeImpact({
        ids: ids.slice(i, i + QUERY_LIMITS.impact.maxSeeds),
        maxResults: Math.min(limit, QUERY_LIMITS.impact.maxResults),
      });
      if (!r.ok) continue;
      truncated ||= r.data.truncated;
      for (const c of r.data.candidates) if (!changedIds.has(c.id) && !seen.has(c.id)) seen.set(c.id, c);
    }
  };
  // Removed objects are traced in the model they were removed from; everything else in the result.
  run(
    after,
    changes.filter((c) => c.change !== "removed" && c.kind !== "project").map((c) => c.id),
  );
  run(
    before,
    changes.filter((c) => c.change === "removed").map((c) => c.id),
  );
  const candidates = [...seen.values()].sort((p, q) => p.distance - q.distance || (p.id < q.id ? -1 : 1));

  const modules = new Map<Id, { id: Id; name: string; via: "changed" | "impacted" }>();
  const nameIn = (id: Id) => buildIndex(after).byId.get(id)?.name ?? buildIndex(before).byId.get(id)?.name ?? id;
  for (const c of changes)
    if (c.moduleId) modules.set(c.moduleId, { id: c.moduleId, name: nameIn(c.moduleId), via: "changed" });
  for (const c of candidates)
    if (c.moduleId && !modules.has(c.moduleId))
      modules.set(c.moduleId, { id: c.moduleId, name: nameIn(c.moduleId), via: "impacted" });

  const contracts = new Map<Id, { id: Id; name: string; moduleId: Id | null; via: "changed" | "impacted" }>();
  for (const c of changes)
    if (c.kind === "contract") contracts.set(c.id, { id: c.id, name: c.name, moduleId: c.moduleId, via: "changed" });
  for (const c of candidates)
    if (c.kind === "contract" && !contracts.has(c.id))
      contracts.set(c.id, { id: c.id, name: c.name, moduleId: c.moduleId ?? null, via: "impacted" });

  return {
    modules: [...modules.values()].sort((p, q) => (p.id < q.id ? -1 : 1)),
    crossModule: modules.size > 1 ? "yes" : truncated || candidates.length > limit ? "not-determined" : "no",
    contracts: [...contracts.values()].sort((p, q) => (p.id < q.id ? -1 : 1)),
    candidates: candidates.slice(0, limit),
    total: candidates.length,
    truncated: truncated || candidates.length > limit,
    impactClass: "structural-candidate",
    note: "Structural candidates from declared model references (@vcv/query analyzeImpact), not proof of semantic or code impact. Confirm each in the repository.",
  };
}

/** One line per operation, for people. */
export function describeOperation(op: ProposedModelChange["operations"][number]): string {
  switch (op.type) {
    case "createModule":
      return `create module ${op.module.id} "${op.module.name}"`;
    case "createEvent":
      return `create event ${op.event.id} "${op.event.name}" owned by ${String(op.event.owner)}`;
    case "createCapability":
      return `create capability ${op.capability.id} "${op.capability.name}" owned by ${String(op.capability.owner)}`;
    case "createRule":
      return `create rule ${op.rule.id} owned by ${String(op.rule.owner)}`;
    case "addDataAttribute":
      return `add attribute ${op.attribute.id} (${op.attribute.name}: ${op.attribute.type}) to ${op.dataId}`;
    case "addState":
      return `add state ${op.state.id} "${op.state.name}" to ${op.behaviorId}`;
    case "addTransition":
      return `add transition ${op.transition.id} to ${op.behaviorId}`;
    case "renameObject":
      return `rename ${op.objectId} to "${op.name}"`;
    case "renameState":
      return `rename state ${op.stateId} of ${op.behaviorId} to "${op.name}"`;
    case "linkContract":
      return `module ${op.moduleId} consumes contract ${op.contractId}`;
    case "setModuleDependencies":
      return `module ${op.moduleId} depends on [${op.dependsOn.join(", ")}]`;
    case "removeObject":
      return `remove ${op.objectId}`;
    case "setRuleStatement":
      return `change the statement of rule ${op.ruleId}`;
    case "setDescription":
      return `change the description of ${op.objectId}`;
    case "createCriterion":
      return `create ${op.criterion.verification} criterion ${op.criterion.id} on ${op.criterion.verifies.map(String).join(", ")}`;
    case "reviseCriterion": {
      const what = [
        op.statement !== undefined && "its statement",
        op.verifies !== undefined && `what it verifies (${op.verifies.join(", ")})`,
        op.verification !== undefined && `its verification policy (${op.verification})`,
      ].filter(Boolean);
      return `change ${what.join(", ")} of criterion ${op.criterionId}`;
    }
    case "approveDraft":
      return "mark the model snapshot approved (draft → approved)";
  }
}
