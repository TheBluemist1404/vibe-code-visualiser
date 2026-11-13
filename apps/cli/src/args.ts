// Command-line arguments, the host identity, and the user's input files.
//
// The CLI acts as the trusted host for a local single user: identity and permissions come
// from flags here, standing in for what a real session or OAuth token would supply.
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseYaml } from "@vcv/ir";
import { OPEN_READ, readUpTo } from "@vcv/core";
import { TEST_RUN_LIMITS, PROPOSAL_LIMITS, parseLocator } from "@vcv/repo";
import type { BindingHost, TrustSource } from "@vcv/repo";
import type { ClaimSource } from "@vcv/core";
import type { HostContext, Permission } from "@vcv/core";

export const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: "string" },
    perm: { type: "string" },
    object: { type: "string" },
    relation: { type: "string" },
    locator: { type: "string" },
    source: { type: "string" },
    id: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "string" },
    revision: { type: "string" },
    expect: { type: "string" },
    reason: { type: "string" },
    "allow-unchecked": { type: "boolean", default: false },
    tree: { type: "boolean", default: false },
    kind: { type: "string", multiple: true },
    limit: { type: "string" },
    depth: { type: "string" },
    direction: { type: "string" },
    json: { type: "boolean", default: false },
    cursor: { type: "string" },
    "expected-revision": { type: "string" },
    relations: { type: "string" },
    "selector-kinds": { type: "string" },
    states: { type: "string" },
    since: { type: "string" },
    request: { type: "string" },
    file: { type: "string" },
    digest: { type: "string" },
    key: { type: "string" },
    trust: { type: "string" },
    "trust-ref": { type: "string" },
    "trust-commit": { type: "string" },
    "trust-working-tree": { type: "boolean", default: false },
    base: { type: "string" },
    "require-attestation": { type: "boolean", default: false },
    add: { type: "string" },
    report: { type: "string" },
    junit: { type: "string" },
    root: { type: "string" },
    runner: { type: "string" },
    "runner-version": { type: "string" },
    invocation: { type: "string" },
    before: { type: "string" },
    out: { type: "string" },
    run: { type: "string", multiple: true },
    coverage: { type: "string" },
    policy: { type: "string" },
    "policy-at-base": { type: "string" },
    observations: { type: "string" },
  },
});
export const [cmd, a, b, ...rest] = positionals;
export const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
/** A host-fixed identity (env) cannot be widened from the command line. */
function hostContext(): HostContext {
  const fixedAs = process.env.VCV_HOST_PRINCIPAL;
  const fixedPerm = process.env.VCV_HOST_PERMISSIONS;
  if ((fixedAs !== undefined && values.as !== undefined) || (fixedPerm !== undefined && values.perm !== undefined)) {
    throw new InputError(
      "identity and permissions are fixed by this host (VCV_HOST_PRINCIPAL / VCV_HOST_PERMISSIONS); --as and --perm are not accepted",
    );
  }
  const perm = fixedPerm ?? values.perm ?? "propose,apply,approve,binding:record,binding:dispute,tests:observe";
  return {
    principalId: fixedAs ?? values.as ?? "local-user",
    permissions: perm
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (p.includes(":") ? p : `model:${p}`) as Permission),
  };
}
let hostCache: HostContext | undefined;
/** The host context, read once (the first call can throw InputError, inside the CLI's try). */
export function host(): HostContext {
  hostCache ??= hostContext();
  return hostCache;
}

export function bindingHost(): BindingHost {
  const source = values.source;
  if (source !== "agent" && source !== "human" && source !== "tool")
    throw new InputError("--source agent|human|tool is required: say who makes this claim");
  return { ...host(), source: source as ClaimSource };
}
export function need(v: string | undefined, flag: string): string {
  if (!v) throw new InputError(`${flag} is required`);
  return v;
}
export function locatorArg(): ReturnType<typeof parseLocator> {
  try {
    return parseLocator(need(values.locator, "--locator"));
  } catch (e) {
    throw new InputError(`--locator: ${(e as Error).message}`);
  }
}

