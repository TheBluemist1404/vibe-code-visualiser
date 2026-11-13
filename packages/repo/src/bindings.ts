// Binding claims in a repository project (Issue #13, ADR 0007 §5).
//
// A claim says "this source artifact implements/exposes/persists/tests that model object". It is
// stored as one Git-tracked file, `.vcv/bindings/<bindingId>.json`, and Git is its only history:
// there is no binding revision counter, and recording a claim never touches `.vcv/HEAD` or the
// model revisions. VCV checks the claim's shape, that the model object and revision exist, that
// the path stays inside the checkout, and that the locator resolves to exactly one artifact. It
// does not check what the code means; verification says so in every result.
//
// Writes are checkout-safe in the same way as model writes (ADR 0007 §2): each operation takes one
// snapshot (store fingerprint, Git commit, the claim on disk), validates against it, and re-checks
// it immediately before the write. The caller also names the claim it expects to replace (by
// digest, or null for "there is none"), so a claim read on one branch can never overwrite a
// different same-ID claim after `git checkout`.
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { buildIndex, loadModel, persistedIdProblem } from "@vcv/ir";
import type { Id, Model } from "@vcv/ir";
import {
  BINDING_RELATIONS,
  HTTP_METHODS,
  SYMBOL_DECLARATIONS,
  canonicalJson,
  durableWrite,
  STORE_FILE_LIMITS,
  readHeadRevision,
  readStoreFile,
  storeFingerprint,
  sha256Hex,
  digestOf,
  OPEN_READ_NOFOLLOW,
  readUpTo,
} from "@vcv/core";
import type { BindingClaim, BindingRelation, BindingState, ClaimSource, Permission, SourceLocator } from "@vcv/core";
import { fileWorkingState, headCommit } from "./git.ts";
import { pathProblem, resolveInside, selectorProblem } from "./locator.ts";
import { fileFingerprintAt, resolveLocator } from "./resolver.ts";
import type { Resolution } from "./resolver.ts";
import { VCV_DIR, projectStatus, resolveProjectRoot } from "./project.ts";
import type { ProjectStatus } from "./project.ts";

export const BINDINGS_DIR = "bindings";
/** Recorded in each claim; a claim fingerprinted with another algorithm is compared as "unknown". */
export const FINGERPRINT_ALGORITHM = "vcv-fp-1";

/** Supplied by the trusted host (CLI flags, a session), never by the claim payload. */
export type BindingHost = { principalId: string; permissions: readonly Permission[]; source: ClaimSource };

export type BindingErrorCode =
  | "NOT_AUTHORIZED"
  /** The project is not `ready` (absent, conflicted, diverged, invalid): nothing is written. */
  | "PROJECT_NOT_READY"
  | "INVALID_CLAIM"
  | "UNKNOWN_OBJECT"
  | "UNKNOWN_REVISION"
  /** Absolute, "..", backslash, excluded directory, or a symlink out of the checkout. */
  | "UNSAFE_PATH"
  | "LOCATOR_MISSING"
  | "LOCATOR_AMBIGUOUS"
  /** The resolver cannot check this selector; refused unless the caller allows unchecked claims. */
  | "LOCATOR_UNCHECKED"
  /** A create found a claim with this ID already on disk. */
  | "BINDING_EXISTS"
  | "NOT_FOUND"
  /** The claim on disk is not the one the caller read (another branch's, or edited since). */
  | "BINDING_CHANGED"
  /** The model store, Git commit or source changed during the operation (e.g. a checkout). */
  | "STATE_CHANGED";

export class BindingError extends Error {
  readonly code: BindingErrorCode;
  constructor(code: BindingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "BindingError";
  }
}

/** A claim file as found on disk. `digest` is what a later write passes as `expected`. */
export type ClaimEntry = {
  bindingId: string;
  /** Repository-relative path of the claim file. */
  file: string;
  /** sha256 of the file's bytes. */
  digest: string;
  claim: BindingClaim | null;
  /** Why `claim` is null: conflict markers, bad JSON, wrong shape, or an ID that does not match the file name. */
  problem?: string;
};

// --- claim file format ------------------------------------------------------------------

const selectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file") }).strict(),
  z
    .object({ kind: z.literal("symbol"), name: z.string(), declaration: z.enum(SYMBOL_DECLARATIONS).optional() })
    .strict(),
  z
    .object({
      kind: z.literal("route"),
      method: z.enum(HTTP_METHODS),
      route: z.string(),
      handler: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("test"), name: z.string() }).strict(),
]);
const locatorSchema = z.object({ path: z.string(), selector: selectorSchema }).strict();
const claimSchema = z
  .object({
    format: z.literal(1),
    bindingId: z.string(),
    modelObjectId: z.string().min(1),
    relation: z.enum(BINDING_RELATIONS),
    locator: locatorSchema,
    provenance: z
      .object({
        source: z.enum(["agent", "human", "tool"]),
        principalId: z.string().min(1),
        rationale: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
      })
      .strict(),
    modelRevision: z.string().min(1),
    observed: z
      .object({
        commit: z.string().nullable(),
        workingTree: z.enum(["clean", "modified", "untracked", "no-git"]),
        fingerprint: z.object({ algorithm: z.string(), file: z.string(), selector: z.string().optional() }).strict(),
      })
      .strict(),
    disputed: z.object({ by: z.string(), reason: z.string() }).strict().optional(),
  })
  .strict();

/** Check a parsed claim beyond its JSON shape: ID grammar and portable path rules. */
function claimProblem(c: z.infer<typeof claimSchema>): string | undefined {
  const idp = persistedIdProblem(c.bindingId);
  if (idp) return `bindingId "${c.bindingId}" ${idp}`;
  const pp = pathProblem(c.locator.path);
  if (pp) return `locator path "${c.locator.path}" ${pp}`;
  return selectorProblem(c.locator.selector);
}

/** Serialize with a fixed key order, so the same claim is always the same bytes (no false Git conflicts). */
export function serializeClaim(c: BindingClaim): string {
  const sel = c.locator.selector;
  const selector =
    sel.kind === "file"
      ? { kind: sel.kind }
      : sel.kind === "symbol"
        ? { kind: sel.kind, name: sel.name, declaration: sel.declaration }
        : sel.kind === "route"
          ? { kind: sel.kind, method: sel.method, route: sel.route, handler: sel.handler }
          : { kind: sel.kind, name: sel.name };
  const p = c.provenance;
  const o = c.observed;
  const ordered = {
    format: c.format,
    bindingId: c.bindingId,
    modelObjectId: c.modelObjectId,
    relation: c.relation,
    locator: { path: c.locator.path, selector },
    provenance: { source: p.source, principalId: p.principalId, rationale: p.rationale, confidence: p.confidence },
    modelRevision: c.modelRevision,
    observed: {
      commit: o.commit,
      workingTree: o.workingTree,
      fingerprint: { algorithm: o.fingerprint.algorithm, file: o.fingerprint.file, selector: o.fingerprint.selector },
    },
    disputed: c.disputed ? { by: c.disputed.by, reason: c.disputed.reason } : undefined,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`; // undefined members are omitted
}

function parseClaimFile(id: string, bytes: Buffer): Pick<ClaimEntry, "claim" | "problem"> {
  const text = bytes.toString("utf8");
  if (/^(<{7}|>{7})(\s|$)/m.test(text)) return { claim: null, problem: "unresolved Git conflict markers" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { claim: null, problem: "not valid JSON" };
  }
  const parsed = claimSchema.safeParse(json);
  if (!parsed.success)
    return {
      claim: null,
      problem: `not a format-1 claim: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    };
  const problem = claimProblem(parsed.data);
  if (problem) return { claim: null, problem };
  if (parsed.data.bindingId !== id)
    return { claim: null, problem: `file is named ${id}.json but holds claim ${parsed.data.bindingId}` };
  return { claim: parsed.data as BindingClaim };
}

// --- reading --------------------------------------------------------------------------

const bindingsDir = (root: string) => join(root, VCV_DIR, BINDINGS_DIR);
const claimPath = (root: string, id: string) => join(bindingsDir(root), `${id}.json`);
const claimRel = (id: string) => `${VCV_DIR}/${BINDINGS_DIR}/${id}.json`;

/** Longest test identity (`Suite > case`) a new claim may record. */
export const MAX_TEST_NAME_CHARS = 1000;

/** Largest claim file VCV reads. Real claims are well under 2 KB. */
export const MAX_CLAIM_BYTES = 64 * 1024;

/** A claim file as found on disk, without following anything out of the checkout. */
type ClaimFile =
  | { kind: "absent" }
  | { kind: "file"; bytes: Buffer; digest: string }
  /** Not read: a symlink, directory, special file, oversized or unreadable entry. `digest` is a stable token for --expect. */
  | {
      kind: "unsafe";
      what: "symlink" | "directory" | "special" | "oversize" | "unreadable";
      problem: string;
      digest: string;
    };

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * The bindings directory must be a plain directory inside the checkout, and so must `.vcv/`:
 * claims are never read or written through a symlink. Returns false when bindings/ is absent.
 */
