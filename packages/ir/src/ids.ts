// Identifiers that the file store turns into file names (change IDs and model revision IDs).
// One grammar, checked at every boundary: the change schema, the model schema, and the store.
// Canonical object IDs are not used as file names and stay opaque (IR v0.2 §6).
import { z } from "zod";

/**
 * Starts with a letter or digit, then letters, digits, ".", "_" or "-"; at most 128 chars.
 * This excludes "/", "\", ":", "..", leading dots, spaces and control characters on every OS.
 */
const PERSISTED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Device names Windows refuses as file names, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function persistedIdProblem(value: string): string | undefined {
  if (!PERSISTED_ID.test(value)) {
    return "must be 1–128 characters of letters, digits, '.', '_' or '-', starting with a letter or digit";
  }
  if (WINDOWS_RESERVED.test(value)) return "is a reserved device name on Windows";
  if (value.endsWith(".")) return "must not end with '.'";
  return undefined;
}

export const isPersistedId = (value: string) => persistedIdProblem(value) === undefined;

export const persistedIdSchema = z.string().superRefine((v, ctx) => {
  const problem = persistedIdProblem(v);
  if (problem) ctx.addIssue({ code: "custom", message: `identifier ${problem}` });
});
