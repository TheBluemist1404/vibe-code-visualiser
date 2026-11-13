// Deterministic locator resolution for a bounded TypeScript/TSX subset (ADR 0007 §6, Issue #13).
//
// This answers exactly one question: does a locator point at one existing artifact, and what is
// that artifact's fingerprint? It does not look for architecture, guess meaning, follow imports or
// type-check. Anything outside the documented subset is "unchecked", never guessed.
//
// Parser: the TypeScript 6 compiler API, pinned in @vcv/repo's package.json. TypeScript 7 (the
// repository's type checker) is a native binary whose JS API is "unstable" and runs over IPC, so
// it is not used for this. Only syntax is read (createSourceFile); no program, no config.
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { HttpMethod, LocatorState, Selector, SourceLocator, SymbolDeclaration } from "@vcv/core";
import { normalizeRoute, resolveInside, selectorProblem } from "./locator.ts";
import type { PathResolution } from "./locator.ts";

/** Identifies the fingerprint algorithm. A claim fingerprinted by another version is compared as unknown, not as changed. */
export const RESOLVER_ID = `vcv-ts-subset-1/typescript-${ts.version}`;
/** Larger files are fingerprinted as files, but selectors in them are unchecked. */
export const MAX_SOURCE_BYTES = 1_000_000;

const TS_FILE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /[.-](test|spec)\.(ts|tsx|mts|cts)$/;

export type Match = { label: string; declaration: string; line: number; fingerprint: string };

export type Resolution = {
  state: LocatorState;
  /** One sentence on why, for people and agents. */
  detail: string;
  /** Present when the path itself is the problem. */
  pathIssue?: Exclude<PathResolution, { ok: true }>["reason"];
  /** sha256 of the file (CRLF → LF), when the file could be read. */
  fileFingerprint: string | null;
  /** Fingerprint of the one selected artifact, when resolved by a selector. */
  selectorFingerprint?: string;
  /** Every artifact the selector matched (one when resolved, several when ambiguous). */
  matches: Match[];
};