function checkBindingsDir(root: string): boolean {
  for (const [p, label] of [
    [join(root, VCV_DIR), `${VCV_DIR}/`],
    [bindingsDir(root), `${VCV_DIR}/${BINDINGS_DIR}/`],
  ] as const) {
    const st = lstatOrNull(p);
    if (!st) return false;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new BindingError(
        "UNSAFE_PATH",
        `${label} is ${st.isSymbolicLink() ? "a symlink" : "not a directory"}; binding claims are only read from and written to a plain directory inside the checkout`,
      );
    }
  }
  return true;
}

const unsafeFile = (id: string, what: Extract<ClaimFile, { kind: "unsafe" }>["what"], detail: string): ClaimFile => ({
  kind: "unsafe",
  what,
  problem: `${claimRel(id)} ${detail}; it was not read`,
  digest: `unsafe:${what}`,
});

/**
 * Read one claim file: only a regular, non-symlink file of at most MAX_CLAIM_BYTES, opened with
 * O_NOFOLLOW (where the OS has it) and checked again on the open descriptor, so a swap after
 * the lstat cannot redirect the read.
 */
function readClaimFile(root: string, id: string): ClaimFile {
  if (!checkBindingsDir(root)) return { kind: "absent" };
  const p = claimPath(root, id);
  const st = lstatOrNull(p);
  if (!st) return { kind: "absent" };
  if (st.isSymbolicLink()) return unsafeFile(id, "symlink", "is a symlink, which is never followed");
  if (st.isDirectory()) return unsafeFile(id, "directory", "is a directory, not a claim file");
  if (!st.isFile()) return unsafeFile(id, "special", "is not a regular file");
  if (st.size > MAX_CLAIM_BYTES) return unsafeFile(id, "oversize", `is larger than ${MAX_CLAIM_BYTES} bytes`);
  let fd: number;
  try {
    fd = openSync(p, OPEN_READ_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP") return unsafeFile(id, "symlink", "is a symlink, which is never followed");
    return unsafeFile(id, "unreadable", `cannot be opened (${code})`);
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return unsafeFile(id, "special", "is not a regular file");
    const bytes = readUpTo(fd, MAX_CLAIM_BYTES);
    if (bytes.length > MAX_CLAIM_BYTES) return unsafeFile(id, "oversize", `is larger than ${MAX_CLAIM_BYTES} bytes`);
    return { kind: "file", bytes, digest: sha256Hex(bytes) };
  } finally {
    closeSync(fd);
  }
}

function entryFor(id: string, f: Exclude<ClaimFile, { kind: "absent" }>): ClaimEntry {
  const base = { bindingId: id, file: claimRel(id), digest: f.digest };
  return f.kind === "file" ? { ...base, ...parseClaimFile(id, f.bytes) } : { ...base, claim: null, problem: f.problem };
}

/**
 * The claim with this ID in the checkout containing `path`, or null if there is none. Read-only.
 * Throws UNSAFE_PATH if `.vcv/` or `.vcv/bindings/` is a symlink or not a directory.
 */
export function readBinding(path: string, bindingId: string): ClaimEntry | null {
  const idp = persistedIdProblem(bindingId);
  if (idp) throw new BindingError("INVALID_CLAIM", `bindingId "${bindingId}" ${idp}`);
  const { root } = resolveProjectRoot(path);
  const f = readClaimFile(root, bindingId);
  return f.kind === "absent" ? null : entryFor(bindingId, f);
}

/**
 * Every `*.json` entry in `.vcv/bindings/`, sorted by ID. Entries that are not readable claims
 * (including symlinks, directories and oversized files, which are not followed or read) are
 * listed with a problem, never skipped. Read-only. Throws UNSAFE_PATH for a symlinked directory.
 */
export function listBindings(path: string): ClaimEntry[] {
  const { root } = resolveProjectRoot(path);
  if (!checkBindingsDir(root)) return [];
  return readdirSync(bindingsDir(root))
    .filter((f) => f.endsWith(".json") && !f.includes(".tmp-"))
    .sort()
    .map((f) => {
      const id = f.slice(0, -".json".length);
      if (persistedIdProblem(id))
        return {
          bindingId: id,
          file: claimRel(id),
          digest: "unsafe:name",
          claim: null,
          problem: `file name ${f} is not a valid binding ID`,
        };
      const c = readClaimFile(root, id);
      return c.kind === "absent" ? null : entryFor(id, c);
    })
    .filter((e): e is ClaimEntry => e !== null);
}

// --- the guarded write ----------------------------------------------------------------

type Snapshot = {
  root: string;
  storeDir: string;
  model: Model;
  history: string[];
  storeToken: string;
  commit: string | null;
  claim: ClaimFile;
  claimDigest: string | null;
};

/** One coherent view of the project for one operation, or a refusal. */
function takeSnapshot(path: string, bindingId: string): Snapshot {
  const status = projectStatus(path);
  if (status.state !== "ready" || !status.model) {
    throw new BindingError(
      "PROJECT_NOT_READY",
      `project is ${status.state}; binding claims are only written to a ready project (${status.diagnostics.map((d) => d.message).join("; ")})`,
    );
  }
  const storeDir = status.storeDir;
  const storeToken = storeFingerprint(storeDir);
  const model = readHeadRevision(storeDir);
  const history = status.model.history;
  // The store must not have moved between the status checks and the model read.
  if (storeFingerprint(storeDir) !== storeToken || model.project.modelRevision !== status.model.revision) {
    throw new BindingError(
      "STATE_CHANGED",
      "the model store changed while it was being read; nothing was written. Retry.",
    );
  }
  const claim = readClaimFile(status.root, bindingId); // refuses a symlinked .vcv/ or bindings/ before anything is read
  return {
    root: status.root,
    storeDir,
    model,
    history,
    storeToken,
    commit: status.git?.commit ?? null,
    claim,
    claimDigest: claim.kind === "absent" ? null : claim.digest,
  };
}

/** The claim on disk must be exactly the one the caller decided on: `null` means "none". */
function checkExpected(snap: Snapshot, bindingId: string, expected: string | null, creating: boolean): void {
  if (snap.claimDigest === expected) return;
  if (expected === null) {
    throw new BindingError(
      creating ? "BINDING_EXISTS" : "BINDING_CHANGED",
      `binding ${bindingId} already exists on disk (${claimRel(bindingId)}, digest ${snap.claimDigest!.slice(0, 12)}); it may belong to another branch. Read it and reassert it with --expect instead; nothing was written`,
    );
  }
  if (snap.claimDigest === null)
    throw new BindingError(
      "NOT_FOUND",
      `binding ${bindingId} does not exist in this checkout (another branch?); nothing was written`,
    );
  throw new BindingError(
    "BINDING_CHANGED",
    `binding ${bindingId} on disk (digest ${snap.claimDigest.slice(0, 12)}) is not the claim you read (digest ${expected.slice(0, 12)}); it changed or belongs to another branch. Nothing was written`,
  );
}

export type WriteHooks = {
  /** Test hook: runs after validation, immediately before the pre-write re-check. */
  beforeWrite?: () => void;
};

/**
 * Re-check the snapshot right before writing: same store state, same Git commit, same claim on
 * disk, and (for a record) the same source bytes as were fingerprinted. Then write or delete.
 * This is check-then-rename, like the model store: a checkout landing inside the rename itself
 * is not prevented.
 */
function commitWrite(
  snap: Snapshot,
  bindingId: string,
  content: string | null,
  source?: { rel: string; fingerprint: string },
  hooks?: WriteHooks,
): void {
  hooks?.beforeWrite?.();
  const now = readClaimFile(snap.root, bindingId);
  const moved =
    storeFingerprint(snap.storeDir) !== snap.storeToken
      ? "the model store"
      : headCommit(snap.root) !== snap.commit
        ? "the Git commit"
        : (now.kind === "absent" ? null : now.digest) !== snap.claimDigest
          ? `binding ${bindingId}`
          : source && currentFileFingerprint(snap.root, source.rel) !== source.fingerprint
            ? `source file ${source.rel}`
            : null;
  if (moved)
    throw new BindingError(
      "STATE_CHANGED",
      `${moved} changed during this operation (Git checkout, pull or another writer); nothing was written. Re-read and retry.`,
    );
  // readClaimFile above re-checked that .vcv/ and bindings/ are plain directories. A symlinked
  // claim entry is replaced or removed as a link (never followed); a directory or special file
  // under a claim's name is left for a person.
  if (now.kind === "unsafe" && (now.what === "directory" || now.what === "special")) {
    throw new BindingError("UNSAFE_PATH", `${now.problem}; remove it by hand. Nothing was written`);
  }
  if (content === null) rmSync(claimPath(snap.root, bindingId));
  else {
    mkdirSync(bindingsDir(snap.root), { recursive: true });
    checkBindingsDir(snap.root); // in case a symlink appeared where the directory was just created
    durableWrite(claimPath(snap.root, bindingId), content);
  }
}

function currentFileFingerprint(root: string, rel: string): string | null {
  const where = resolveInside(root, rel);
  return where.ok ? fileFingerprintAt(where.abs) : null;
}

function requirePermission(host: BindingHost, p: Permission, what: string) {
  if (!host.permissions.includes(p))
    throw new BindingError("NOT_AUTHORIZED", `${host.principalId} may not ${what} (needs ${p})`);
}

// --- operations -----------------------------------------------------------------------

export type RecordInput = {
  /** Omit to mint one from object, relation and locator. Kept for the life of the claim. */
  bindingId?: string;
  modelObjectId: Id;
  relation: BindingRelation;
  locator: SourceLocator;
  rationale?: string;
  confidence?: number;
  /** The revision the claim was made against. Default: the current revision. Must be in HEAD's history. */
  modelRevision?: string;
  /** Store a claim whose selector the resolver cannot check (verification then reports `unchecked`). */
  allowUnchecked?: boolean;
};

export type RecordResult = { entry: ClaimEntry; resolution: Resolution; created: boolean };

/** A deterministic default ID: same claim on two branches → same ID and same bytes. */
export function defaultBindingId(objectId: Id, relation: BindingRelation, locator: SourceLocator): string {
  const slug = objectId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 80)
    .replace(/[.-]+$/, "");
  const hash = digestOf(locator).slice(0, 8);
  return `${relation}.${slug || "object"}.${hash}`;
}

