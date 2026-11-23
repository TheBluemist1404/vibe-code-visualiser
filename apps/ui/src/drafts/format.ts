// The on-disk format of a local draft, and the checks every file passes when it is read. A
// file that fails them is reported, never repaired or replaced.
import { randomBytes } from "node:crypto";
import type { Step } from "../edits.ts";
import type { EditableFieldName, ModelIdentity } from "../types.ts";

export const DRAFT_FORMAT = "vcv-ui-draft-1";

export const DRAFT_LIMITS = {
  /** Largest draft file read or written. */
  fileBytes: 256 * 1024,
  steps: 50,
  rationale: 4000,
  /** Drafts kept per checkout and project. */
  drafts: 20,
} as const;

export type DraftFile = {
  format: typeof DRAFT_FORMAT;
  draftId: string;
  version: number;
  checkoutRoot: string;
  projectId: string;
  /** The model the draft was staged on. Never changed after the draft is created. */
  base: ModelIdentity;
  steps: Step[];
  rationale: string;
  createdAt: string;
  updatedAt: string;
};

const DRAFT_ID = /^d-\d{8}-\d{6}-[0-9a-f]{4}$/;
const FIELDS: EditableFieldName[] = ["name", "description", "statement", "dependsOn"];
const OPERATIONS = ["renameObject", "setDescription", "setRuleStatement", "reviseCriterion", "setModuleDependencies"];

export const isDraftId = (id: string) => DRAFT_ID.test(id);

/** A new draft ID that sorts by time: d-20261123-101500-3f9a. */
export function newDraftId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `d-${stamp}-${randomBytes(2).toString("hex")}`;
}

export class DraftFileProblem extends Error {
  readonly code: "CORRUPT" | "TOO_LARGE" | "FOREIGN" | "UNSUPPORTED_FORMAT";
  constructor(code: DraftFileProblem["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isValue = (v: unknown) => isStr(v) || (Array.isArray(v) && v.every(isStr));

function checkIdentity(v: unknown): v is ModelIdentity {
  const m = v as ModelIdentity;
  return (
    !!m &&
    isStr(m.revision) &&
    isStr(m.modelKey) &&
    (m.branch === null || isStr(m.branch)) &&
    (m.commit === null || isStr(m.commit))
  );
}

function checkStep(v: unknown): v is Step {
  const s = v as Step;
  return (
    !!s &&
    typeof s.operation === "object" &&
    s.operation !== null &&
    OPERATIONS.includes(s.operation.type) &&
    isStr(s.objectId) &&
    isStr(s.objectName) &&
    isStr(s.objectKind) &&
    FIELDS.includes(s.field) &&
    isStr(s.label) &&
    (s.before === null || isValue(s.before)) &&
    isValue(s.after)
  );
}

/**
 * Parse one draft file and check it belongs to this checkout and project. The operations are
 * checked for shape only: an operation the engine would refuse (an empty name) is kept, so the
 * dry run can report it and an agent can repair it.
 */
export function parseDraft(text: string, expect: { draftId: string; root: string; projectId: string }): DraftFile {
  if (Buffer.byteLength(text) > DRAFT_LIMITS.fileBytes)
    throw new DraftFileProblem("TOO_LARGE", `larger than ${DRAFT_LIMITS.fileBytes} bytes; not read`);
  let d: DraftFile;
  try {
    d = JSON.parse(text) as DraftFile;
  } catch (e) {
    throw new DraftFileProblem("CORRUPT", `not JSON: ${(e as Error).message}`);
  }
  if (d?.format !== DRAFT_FORMAT)
    throw new DraftFileProblem(
      "UNSUPPORTED_FORMAT",
      `format is ${JSON.stringify(d?.format)}, expected ${DRAFT_FORMAT}`,
    );
  if (d.draftId !== expect.draftId || d.checkoutRoot !== expect.root || d.projectId !== expect.projectId)
    throw new DraftFileProblem("FOREIGN", "the file belongs to another draft, checkout or project");
  const ok =
    Number.isInteger(d.version) &&
    d.version > 0 &&
    checkIdentity(d.base) &&
    Array.isArray(d.steps) &&
    d.steps.length <= DRAFT_LIMITS.steps &&
    d.steps.every(checkStep) &&
    isStr(d.rationale) &&
    d.rationale.length <= DRAFT_LIMITS.rationale &&
    isStr(d.createdAt) &&
    isStr(d.updatedAt);
  if (!ok) throw new DraftFileProblem("CORRUPT", "the draft does not match the draft format");
  return d;
}
