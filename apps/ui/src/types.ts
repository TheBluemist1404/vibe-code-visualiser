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
export type DraftPreview = EngineCheck & {
  /** Always "unsubmitted": a dry run of a local draft, never a pending or approved proposal. */
  origin: "unsubmitted";
};

/** The engine's check of a change against the current model (previewProposal): validation, delta, impact. */
export type EngineCheck = {
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

// Proposal inbox (M5.4). Read-only views of recorded proposals; see src/proposals.ts.

export type ProposalLifecycle = "pending" | "stale" | "rejected" | "applied" | "invalid";

export type InboxItem = {
  changeId: string;
  lifecycle: ProposalLifecycle;
  proposerId: string | null;
  baseRevision: string | null;
  proposalDigest: string | null;
  operations: number;
  /** What the record says about how it was applied; never who really decided. */
  approval: "none" | "applied-by-host" | "approved-by-separate-reviewer";
  rationale?: string;
  stale?: { reason: "superseded" | "other-line"; detail: string };
  resultingRevision?: string;
  resultInThisCheckout?: boolean;
  /** As written in the record: not proof of who approved. */
  recordedApproverId?: string;
  problem?: string;
};

export type Inbox = {
  modelKey: string;
  revision: string;
  items: InboxItem[];
  counts: Record<ProposalLifecycle, number>;
  total: number;
  truncated: boolean;
  /** The protected base this host checks integrity against, or null (integrity then unknown here). */
  protectedBase: string | null;
};

/** One fact about a proposal, from one source. "unknown" is never shown as success. */
export type ReviewStep = {
  id: "recorded" | "signed" | "integrity" | "model" | "implementation";
  label: string;
  state: "done" | "not-yet" | "failed" | "unknown";
  detail: string;
};

export type ProposalReview = {
  changeId: string;
  lifecycle: ProposalLifecycle;
  proposalDigest: string;
  proposerId: string | null;
  projectId: string;
  baseRevision: string;
  currentRevision: string;
  modelKey: string;
  rationale?: string;
  stale?: { reason: "superseded" | "other-line"; detail: string };
  resultingRevision?: string;
  recordedApproverId?: string;
  check: EngineCheck;
  /** Diagnostics stored on the record when it was submitted. */
  atSubmission: ProposalDiagnostic[];
  bindings: {
    items: { bindingId: string; modelObjectId: string; relation: string; locator: string; why: string }[];
    total: number;
    truncated: boolean;
    note: string;
  };
  steps: ReviewStep[];
  /** For a pending proposal: how a reviewer approves it outside this host. */
  reviewer: { digest: string; commands: { label: string; text: string }[]; notes: string[] } | null;
  /** For a stale, rejected or invalid proposal: what goes back to an agent. */
  agent: { note: string; commands: { label: string; text: string }[] } | null;
  integrityLimits: string[];
};

// Evidence (M5.5). Each view is one new observation; see src/evidence.ts.

/** Which checkout state an evidence answer was read from. */
export type EvidenceObservation = {
  at: string;
  modelRevision: string;
  modelKey: string;
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  resolver: string;
};

export type EvidenceStateName =
  | "resolved"
  | "stale"
  | "missing"
  | "ambiguous"
  | "unchecked"
  | "indeterminate"
  | "invalid";

export type BindingView = {
  bindingId: string;
  /** Repository-relative claim file. */
  file: string;
  state: EvidenceStateName;
  problem?: string;
  relation: string | null;
  /** The locator as written in the claim (repo-relative path plus selector). */
  locator: string | null;
  path: string | null;
  selectorKind: string | null;
  claimedAtRevision: string | null;
  /** Who made the claim and how, as the claim says. Never checked by VCV. */
  provenance: { source: string; principalId: string } | null;
  /** Does the pointer resolve now. */
  pointer: {
    state: "resolved" | "missing" | "ambiguous" | "unchecked";
    detail: string;
    matches: { label: string; declaration: string; line: number }[];
    matchesTotal: number;
  } | null;
  sourceFreshness: { state: string; cause: string } | null;
  modelFreshness: { state: string; cause: string } | null;
  disputed: { by: string; reason: string } | null;
};

export type CriterionView = {
  verification: string;
  mapping: "none" | "resolved" | "partial" | "unresolved" | "unknown";
  assessment: "complete" | "incomplete";
  /** unverified: no test runs were supplied to this host. */
  result: "passed" | "failed" | "stale" | "missing" | "unknown" | "unverified";
  resultObservedBy: "host" | "claimed" | null;
  runsSupplied: number;
  mappings: {
    bindingId: string;
    test: string | null;
    state: string;
    claimedAtRevision: string | null;
    result: { status: string; observedBy: ("host" | "claimed")[]; message?: string } | null;
  }[];
  problems: { code: string; message: string }[];
};

export type ObjectEvidenceView = {
  observed: EvidenceObservation;
  object: { id: string; kind: string | null; name: string | null; inCurrentModel: boolean };
  counts: Record<EvidenceStateName, number> & { total: number; disputed: number };
  bindings: BindingView[];
  matched: number;
  truncated: boolean;
  unreadableClaims: number;
  /** For a criterion: its test mappings and their results in the runs this host was given. */
  criterion: CriterionView | null;
  limits: string[];
};

export type ModuleEvidenceView = {
  observed: EvidenceObservation;
  moduleId: string;
  objects: {
    id: string;
    kind: string;
    name: string;
    claims: number;
    states: Record<string, number>;
    disputed: number;
  }[];
  truncated: boolean;
  unreadableClaims: number;
};

export type ImplementationView = {
  changeId: string;
  modelKey: string;
  /** What was approved to be implemented. Null when the change is not applied and attested here. */
  handoff: {
    digest: string;
    approvedRevision: string;
    request: {
      behavior: string;
      acceptanceCriteria: string[];
      suggestedTests: string[];
      scope: string[] | null;
    } | null;
    scopeFromBindings: string[];
    bindings: {
      bindingId: string;
      modelObjectId: string;
      relation: string;
      locator: string;
      why: string;
      state: string;
      reassert: boolean;
    }[];
    bindingsTotal: number;
    baseCommit: string | null;
    caveats: string[];
  } | null;
  handoffProblem: string | null;
  /** The agent's recorded report: its claims, what VCV observed then, and what it observes now. */
  report: {
    file: string;
    digest: string;
    claims: {
      by: string;
      confidence: string;
      testsRun: { command: string; outcome: string; summary?: string }[];
      acceptance: { criterion: string; status: string; evidence?: string }[];
      gaps: string[];
      outOfScope: { path: string; reason: string }[];
      notes: string | null;
      note: string;
    };
    observedThen: { filesModified: string[]; outOfScope: string[] };
    observedNow: {
      baseCommit: string;
      headCommit: string | null;
      dirty: boolean | null;
      filesModified: string[];
      filesTruncated: boolean;
      outOfScope: string[];
      bindings: { bindingId: string; locator: string; state: string; reasserted: boolean }[];
    };
    changedSinceReport: boolean;
    warnings: { code: string; message: string; path?: string; bindingId?: string }[];
    notReconciled: string;
  } | null;
  reportProblem: string | null;
};

export type GateInputs = {
  baseCommit: string | null;
  /** Test-run record files given at start (claims). */
  runs: string[];
  policy: string | null;
  /** What is needed to run reconciliation and the gate, and was not given. */
  missing: string[];
};

export type GateView = {
  modelKey: string;
  inputs: GateInputs;
  problem: string | null;
  reconciliation: {
    base: {
      ref: string;
      commit: string;
      pinned: boolean;
      mergeBase: string;
      containedInCandidate: boolean;
      modelRevision: string | null;
    };
    candidate: { commit: string; branch: string | null; dirty: boolean; modelRevision: string };
    lineage: string;
    integrity: { ok: boolean; errors: { code: string; message: string }[]; authorization: string };
    summary: Record<string, number | string | boolean>;
    files: { path: string; area: string; committed: boolean; uncommitted: boolean; objectIds: string[] }[];
    filesTotal: number;
    findings: {
      code: string;
      category: string;
      basis: "checked" | "observed" | "not-checked";
      related: boolean;
      message: string;
      checked: string;
      objectIds?: string[];
      path?: string;
    }[];
    findingsTotal: number;
    findingsTruncated: boolean;
    limits: string[];
  } | null;
  gate: {
    decision: "pass" | "warn" | "block";
    headline: string;
    changeKind: string;
    policy: { source: string; changedByCandidate: boolean };
    reasons: {
      severity: string;
      code: string;
      rule: string;
      basis: "checked" | "observed" | "not-checked" | "claim";
      message: string;
      criterionId?: string;
    }[];
    reasonsTotal: number;
    criteria: { id: string; verification: string; result: string; observedBy: string | null; verifies: string[] }[];
    runs: {
      index: number;
      observedBy: "host" | "claimed";
      runner: string;
      fresh: boolean;
      staleBecause: string[];
      summary: { tests: number; passed: number; failed: number; errors: number; skipped: number };
    }[];
    limits: string[];
  } | null;
};
