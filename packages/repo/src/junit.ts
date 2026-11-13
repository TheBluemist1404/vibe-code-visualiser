// A strict, bounded reader for JUnit XML test reports (Issue #22, M4.3).
//
// JUnit XML is what ordinary runners already emit per test case (Vitest `--reporter=junit`,
// Jest via jest-junit, pytest `--junitxml`, Maven Surefire…), so VCV reads it instead of inventing
// a result format. This is not a general XML parser: it accepts the subset those reports use
// (elements, attributes, text, CDATA, comments, the XML declaration and the five predefined plus
// numeric character references) and refuses everything else, DOCTYPE and entity declarations
// included, so a report cannot expand, include or reference anything. Every limit is explicit.
//
// Declared counts are checked against the cases actually present (per suite and for the root):
// a truncated, spliced or hand-edited report whose totals no longer add up is refused, not
// silently read as "fewer tests". This catches accidents and careless edits, not a deliberate
// forgery with consistent numbers; provenance (who ran it) is recorded separately (testruns.ts).
import { pathProblem } from "./locator.ts";
import { sha256Hex } from "@vcv/core";

export const JUNIT_LIMITS = {
  bytes: 16 * 1024 * 1024,
  depth: 32,
  elements: 250_000,
  cases: 20_000,
  attributes: 64,
  nameChars: 300,
  messageChars: 500,
} as const;

export type CaseStatus = "passed" | "failed" | "error" | "skipped";

export type JUnitCase = {
  /** sha256 of `<repository-relative path>\0<full name>`: the identity results are matched by. */
  key: string;
  path: string;
  /** Full title as the runner reports it (Vitest: "Suite > case"), cut at JUNIT_LIMITS.nameChars. */
  name: string;
  /** sha256 of the full name, present when `name` was cut. */
  nameDigest?: string;
  status: CaseStatus;
  /** The failure/error message, cut at JUNIT_LIMITS.messageChars. */
  message?: string;
};

export type JUnitReport = {
  format: "junit";
  sha256: string;
  bytes: number;
  cases: JUnitCase[];
  summary: { tests: number; passed: number; failed: number; errors: number; skipped: number };
  /** Identities reported more than once (a duplicated title): their results are ambiguous. */
  duplicates: string[];
};

export type JUnitResult =
  | { ok: true; report: JUnitReport }
  | { ok: false; code: "REPORT_INVALID" | "REPORT_INCONSISTENT" | "REPORT_TOO_LARGE" | "UNSAFE_PATH"; message: string };

type El = { name: string; attrs: Map<string, string>; children: El[]; text: string };

class XmlError extends Error {}

const cut = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
export const caseKey = (path: string, name: string) => sha256Hex(`${path}\0${name}`);

/**
 * Read a JUnit XML report. `root` is the directory the runner's paths are relative to, as a
 * repository-relative POSIX path ("" or "." for the repository root; Vitest run in `server/` → "server").
 */