/** sha256 of file bytes with CRLF normalized to LF (so a Windows checkout agrees with Linux). */
export function fileFingerprint(bytes: Buffer): string {
  return sha256(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}

const CHUNK = 1 << 20;

function openRegular(abs: string): number | null {
  try {
    const fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    if (fstatSync(fd).isFile()) return fd;
    closeSync(fd);
  } catch {
    // reported as unreadable by the caller
  }
  return null;
}

/**
 * fileFingerprint of a file, streamed in 1 MiB chunks so a large file never has to fit in memory.
 * Same result as fileFingerprint(readFileSync(abs)); a CR at a chunk end is held for the next one.
 * Null if the file cannot be opened as a regular file.
 */
export function fileFingerprintAt(abs: string): string | null {
  const fd = openRegular(abs);
  if (fd === null) return null;
  try {
    const h = createHash("sha256");
    const buf = Buffer.alloc(CHUNK);
    let carry = "";
    for (let n; (n = readSync(fd, buf, 0, CHUNK, null)) > 0; ) {
      let text = carry + buf.toString("latin1", 0, n);
      carry = text.endsWith("\r") ? "\r" : "";
      if (carry) text = text.slice(0, -1);
      h.update(Buffer.from(text.replace(/\r\n/g, "\n"), "latin1"));
    }
    h.update(Buffer.from(carry, "latin1"));
    return h.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** At most `max` bytes of a regular file, or "too-large" without reading further, or null if unreadable. */
function readBounded(abs: string, max: number): Buffer | "too-large" | null {
  const fd = openRegular(abs);
  if (fd === null) return null;
  try {
    if (fstatSync(fd).size > max) return "too-large";
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0; ) n += r;
    return n > max ? "too-large" : buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const sha256 = (text: string, enc: BufferEncoding = "utf8") =>
  createHash("sha256").update(Buffer.from(text, enc)).digest("hex");

/** Resolve a locator inside `root`. Read-only and deterministic for the same bytes. */
export function resolveLocator(root: string, locator: SourceLocator): Resolution {
  const problem = selectorProblem(locator.selector);
  if (problem)
    return { state: "unchecked", detail: `malformed selector: ${problem}`, fileFingerprint: null, matches: [] };
  const where = resolveInside(root, locator.path);
  if (!where.ok)
    return { state: "missing", detail: where.message, pathIssue: where.reason, fileFingerprint: null, matches: [] };
  const sel = locator.selector;
  const unreadable = (): Resolution => ({
    state: "missing",
    detail: `${locator.path} cannot be read as a regular file`,
    fileFingerprint: null,
    matches: [],
  });
  // Whole files and files the resolver will not parse are fingerprinted by streaming, in bounded memory.
  const streamed = (): string | null => fileFingerprintAt(where.abs);
  if (sel.kind === "file") {
    const fp = streamed();
    return fp
      ? { state: "resolved", detail: `${locator.path} exists`, fileFingerprint: fp, matches: [] }
      : unreadable();
  }
  const unchecked = (detail: string, fp: string | null): Resolution =>
    fp ? { state: "unchecked", detail, fileFingerprint: fp, matches: [] } : unreadable();
  if (!TS_FILE.test(locator.path))
    return unchecked(`${sel.kind} selectors are only checked in .ts/.tsx/.mts/.cts files`, streamed());
  if (sel.kind === "test" && !TEST_FILE.test(locator.path))
    return unchecked("test selectors are only checked in *.test.* and *.spec.* files", streamed());
  // The size limit is checked before the file is read into memory, and again while reading.
  const bytes = readBounded(where.abs, MAX_SOURCE_BYTES);
  if (bytes === null) return unreadable();
  if (bytes === "too-large")
    return unchecked(
      `${locator.path} is larger than ${MAX_SOURCE_BYTES} bytes; selectors are not checked in it`,
      streamed(),
    );
  const fileFp = fileFingerprint(bytes);

  const sf = ts.createSourceFile(
    locator.path,
    bytes.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(locator.path),
  );
  const found =
    sel.kind === "symbol" ? findSymbols(sf, sel) : sel.kind === "route" ? findRoutes(sf, sel) : findTests(sf, sel);
  const label = describeSelector(sel);
  if (found.matches.length === 1) {
    const m = found.matches[0]!;
    return {
      state: "resolved",
      detail: `${label} resolves to ${m.declaration} ${m.label} at line ${m.line}`,
      fileFingerprint: fileFp,
      selectorFingerprint: m.fingerprint,
      matches: found.matches,
    };
  }
  if (found.matches.length > 1) {
    return {
      state: "ambiguous",
      detail: `${label} matches ${found.matches.length} artifacts (lines ${found.matches.map((m) => m.line).join(", ")}); none is picked`,
      fileFingerprint: fileFp,
      matches: found.matches,
    };
  }
  if (found.unsupported.length)
    return unchecked(
      `${label} not found, but ${locator.path} has constructs the resolver cannot read: ${found.unsupported.slice(0, 3).join("; ")}`,
      fileFp,
    );
  return { state: "missing", detail: `${label} not found in ${locator.path}`, fileFingerprint: fileFp, matches: [] };
}

function describeSelector(s: Selector): string {
  switch (s.kind) {
    case "file":
      return "file";
    case "symbol":
      return `symbol ${s.name}${s.declaration ? ` (${s.declaration})` : ""}`;
    case "route":
      return `route ${s.method} ${normalizeRoute(s.route)}${s.handler ? ` (${s.handler})` : ""}`;
    case "test":
      return `test "${s.name}"`;
  }
}

function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

// --- fingerprints ---------------------------------------------------------------------

/**
 * Fingerprint of declarations: the sequence of their syntax tokens, so comments, JSDoc and
 * formatting do not count, while any change to code (including decorators) does. JSX text is
 * compared with whitespace runs collapsed.
 */
function nodesFingerprint(sf: ts.SourceFile, nodes: readonly ts.Node[]): string {
  const tokens: string[] = [];
  const walk = (n: ts.Node) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = n.getChildren(sf);
    if (children.length === 0) {
      if (n.kind === ts.SyntaxKind.EndOfFileToken || n.end === n.pos) return;
      const text = n.getText(sf);
      if (text === "") return;
      tokens.push(n.kind === ts.SyntaxKind.JsxText ? text.replace(/\s+/g, " ").trim() : text);
      return;
    }
    children.forEach(walk);
  };
  for (const n of nodes) walk(n);
  return sha256("vcv-selector-v1\0" + tokens.filter((t) => t !== "").join("\n"));
}

const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

// --- symbols --------------------------------------------------------------------------

type Decl = { name: string; declaration: SymbolDeclaration; node: ts.Node; hasBody: boolean; accessor?: "get" | "set" };

function memberName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined; // computed names are not addressable
}

/** Top-level and class/interface-member declarations. Nothing inside function bodies. */
function collectDeclarations(sf: ts.SourceFile): { decls: Decl[]; unsupported: string[] } {
  const decls: Decl[] = [];
  const unsupported: string[] = [];
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st)) {
      const cls = st.name?.text ?? (hasDefaultExport(st) ? "default" : undefined);
      if (!cls) continue;
      decls.push({ name: cls, declaration: "class", node: st, hasBody: true });
      for (const m of st.members) {
        if (ts.isConstructorDeclaration(m))
          decls.push({ name: `${cls}.constructor`, declaration: "method", node: m, hasBody: !!m.body });
        const name = memberName((m as { name?: ts.PropertyName }).name);
        if (!name) {
          if ((m as { name?: ts.PropertyName }).name)
            unsupported.push(`a computed member name in class ${cls} (line ${lineOf(sf, m)})`);
          continue;
        }
        if (ts.isMethodDeclaration(m))
          decls.push({ name: `${cls}.${name}`, declaration: "method", node: m, hasBody: !!m.body });
        else if (ts.isPropertyDeclaration(m))
          decls.push({ name: `${cls}.${name}`, declaration: "property", node: m, hasBody: true });
        else if (ts.isGetAccessorDeclaration(m))
          decls.push({ name: `${cls}.${name}`, declaration: "accessor", node: m, hasBody: true, accessor: "get" });
        else if (ts.isSetAccessorDeclaration(m))
          decls.push({ name: `${cls}.${name}`, declaration: "accessor", node: m, hasBody: true, accessor: "set" });
      }
    } else if (ts.isFunctionDeclaration(st)) {
      const name = st.name?.text ?? (hasDefaultExport(st) ? "default" : undefined);
      if (name) decls.push({ name, declaration: "function", node: st, hasBody: !!st.body });
    } else if (ts.isInterfaceDeclaration(st)) {
      decls.push({ name: st.name.text, declaration: "interface", node: st, hasBody: true });
      for (const m of st.members) {
        const name = memberName((m as { name?: ts.PropertyName }).name);
        if (!name) continue;
        if (ts.isMethodSignature(m))
          decls.push({ name: `${st.name.text}.${name}`, declaration: "method", node: m, hasBody: false });
        else if (ts.isPropertySignature(m))
          decls.push({ name: `${st.name.text}.${name}`, declaration: "property", node: m, hasBody: true });
      }
    } else if (ts.isTypeAliasDeclaration(st)) {
      decls.push({ name: st.name.text, declaration: "type", node: st, hasBody: true });
    } else if (ts.isEnumDeclaration(st)) {
      decls.push({ name: st.name.text, declaration: "enum", node: st, hasBody: true });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) decls.push({ name: d.name.text, declaration: "const", node: d, hasBody: true });
        else unsupported.push(`a destructuring declaration (line ${lineOf(sf, d)})`);
      }
    } else if (ts.isModuleDeclaration(st)) {
      unsupported.push(`namespace or module ${st.name.getText(sf)} (line ${lineOf(sf, st)})`);
    }
  }
  return { decls, unsupported };
}

