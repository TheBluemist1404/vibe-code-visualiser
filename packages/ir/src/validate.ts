// Validation levels 1–3 of IR v0.2 §10: schema, typed references, structural/semantic consistency.
// Level 4 (implementation evidence) lives outside the IR, in bindings.
import { modelSchema } from "./schema.ts";
import { buildIndex, collectRefs, refId } from "./graph.ts";
import { SCHEMA_VERSION, isUnresolved } from "./types.ts";
import type { Diagnostic, Id, Model } from "./types.ts";

export type ParseResult = { ok: true; model: Model; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] };

/** Level 1: shape check. Returns the typed model only if its shape is valid. */
export function parseModel(input: unknown): ParseResult {
  const r = modelSchema.safeParse(input);
  if (!r.success) {
    return {
      ok: false,
      diagnostics: r.error.issues.map((i) => ({
        code: "SCHEMA",
        severity: "error",
        path: i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, ""),
        message: i.message,
      })),
    };
  }
  return { ok: true, model: r.data as Model, diagnostics: [] };
}

/** Levels 2–3 on an already well-shaped model. */
export function validateModel(model: Model): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, path: string, message: string) => out.push({ code, severity: "error", path, message });
  const warn = (code: string, path: string, message: string) => out.push({ code, severity: "warning", path, message });
  const draft = model.project.status === "draft";

  if (model.schemaVersion !== SCHEMA_VERSION) {
    err("SCHEMA_VERSION", "schemaVersion", `expected schemaVersion "${SCHEMA_VERSION}", got "${model.schemaVersion}"`);
  }

  const index = buildIndex(model);
  for (const [id, paths] of index.duplicates) {
    err("DUPLICATE_ID", paths[1]!, `ID "${id}" is declared more than once (${paths.join(", ")})`);
  }

  // Typed reference resolution.
  for (const site of collectRefs(model)) {
    if (isUnresolved(site.ref)) {
      const msg = `unresolved reference "${site.ref.unresolved}"${site.ref.diagnostic ? `: ${site.ref.diagnostic}` : ""}`;
      if (draft) warn("UNRESOLVED_REF", site.path, msg);
      else err("UNRESOLVED_IN_APPROVED", site.path, `${msg} (not allowed in an approved snapshot)`);
      continue;
    }
    const target = index.byId.get(site.ref);
    if (!target) err("UNKNOWN_REF", site.path, `"${site.ref}" does not exist`);
    else if (!site.expected.includes(target.kind)) {
      err("WRONG_KIND", site.path, `"${site.ref}" is a ${target.kind}, expected ${site.expected.join(" or ")}`);
    }
  }

  const kindOf = (id: Id | undefined) => (id ? index.byId.get(id)?.kind : undefined);
  const parentOf = (id: Id | undefined) => (id ? index.byId.get(id)?.parentId : undefined);

  // Data attributes.
  model.data.forEach((d, i) =>
    d.attributes.forEach((a, j) => {
      const p = `data[${i}].attributes[${j}]`;
      if (a.type === "reference" && a.refDataId === undefined) err("MISSING_REF_DATA", p, `reference attribute "${a.id}" needs refDataId`);
      if (a.type !== "reference" && a.refDataId !== undefined) warn("UNUSED_REF_DATA", p, `refDataId is ignored unless type is "reference"`);
    }),
  );

  // Module dependencies.
  model.modules.forEach((m, i) => {
    m.dependsOn?.forEach((r, j) => {
      if (refId(r) === m.id) err("SELF_DEPENDENCY", `modules[${i}].dependsOn[${j}]`, `module "${m.id}" depends on itself`);
    });
  });
  for (const cycle of dependencyCycles(model)) {
    warn("DEPENDENCY_CYCLE", "modules", `dependency cycle: ${cycle.join(" → ")}`);
  }

  // Contracts may only list events owned by the contract's own module.
  model.contracts.forEach((c, i) => {
    const check = (list: typeof c.accepts, field: string) =>
      list?.forEach((r, j) => {
        const e = refId(r);
        if (kindOf(e) === "event" && parentOf(e) !== refId(c.owner)) {
          err("CONTRACT_FOREIGN_EVENT", `contracts[${i}].${field}[${j}]`, `contract "${c.id}" lists event "${e}" owned by another module`);
        }
      });
    check(c.accepts, "accepts");
    check(c.publishes, "publishes");
  });

  // Behaviors.
  const rules = new Map(model.rules.map((r) => [r.id, r]));
  const attrType = new Map(model.data.flatMap((d) => d.attributes.map((a) => [a.id, a.type] as const)));
  model.behaviors.forEach((b, i) => {
    const p = `behaviors[${i}]`;
    const moduleId = refId(b.owner);
    const own = (stateRef: typeof b.initialStateId, path: string) => {
      const s = refId(stateRef);
      if (kindOf(s) === "state" && parentOf(s) !== b.id) err("STATE_NOT_IN_BEHAVIOR", path, `state "${s}" belongs to another behavior`);
    };
    own(b.initialStateId, `${p}.initialStateId`);
    b.transitions.forEach((t, j) => {
      const tp = `${p}.transitions[${j}]`;
      own(t.fromStateId, `${tp}.fromStateId`);
      own(t.toStateId, `${tp}.toStateId`);

      if (t.trigger.kind === "event") {
        checkBoundary(t.trigger.eventId, "publishes", `${tp}.trigger.eventId`);
      } else {
        const dataId = refId(t.trigger.anchor.dataId);
        const attrId = refId(t.trigger.anchor.attributeId);
        if (kindOf(attrId) === "attribute") {
          if (dataId && parentOf(attrId) !== dataId) {
            err("ANCHOR_ATTRIBUTE_MISMATCH", `${tp}.trigger.anchor`, `attribute "${attrId}" does not belong to data "${dataId}"`);
          }
          const ty = attrType.get(attrId!);
          if (ty !== "timestamp" && ty !== "date") {
            err("ANCHOR_NOT_TEMPORAL", `${tp}.trigger.anchor.attributeId`, `timer anchor "${attrId}" has type "${ty}", expected timestamp or date`);
          }
        }
      }
      t.guards?.forEach((g, k) => {
        const r = rules.get(refId(g.ruleId) ?? "");
        if (r && r.ruleKind !== "permission") {
          err("GUARD_NOT_PERMISSION", `${tp}.guards[${k}].ruleId`, `permission guard points to rule "${r.id}" of kind "${r.ruleKind}"`);
        }
      });
      t.effects?.forEach((e, k) => checkBoundary(e.eventId, "accepts", `${tp}.effects[${k}].eventId`));
    });

    /**
     * An event owned by another module may be used only through a contract that the
     * owning module exposes and this behavior's module consumes. Triggers need the event
     * published by that contract; emitted effects need it accepted by that contract.
     */
    function checkBoundary(ref: typeof b.initialStateId, direction: "publishes" | "accepts", path: string) {
      const eventId = refId(ref);
      if (kindOf(eventId) !== "event" || !moduleId) return;
      const eventModule = parentOf(eventId);
      if (eventModule === moduleId) return;
      const consumer = model.modules.find((m) => m.id === moduleId);
      const consumed = new Set((consumer?.consumes ?? []).map(refId));
      const ok = model.contracts.some(
        (c) => refId(c.owner) === eventModule && consumed.has(c.id) && (c[direction] ?? []).some((r) => refId(r) === eventId),
      );
      if (!ok) {
        err(
          "EVENT_BOUNDARY",
          path,
          `event "${eventId}" belongs to module "${eventModule}"; "${moduleId}" must consume a contract of that module that ${direction} it`,
        );
      }
    }
  });

  return out;
}

export type CheckResult = { ok: boolean; model?: Model; diagnostics: Diagnostic[] };

/** Parse then validate. `model` is present whenever the shape is valid, even if references are not. */
export function checkModel(input: unknown): CheckResult {
  const parsed = parseModel(input);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const diagnostics = validateModel(parsed.model);
  return { ok: !hasErrors(diagnostics), model: parsed.model, diagnostics };
}

export const hasErrors = (d: Diagnostic[]) => d.some((x) => x.severity === "error");

function dependencyCycles(model: Model): Id[][] {
  const edges = new Map(model.modules.map((m) => [m.id, (m.dependsOn ?? []).map(refId).filter((x): x is Id => !!x && x !== m.id)]));
  const cycles: Id[][] = [];
  const state = new Map<Id, "visiting" | "done">();
  const stack: Id[] = [];
  const visit = (id: Id) => {
    state.set(id, "visiting");
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === "visiting") cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (!state.has(next) && edges.has(next)) visit(next);
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const id of edges.keys()) if (!state.has(id)) visit(id);
  return cycles;
}
