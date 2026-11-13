// Content digests used across VCV: canonical JSON and SHA-256 in lowercase hex.
import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level and undefined values dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of bytes, or of a string's UTF-8 encoding, as 64 lowercase hex characters. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of a value's canonical JSON. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