function hasDefaultExport(n: ts.Node): boolean {
  const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function findSymbols(
  sf: ts.SourceFile,
  sel: Extract<Selector, { kind: "symbol" }>,
): { matches: Match[]; unsupported: string[] } {
  const { decls, unsupported } = collectDeclarations(sf);
  const named = decls.filter((d) => d.name === sel.name && (!sel.declaration || d.declaration === sel.declaration));
  // One artifact per declaration kind: overload signatures belong to their single
  // implementation, and a get/set pair is one accessor. Two implementations stay two.
  const groups = new Map<SymbolDeclaration, Decl[]>();
  for (const d of named) groups.set(d.declaration, [...(groups.get(d.declaration) ?? []), d]);
  const matches: Match[] = [];
  for (const [declaration, ds] of groups) {
    const single =
      declaration === "accessor"
        ? ds.filter((d) => d.accessor === "get").length <= 1 && ds.filter((d) => d.accessor === "set").length <= 1
        : declaration === "method" || declaration === "function"
          ? ds.filter((d) => d.hasBody).length <= 1
          : ds.length === 1;
    const parts = single ? [ds] : ds.map((d) => [d]);
    for (const p of parts)
      matches.push({
        label: sel.name,
        declaration,
        line: lineOf(sf, p[0]!.node),
        fingerprint: nodesFingerprint(
          sf,
          p.map((d) => d.node),
        ),
      });
  }
  // Unreadable constructs only matter when they could hide the symbol: a namespace with the
  // symbol's first name segment, a computed member of its class, or any destructuring.
  const head = sel.name.split(".")[0]!;
  const relevant = unsupported.filter((u) =>
    u.startsWith("namespace")
      ? u.startsWith(`namespace or module ${head} `)
      : u.startsWith("a computed")
        ? u.includes(` class ${head} `)
        : true,
  );
  return { matches, unsupported: relevant };
}

// --- NestJS routes --------------------------------------------------------------------

const ROUTE_DECORATORS: Record<string, HttpMethod> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Head: "HEAD",
  Options: "OPTIONS",
  All: "ALL",
};