/**
 * Create (`expected` null) or reassert (`expected` = the digest of the claim being replaced) a
 * binding claim. Refused, with nothing written, unless the locator resolves to exactly one
 * artifact now (or the caller explicitly allows an unchecked claim). Never touches `.vcv/HEAD`.
 */
export function recordBinding(
  path: string,
  input: RecordInput,
  host: BindingHost,
  expected: string | null,
  hooks?: WriteHooks,
): RecordResult {
  requirePermission(host, "binding:record", "record binding claims");
  if (!(BINDING_RELATIONS as readonly string[]).includes(input.relation))
    throw new BindingError(
      "INVALID_CLAIM",
      `relation "${input.relation}" is not one of ${BINDING_RELATIONS.join(", ")}`,
    );
  if (input.confidence !== undefined && !(input.confidence >= 0 && input.confidence <= 1))
    throw new BindingError("INVALID_CLAIM", "confidence must be between 0 and 1");
  const locShape = locatorSchema.safeParse(input.locator);
  if (!locShape.success)
    throw new BindingError(
      "INVALID_CLAIM",
      `malformed locator: ${locShape.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  const pp = pathProblem(input.locator.path);
  if (pp) throw new BindingError("UNSAFE_PATH", `locator path "${input.locator.path}" ${pp}`);
  const sp = selectorProblem(input.locator.selector);
  if (sp) throw new BindingError("INVALID_CLAIM", sp);
  // New claims carry portable, bounded test identities (claims already on disk are read as they are).
  if (input.locator.selector.kind === "test" && input.locator.selector.name.length > MAX_TEST_NAME_CHARS) {
    throw new BindingError("INVALID_CLAIM", `test name is longer than ${MAX_TEST_NAME_CHARS} characters`);
  }
  const bindingId = input.bindingId ?? defaultBindingId(input.modelObjectId, input.relation, input.locator);
  const idp = persistedIdProblem(bindingId);
  if (idp) throw new BindingError("INVALID_CLAIM", `bindingId "${bindingId}" ${idp}`);

  const snap = takeSnapshot(path, bindingId);
  checkExpected(snap, bindingId, expected, expected === null);

  // The object and the revision must exist in the validated project state.
  if (!buildIndex(snap.model).byId.has(input.modelObjectId)) {
    throw new BindingError(
      "UNKNOWN_OBJECT",
      `model object ${input.modelObjectId} does not exist at the current revision ${snap.model.project.modelRevision}`,
    );
  }
  // An acceptance criterion (M4.2) is checked by test cases: its only claims are `tests` claims
  // that name one individual test (file + full title), never a file, a suite or a symbol.
  if (
    buildIndex(snap.model).byId.get(input.modelObjectId)!.kind === "criterion" &&
    (input.relation !== "tests" || input.locator.selector.kind !== "test")
  ) {
    throw new BindingError(
      "INVALID_CLAIM",
      `criterion ${input.modelObjectId} can only be mapped to individual test cases: use --relation tests and a <file>#test:<Suite > case> locator`,
    );
  }
  const modelRevision = input.modelRevision ?? snap.model.project.modelRevision;
  if (!snap.history.includes(modelRevision))
    throw new BindingError("UNKNOWN_REVISION", `revision ${modelRevision} is not in this checkout's model history`);
  const atRevision =
    modelRevision === snap.model.project.modelRevision ? snap.model : readRevision(snap.storeDir, modelRevision);
  if (!atRevision || !buildIndex(atRevision).byId.has(input.modelObjectId)) {
    throw new BindingError(
      "UNKNOWN_OBJECT",
      `model object ${input.modelObjectId} does not exist at revision ${modelRevision}`,
    );
  }

  const resolution = resolveLocator(snap.root, input.locator);
  if (resolution.pathIssue === "unsafe") throw new BindingError("UNSAFE_PATH", resolution.detail);
  if (resolution.state === "missing")
    throw new BindingError("LOCATOR_MISSING", `${resolution.detail}; a claim must point at something that exists`);
  if (resolution.state === "ambiguous")
    throw new BindingError(
      "LOCATOR_AMBIGUOUS",
      `${resolution.detail}; add a declaration kind or a handler to the selector`,
    );
  if (resolution.state === "unchecked" && !input.allowUnchecked) {
    throw new BindingError(
      "LOCATOR_UNCHECKED",
      `${resolution.detail}. Use a file selector, or record it explicitly as unchecked`,
    );
  }

  const claim: BindingClaim = {
    format: 1,
    bindingId,
    modelObjectId: input.modelObjectId,
    relation: input.relation,
    locator: input.locator,
    provenance: {
      source: host.source,
      principalId: host.principalId,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    },
    modelRevision,
    observed: {
      commit: snap.commit,
      workingTree: fileWorkingState(snap.root, input.locator.path),
      fingerprint: {
        algorithm: FINGERPRINT_ALGORITHM,
        file: resolution.fileFingerprint!,
        ...(resolution.selectorFingerprint ? { selector: resolution.selectorFingerprint } : {}),
      },
    },
  };
  const content = serializeClaim(claim);
  commitWrite(snap, bindingId, content, { rel: input.locator.path, fingerprint: resolution.fileFingerprint! }, hooks);
  return {
    entry: { bindingId, file: claimRel(bindingId), digest: sha256Hex(Buffer.from(content)), claim },
    resolution,
    created: expected === null,
  };
}

