// Which fields the inspector may edit, and the typed operation each edit becomes. This table is
// the only place the UI decides editability, and it decides nothing about validity: every
// operation it builds is checked by the engine's dry run (previewProposal), never here.
import { buildIndex, COLLECTIONS, collectionOf, isUnresolved } from "@vcv/ir";
import type { CollectionName, Model } from "@vcv/ir";
import type { EditableFieldName, FieldAccess, StagedEdit } from "./types.ts";

export class BadEdit extends Error {
  readonly code = "INVALID_EDIT";
}

/** Kinds nested inside another object; their names and fields are edited through the parent. */
const NESTED = new Set(["state", "transition", "attribute"]);

const READ_ONLY_ID = { field: "id", label: "ID", reason: "Stable ID. Other objects refer to it, so it never changes." };
const READ_ONLY_OWNER = {
  field: "owner",
  label: "Owner",
  reason: "No typed operation moves an object to another module.",
};

/** Edit access for one object, from its kind and its current record. */
export function fieldAccess(kind: string, record: Record<string, unknown>): FieldAccess {
  const text = (k: string) => (typeof record[k] === "string" ? (record[k] as string) : null);
  if (NESTED.has(kind)) {
    return {
      editable: [],
      readOnly: [
        READ_ONLY_ID,
        {
          field: "*",
          label: "All fields",
          reason: `A ${kind} is part of its parent; editing it from here is not supported yet.`,
        },
      ],
    };
  }
  const access: FieldAccess = {
    editable: [
      { field: "name", label: "Name", operation: "renameObject", input: "line", value: text("name") },
      {
        field: "description",
        label: "Description",
        operation: "setDescription",
        input: "text",
        value: text("description"),
      },
    ],
    readOnly: [READ_ONLY_ID],
  };
  if (kind === "module") {
    access.editable.push({
      field: "dependsOn",
      label: "Depends on",
      operation: "setModuleDependencies",
      input: "modules",
      value: Array.isArray(record.dependsOn)
        ? (record.dependsOn as unknown[]).filter((r): r is string => typeof r === "string" && !isUnresolved(r))
        : [],
    });
    access.readOnly.push(
      { field: "purpose", label: "Purpose", reason: "No typed operation changes a module's purpose yet." },
      {
        field: "consumes",
        label: "Consumes",
        reason: "Contracts are linked with linkContract, which is not offered here.",
      },
    );
    return access;
  }
  if (kind === "rule")
    access.editable.push({
      field: "statement",
      label: "Statement",
      operation: "setRuleStatement",
      input: "text",
      value: text("statement"),
    });
  if (kind === "criterion")
    access.editable.push({
      field: "statement",
      label: "Statement",
      operation: "reviseCriterion",
      input: "text",
      value: text("statement"),
    });
  access.readOnly.push(READ_ONLY_OWNER, {
    field: "*",
    label: "Other fields",
    reason: "No typed operation edits them from the inspector.",
  });
  return access;
}

/** One staged edit, kept as the typed operation it became when it was staged. */
export type Step = {
  operation: Record<string, unknown> & { type: string };
  objectId: string;
  objectName: string;
  objectKind: string;
  field: EditableFieldName;
  label: string;
  /** What the field said in the model the draft is based on, and the staged value. Display only. */
  before: string | string[] | null;
  after: string | string[];
};

/** The record of one top-level object (not nested elements), or undefined. */
function recordOf(model: Model, id: string): Record<string, unknown> | undefined {
  for (const coll of Object.keys(COLLECTIONS) as CollectionName[]) {
    const hit = collectionOf(model, coll).find((o) => o.id === id);
    if (hit) return hit as unknown as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Turn one edit into its typed operation, against the model the draft is based on. Rejects an
 * unknown object or a field its kind does not offer; leaves every rule about the value to the
 * engine (an empty name is staged and the dry run reports it).
 */
export function toStep(model: Model, edit: unknown): Step {
  const e = (edit ?? {}) as Partial<StagedEdit>;
  if (typeof e.objectId !== "string" || typeof e.field !== "string")
    throw new BadEdit("an edit names an objectId and a field");
  const entry = buildIndex(model).byId.get(e.objectId);
  const record = recordOf(model, e.objectId);
  if (!entry || !record) throw new BadEdit(`no editable object ${e.objectId} in this model`);
  const access = fieldAccess(entry.kind, record).editable.find((f) => f.field === e.field);
  if (!access) throw new BadEdit(`the ${e.field} of a ${entry.kind} cannot be edited here`);
  const field = access.field;
  return {
    operation: operation(entry.kind, e.objectId, field, e.value),
    objectId: e.objectId,
    objectName: entry.name,
    objectKind: entry.kind,
    field,
    label: access.label,
    before: access.value,
    after: e.value as string | string[],
  };
}

function operation(
  kind: string,
  objectId: string,
  field: EditableFieldName,
  value: unknown,
): Record<string, unknown> & { type: string } {
  if (field === "dependsOn") {
    if (!Array.isArray(value) || value.length > 200 || !value.every((v) => typeof v === "string"))
      throw new BadEdit("dependsOn takes a list of module IDs");
    return { type: "setModuleDependencies", moduleId: objectId, dependsOn: value };
  }
  if (typeof value !== "string") throw new BadEdit(`${field} takes text`);
  if (value.length > 4000) throw new BadEdit(`${field} is longer than 4000 characters`);
  // Text is kept as typed; the engine decides whether it is acceptable.
  if (field === "name") return { type: "renameObject", objectId, name: value };
  if (field === "description") return { type: "setDescription", objectId, description: value };
  return kind === "criterion"
    ? { type: "reviseCriterion", criterionId: objectId, statement: value }
    : { type: "setRuleStatement", ruleId: objectId, statement: value };
}