export function parseJUnit(bytes: Uint8Array, root: string): JUnitResult {
  if (bytes.byteLength > JUNIT_LIMITS.bytes)
    return {
      ok: false,
      code: "REPORT_TOO_LARGE",
      message: `the report is ${bytes.byteLength} bytes; at most ${JUNIT_LIMITS.bytes} are read`,
    };
  const base = root === "" || root === "." ? "" : root.replace(/\/+$/, "");
  if (base && pathProblem(base))
    return { ok: false, code: "UNSAFE_PATH", message: `report root "${root}" ${pathProblem(base)}` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: "REPORT_INVALID", message: "the report is not valid UTF-8" };
  }
  let doc: El;
  try {
    doc = parseXml(text);
  } catch (e) {
    return {
      ok: false,
      code: "REPORT_INVALID",
      message: e instanceof XmlError ? e.message : "the report cannot be read as XML",
    };
  }
  if (doc.name !== "testsuites" && doc.name !== "testsuite")
    return {
      ok: false,
      code: "REPORT_INVALID",
      message: `the root element is <${cut(doc.name, 50)}>, not <testsuites> or <testsuite>`,
    };

  const cases: JUnitCase[] = [];
  const seen = new Map<string, number>();
  const problems: string[] = [];
  const count = (el: El, attr: string) => {
    const v = el.attrs.get(attr);
    if (v === undefined) return undefined;
    if (!/^\d{1,9}$/.test(v.trim())) throw new XmlError(`<${el.name}> ${attr}="${cut(v, 20)}" is not a count`);
    return Number(v.trim());
  };
  const walkSuite = (suite: El, path: string[]): { tests: number; failed: number; errors: number; skipped: number } => {
    const tally = { tests: 0, failed: 0, errors: 0, skipped: 0 };
    for (const ch of suite.children) {
      if (ch.name === "testsuite") {
        const t = walkSuite(ch, [...path, ch.attrs.get("name") ?? ""]);
        tally.tests += t.tests;
        tally.failed += t.failed;
        tally.errors += t.errors;
        tally.skipped += t.skipped;
      } else if (ch.name === "testcase") {
        const file = ch.attrs.get("file") ?? ch.attrs.get("classname");
        const name = ch.attrs.get("name");
        if (!file || name === undefined || name === "")
          throw new XmlError("a <testcase> has no name or no classname/file");
        // The runner's own path must already be a portable relative path: an absolute, drive, UNC,
        // "\\" or ".." path is refused as written, never normalized into a path it might alias.
        const raw = pathProblem(file);
        if (raw) throw new XmlError(`test case path "${cut(file, 200)}" ${raw}`);
        const rel = base ? `${base}/${file}` : file;
        const pp = pathProblem(rel);
        if (pp) throw new XmlError(`test case path "${cut(rel, 200)}" ${pp}`);
        const kinds = ch.children.map((c) => c.name);
        const status: CaseStatus = kinds.includes("error")
          ? "error"
          : kinds.includes("failure")
            ? "failed"
            : kinds.includes("skipped")
              ? "skipped"
              : "passed";
        const detail = ch.children.find((c) => c.name === (status === "error" ? "error" : "failure"));
        const message = detail ? (detail.attrs.get("message") ?? detail.text).trim() : "";
        if (cases.length >= JUNIT_LIMITS.cases) throw new XmlError(`more than ${JUNIT_LIMITS.cases} test cases`);
        const key = caseKey(rel, name);
        seen.set(key, (seen.get(key) ?? 0) + 1);
        cases.push({
          key,
          path: rel,
          name: cut(name, JUNIT_LIMITS.nameChars),
          ...(name.length > JUNIT_LIMITS.nameChars ? { nameDigest: sha256Hex(name) } : {}),
          status,
          ...(message ? { message: cut(message, JUNIT_LIMITS.messageChars) } : {}),
        });
        tally.tests++;
        if (status === "failed") tally.failed++;
        if (status === "error") tally.errors++;
        if (status === "skipped") tally.skipped++;
      }
    }
    if (suite.name === "testsuite") {
      const where = `suite "${cut(suite.attrs.get("name") ?? path.join(" / "), 120)}"`;
      const check = (attr: string, actual: number) => {
        const declared = count(suite, attr);
        if (declared !== undefined && declared !== actual)
          problems.push(`${where} declares ${attr}="${declared}" but has ${actual}`);
      };
      check("tests", tally.tests);
      check("failures", tally.failed);
      check("errors", tally.errors);
      check("skipped", tally.skipped);
    }
    return tally;
  };
  let total;
  try {
    total = walkSuite(doc, []);
    if (doc.name === "testsuites") {
      for (const [attr, actual] of [
        ["tests", total.tests],
        ["failures", total.failed],
        ["errors", total.errors],
        ["skipped", total.skipped],
      ] as const) {
        const declared = count(doc, attr);
        if (declared !== undefined && declared !== actual)
          problems.push(`the report declares ${attr}="${declared}" but has ${actual}`);
      }
    }
  } catch (e) {
    if (e instanceof XmlError) return { ok: false, code: "REPORT_INVALID", message: e.message };
    throw e;
  }
  if (problems.length)
    return {
      ok: false,
      code: "REPORT_INCONSISTENT",
      message: cut(
        `the report's declared counts do not match its test cases (truncated or edited?): ${problems.slice(0, 5).join("; ")}`,
        1000,
      ),
    };
  const duplicates = [...seen]
    .filter(([, n]) => n > 1)
    .map(([k]) => k)
    .sort();
  return {
    ok: true,
    report: {
      format: "junit",
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
      cases,
      summary: {
        tests: total.tests,
        passed: total.tests - total.failed - total.errors - total.skipped,
        failed: total.failed,
        errors: total.errors,
        skipped: total.skipped,
      },
      duplicates,
    },
  };
}

