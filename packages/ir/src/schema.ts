// Level 1 validation: shape and primitive types only. References are checked in validate.ts.
import { z } from "zod";
import { ATTRIBUTE_TYPES } from "./types.ts";

const id = z.string().min(1);
const unresolved = z.object({ unresolved: z.string().min(1), diagnostic: z.string().optional() }).strict();
const ref = z.union([id, unresolved]);

const base = <K extends string>(kind: K) => ({
  id,
  kind: z.literal(kind),
  owner: ref,
  name: z.string().min(1),
  description: z.string().optional(),
});

const actor = z.object(base("actor")).strict();
const module = z
  .object({ ...base("module"), purpose: z.string().optional(), dependsOn: z.array(ref).optional(), consumes: z.array(ref).optional() })
  .strict();
const capability = z.object({ ...base("capability"), initiatorActorId: ref.optional() }).strict();
const attribute = z
  .object({
    id,
    name: z.string().min(1),
    type: z.enum(ATTRIBUTE_TYPES),
    nullable: z.boolean().optional(),
    refDataId: ref.optional(),
  })
  .strict();
const data = z.object({ ...base("data"), attributes: z.array(attribute) }).strict();
// Rules may omit a display name (the spec's own permission-rule example has none).
const ruleBase = { ...base("rule"), name: z.string().min(1).optional() };
const rule = z.discriminatedUnion("ruleKind", [
  z.object({ ...ruleBase, ruleKind: z.literal("permission"), actorId: ref, capabilityId: ref, statement: z.string().optional() }).strict(),
  z.object({ ...ruleBase, ruleKind: z.enum(["invariant", "policy"]), statement: z.string().min(1) }).strict(),
]);
const event = z.object(base("event")).strict();
const contract = z.object({ ...base("contract"), accepts: z.array(ref).optional(), publishes: z.array(ref).optional() }).strict();

// ISO 8601 duration, date and time parts (e.g. P7D, PT12H, P1DT2H).
const isoDuration = z.string().regex(/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/, "ISO 8601 duration expected");

const trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), eventId: ref }).strict(),
  z.object({ kind: z.literal("elapsed"), duration: isoDuration, anchor: z.object({ dataId: ref, attributeId: ref }).strict() }).strict(),
]);
const guard = z.object({ kind: z.literal("permission"), ruleId: ref }).strict();
const effect = z.object({ kind: z.literal("emitEvent"), eventId: ref }).strict();
const state = z.object({ id, name: z.string().min(1) }).strict();
export const transitionSchema = z
  .object({ id, fromStateId: ref, toStateId: ref, trigger, guards: z.array(guard).optional(), effects: z.array(effect).optional() })
  .strict();
const behavior = z
  .object({
    ...base("behavior"),
    realizes: z.array(ref).optional(),
    initialStateId: ref,
    states: z.array(state).min(1),
    transitions: z.array(transitionSchema),
  })
  .strict();

export const modelSchema = z
  .object({
    schemaVersion: z.string(),
    project: z
      .object({
        id,
        name: z.string().min(1),
        modelRevision: z.string().min(1),
        status: z.enum(["draft", "approved"]),
        description: z.string().optional(),
      })
      .strict(),
    actors: z.array(actor).default([]),
    modules: z.array(module).default([]),
    capabilities: z.array(capability).default([]),
    data: z.array(data).default([]),
    rules: z.array(rule).default([]),
    events: z.array(event).default([]),
    contracts: z.array(contract).default([]),
    behaviors: z.array(behavior).default([]),
  })
  .strict();

export const schemas = { state, transition: transitionSchema, attribute, module, event };
