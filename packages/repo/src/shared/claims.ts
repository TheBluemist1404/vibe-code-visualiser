// The checkout's binding claim files, read once with a key for exactly that set.
import { canonicalJson } from "@vcv/core";
import { listBindings } from "../bindings/bindings.ts";
import type { ClaimEntry } from "../bindings/bindings.ts";

/** The checkout's claim files and a key for exactly this set (IDs and digests). */
export function readClaims(root: string): { entries: ClaimEntry[]; key: string } {
  try {
    const entries = listBindings(root);
    return { entries, key: canonicalJson(entries.map((e) => [e.bindingId, e.digest])) };
  } catch (e) {
    // An unsafe or unreadable bindings directory is reported by vcv evidence, not here.
    return { entries: [], key: `unreadable:${(e as Error).message}` };
  }
}
