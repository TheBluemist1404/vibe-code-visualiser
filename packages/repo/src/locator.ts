// Source locators (ADR 0007 §4): parsing, the portable path rules, and resolving a path inside a
// checkout without following anything out of it. Nothing here interprets code.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { HTTP_METHODS } from "@vcv/core";
import type { HttpMethod, Selector, SourceLocator } from "@vcv/core";

/** Directories a locator may never point into: VCV's own store, Git internals, installed packages. */
export const EXCLUDED_SEGMENTS = new Set([".git", ".vcv", "node_modules"]);

/** Why a repository-relative path is not acceptable in a shared claim, or undefined if it is. */
export function pathProblem(path: string): string | undefined {
  if (typeof path !== "string" || path === "") return "is empty";
  if (path.includes("\0")) return "contains a NUL character";
  if (path.includes("\\")) return 'uses "\\"; locator paths are POSIX ("/" separated)';
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "is absolute; locator paths are relative to the repository root";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === ".")) return 'is not normalized (empty or "." segment, or a trailing "/")';
  if (segments.includes("..")) return 'leaves the repository ("..")';
  const excluded = segments.find((s) => EXCLUDED_SEGMENTS.has(s));
  if (excluded) return `points into ${excluded}/, which is never source`;
  return undefined;
}

export type PathResolution =
  | { ok: true; abs: string }
  | { ok: false; reason: "missing" | "unsafe" | "case-mismatch" | "not-a-file"; message: string };

/**
 * Find `rel` under `root` one segment at a time. Each segment must exist with exactly this
 * spelling (a case-only difference is reported, not matched, so case-insensitive filesystems
 * agree with Linux). A symlink anywhere on the way must stay inside the checkout.
 */
export function resolveInside(root: string, rel: string): PathResolution {
  const problem = pathProblem(rel);
  if (problem) return { ok: false, reason: "unsafe", message: `path "${rel}" ${problem}` };
  const realRoot = realpathSync(root);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  let dir = realRoot;
  const segments = rel.split("/");
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i]!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return { ok: false, reason: "missing", message: `${segments.slice(0, i).join("/") || "."} is not a readable directory` };
    }
    if (!entries.includes(name)) {
      const other = entries.find((e) => e.toLowerCase() === name.toLowerCase());
      const at = segments.slice(0, i + 1).join("/");
      return other
        ? { ok: false, reason: "case-mismatch", message: `${at} does not exist, but ${[...segments.slice(0, i), other].join("/")} does (paths are case-sensitive)` }
        : { ok: false, reason: "missing", message: `${at} does not exist` };
    }
    let next = join(dir, name);
    if (lstatSync(next).isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(next);
      } catch {
        return { ok: false, reason: "missing", message: `${segments.slice(0, i + 1).join("/")} is a dangling symlink` };
      }
      if (!inside(target)) return { ok: false, reason: "unsafe", message: `${segments.slice(0, i + 1).join("/")} is a symlink that leaves the checkout` };
      next = target;
    }
    dir = next;
  }
  if (!statSync(dir).isFile()) return { ok: false, reason: "not-a-file", message: `${rel} is not a regular file` };
  return { ok: true, abs: dir };
}

/** Normalize a route for comparison: leading "/", single slashes, no trailing "/". */
export function normalizeRoute(route: string): string {
  const parts = route.split("/").filter(Boolean);
  return "/" + parts.join("/");
}

/** Why a selector is malformed, or undefined. Shape only; whether it resolves is the resolver's job. */
export function selectorProblem(s: Selector): string | undefined {
  switch (s.kind) {
    case "file":
      return undefined;
    case "symbol":
      return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$#][\w$]*)*$/.test(s.name) ? undefined : `symbol name "${s.name}" is not a dotted identifier path`;
    case "route":
      if (!(HTTP_METHODS as readonly string[]).includes(s.method)) return `route method "${s.method}" is not one of ${HTTP_METHODS.join(", ")}`;
      if (typeof s.route !== "string" || !s.route.startsWith("/")) return `route "${s.route}" must start with "/"`;
      return undefined;
    case "test":
      return typeof s.name === "string" && s.name.trim() !== "" ? undefined : "test name is empty";
    default:
      return `unknown selector kind "${(s as { kind: string }).kind}"`;
  }
}

/**
 * Parse the human form: `path`, `path#symbol:Class.member`, `path#route:POST /orders`,
 * `path#test:Suite > case`. Throws on malformed input.
 */
export function parseLocator(text: string): SourceLocator {
  const hash = text.indexOf("#");
  const path = hash < 0 ? text : text.slice(0, hash);
  if (hash < 0) return { path, selector: { kind: "file" } };
  const rest = text.slice(hash + 1);
  const colon = rest.indexOf(":");
  const kind = colon < 0 ? rest : rest.slice(0, colon);
  const arg = colon < 0 ? "" : rest.slice(colon + 1);
  let selector: Selector;
  switch (kind) {
    case "file":
      selector = { kind: "file" };
      break;
    case "symbol":
      selector = { kind: "symbol", name: arg };
      break;
    case "route": {
      const m = /^([A-Za-z]+)\s+(\S+)$/.exec(arg.trim());
      if (!m) throw new Error(`route selector "${arg}" must be "<METHOD> <path>"`);
      selector = { kind: "route", method: m[1]!.toUpperCase() as HttpMethod, route: m[2]! };
      break;
    }
    case "test":
      selector = { kind: "test", name: arg };
      break;
    default:
      throw new Error(`unknown selector kind "${kind}" (use symbol, route or test, or no "#" for a whole file)`);
  }
  return { path, selector };
}

export function formatLocator(l: SourceLocator): string {
  const s = l.selector;
  switch (s.kind) {
    case "file":
      return l.path;
    case "symbol":
      return `${l.path}#symbol:${s.name}`;
    case "route":
      return `${l.path}#route:${s.method} ${s.route}${s.handler ? ` (${s.handler})` : ""}`;
    case "test":
      return `${l.path}#test:${s.name}`;
  }
}