// ---- the XML subset -------------------------------------------------------------------------

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(raw: string, where: string): string {
  return raw.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]+);|&/g, (m, ref: string | undefined) => {
    if (ref === undefined) throw new XmlError(`a bare "&" in ${where}`);
    if (ref[0] === "#") {
      const cp = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!(cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0x10ffff)))
        throw new XmlError(`character reference ${m} is not an XML character`);
      return String.fromCodePoint(cp);
    }
    const v = ENTITIES[ref];
    if (v === undefined) throw new XmlError(`unknown entity ${cut(m, 30)} in ${where} (no DTD is read)`);
    return v;
  });
}

function parseXml(src: string): El {
  let i = 0;
  let elements = 0;
  const stack: El[] = [];
  let root: El | null = null;
  const fail = (msg: string): never => {
    throw new XmlError(`${msg} (at character ${i})`);
  };
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const textEnd = lt === -1 ? src.length : lt;
    if (textEnd > i) {
      const raw = src.slice(i, textEnd);
      if (stack.length) stack[stack.length - 1]!.text += decode(raw, "text");
      else if (raw.trim()) fail("text outside the root element");
      i = textEnd;
      if (lt === -1) break;
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end === -1) fail("an unterminated comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end === -1) fail("an unterminated CDATA section");
      if (!stack.length) fail("CDATA outside the root element");
      stack[stack.length - 1]!.text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith("<!", i)) {
      fail("a DOCTYPE or other declaration; reports are read without a DTD");
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end === -1) fail("an unterminated processing instruction");
      const target = /^<\?([A-Za-z_][-A-Za-z0-9_.]*)/.exec(src.slice(i, i + 40))?.[1];
      if (target?.toLowerCase() === "xml" && (root || i > 1)) fail("an XML declaration after the start");
      i = end + 2;
    } else if (src.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(src);
      if (!m) fail("a malformed end tag");
      const name = m![0];
      i = NAME.lastIndex;
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== ">") fail(`a malformed end tag </${cut(name, 40)}>`);
      i++;
      const open = stack.pop();
      if (!open || open.name !== name)
        fail(`</${cut(name, 40)}> does not close ${open ? `<${cut(open.name, 40)}>` : "anything"}`);
    } else {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(src);
      if (!m) fail("a malformed start tag");
      const el: El = { name: m![0], attrs: new Map(), children: [], text: "" };
      i = NAME.lastIndex;
      for (;;) {
        const ws = i;
        while (/\s/.test(src[i] ?? "")) i++;
        if (src[i] === ">" || src.startsWith("/>", i)) break;
        if (i === ws) fail(`a malformed tag <${cut(el.name, 40)}>`);
        NAME.lastIndex = i;
        const a = NAME.exec(src);
        if (!a) fail(`a malformed attribute in <${cut(el.name, 40)}>`);
        i = NAME.lastIndex;
        while (/\s/.test(src[i] ?? "")) i++;
        if (src[i] !== "=") fail(`attribute ${cut(a![0], 40)} has no value`);
        i++;
        while (/\s/.test(src[i] ?? "")) i++;
        const q = src[i];
        if (q !== '"' && q !== "'") fail(`attribute ${cut(a![0], 40)} is not quoted`);
        const end = src.indexOf(q!, i + 1);
        if (end === -1) fail("an unterminated attribute value");
        const raw = src.slice(i + 1, end);
        if (raw.includes("<")) fail(`"<" in the value of ${cut(a![0], 40)}`);
        if (el.attrs.has(a![0])) fail(`attribute ${cut(a![0], 40)} repeated`);
        if (el.attrs.size >= JUNIT_LIMITS.attributes) fail(`more than ${JUNIT_LIMITS.attributes} attributes`);
        // Attribute-value normalization: literal whitespace becomes a space, character references stay.
        el.attrs.set(a![0], decode(raw.replace(/[\t\n\r]/g, " "), `attribute ${a![0]}`));
        i = end + 1;
      }
      if (++elements > JUNIT_LIMITS.elements) fail(`more than ${JUNIT_LIMITS.elements} elements`);
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(el);
      else if (root) fail("a second root element");
      else root = el;
      if (src.startsWith("/>", i)) i += 2;
      else {
        i++;
        stack.push(el);
        if (stack.length > JUNIT_LIMITS.depth) fail(`elements nested deeper than ${JUNIT_LIMITS.depth}`);
      }
    }
  }
  if (stack.length)
    throw new XmlError(`the report ends inside <${cut(stack[stack.length - 1]!.name, 40)}> (truncated?)`);
  if (!root) throw new XmlError("the report has no root element");
  return root;
}
