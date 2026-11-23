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

/** Fields the inspector may stage edits for; each maps to one typed operation (src/edits.ts). */
export type EditableFieldName = "name" | "description" | "statement" | "dependsOn";

/** What the host lets the inspector edit on one object, and why the rest is read-only. */
export type FieldAccess = {
  editable: {
    field: EditableFieldName;
    label: string;
    /** The typed operation an edit of this field becomes. */
    operation: string;
    input: "line" | "text" | "modules";
    value: string | string[] | null;
  }[];
  readOnly: { field: string; label: string; reason: string }[];
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
  access: FieldAccess;
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
  access: FieldAccess;
  truncated: boolean;
};

/** One staged edit: a new value for one editable field of one object. */
export type StagedEdit = { objectId: string; field: EditableFieldName; value: string | string[] };

export type ProposalDiagnostic = { code: string; severity?: string; path?: string; message: string; hint?: string };

/** A dry run of the draft: the engine's own validation, delta and impact. Nothing is written. */
export type DraftPreview = {
  /** Always "unsubmitted": a dry run of a local draft, never a pending or approved proposal. */
  origin: "unsubmitted";
  operations: { index: number; type: string; summary: string }[];
  expectedRevision: string;
  currentRevision: string;
  validation: { appliesToCurrent: boolean; errors: ProposalDiagnostic[]; warnings: ProposalDiagnostic[] };
  delta: {
    /** "base": the draft is stale, so the delta is against the revision it was staged on. */
    against: "current" | "base";
    revision: string;
    changes: {
      id: string;
      kind: string;
      name: string;
      moduleId: string | null;
      change: "added" | "removed" | "modified";
      fields: { field: string; before?: string; after?: string; truncated?: true }[];
    }[];
    total: number;
    truncated: boolean;
  } | null;
  impact: {
    modules: { id: string; name: string; via: "changed" | "impacted" }[];
    crossModule: "yes" | "no" | "not-determined";
    total: number;
    note: string;
  } | null;
  bindings: { total: number; note: string };
  assumptions: string[];
};

/** One staged edit as the browser and the draft file show it. */
export type DraftStepView = {
  key: string;
  operation: { type: string } & Record<string, unknown>;
  objectId: string;
  objectName: string;
  objectKind: string;
  field: EditableFieldName;
  label: string;
  before: string | string[] | null;
  after: string | string[];
};

export type ModelIdentity = { revision: string; modelKey: string; branch: string | null; commit: string | null };

/**
 * A local human draft: staged typed operations on one base model, never a proposal. Kept on
 * this machine outside the checkout. `version` increases on every write, so two tabs cannot
 * silently overwrite each other.
 */
export type DraftView = {
  draftId: string;
  version: number;
  projectId: string;
  base: ModelIdentity;
  steps: DraftStepView[];
  rationale: string;
  createdAt: string;
  updatedAt: string;
  /** True when the checkout no longer holds the base model: the draft needs agent integration. */
  stale: boolean;
  current: ModelIdentity;
};

/** A draft file that could not be used, reported instead of being replaced. */
export type DraftProblem = { draftId: string; code: string; message: string };

export type DraftList = { drafts: DraftView[]; problems: DraftProblem[]; current: ModelIdentity };

/**
 * The handoff for an external coding agent: a strict proposed change, exactly what
 * `vcv proposal preview --file` and `vcv proposal submit` read, and separate metadata.
 */
export type DraftExport = {
  change: {
    changeId: string;
    projectId: string;
    expectedRevision: string;
    rationale?: string;
    operations: Record<string, unknown>[];
  };
  metadata: {
    format: "vcv-ui-draft-handoff-1";
    draftId: string;
    draftVersion: number;
    checkoutRoot: string;
    base: ModelIdentity;
    current: ModelIdentity;
    /** From the engine's dry run when exported; never an approval or a submission. */
    check: "valid" | "warnings" | "invalid" | "stale";
    needsAgent: boolean;
    note: string;
  };
  /** A file name to save the change under (JSON, which the CLI reads as YAML). */
  fileName: string;
  commands: { preview: string };
};
