// Typed request/response contracts for the read-only Semantic Query API.
// Candidate v0 contracts (Core Engine — Semantic Context API, Draft v0.1 §2–3); not final.
import { z } from "zod";
import type { Diagnostic, Id, Kind, Model, RefRole, SnapshotStatus } from "@vcv/ir";

/** Anything that can hand out the current model snapshot (ModelStore and ModelEngine both can). */
export type SnapshotSource = { current(): Model };

/** Provenance envelope on every response (§3). Model-only until a code-binding adapter exists. */
export type QueryContext = {
  projectId: string;
  modelRevision: string;
  snapshotStatus: SnapshotStatus;
  source: "canonical-ir";
  coverage: "model-only";
  /** Always false in v0: nothing here has been compared with source code or tests. */
  implementationChecked: false;
};

export type QueryErrorCode = "INVALID_REQUEST" | "UNKNOWN_ID" | "REVISION_MISMATCH" | "INVALID_CURSOR";

export type QueryError = { code: QueryErrorCode; message: string; details?: { path: string; message: string }[] };

export type QueryResult<T> =
  | { ok: true; context: QueryContext; data: T; diagnostics: Diagnostic[] }
  | { ok: false; context?: QueryContext; error: QueryError };

/** How an edge should be read by an agent. */
export type RelationCategory = "ownership" | "dependency" | "contract" | "behavior" | "data" | "permission" | "traceability";

export type Relation = RefRole | "contains";

export type ObjectSummary = {
  id: Id;
  kind: Kind;
  name: string;
  description?: string;
  /** Module the object belongs to (itself for a module); absent for project-level objects. */
  moduleId?: Id;
  /** Canonical parent: owner, or containing object for states/transitions/attributes. */
  parentId?: Id;
  /** Where the object is declared in the canonical IR snapshot (provenance). */
  irPath: string;
};

export type Edge = {
  from: Id;
  /** Target ID, or the unresolved placeholder text in a draft snapshot. */
  to: Id | { unresolved: string };
  relation: Relation;
  category: RelationCategory;
  /** IR path of the field that declares this relationship. */
  declaredAt: string;
};

// ---- Requests --------------------------------------------------------------------------

const KINDS = ["actor", "module", "capability", "data", "attribute", "rule", "event", "contract", "behavior", "state", "transition"] as const;
const RELATIONS = [
  "owner", "dependsOn", "consumes", "initiator", "attributeRef", "permissionActor", "permissionCapability",
  "contractAccepts", "contractPublishes", "realizes", "initialState", "fromState", "toState", "triggerEvent",
  "anchorData", "anchorAttribute", "guardRule", "effectEvent", "contains",
] as const satisfies readonly Relation[];

const revision = { expectedRevision: z.string().min(1).optional() };
const id = z.string().min(1).max(256);

export const LIMITS = {
  overview: { defaultModules: 50, maxModules: 200, listItems: 25 },
  search: { default: 20, max: 100, maxKinds: KINDS.length },
  context: { maxRelations: RELATIONS.length, defaultDepth: 1, maxDepth: 2, defaultNodes: 25, maxNodes: 200, defaultEdges: 100, maxEdges: 1000, defaultNested: 25, maxNested: 200 },
  impact: { maxSeeds: 20, defaultDepth: 3, maxDepth: 5, defaultResults: 50, maxResults: 200 },
} as const;

export const overviewRequest = z
  .object({
    ...revision,
    moduleLimit: z.number().int().min(1).max(LIMITS.overview.maxModules).default(LIMITS.overview.defaultModules),
    cursor: z.string().optional(),
  })
  .strict();

export const searchRequest = z
  .object({
    ...revision,
    text: z.string().trim().min(1).max(200),
    /** At most one entry per kind; a longer list can only repeat entries. */
    kinds: z.array(z.enum(KINDS)).min(1).max(LIMITS.search.maxKinds).optional(),
    limit: z.number().int().min(1).max(LIMITS.search.max).default(LIMITS.search.default),
    cursor: z.string().optional(),
  })
  .strict();

