// Identifiers that the file store turns into file names (change IDs and model revision IDs).
// One grammar, checked at every boundary: the change schema, the model schema, and the store.
// Canonical object IDs are not used as file names and stay opaque (IR v0.2 §6).
import { z } from "zod";

/**
 * Lowercase only: starts with a-z or 0-9, then a-z, 0-9, ".", "_" or "-"; at most 128 chars.
 * This excludes "/", "\\", ":", "..", leading dots, spaces and control characters on every OS.
 *
 * Lowercase-only is the case policy: Windows and default macOS filesystems are
 * case-insensitive, so "ch-Test" and "ch-test" would be the same file there. Rejecting
 * uppercase means two distinct accepted IDs can never map to the same file, on any OS.
 */
const PERSISTED_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// Device names Windows refuses as file names, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function persistedIdProblem(value: string): string | undefined {
  if (!PERSISTED_ID.test(value)) {
    return /[A-Z]/.test(value)
      ? "must be lowercase (file names are case-insensitive on Windows and macOS)"
      : "must be 1–128 characters of lowercase letters, digits, '.', '_' or '-', starting with a letter or digit";
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