/** An input file the user named that cannot be read: reported as a diagnostic, not a stack trace. */
export class InputError extends Error {}
export function readInput(path: string | undefined): string {
  if (!path) throw new InputError("a file argument is missing");
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new InputError(
      `cannot read ${path}${code === "ENOENT" ? ": no such file" : code === "EISDIR" ? ": is a directory" : code ? ` (${code})` : ""}`,
    );
  }
}

/** A proposal file: YAML or JSON, bounded before parsing. */
export function readProposalFile(path: string | undefined): unknown {
  const text = readInput(path);
  if (Buffer.byteLength(text) > 4 * PROPOSAL_LIMITS.maxBytes)
    throw new InputError(`${path} is larger than ${4 * PROPOSAL_LIMITS.maxBytes} bytes; split the change`);
  try {
    return parseYaml(text);
  } catch (e) {
    throw new InputError(`${path} is not valid YAML or JSON: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Read at most `limit` bytes of a regular file, refusing a larger one before reading it. */
export function readBounded(file: string, limit: number): Buffer {
  let fd: number;
  try {
    // Nonblocking, so a FIFO or device is refused by its type below instead of blocking the open.
    fd = openSync(file, OPEN_READ);
  } catch (e) {
    throw new InputError(`cannot read ${file}: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new InputError(`${file} is not a regular file`);
    if (st.size > limit) throw new InputError(`${file} is ${st.size} bytes, more than the ${limit} read`);
    const read = readUpTo(fd, limit);
    if (read.length > limit) throw new InputError(`${file} grew past ${limit} bytes while it was read`);
    return read;
  } finally {
    closeSync(fd);
  }
}

export function readJson(file: string, what: string): unknown {
  const buf = readBounded(file, TEST_RUN_LIMITS.recordBytes);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new InputError(`${file} is not a valid ${what}: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Total line coverage from an Istanbul `json-summary` (coverage-summary.json). Supporting context only. */
export function readCoverage(file: string): { linesPct: number; source: string } {
  const pct = (readJson(file, "coverage summary") as { total?: { lines?: { pct?: unknown } } })?.total?.lines?.pct;
  if (typeof pct !== "number" || !(pct >= 0 && pct <= 100))
    throw new InputError(`${file} has no total.lines.pct (an Istanbul json-summary is expected)`);
  return { linesPct: pct, source: "istanbul json-summary" };
}

export function captureInput() {
  return {
    root: values.root ?? "",
    runner: {
      name: need(values.runner, "--runner"),
      ...(values["runner-version"] ? { version: values["runner-version"] } : {}),
    },
    invocation: need(values.invocation, "--invocation"),
    ...(values.before ? { before: values.before } : {}),
  };
}

/** Review commands take no identity from flags or the environment: the key and trust list decide. */
export function refuseAssertedIdentity(what: string) {
  if (
    values.as !== undefined ||
    values.perm !== undefined ||
    process.env.VCV_HOST_PRINCIPAL !== undefined ||
    process.env.VCV_HOST_PERMISSIONS !== undefined
  ) {
    throw new InputError(
      `${what} takes no --as/--perm and refuses to run under VCV_HOST_PRINCIPAL/VCV_HOST_PERMISSIONS (an agent host); the reviewer's identity comes from --key and the trust list`,
    );
  }
}

export function trustSource(defaultRef: string | null): TrustSource | undefined {
  const pinned = values["trust-commit"];
  const given = [
    values.trust !== undefined,
    values["trust-ref"] !== undefined || pinned !== undefined,
    values["trust-working-tree"],
  ].filter(Boolean).length;
  if (given > 1) throw new InputError("pass one of --trust <file>, --trust-ref <ref> or --trust-working-tree");
  if (values.trust !== undefined) return { kind: "file", path: values.trust };
  if (pinned !== undefined) return { kind: "git-ref", ref: values["trust-ref"] ?? pinned, pinnedCommit: pinned };
  if (values["trust-ref"] !== undefined) return { kind: "git-ref", ref: values["trust-ref"] };
  if (values["trust-working-tree"]) return { kind: "working-tree" };
  return defaultRef ? { kind: "git-ref", ref: defaultRef } : undefined;
}
