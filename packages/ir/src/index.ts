export { collectionOf, COLLECTIONS, isUnresolved } from "./types.ts";
export type {
  Actor,
  AttributeType,
  Behavior,
  Capability,
  CollectionName,
  Contract,
  Criterion,
  Data,
  DataAttribute,
  Diagnostic,
  Effect,
  Event,
  Guard,
  Id,
  Kind,
  Model,
  Module,
  Project,
  Ref,
  Rule,
  Severity,
  SnapshotStatus,
  State,
  Transition,
  Trigger,
  UnresolvedRef,
  VerificationPolicy,
} from "./types.ts";
export { schemas } from "./schema.ts";
export { buildIndex, collectRefs, ownershipTree, referenceGraph, refId } from "./graph.ts";
export type { GraphEdge, IndexEntry, ModelIndex, RefRole, RefSite, TreeNode } from "./graph.ts";
export { checkModel, hasErrors, validateModel } from "./validate.ts";
export type { CheckResult, ParseResult } from "./validate.ts";
export { dumpModel, loadModel, parseYaml } from "./serialize.ts";
export { isPersistedId, persistedIdProblem, persistedIdSchema } from "./ids.ts";