/** Literal path arguments of a Nest decorator: [""] for none, a list for arrays, null if not static. */
function staticPaths(args: readonly ts.Expression[], allowObject: boolean): string[] | null {
  const arg = args[0];
  if (!arg) return [""];
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return [arg.text];
  if (ts.isArrayLiteralExpression(arg)) {
    const out = arg.elements.map((e) =>
      ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null,
    );
    return out.every((p) => p !== null) ? (out as string[]) : null;
  }
  if (allowObject && ts.isObjectLiteralExpression(arg)) {
    // { path: "x" } only. host/version change what the route means at runtime, so they are not static.
    let paths: string[] | null = [""];
    for (const p of arg.properties) {
      if (!ts.isPropertyAssignment(p)) return null;
      const key = memberName(p.name);
      if (key === "path") paths = staticPaths([p.initializer], false);
      else return null;
    }
    return paths;
  }
  return null;
}

function nestImports(sf: ts.SourceFile): { names: Map<string, string>; unsupported: string[] } {
  const names = new Map<string, string>();
  const unsupported: string[] = [];
  for (const st of sf.statements) {
    if (
      !ts.isImportDeclaration(st) ||
      !ts.isStringLiteral(st.moduleSpecifier) ||
      st.moduleSpecifier.text !== "@nestjs/common"
    )
      continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) unsupported.push(`namespace import of @nestjs/common (line ${lineOf(sf, st)})`);
    if (b && ts.isNamedImports(b)) {
      for (const el of b.elements) {
        if (el.propertyName)
          unsupported.push(`aliased import ${el.propertyName.getText(sf)} as ${el.name.text} (line ${lineOf(sf, el)})`);
        else names.set(el.name.text, el.name.text);
      }
    }
  }
  return { names, unsupported };
}

function decoratorCall(d: ts.Decorator): { name: string; args: readonly ts.Expression[] } | null {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return { name: e.expression.text, args: e.arguments };
  return null;
}