/** Delete a claim. `expected` is the digest of the claim the caller read. */
export function removeBinding(
  path: string,
  bindingId: string,
  host: BindingHost,
  expected: string,
  hooks?: WriteHooks,
): void {
  requirePermission(host, "binding:record", "remove binding claims");
  const idp = persistedIdProblem(bindingId);
  if (idp) throw new BindingError("INVALID_CLAIM", `bindingId "${bindingId}" ${idp}`);
  const snap = takeSnapshot(path, bindingId);
  checkExpected(snap, bindingId, expected, false);
  commitWrite(snap, bindingId, null, undefined, hooks);
}

/**
 * Record that a principal disputes a claim. The claim stays (Git keeps who said what); its
 * verification shows the dispute verbatim. Reasserting the claim clears it.
 */
export function disputeBinding(
  path: string,
  bindingId: string,
  reason: string,
  host: BindingHost,
  expected: string,
  hooks?: WriteHooks,
): ClaimEntry {
  requirePermission(host, "binding:dispute", "dispute binding claims");
  if (!reason.trim()) throw new BindingError("INVALID_CLAIM", "a dispute needs a reason");
  const idp = persistedIdProblem(bindingId);
  if (idp) throw new BindingError("INVALID_CLAIM", `bindingId "${bindingId}" ${idp}`);
  const snap = takeSnapshot(path, bindingId);
  checkExpected(snap, bindingId, expected, false);
  if (snap.claim.kind !== "file")
    throw new BindingError(
      "INVALID_CLAIM",
      `binding ${bindingId} cannot be disputed: ${snap.claim.kind === "unsafe" ? snap.claim.problem : "it does not exist"}`,
    );
  const current = parseClaimFile(bindingId, snap.claim.bytes);
  if (!current.claim)
    throw new BindingError("INVALID_CLAIM", `binding ${bindingId} cannot be disputed: ${current.problem}`);
  const claim: BindingClaim = { ...current.claim, disputed: { by: host.principalId, reason } };
  const content = serializeClaim(claim);
  commitWrite(snap, bindingId, content, undefined, hooks);
  return { bindingId, file: claimRel(bindingId), digest: sha256Hex(Buffer.from(content)), claim };
}

