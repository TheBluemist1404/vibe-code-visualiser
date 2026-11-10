// Opaque page cursors: "<revision>:<scope fingerprint>:<offset>".
// The scope fingerprint binds a cursor to the query that produced it, so a cursor from one
// search cannot be replayed against another and silently skip results. Revision IDs cannot
// contain ":" (persisted-ID grammar), so the format is unambiguous.
import { createHash } from "node:crypto";

export type DecodedCursor = { revision: string; scope: string; offset: number };

export function scopeOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export function encodeCursor(revision: string, scope: string, offset: number): string {
  return `${revision}:${scope}:${offset}`;
}

export function decodeCursor(cursor: string): DecodedCursor | undefined {
  const m = /^([^:]+):([0-9a-f]{16}):(0|[1-9]\d{0,8})$/.exec(cursor);
  return m ? { revision: m[1]!, scope: m[2]!, offset: Number(m[3]) } : undefined;
}
