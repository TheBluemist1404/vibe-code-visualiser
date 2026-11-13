// IR v0.2 canonical types. Mirrors "IR v0 — Conceptual Specification" (Draft v0.2).
// Canonical objects are typed records with one `owner` reference; ownership trees,
// graphs and canvases are derived from these records, never stored alongside them.

export const SCHEMA_VERSION = "0.2";

export type Id = string;

/** An explicit placeholder for a reference that could not be resolved (draft snapshots only). */
export type UnresolvedRef = { unresolved: string; diagnostic?: string };

/** A typed reference: a declared ID, or (in drafts) an explicit unresolved placeholder. */
export type Ref = Id | UnresolvedRef;

export type SnapshotStatus = "draft" | "approved";

export type Project = {
  id: Id;
  name: string;
  modelRevision: string;
  status: SnapshotStatus;
  description?: string;
};

type Base<K extends string> = {
  id: Id;
  kind: K;
  owner: Ref;
  name: string;
  description?: string;
};

export type Actor = Base<"actor">;

export type Module = Base<"module"> & {
  purpose?: string;
  dependsOn?: Ref[];
  consumes?: Ref[];
};

export type Capability = Base<"capability"> & {
  initiatorActorId?: Ref;
};

export const ATTRIBUTE_TYPES = [
  "string",
  "boolean",
  "integer",
  "decimal",
  "timestamp",
  "date",
  "id",
  "reference",
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export type DataAttribute = {
  id: Id;
  name: string;
  type: AttributeType;
  nullable?: boolean;
  /** Required when type is "reference": the Data the attribute points to. */
  refDataId?: Ref;
};

export type Data = Base<"data"> & {
  attributes: DataAttribute[];
};

type RuleBase = Omit<Base<"rule">, "name"> & { name?: string };
export type Rule =
  | (RuleBase & { ruleKind: "permission"; actorId: Ref; capabilityId: Ref; statement?: string })
  | (RuleBase & { ruleKind: "invariant" | "policy"; statement: string });

export type Event = Base<"event">;

export type Contract = Base<"contract"> & {
  accepts?: Ref[];
  publishes?: Ref[];
};

export type State = { id: Id; name: string };

export type Trigger =
  | { kind: "event"; eventId: Ref }
  | { kind: "elapsed"; duration: string; anchor: { dataId: Ref; attributeId: Ref } };

export type Guard = { kind: "permission"; ruleId: Ref };

export type Effect = { kind: "emitEvent"; eventId: Ref };

export type Transition = {
  id: Id;
  fromStateId: Ref;
  toStateId: Ref;
  trigger: Trigger;
  guards?: Guard[];
  effects?: Effect[];
};

export type Behavior = Base<"behavior"> & {
  realizes?: Ref[];
  initialStateId: Ref;
  states: State[];
  transitions: Transition[];
};

/** How a criterion must be verified before merge (M4.2). Changing it is a model change. */
export const VERIFICATION_POLICIES = ["required", "optional"] as const;
export type VerificationPolicy = (typeof VERIFICATION_POLICIES)[number];

/**
 * An approved acceptance criterion (M4.2): one observable expected behaviour or invariant, the
 * model objects it is about, and whether evidence for it is required. Intent, like every IR
 * object: it changes only through a typed proposal and approval. Which test cases check it is
 * not stored here; that is an agent-maintained `tests` binding claim on the criterion's ID.
 */
export type Criterion = Base<"criterion"> & {
  /** The observable expected behaviour or invariant, in plain words. */
  statement: string;
  /** The objects this criterion is about (capabilities, rules, contracts, events, behaviours…). */
  verifies: Ref[];
  verification: VerificationPolicy;
};

export type Model = {
  schemaVersion: string;
  project: Project;
  actors: Actor[];
  modules: Module[];
  capabilities: Capability[];
  data: Data[];
  rules: Rule[];
  events: Event[];
  contracts: Contract[];
  behaviors: Behavior[];
  /**
   * Optional and absent when empty, so every model written before M4.2 keeps exactly the same
   * canonical form (and branch-safe revision digest).
   */
  criteria?: Criterion[];
};

/** Every kind that can be the target of a reference, including nested elements. */
export type Kind =
  | "project"
  | "actor"
  | "module"
  | "capability"
  | "data"
  | "attribute"
  | "rule"
  | "event"
  | "contract"
  | "behavior"
  | "criterion"
  | "state"
  | "transition";

/** Top-level collections and the kind each holds. */
export const COLLECTIONS = {
  actors: "actor",
  modules: "module",
  capabilities: "capability",
  data: "data",
  rules: "rule",
  events: "event",
  contracts: "contract",
  behaviors: "behavior",
  criteria: "criterion",
} as const satisfies Record<string, Kind>;

export type CollectionName = keyof typeof COLLECTIONS;

/** A top-level collection of a model; `criteria` may be absent. */
export const collectionOf = <C extends CollectionName>(model: Model, coll: C): NonNullable<Model[C]> =>
  (model[coll] ?? []) as NonNullable<Model[C]>;

export type Severity = "error" | "warning";

export type Diagnostic = {
  code: string;
  severity: Severity;
  /** Dotted path into the model, e.g. behaviors[0].transitions[1].toStateId */
  path: string;
  message: string;
};

export function isUnresolved(ref: unknown): ref is UnresolvedRef {
  return typeof ref === "object" && ref !== null && "unresolved" in ref;
}