// --- verification ---------------------------------------------------------------------

export type SourceFreshness = {
  /** Compared with the fingerprint recorded in the claim: the selected artifact (or the file, for file selectors). */
  state: "unchanged" | "changed" | "unknown";
  cause: string;
  /** Whether the file's bytes differ from the recorded file fingerprint, which alone is not drift. */
  fileChanged: boolean | null;
};

export type ModelFreshness = {
  state: "unchanged" | "changed" | "removed" | "unknown";
  cause: string;
};

export type Verification = {
  bindingId: string;
  /** The claim exactly as stored, including who made it. Interpretation, not fact. */
  claim: BindingClaim | null;
  /** Derived; never stored. `invalid`: the claim file itself is unreadable. */
  state: BindingState | "invalid";
  problem?: string;
  locator: { state: Resolution["state"]; detail: string; matches: Resolution["matches"] } | null;
  source: SourceFreshness | null;
  model: ModelFreshness | null;
  /** Observation context only; a moved commit is never evidence of drift by itself. */
  git: { commitMoved: boolean | null; workingTree: "clean" | "modified" | "untracked" | "no-git" | null };
  disputed: { by: string; reason: string } | null;
  /** Constant: VCV never checks that the code does what the claim says. */
  meaning: "unverified";
  /** Constant: verification never approves anything; approvals go through the model engine. */
  approved: false;
};

