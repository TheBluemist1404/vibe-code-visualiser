// Module graph for the canvas, projected from one model snapshot. Edge direction is taken
// from the declaring IR field and never inferred: `from` declares `dependsOn` (or `consumes`),
// `to` is the module depended on.
import { isUnresolved, refId } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import type { ProjectOverview } from "@vcv/query";
import type { ModuleEdgeView, ModuleNodeView } from "./types.ts";

export type ModuleGraph = {
  modules: ModuleNodeView[];
  edges: ModuleEdgeView[];
  unresolved: { from: string; text: string; declaredAt: string }[];
};

/** Nodes come from the query overview (purpose, owned counts); edges from the module records. */
export function moduleGraph(model: Model, overview: Pick<ProjectOverview, "modules">): ModuleGraph {
  const modules: ModuleNodeView[] = overview.modules.map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.purpose ? { purpose: m.purpose } : {}),
    owned: Object.fromEntries(Object.entries(m.owned).filter(([, n]) => (n ?? 0) > 0)) as Record<string, number>,
  }));
  const shown = new Set(modules.map((m) => m.id));
  const contractOwner = new Map(model.contracts.map((c) => [c.id, refId(c.owner)]));
  const edges = new Map<string, ModuleEdgeView>();
  const unresolved: ModuleGraph["unresolved"] = [];

  model.modules.forEach((m, i) => {
    if (!shown.has(m.id)) return;
    (m.dependsOn ?? []).forEach((ref, j) => {
      const declaredAt = `modules[${i}].dependsOn[${j}]`;
      if (isUnresolved(ref)) return unresolved.push({ from: m.id, text: ref.unresolved, declaredAt });
      if (!shown.has(ref)) return unresolved.push({ from: m.id, text: ref, declaredAt });
      const id = `dependsOn:${m.id}->${ref}`;
      if (!edges.has(id)) edges.set(id, { id, from: m.id, to: ref, kind: "dependsOn", via: [], declaredAt });
    });
    (m.consumes ?? []).forEach((ref, j) => {
      const declaredAt = `modules[${i}].consumes[${j}]`;
      const owner = isUnresolved(ref) ? undefined : contractOwner.get(ref);
      if (isUnresolved(ref) || !owner || !shown.has(owner) || owner === m.id) {
        if (owner !== m.id) unresolved.push({ from: m.id, text: isUnresolved(ref) ? ref.unresolved : ref, declaredAt });
        return;
      }
      const id = `consumes:${m.id}->${owner}`;
      const edge = edges.get(id) ?? { id, from: m.id, to: owner, kind: "consumes" as const, via: [], declaredAt };
      edge.via.push(ref);
      edges.set(id, edge);
    });
  });
  return { modules, edges: [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), unresolved };
}