function findRoutes(
  sf: ts.SourceFile,
  sel: Extract<Selector, { kind: "route" }>,
): { matches: Match[]; unsupported: string[] } {
  const { names, unsupported } = nestImports(sf);
  const want = normalizeRoute(sel.route);
  const matches: Match[] = [];
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st)) continue;
    const ctrl = (ts.getDecorators(st) ?? []).map(decoratorCall).find((c) => c && names.get(c.name) === "Controller");
    if (!ctrl) continue;
    const cls = st.name?.text ?? "default";
    const base = staticPaths(ctrl.args, true);
    if (!base) {
      unsupported.push(`@Controller(...) of ${cls} has a non-literal path (line ${lineOf(sf, st)})`);
      continue;
    }
    for (const m of st.members) {
      if (!ts.isMethodDeclaration(m)) continue;
      const handler = `${cls}.${memberName(m.name) ?? "?"}`;
      for (const call of (ts.getDecorators(m) ?? []).map(decoratorCall)) {
        if (!call) continue;
        const method = ROUTE_DECORATORS[names.get(call.name) ?? ""];
        if (!method) continue;
        const paths = staticPaths(call.args, false);
        if (!paths) {
          unsupported.push(`@${call.name}(...) on ${handler} has a non-literal path (line ${lineOf(sf, m)})`);
          continue;
        }
        for (const b of base) {
          for (const p of paths) {
            const route = normalizeRoute(`${b}/${p}`);
            if (method !== sel.method || route !== want) continue;
            if (sel.handler && sel.handler !== handler && sel.handler !== memberName(m.name)) continue;
            matches.push({
              label: `${method} ${route} → ${handler}`,
              declaration: "route",
              line: lineOf(sf, m),
              fingerprint: nodesFingerprint(sf, [m]),
            });
          }
        }
      }
    }
  }
  return { matches, unsupported };
}

// --- tests ----------------------------------------------------------------------------

const SUITE = new Set(["describe", "suite"]);
const CASE = new Set(["it", "test"]);
const MODIFIERS = new Set(["only", "skip", "todo", "concurrent", "sequential", "fails"]);

/** describe/it/test with a literal title, optionally with .only/.skip/...; `.each` and friends are not static. */
function testCall(n: ts.CallExpression): { role: "suite" | "case"; title: string | null; dynamic?: string } | null {
  let callee = n.expression;
  let viaEach = false;
  if (ts.isCallExpression(callee)) {
    viaEach = true; // describe.each(table)("title", ...)
    callee = callee.expression;
  }
  while (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === "each" || callee.name.text === "for") viaEach = true;
    else if (!MODIFIERS.has(callee.name.text)) return null;
    callee = callee.expression;
  }
  if (!ts.isIdentifier(callee)) return null;
  const role = SUITE.has(callee.text) ? "suite" : CASE.has(callee.text) ? "case" : null;
  if (!role) return null;
  if (viaEach) return { role, title: null, dynamic: `${callee.text}.each` };
  const t = n.arguments[0];
  if (t && (ts.isStringLiteral(t) || ts.isNoSubstitutionTemplateLiteral(t))) return { role, title: t.text };
  return { role, title: null, dynamic: `${callee.text} with a non-literal title` };
}

function findTests(
  sf: ts.SourceFile,
  sel: Extract<Selector, { kind: "test" }>,
): { matches: Match[]; unsupported: string[] } {
  const want = sel.name
    .split(">")
    .map((s) => s.trim())
    .join(" > ");
  const matches: Match[] = [];
  const unsupported: string[] = [];
  const visit = (n: ts.Node, path: string[] | null) => {
    if (ts.isCallExpression(n)) {
      const t = testCall(n);
      if (t) {
        const title = t.title === null || path === null ? null : [...path, t.title].join(" > ");
        if (t.title === null) unsupported.push(`${t.dynamic} (line ${lineOf(sf, n)})`);
        if (title === want)
          matches.push({
            label: title,
            declaration: t.role === "suite" ? "suite" : "test",
            line: lineOf(sf, n),
            fingerprint: nodesFingerprint(sf, [n]),
          });
        const next = title === null ? null : [...path!, t.title!];
        n.arguments.forEach((a) => visit(a, next));
        return;
      }
    }
    ts.forEachChild(n, (c) => visit(c, path));
  };
  visit(sf, []);
  return { matches, unsupported };
}