/**
 * Recompute a claim's state against the working tree and the model. Read-only. Pass `status`
 * (from projectStatus) to verify several claims against one observation of the project.
 */
/**
 * Per-read memo for verifying many claims in one observation: the HEAD model, revision models and
 * their indexes, Git working-tree states and locator resolutions are computed once. Only for one
 * read whose inputs are rechecked before answering (a guard); never kept across reads.
 */
export type VerifyMemo = {
  head?: Model;
  revisions: Map<string, Model | undefined>;
  indexes: WeakMap<Model, ReturnType<typeof buildIndex>>;
  working: Map<string, ReturnType<typeof fileWorkingState>>;
  resolutions: Map<string, Resolution>;
};
export const verifyMemo = (): VerifyMemo => ({
  revisions: new Map(),
  indexes: new WeakMap(),
  working: new Map(),
  resolutions: new Map(),
});

export function verifyBinding(
  path: string,
  entry: ClaimEntry,
  status: ProjectStatus = projectStatus(path),
  memo?: VerifyMemo,
): Verification {
  const base = { bindingId: entry.bindingId, meaning: "unverified" as const, approved: false as const };
  const c = entry.claim;
  if (!c) {
    return {
      ...base,
      claim: null,
      state: "invalid",
      problem: entry.problem,
      locator: null,
      source: null,
      model: null,
      git: { commitMoved: null, workingTree: null },
      disputed: null,
    };
  }
  const once = <K, V>(m: Map<K, V> | undefined, k: K, f: () => V): V => {
    if (!m) return f();
    if (!m.has(k)) m.set(k, f());
    return m.get(k)!;
  };
  const resolution = once(memo?.resolutions, canonicalJson(c.locator), () => resolveLocator(status.root, c.locator));
  const source = sourceFreshness(c, resolution);
  const model =
    status.state === "ready" && status.model
      ? modelFreshness(status.storeDir, status.model.history, c, memo)
      : { state: "unknown" as const, cause: `project is ${status.state}` };
  // resolved needs complete evidence: a unique locator AND both axes known unchanged. Known
  // change wins (stale); anything still unknown is indeterminate, never a pass.
  const state: BindingState =
    resolution.state !== "resolved"
      ? resolution.state
      : source.state === "changed" || model.state === "changed" || model.state === "removed"
        ? "stale"
        : source.state === "unchanged" && model.state === "unchanged"
          ? "resolved"
          : "indeterminate";
  const workingTree = resolution.fileFingerprint
    ? once(memo?.working, c.locator.path, () => fileWorkingState(status.root, c.locator.path))
    : null;
  return {
    ...base,
    claim: c,
    state,
    locator: { state: resolution.state, detail: resolution.detail, matches: resolution.matches },
    source,
    model,
    git: { commitMoved: status.git ? (status.git.commit ?? null) !== c.observed.commit : null, workingTree },
    disputed: c.disputed ?? null,
  };
}

/** verifyBinding for every claim in the checkout. Read-only. */
export function verifyBindings(path: string): Verification[] {
  const status = projectStatus(path);
  return listBindings(path).map((e) => verifyBinding(path, e, status));
}