export const contextRequest = z
  .object({
    ...revision,
    id,
    depth: z.number().int().min(1).max(LIMITS.context.maxDepth).default(LIMITS.context.defaultDepth),
    direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
    /** At most one entry per relation; a longer list can only repeat entries. */
    relations: z.array(z.enum(RELATIONS)).min(1).max(LIMITS.context.maxRelations).optional(),
    maxNodes: z.number().int().min(1).max(LIMITS.context.maxNodes).default(LIMITS.context.defaultNodes),
    maxEdges: z.number().int().min(1).max(LIMITS.context.maxEdges).default(LIMITS.context.defaultEdges),
    /** Cap on every array inside the focus record (states, transitions, attributes, refs). */
    maxNestedItems: z.number().int().min(1).max(LIMITS.context.maxNested).default(LIMITS.context.defaultNested),
  })
  .strict();

export const impactRequest = z
  .object({
    ...revision,
    ids: z.array(id).min(1).max(LIMITS.impact.maxSeeds),
    maxDepth: z.number().int().min(1).max(LIMITS.impact.maxDepth).default(LIMITS.impact.defaultDepth),
    maxResults: z.number().int().min(1).max(LIMITS.impact.maxResults).default(LIMITS.impact.defaultResults),
  })
  .strict();

export type OverviewRequest = z.input<typeof overviewRequest>;
export type SearchRequest = z.input<typeof searchRequest>;
export type ContextRequest = z.input<typeof contextRequest>;
export type ImpactRequest = z.input<typeof impactRequest>;

// ---- Responses -------------------------------------------------------------------------

export type ModuleSummary = ObjectSummary & {
  purpose?: string;
  dependsOn: (Id | { unresolved: string })[];
  consumes: (Id | { unresolved: string })[];
  /** Contracts this module owns (its public boundary). */
  exposes: Id[];
  /** Full lengths of dependsOn/consumes/exposes; each list is capped at LIMITS.overview.listItems. */
  counts: { dependsOn: number; consumes: number; exposes: number };
  /** Number of owned objects by kind. */
  owned: Partial<Record<Kind, number>>;
};

export type ProjectOverview = {
  project: { id: Id; name: string; description?: string; schemaVersion: string };
  /** One page of modules, ordered by ID. */
  modules: ModuleSummary[];
  modulesTotal: number;
  truncated: boolean;
  nextCursor?: string;
  /** Number of objects by kind across the project. */
  inventory: Partial<Record<Kind, number>>;
  validation: { errors: number; warnings: number };
};

export type SearchHit = ObjectSummary & { score: number; matchedFields: string[] };

export type SearchResults = {
  hits: SearchHit[];
  total: number;
  truncated: boolean;
  /** Pass back as `cursor` to get the next page; bound to this model revision. */
  nextCursor?: string;
};

export type ContextNode = ObjectSummary & { distance: number };

export type ObjectContext = {
  /** The canonical record, with every array capped at maxNestedItems (see truncatedFields). */
  focus: ObjectSummary & { record: unknown; truncatedFields?: { field: string; returned: number; total: number }[] };
  /** Neighbours reached within the depth and node budget, in breadth-first order. */
  nodes: ContextNode[];
  /**
   * Every edge between the focus and returned nodes that matches the relation filter,
   * regardless of traversal direction, plus unresolved outgoing references; capped at maxEdges.
   */
  edges: Edge[];
  edgesTotal: number;
  /** True if nodes, edges or the focus record were cut by a budget or the depth limit. */
  truncated: boolean;
  budget: { depth: number; maxNodes: number; maxEdges: number; maxNestedItems: number; direction: "incoming" | "outgoing" | "both" };
};

export type PathStep = { from: Id; relation: Relation; to: Id };

export type ImpactCandidate = ObjectSummary & {
  distance: number;
  /**
   * "dependent": references a changed object, so its meaning may change too; impact keeps
   * propagating from it. "container": owns or contains a changed object; reported, but impact
   * does not propagate further from it.
   */
  via: "dependent" | "container";
  /** One shortest path, from a seed to this candidate, as declared model references. */
  dependencyPath: PathStep[];
  reason: string;
};

export type ImpactAnalysis = {
  seeds: ObjectSummary[];
  candidates: ImpactCandidate[];
  truncated: boolean;
  budget: { maxDepth: number; maxResults: number };
  /** Always "structural-candidate": derived from declared references, not from code or tests. */
  impactClass: "structural-candidate";
  note: string;
};
