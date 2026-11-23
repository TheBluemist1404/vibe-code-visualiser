// Which fields the inspector may edit, and the typed operation each edit becomes. This table is
// the only place the UI decides editability, and it decides nothing about validity: every
// operation it builds is checked by the engine (previewProposal / submitProposal), never here.
import { buildIndex, isUnresolved } from "@vcv/ir";
import type { Model } from "@vcv/ir";
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

/**
 * Turn staged edits into typed operations, in the order they were staged. Rejects an edit of
 * an unknown object or a field its kind does not offer; leaves every rule about the result to
 * the engine.
 */
export function toOperations(model: Model, edits: unknown): Record<string, unknown>[] {
  if (!Array.isArray(edits) || edits.length === 0) throw new BadEdit("stage at least one edit");
  if (edits.length > 50) throw new BadEdit("at most 50 edits in one proposal");
  const index = buildIndex(model).byId;
  const seen = new Set<string>();
  return edits.map((raw, i) => {
    const e = raw as Partial<StagedEdit>;
    if (typeof e?.objectId !== "string" || typeof e.field !== "string")
      throw new BadEdit(`edit ${i}: objectId and field are required`);
    const entry = index.get(e.objectId);
    if (!entry || entry.kind === "project") throw new BadEdit(`edit ${i}: no object ${e.objectId} in this model`);
    const key = `${e.objectId}:${e.field}`;
    if (seen.has(key)) throw new BadEdit(`edit ${i}: ${key} is staged twice`);
    seen.add(key);
    const allowed = fieldAccess(entry.kind, {}).editable.map((f) => f.field);
    if (!allowed.includes(e.field as EditableFieldName))
      throw new BadEdit(`edit ${i}: the ${e.field} of a ${entry.kind} cannot be edited here`);
    return operation(entry.kind, e.objectId, e.field as EditableFieldName, e.value, i);
  });
}

function operation(
  kind: string,
  objectId: string,
  field: EditableFieldName,
  value: unknown,
  i: number,
): Record<string, unknown> {
  if (field === "dependsOn") {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
      throw new BadEdit(`edit ${i}: dependsOn takes a list of module IDs`);
    return { type: "setModuleDependencies", moduleId: objectId, dependsOn: value };
  }
  if (typeof value !== "string") throw new BadEdit(`edit ${i}: ${field} takes text`);
  // Text is sent as typed; the engine decides whether it is acceptable (an empty name is not).
  if (field === "name") return { type: "renameObject", objectId, name: value };
  if (field === "description") return { type: "setDescription", objectId, description: value };
  return kind === "criterion"
    ? { type: "reviseCriterion", criterionId: objectId, statement: value }
    : { type: "setRuleStatement", ruleId: objectId, statement: value };
}