function sourceFreshness(c: BindingClaim, r: Resolution): SourceFreshness {
  const fp = c.observed.fingerprint;
  const fileChanged = r.fileFingerprint === null ? null : r.fileFingerprint !== fp.file;
  if (fp.algorithm !== FINGERPRINT_ALGORITHM)
    return {
      state: "unknown",
      cause: `claim was fingerprinted with ${fp.algorithm}, this VCV uses ${FINGERPRINT_ALGORITHM}`,
      fileChanged,
    };
  if (r.state !== "resolved") return { state: "unknown", cause: `locator is ${r.state}`, fileChanged };
  if (c.locator.selector.kind === "file") {
    return fileChanged
      ? { state: "changed", cause: "file content differs from the recorded fingerprint", fileChanged }
      : { state: "unchanged", cause: "file content matches the recorded fingerprint", fileChanged };
  }
  if (!fp.selector)
    return {
      state: "unknown",
      cause: "the claim was recorded without a selector fingerprint (unchecked when recorded)",
      fileChanged,
    };
  if (r.selectorFingerprint !== fp.selector)
    return {
      state: "changed",
      cause: "the selected declaration's code differs from the recorded fingerprint",
      fileChanged,
    };
  return {
    state: "unchanged",
    cause: fileChanged
      ? "the selected declaration is unchanged; other parts of the file changed, which is not evidence about this claim"
      : "the selected declaration matches the recorded fingerprint",
    fileChanged,
  };
}

/** Does the bound object's definition differ between the claim's revision and the current one? */
function modelFreshness(
  storeDir: string,
  history: readonly string[],
  c: BindingClaim,
  memo?: VerifyMemo,
): ModelFreshness {
  const current = memo ? (memo.head ??= readHeadRevision(storeDir)) : readHeadRevision(storeDir);
  const now = objectJson(current, c.modelObjectId, memo);
  if (now === undefined)
    return {
      state: "removed",
      cause: `${c.modelObjectId} does not exist at the current revision ${current.project.modelRevision}`,
    };
  if (c.modelRevision === current.project.modelRevision)
    return { state: "unchanged", cause: `claim was made against the current revision ${c.modelRevision}` };
  if (!history.includes(c.modelRevision))
    return {
      state: "unknown",
      cause: `revision ${c.modelRevision} is not in this checkout's model history (another branch?)`,
    };
  const then = memo
    ? memo.revisions.has(c.modelRevision)
      ? memo.revisions.get(c.modelRevision)
      : (memo.revisions.set(c.modelRevision, readRevision(storeDir, c.modelRevision)),
        memo.revisions.get(c.modelRevision))
    : readRevision(storeDir, c.modelRevision);
  const before = then ? objectJson(then, c.modelObjectId, memo) : undefined;
  if (before === undefined)
    return { state: "unknown", cause: `${c.modelObjectId} cannot be read at ${c.modelRevision}` };
  return before === now
    ? {
        state: "unchanged",
        cause: `${c.modelObjectId} is identical at ${c.modelRevision} and ${current.project.modelRevision}`,
      }
    : {
        state: "changed",
        cause: `${c.modelObjectId} changed between ${c.modelRevision} and ${current.project.modelRevision}`,
      };
}

/** A revision listed in HEAD's history (already verified by the project's inspection). */
function readRevision(storeDir: string, rev: string): Model | undefined {
  if (persistedIdProblem(rev)) return undefined;
  // Same safe reader as the store: no symlinks, no special files, bounded.
  const f = readStoreFile(storeDir, `revisions/${rev}.yaml`, STORE_FILE_LIMITS.revision);
  if (f.kind !== "file") return undefined;
  try {
    return loadModel(f.text).model;
  } catch {
    return undefined;
  }
}

/** Canonical JSON of the object with this ID (top-level or nested), or undefined if absent. */
function objectJson(model: Model, id: Id, memo?: VerifyMemo): string | undefined {
  let index = memo?.indexes.get(model);
  if (!index) {
    index = buildIndex(model);
    memo?.indexes.set(model, index);
  }
  const entry = index.byId.get(id);
  if (!entry) return undefined;
  let node: unknown = model;
  for (const part of entry.path.matchAll(/([A-Za-z]+)(?:\[(\d+)\])?/g)) {
    node = (node as Record<string, unknown>)[part[1]!];
    if (part[2] !== undefined) node = (node as unknown[])[Number(part[2])];
  }
  return canonicalJson(node);
}
