// Keep absolute paths out of anything VCV prints or returns.
import { homedir } from "node:os";

/** Replace the checkout's absolute path and the home directory in every string. */
export function redact<T>(v: T, root: string): T {
  const home = homedir();
  const scrub = (s: string) => {
    let out = s.split(root).join("<checkout>");
    if (home && home.length > 1) out = out.split(home).join("~");
    return out;
  };
  const walk = (x: unknown): unknown =>
    typeof x === "string"
      ? scrub(x)
      : Array.isArray(x)
        ? x.map(walk)
        : x && typeof x === "object"
          ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]))
          : x;
  return walk(v) as T;
}
