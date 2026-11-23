// The JSON contract between the UI host and the browser. Types only: the web client imports
// this file with `import type`, so nothing here may depend on Node.

export type ProjectState = "ready" | "absent" | "uninitialized" | "conflicted" | "diverged" | "invalid";

export type Diagnostic = { code: string; severity: "error" | "warning" | "info"; message: string };

/** What the host observed about the checkout. Paths are local to this machine. */
export type Observation = {
  state: ProjectState;
  root: string;
  git: {
    commit: string | null;
    branch: string | null;
    detached: boolean;
    dirty: boolean;
    storeChanges: string[];
    operation: string | null;
  } | null;
  model: { projectId: string; revision: string; status: string; history: string[]; key: string } | null;
  diagnostics: Diagnostic[];
  /** When the host read the checkout (ISO 8601). */
  observedAt: string;
};

export type DependencyKind = "dependsOn" | "consumes";

/** A module as the canvas draws it. Counts are owned objects by kind. */
export type ModuleNodeView = {
  id: string;
  name: string;
  purpose?: string;
  owned: Record<string, number>;
};

/**
 * A directed relationship between two modules, exactly as declared in the IR: `from` declares
 * it, `to` is depended on. "consumes" edges point at the module that owns the consumed contract.
 */
export type ModuleEdgeView = {
  id: string;
  from: string;
  to: string;
  kind: DependencyKind;
  /** The contracts behind a "consumes" edge. */
  via: string[];
  declaredAt: string;
};

export type Position = { x: number; y: number; pinned: boolean };

export type GraphView = {
  project: { id: string; name: string; description?: string };
  revision: string;
  /** Identity of the model read: the revision plus a digest of its file. Two branches can hold different models under the same revision ID (rev-1), so the revision alone is not enough. */
  modelKey: string;
  modules: ModuleNodeView[];
  edges: ModuleEdgeView[];
  /** Declared references the graph could not draw (unresolved in a draft, or not a module). */
  unresolved: { from: string; text: string; declaredAt: string }[];
  positions: Record<string, Position>;
  /** Modules placed for the first time in this read (none on a first open). */
  placed: string[];
  validation: { errors: number; warnings: number };
  /** Set when the project has more modules than the canvas loads. */
  truncated?: { shown: number; total: number };
};

/** How the model moved since the previous observation the host served. */
export type ModelChange = {
  seq: number;
  modelLine: "advanced" | "rewound" | "switched" | "appeared" | "disappeared";
  before: { revision: string | null; branch: string | null };
  after: { revision: string | null; branch: string | null };
  added: string[];
  removed: string[];
  at: string;
};

export type ProjectView = {
  observation: Observation;
  graph: GraphView | null;
  lastChange: ModelChange | null;
};

export type ObjectRef = { id: string; kind: string; name: string };

/** One owned object, summarised for the module inspector. */
export type OwnedObject = ObjectRef & {
  /** The most telling declared text: a rule's statement, a criterion's statement, or the description. */
  text?: string;
  /** Short facts such as "invariant", "required", "5 attributes", "initiated by Student". */
  facts: string[];
};

export type ModuleView = {
  revision: string;
  /** Same as GraphView.modelKey for the model this answer was read from. */
  modelKey: string;
  module: ObjectRef & { purpose?: string; description?: string; irPath: string };
  dependsOn: (ObjectRef & { kind: DependencyKind; via: string[] })[];
  usedBy: (ObjectRef & { kind: DependencyKind; via: string[] })[];
  /** Owned objects grouped by kind, in IR order. */
  owned: Record<string, OwnedObject[]>;
  truncated: boolean;
};

export type ObjectView = {
  revision: string;
  modelKey: string;
  object: ObjectRef & { moduleId?: string; parentId?: string; irPath: string; record: Record<string, unknown> };
  /** `other.moduleId` is the module that owns the related object (absent for project-level objects). */
  relations: {
    direction: "outgoing" | "incoming";
    relation: string;
    other: ObjectRef & { moduleId?: string };
    declaredAt: string;
  }[];
  truncated: boolean;
};

export type ApiError = { error: { code: string; message: string } };
