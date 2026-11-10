// Read-only Semantic Query API (Core Engine — Semantic Context API, Draft v0.1).
// Each call reads exactly one snapshot from the source and never writes anything.
import type { Diagnostic, Id, Kind } from "@vcv/ir";
import { Snapshot, compareObjects, cmp, target } from "./snapshot.ts";
import { contextRequest, impactRequest, overviewRequest, searchRequest } from "./types.ts";
import type {
  ContextNode,
  ContextRequest,
  Edge,
  ImpactAnalysis,
  ImpactCandidate,
  ImpactRequest,
  ModuleSummary,
  ObjectContext,
  OverviewRequest,
  PathStep,
  ProjectOverview,
  QueryError,
  QueryResult,
  SearchHit,
  SearchRequest,
  SearchResults,
  SnapshotSource,
} from "./types.ts";
import type { z } from "zod";

export type QueryApi = {
  getProjectOverview(req?: OverviewRequest): QueryResult<ProjectOverview>;
  searchObjects(req: SearchRequest): QueryResult<SearchResults>;
  getContext(req: ContextRequest): QueryResult<ObjectContext>;
  analyzeImpact(req: ImpactRequest): QueryResult<ImpactAnalysis>;
};

export function createQueryApi(source: SnapshotSource): QueryApi {
  /** Validate the request, take one snapshot, check the expected revision, run the query. */
  function run<S extends z.ZodType<{ expectedRevision?: string | undefined }>, T>(
    schema: S,
    input: unknown,
    body: (req: z.output<S>, snap: Snapshot) => QueryResult<T>,
  ): QueryResult<T> {
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      return fail({
        code: "INVALID_REQUEST",
        message: "request does not match the query's input schema",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const snap = new Snapshot(source.current());
    const expected = parsed.data.expectedRevision;
    if (expected !== undefined && expected !== snap.model.project.modelRevision) {
      return fail(
        { code: "REVISION_MISMATCH", message: `expected revision ${expected}, current is ${snap.model.project.modelRevision}; restart the analysis` },
        snap,
      );
    }
    return body(parsed.data, snap);
  }

  return {
    getProjectOverview: (req) => run(overviewRequest, req, (_r, snap) => ok(snap, overview(snap), [])),
    searchObjects: (req) => run(searchRequest, req, search),
    getContext: (req) => run(contextRequest, req, context),
    analyzeImpact: (req) => run(impactRequest, req, impact),
  };
}

// ---- getProjectOverview ------------------------------------------------------------------

function overview(snap: Snapshot): ProjectOverview {
  const { model } = snap;
  const inventory: Partial<Record<Kind, number>> = {};
  for (const e of snap.index.values()) if (e.kind !== "project") inventory[e.kind] = (inventory[e.kind] ?? 0) + 1;

  const modules: ModuleSummary[] = model.modules
    .map((m) => {
      const owned: Partial<Record<Kind, number>> = {};
      for (const e of snap.index.values()) {
        if (e.kind !== "module" && snap.moduleOf(e.id) === m.id) owned[e.kind] = (owned[e.kind] ?? 0) + 1;
      }
      const refs = (list: typeof m.dependsOn) => (list ?? []).map((r) => (typeof r === "string" ? r : { unresolved: r.unresolved }));
      return {
        ...snap.summary(m.id),
        ...(m.purpose ? { purpose: m.purpose } : {}),
        dependsOn: refs(m.dependsOn),
        consumes: refs(m.consumes),
        exposes: model.contracts.filter((c) => c.owner === m.id).map((c) => c.id).sort(cmp),
        owned: sortKeys(owned),
      };
    })
    .sort((a, b) => cmp(a.id, b.id));

  return {
    project: {
      id: model.project.id,
      name: model.project.name,
      ...(model.project.description ? { description: model.project.description } : {}),
      schemaVersion: model.schemaVersion,
    },
    modules,
    inventory: sortKeys(inventory),
    validation: {
      errors: snap.diagnostics.filter((d) => d.severity === "error").length,
      warnings: snap.diagnostics.filter((d) => d.severity === "warning").length,
    },
  };
}

// ---- searchObjects -----------------------------------------------------------------------

const FIELD_WEIGHT = { id: 4, name: 6, purpose: 2, description: 2, statement: 2 } as const;
type Field = keyof typeof FIELD_WEIGHT;

function search(req: z.output<typeof searchRequest>, snap: Snapshot): QueryResult<SearchResults> {
  const revision = snap.model.project.modelRevision;
  let offset = 0;
  if (req.cursor !== undefined) {
    const m = /^(.+):(\d+)$/.exec(req.cursor);
    if (!m) return fail({ code: "INVALID_CURSOR", message: "cursor is not one returned by searchObjects" }, snap);
    if (m[1] !== revision) {
      return fail({ code: "REVISION_MISMATCH", message: `cursor belongs to revision ${m[1]}, current is ${revision}; search again` }, snap);
    }
    offset = Number(m[2]);
  }

  const terms = [...new Set(req.text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1))];
  if (terms.length === 0) {
    return fail({ code: "INVALID_REQUEST", message: "text needs at least one search term of two or more letters or digits" }, snap);
  }
  const kinds = req.kinds ? new Set<Kind>(req.kinds) : undefined;

  const hits: SearchHit[] = [];
  for (const e of snap.index.values()) {
    if (e.kind === "project" || (kinds && !kinds.has(e.kind))) continue;
    const rec = snap.records.get(e.id) ?? {};
    const fields: [Field, string][] = [
      ["id", e.id],
      ["name", e.name],
      ...(["purpose", "description", "statement"] as const)
        .filter((f) => typeof rec[f] === "string")
        .map((f) => [f, rec[f] as string] as [Field, string]),
    ];
    let score = 0;
    const matched = new Set<string>();
    for (const term of terms) {
      const root = stem(term);
      for (const [field, value] of fields) {
        const v = value.toLowerCase();
        let weight: number;
        if (v.includes(term)) {
          // Matches at a word start count double: "enrollment" in "Enrollment events" beats "role" in "parole".
          weight = new RegExp(`(^|[^a-z0-9])${term}`).test(v) ? 2 : 1;
        } else if (root !== term && v.includes(root)) {
          weight = 0.5; // "notify" finds "Notifications", "rejected" finds "rejection"
        } else continue;
        score += FIELD_WEIGHT[field] * weight;
        matched.add(field);
      }
    }
    if (score === 0) continue;
    if (e.kind === "module") score *= 1.5; // modules are the usual entry point for an agent
    hits.push({ ...snap.summary(e.id), score, matchedFields: [...matched].sort(cmp) });
  }
  hits.sort((a, b) => b.score - a.score || compareObjects(a, b));

  const page = hits.slice(offset, offset + req.limit);
  const end = offset + page.length;
  return ok(snap, {
    hits: page,
    total: hits.length,
    truncated: end < hits.length,
    ...(end < hits.length ? { nextCursor: `${revision}:${end}` } : {}),
  }, []);
}

const SUFFIXES = ["ations", "ation", "ions", "ion", "ing", "ies", "ied", "ed", "es", "y", "s"];

/** A crude, deterministic suffix strip; keeps at least four characters. */
function stem(term: string): string {
  for (const suf of SUFFIXES) if (term.endsWith(suf) && term.length - suf.length >= 4) return term.slice(0, -suf.length);
  return term;
}

// ---- getContext --------------------------------------------------------------------------

function context(req: z.output<typeof contextRequest>, snap: Snapshot): QueryResult<ObjectContext> {
  if (!snap.has(req.id) || snap.index.get(req.id)!.kind === "project") {
    return unknownIds([req.id], snap);
  }
  const relations = req.relations ? new Set<string>(req.relations) : undefined;
  const allowed = (e: Edge) => !relations || relations.has(e.relation);
  const out = req.direction !== "incoming";
  const inc = req.direction !== "outgoing";

  const distance = new Map<Id, number>([[req.id, 0]]);
  const order: Id[] = [];
  const edges = new Map<string, Edge>();
  let truncated = false;
  let frontier = [req.id];

  for (let d = 1; d <= req.depth && frontier.length; d++) {
    const next: Id[] = [];
    for (const id of frontier) {
      const candidates: [Edge, Id | undefined][] = [
        ...(out ? (snap.outgoing.get(id) ?? []).filter(allowed).map((e) => [e, typeof e.to === "string" ? e.to : undefined] as [Edge, Id | undefined]) : []),
        ...(inc ? (snap.incoming.get(id) ?? []).filter(allowed).map((e) => [e, e.from] as [Edge, Id]) : []),
      ].filter(([e]) => id === req.id || !listsChildren(e, id));
      for (const [edge, other] of candidates) {
        if (other === undefined) {
          edges.set(edgeKey(edge), edge); // unresolved outgoing reference: shown, never followed
          continue;
        }
        if (other === snap.model.project.id) continue; // the project root is in the overview
        if (!distance.has(other)) {
          if (order.length >= req.maxNodes) {
            truncated = true;
            continue;
          }
          distance.set(other, d);
          order.push(other);
          next.push(other);
        }
        edges.set(edgeKey(edge), edge);
      }
    }
    frontier = next;
  }
  // Report truncation also when the depth limit cut off further neighbours.
  if (!truncated) {
    truncated = frontier.some((id) =>
      [...(out ? snap.outgoing.get(id) ?? [] : []), ...(inc ? snap.incoming.get(id) ?? [] : [])]
        .filter((e) => allowed(e) && !listsChildren(e, id))
        .some((e) => {
          const other = e.from === id ? e.to : e.from;
          return typeof other === "string" && other !== snap.model.project.id && !distance.has(other);
        }),
    );
  }

  const included = new Set([req.id, ...order]);
  const nodes: ContextNode[] = order.map((id) => ({ ...snap.summary(id), distance: distance.get(id)! }));
  const kept = [...edges.values()].filter((e) => included.has(e.from) && (typeof e.to !== "string" || included.has(e.to)));
  kept.sort((a, b) => cmp(a.from, b.from) || cmp(a.relation, b.relation) || cmp(target(a), target(b)));

  return ok(
    snap,
    {
      focus: { ...snap.summary(req.id), record: structuredClone(snap.records.get(req.id)) },
      nodes,
      edges: kept,
      truncated,
      budget: { depth: req.depth, maxNodes: req.maxNodes, direction: req.direction },
    },
    snap.diagnosticsFor(included),
  );
}

/**
 * True when following `e` from `id` would enumerate the children of `id` (objects it owns or
 * contains). Children are listed for the focus object only; beyond depth 1 a module would
 * otherwise flood the budget with every sibling of the path that reached it.
 */
const listsChildren = (e: Edge, id: Id) =>
  (e.relation === "owner" && e.to === id) || (e.relation === "contains" && e.from === id);

const edgeKey = (e: Edge) => `${e.from}|${e.relation}|${target(e)}|${e.declaredAt}`;

// ---- analyzeImpact -----------------------------------------------------------------------

/**
 * Propagation rules (structural only):
 * - An object that references a changed object is a *dependent*: its meaning may change.
 *   Impact keeps propagating from dependents.
 * - The owner/container of a changed object is a *container*: its surface may change.
 *   It is reported but impact does not propagate from it, so changing one attribute does
 *   not mark every module that depends on the attribute's module.
 */
function impact(req: z.output<typeof impactRequest>, snap: Snapshot): QueryResult<ImpactAnalysis> {
  const seeds = [...new Set(req.ids)].sort(cmp);
  const missing = seeds.filter((id) => !snap.has(id) || snap.index.get(id)!.kind === "project");
  if (missing.length) return unknownIds(missing, snap);

  type Found = { distance: number; via: "dependent" | "container"; path: PathStep[] };
  const found = new Map<Id, Found>();
  const seen = new Set<Id>(seeds);
  let frontier = seeds.map((id) => ({ id, path: [] as PathStep[] }));
  let truncated = false;

  for (let d = 1; d <= req.maxDepth && frontier.length; d++) {
    const next: typeof frontier = [];
    for (const { id, path } of frontier) {
      const steps: { other: Id; step: PathStep; via: "dependent" | "container" }[] = [];
      for (const e of snap.incoming.get(id) ?? []) {
        if (e.relation === "owner") continue; // owned objects are not affected by their owner changing
        if (e.relation === "contains") steps.push({ other: e.from, step: { from: id, relation: "contains", to: e.from }, via: "container" });
        else steps.push({ other: e.from, step: { from: id, relation: e.relation, to: e.from }, via: "dependent" });
      }
      for (const e of snap.outgoing.get(id) ?? []) {
        if (e.relation === "owner" && typeof e.to === "string" && e.to !== snap.model.project.id) {
          steps.push({ other: e.to, step: { from: id, relation: "owner", to: e.to }, via: "container" });
        }
      }
      for (const { other, step, via } of steps) {
        if (seen.has(other)) continue;
        if (found.size >= req.maxResults) {
          truncated = true;
          continue;
        }
        seen.add(other);
        const p = [...path, step];
        found.set(other, { distance: d, via, path: p });
        if (via === "dependent") next.push({ id: other, path: p });
      }
    }
    frontier = next;
  }
  if (!truncated && frontier.length) {
    // Depth limit reached with dependents left unexplored.
    truncated = frontier.some(({ id }) => (snap.incoming.get(id) ?? []).some((e) => e.relation !== "owner" && !seen.has(e.from)));
  }

  const candidates: ImpactCandidate[] = [...found.entries()]
    .map(([id, f]) => ({ ...snap.summary(id), distance: f.distance, via: f.via, dependencyPath: f.path, reason: explain(f.path, snap) }))
    .sort((a, b) => a.distance - b.distance || compareObjects(a, b));

  return ok(
    snap,
    {
      seeds: seeds.map((id) => snap.summary(id)),
      candidates,
      truncated,
      budget: { maxDepth: req.maxDepth, maxResults: req.maxResults },
      impactClass: "structural-candidate",
      note: "Candidates follow declared model references only. Nothing here was checked against source code, tests or runtime behaviour.",
    },
    snap.diagnosticsFor([...seeds, ...found.keys()]),
  );
}

/** Read a path back as plain sentences, from the candidate toward the seed. */
function explain(path: PathStep[], snap: Snapshot): string {
  const name = (id: Id) => `${snap.index.get(id)!.kind} ${id}`;
  return [...path]
    .reverse()
    .map((s) => {
      // Step s.from = object closer to the seed (changed), s.to = the affected object.
      const changed = name(s.from);
      const affected = name(s.to);
      if (s.relation === "owner") return `${affected} owns ${changed}`;
      if (s.relation === "contains") return `${affected} contains ${changed}`;
      return `${affected} references ${changed} (${PHRASE[s.relation] ?? s.relation})`;
    })
    .join("; ");
}

const PHRASE: Partial<Record<string, string>> = {
  dependsOn: "module dependency",
  consumes: "consumes this contract",
  contractAccepts: "contract accepts this event",
  contractPublishes: "contract publishes this event",
  triggerEvent: "transition is triggered by this event",
  effectEvent: "transition emits this event",
  guardRule: "transition is guarded by this rule",
  realizes: "behavior realizes this capability",
  fromState: "transition starts from this state",
  toState: "transition leads to this state",
  initialState: "initial state",
  anchorData: "timer anchored on this data",
  anchorAttribute: "timer anchored on this attribute",
  permissionActor: "permission granted to this actor",
  permissionCapability: "permission for this capability",
  initiator: "capability initiated by this actor",
  attributeRef: "attribute references this data",
};

// ---- helpers -----------------------------------------------------------------------------

function ok<T>(snap: Snapshot, data: T, diagnostics: Diagnostic[]): QueryResult<T> {
  return { ok: true, context: snap.context(), data, diagnostics };
}

function fail<T>(error: QueryError, snap?: Snapshot): QueryResult<T> {
  return { ok: false, ...(snap ? { context: snap.context() } : {}), error };
}

function unknownIds<T>(ids: Id[], snap: Snapshot): QueryResult<T> {
  return fail({ code: "UNKNOWN_ID", message: `no object with ID ${ids.map((i) => `"${i}"`).join(", ")} in revision ${snap.model.project.modelRevision}` }, snap);
}

function sortKeys<V>(o: Partial<Record<Kind, V>>): Partial<Record<Kind, V>> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b))) as Partial<Record<Kind, V>>;
}
