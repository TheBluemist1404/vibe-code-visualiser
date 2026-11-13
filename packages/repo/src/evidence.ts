// Read-only source-evidence queries (Issue #15, M2.5).
//
// One shared layer behind the CLI (`vcv evidence`) and MCP (`vcv_get_*_evidence`): request
// validation, limits, cursors, the expectedRevision guard and every error code live here, so the
// adapters only forward arguments and print the result.
//
// Evidence is about binding claims (docs/bindings.md): what an agent or a person claimed, whether
// the pointer resolves now, whether the code or the model object changed since the claim, and the
// fact that nothing here is an approval. Four concerns are kept apart in every item:
//
//   claim      the claimant's interpretation: relation, locator, provenance, rationale, confidence
//   locator    existence: does the pointer resolve to exactly one artifact now
//   freshness  did the selected code / the model object change since the claim, with causes
//   approval   always "not approved": a claim is never approved, whatever its state
//
// Nothing is inferred, cached, written or proposed. Every call observes the working tree as it is
// now; `refreshEvidence` is the explicit "recheck everything" call and returns a token that
// changes when any reported evidence changes. Results never contain source text or absolute paths.
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildIndex, persistedIdProblem } from "@vcv/ir";
import { BINDING_RELATIONS, canonicalJson, readHeadRevision, storeFingerprint } from "@vcv/core";
import type { BindingClaim, BindingRelation, Selector } from "@vcv/core";
import { BindingError, FINGERPRINT_ALGORITHM, listBindings, readBinding, verifyBinding } from "./bindings.ts";
import type { ClaimEntry, Verification } from "./bindings.ts";
import { headCommit } from "./git.ts";
import { formatLocator, resolveInside } from "./locator.ts";
import { projectStatus } from "./project.ts";
import type { ProjectStatus } from "./project.ts";
import { RESOLVER_ID, fileFingerprintAt } from "./resolver.ts";

// ---- requests --------------------------------------------------------------------------

export const EVIDENCE_STATES = [
  "resolved",
  "stale",
  "missing",
  "ambiguous",
  "unchecked",
  "indeterminate",
  "invalid",
] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];
const SELECTOR_KINDS = ["file", "symbol", "route", "test"] as const;

export const EVIDENCE_LIMITS = { default: 50, max: 200, matches: 10 } as const;

const persistedId = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => persistedIdProblem(v) === undefined, {
    message: "must use the persisted-ID grammar (lowercase letters, digits, '.', '-', '_')",
  });
const revision = { expectedRevision: persistedId.optional() };
const page = {
  limit: z.number().int().min(1).max(EVIDENCE_LIMITS.max).default(EVIDENCE_LIMITS.default),
  cursor: z.string().max(512).optional(),
};
const states = z.array(z.enum(EVIDENCE_STATES)).min(1).max(EVIDENCE_STATES.length).optional();

export const evidenceOverviewRequest = z.object({ ...revision, ...page, states }).strict();

export const objectEvidenceRequest = z
  .object({
    ...revision,
    ...page,
    id: z.string().min(1).max(256),
    relations: z.array(z.enum(BINDING_RELATIONS)).min(1).max(BINDING_RELATIONS.length).optional(),
    selectorKinds: z.array(z.enum(SELECTOR_KINDS)).min(1).max(SELECTOR_KINDS.length).optional(),
    states,
  })
  .strict();

export const bindingEvidenceRequest = z.object({ ...revision, bindingId: persistedId }).strict();

export const refreshEvidenceRequest = z
  .object({
    ...revision,
    ...page,
    /** Recheck only these claims (all when absent). */
    bindingIds: z.array(persistedId).min(1).max(EVIDENCE_LIMITS.max).optional(),
    /** The observationToken of an earlier refresh; the result says whether anything changed since. */
    since: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "must be an observationToken from an earlier refreshEvidence")
      .optional(),
  })
  .strict();

export type EvidenceOverviewRequest = z.input<typeof evidenceOverviewRequest>;
export type ObjectEvidenceRequest = z.input<typeof objectEvidenceRequest>;
export type BindingEvidenceRequest = z.input<typeof bindingEvidenceRequest>;
export type RefreshEvidenceRequest = z.input<typeof refreshEvidenceRequest>;

// ---- responses -------------------------------------------------------------------------

export type EvidenceErrorCode =
  | "INVALID_REQUEST"
  /** No model object with this ID, and no claim names it. */
  | "UNKNOWN_ID"
  /** No claim file with this binding ID. */
  | "UNKNOWN_BINDING"
  | "REVISION_MISMATCH"
  | "INVALID_CURSOR"
  /** The project is absent, uninitialized, conflicted, diverged or invalid. */
  | "PROJECT_NOT_READY"
  /** `.vcv/` or `.vcv/bindings/` is a symlink or not a directory; no claim was read. */
  | "UNSAFE_PATH"
  /** The model store, Git commit or claim files changed while reading (e.g. a checkout). Retry. */
  | "STATE_CHANGED";

export type EvidenceError = { code: EvidenceErrorCode; message: string; details?: { path: string; message: string }[] };

/** Provenance envelope on every successful result, and on errors once the project was read. */
export type EvidenceContext = {
  projectId: string;
  modelRevision: string;
  /** The model snapshot's own status (draft or approved). Unrelated to whether a pointer resolves. */
  snapshotStatus: string;
  source: "repository-evidence";
  /** Always false: VCV never checks that code does what a claim says. */
  implementationChecked: false;
  meaning: "unverified";
  observed: {
    /** Git commit of the checkout, or null outside Git / before the first commit. */
    commit: string | null;
    branch: string | null;
    /** True when the working tree differs from the commit. Verification reads the working tree. */
    dirty: boolean | null;
    resolver: string;
    fingerprintAlgorithm: string;
  };
};

export type EvidenceResult<T> =
  | { ok: true; context: EvidenceContext; data: T }
  | { ok: false; context?: EvidenceContext; error: EvidenceError };

export type LocatorText = { text: string; path: string; selector: Selector };

/** One claim's full evidence, with the four concerns in separate sections. */
export type BindingEvidence = {
  bindingId: string;
  /** Repository-relative path of the claim file. */
  file: string;
  /** sha256 of the claim file; what a later write passes as --expect. */
  digest: string;
  state: EvidenceState;
  /** Why the claim file could not be read as a claim (state "invalid"). */
  problem?: string;
  /** The claimant's interpretation, exactly as stored. Not checked by VCV. */
  claim: {
    modelObjectId: string;
    relation: BindingRelation;
    locator: LocatorText;
    provenance: BindingClaim["provenance"];
    modelRevision: string;
    observed: BindingClaim["observed"];
  } | null;
  /** Does the pointer resolve now. */
  locator: {
    state: "resolved" | "missing" | "ambiguous" | "unchecked";
    detail: string;
    matches: { label: string; declaration: string; line: number }[];
    matchesTotal: number;
  } | null;
  /** Did the selected code or the model object change since the claim. */
  freshness: {
    source: NonNullable<Verification["source"]>;
    model: NonNullable<Verification["model"]>;
    git: Verification["git"];
  } | null;
  /** A recorded dispute (by `vcv binding dispute`), never set by verification. */
  disputed: { by: string; reason: string } | null;
  approval: { approved: false; note: string };
};

/** One line per claim, for overviews and refresh. */
export type EvidenceSummary = {
  bindingId: string;
  state: EvidenceState;
  modelObjectId: string | null;
  relation: BindingRelation | null;
  locator: string | null;
  disputed: boolean;
  problem?: string;
};

export type Counts = Record<EvidenceState, number> & { total: number; disputed: number };

export type EvidenceOverview = {
  counts: Counts;
  /** Claims whose model object is not in the current revision (they verify as stale). */
  objectsMissingFromModel: string[];
  bindings: EvidenceSummary[];
  /** Claims matching the request's filters (all claims without filters). */
  matched: number;
  truncated: boolean;
  nextCursor?: string;
};

export type ObjectEvidence = {
  object: { id: string; kind: string | null; name: string | null; inCurrentModel: boolean };
  counts: Counts;
  bindings: BindingEvidence[];
  matched: number;
  truncated: boolean;
  nextCursor?: string;
  /** Claim files that cannot be read, so may or may not be about this object. */
  unreadableClaims: number;
};

export type EvidenceRefresh = {
  /** sha256 over the model revision and every claim's reported evidence. */
  observationToken: string;
  /** Compared with `since`: true if any reported evidence differs, null without `since`. */
  changedSince: boolean | null;
  counts: Counts;
  bindings: EvidenceSummary[];
  matched: number;
  truncated: boolean;
  nextCursor?: string;
  writes: "none";
};

export type EvidenceApi = {
  getEvidenceOverview(req?: EvidenceOverviewRequest): EvidenceResult<EvidenceOverview>;
  getObjectEvidence(req: ObjectEvidenceRequest): EvidenceResult<ObjectEvidence>;
  getBindingEvidence(req: BindingEvidenceRequest): EvidenceResult<BindingEvidence>;
  refreshEvidence(req?: RefreshEvidenceRequest): EvidenceResult<EvidenceRefresh>;
};

/** Test seam: runs between verifying the claims and the final consistency re-check. */
export type EvidenceHooks = { afterRead?: () => void; afterVerify?: (bindingId: string) => void };

// ---- the API ---------------------------------------------------------------------------

/** Read-only evidence for the checkout containing `path`. Nothing is opened or cached up front. */
export function createEvidenceApi(path: string, hooks: EvidenceHooks = {}): EvidenceApi {
  function run<S extends z.ZodType<{ expectedRevision?: string | undefined }>, T>(
    schema: S,
    input: unknown,
    body: (req: z.output<S>, obs: Observation) => Body<T>,
    which: "all" | ((req: z.output<S>) => string),
  ): EvidenceResult<T> {
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "request does not match the evidence query's input schema",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      };
    }
    const req = parsed.data;
    const status = projectStatus(path);
    const scrub = scrubber(status.root);
    if (status.state !== "ready" || !status.model) {
      return scrub({
        ok: false,
        error: {
          code: "PROJECT_NOT_READY",
          message: `project is ${status.state}; evidence is only read from a ready project`,
          details: status.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => ({ path: "project", message: `${d.code}: ${d.message}` })),
        },
      });
    }
    const context = contextOf(status);
    if (req.expectedRevision !== undefined && req.expectedRevision !== status.model.revision) {
      return scrub({
        ok: false,
        context,
        error: {
          code: "REVISION_MISMATCH",
          message: `expected revision ${req.expectedRevision}, current is ${status.model.revision}; restart the analysis`,
        },
      });
    }
    const obs = observe(path, status, which === "all" ? null : which(req), hooks);
    if ("error" in obs) return scrub({ ok: false, context, error: obs.error });
    const result = body(req, obs);
    return scrub(
      "error" in result ? { ok: false, context, error: result.error } : { ok: true, context, data: result.data },
    );
  }

  return {
    getEvidenceOverview: (req) => run(evidenceOverviewRequest, req, overview, "all"),
    getObjectEvidence: (req) => run(objectEvidenceRequest, req, objectEvidence, "all"),
    getBindingEvidence: (req) => run(bindingEvidenceRequest, req, bindingEvidence, (r) => r.bindingId),
    refreshEvidence: (req) => run(refreshEvidenceRequest, req, refresh, "all"),
  };
}

// ---- one observation per call ----------------------------------------------------------

type Observation = {
  status: ProjectStatus;
  verifications: Verification[];
  entries: ClaimEntry[];
  /** Set when a single claim was asked for and it does not exist. */
  absent?: string;
  objects: Map<string, { kind: string; name: string }>;
};

/**
 * Read the claims and verify them against one project status, then check that the store, the
 * Git commit, the claim files and every bound source file are still what was read. A checkout landing mid-read is
 * reported as STATE_CHANGED instead of mixing two branches' evidence.
 */
function observe(
  path: string,
  status: ProjectStatus,
  only: string | null,
  hooks: EvidenceHooks,
): Observation | { error: EvidenceError } {
  const store = storeFingerprint(status.storeDir);
  const commit = status.git?.commit ?? null;
  let entries: ClaimEntry[];
  try {
    if (only === null) entries = listBindings(path);
    else {
      const e = readBinding(path, only);
      entries = e ? [e] : [];
    }
  } catch (e) {
    if (e instanceof BindingError && e.code === "UNSAFE_PATH")
      return { error: { code: "UNSAFE_PATH", message: e.message } };
    throw e;
  }
  // The working tree is part of the observation too: fingerprint every bound source file before
  // and after verification, so a dirty edit mid-read cannot mix two generations of the source.
  const sources = [...new Set(entries.map((e) => e.claim?.locator.path).filter((p): p is string => !!p))].sort();
  const sourcesBefore = sourceState(status.root, sources);
  const changed = {
    error: {
      code: "STATE_CHANGED" as const,
      message:
        "the model store, Git commit or claim files changed while evidence was read (a checkout or an edit?); nothing was mixed, retry the call",
    },
  };
  let verifications: Verification[];
  let model: ReturnType<typeof readHeadRevision>;
  try {
    verifications = entries.map((e) => {
      const v = verifyBinding(path, e, status);
      hooks.afterVerify?.(e.bindingId);
      return v;
    });
    model = readHeadRevision(status.storeDir);
  } catch (e) {
    // The store was ready when the call started; failing to read it now means it moved.
    if (storeFingerprint(status.storeDir) !== store) return changed;
    throw e;
  }
  hooks.afterRead?.();

  const again = only === null ? safeList(path) : safeOne(path, only);
  const sameClaims =
    again !== null &&
    again.length === entries.length &&
    again.every((e, i) => e.bindingId === entries[i]!.bindingId && e.digest === entries[i]!.digest);
  if (
    storeFingerprint(status.storeDir) !== store ||
    (status.git ? headCommit(status.root) : null) !== commit ||
    !sameClaims ||
    sourceState(status.root, sources) !== sourcesBefore
  ) {
    return changed;
  }
  const objects = new Map<string, { kind: string; name: string }>();
  for (const e of buildIndex(model).byId.values()) objects.set(e.id, { kind: e.kind, name: e.name });
  return {
    status,
    verifications,
    entries,
    objects,
    ...(only !== null && entries.length === 0 ? { absent: only } : {}),
  };
}

/**
 * One string describing every bound source file as it is now: its fingerprint, or why it cannot
 * be read (missing, unsafe, case mismatch, a symlink out of the checkout). Uses the resolver's
 * own path walk, so nothing outside the checkout is followed. Read-only.
 */
function sourceState(root: string, paths: readonly string[]): string {
  return JSON.stringify(
    paths.map((p) => {
      try {
        const where = resolveInside(root, p);
        return where.ok ? (fileFingerprintAt(where.abs) ?? "unreadable") : where.reason;
      } catch {
        return "unreadable";
      }
    }),
  );
}

function safeList(path: string): ClaimEntry[] | null {
  try {
    return listBindings(path);
  } catch {
    return null;
  }
}
function safeOne(path: string, id: string): ClaimEntry[] | null {
  try {
    const e = readBinding(path, id);
    return e ? [e] : [];
  } catch {
    return null;
  }
}

function contextOf(status: ProjectStatus): EvidenceContext {
  const m = status.model!;
  return {
    projectId: m.projectId,
    modelRevision: m.revision,
    snapshotStatus: m.status,
    source: "repository-evidence",
    implementationChecked: false,
    meaning: "unverified",
    observed: {
      commit: status.git?.commit ?? null,
      branch: status.git?.branch ?? null,
      dirty: status.git ? status.git.dirty : null,
      resolver: RESOLVER_ID,
      fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    },
  };
}

/** Results never carry this machine's checkout path: replace it with "." wherever it appears. */
function scrubber(root: string) {
  return <T>(value: T): T => {
    const text = JSON.stringify(value);
    if (!text.includes(root)) return value;
    return JSON.parse(text.split(JSON.stringify(root).slice(1, -1)).join(".")) as T;
  };
}

// ---- shaping ---------------------------------------------------------------------------

function evidenceOf(v: Verification, entry: ClaimEntry): BindingEvidence {
  const c = v.claim;
  const approval = {
    approved: false as const,
    note: "binding claims are never approved; context.snapshotStatus is the model's own status",
  };
  const base = { bindingId: v.bindingId, file: entry.file, digest: entry.digest, state: v.state as EvidenceState };
  if (!c)
    return {
      ...base,
      problem: v.problem ?? "unreadable claim",
      claim: null,
      locator: null,
      freshness: null,
      disputed: null,
      approval,
    };
  const matches = v.locator!.matches;
  return {
    ...base,
    claim: {
      modelObjectId: c.modelObjectId,
      relation: c.relation,
      locator: { text: formatLocator(c.locator), path: c.locator.path, selector: c.locator.selector },
      provenance: c.provenance,
      modelRevision: c.modelRevision,
      observed: c.observed,
    },
    locator: {
      state: v.locator!.state,
      detail: v.locator!.detail,
      matches: matches
        .slice(0, EVIDENCE_LIMITS.matches)
        .map((m) => ({ label: m.label, declaration: m.declaration, line: m.line })),
      matchesTotal: matches.length,
    },
    freshness: { source: v.source!, model: v.model!, git: v.git },
    disputed: v.disputed,
    approval,
  };
}

function summaryOf(v: Verification): EvidenceSummary {
  const c = v.claim;
  return {
    bindingId: v.bindingId,
    state: v.state as EvidenceState,
    modelObjectId: c?.modelObjectId ?? null,
    relation: c?.relation ?? null,
    locator: c ? formatLocator(c.locator) : null,
    disputed: Boolean(v.disputed),
    ...(c ? {} : { problem: v.problem ?? "unreadable claim" }),
  };
}

function countsOf(vs: readonly Verification[]): Counts {
  const counts = Object.fromEntries(EVIDENCE_STATES.map((s) => [s, 0])) as Record<EvidenceState, number>;
  for (const v of vs) counts[v.state as EvidenceState]++;
  return { ...counts, total: vs.length, disputed: vs.filter((v) => v.disputed).length };
}

// ---- cursors -------------------------------------------------------------------------
// "<revision>:<scope>:<offset>", as in @vcv/query. The scope binds a cursor to the request's
// filters AND the claim set it paged over (IDs and digests), so a cursor cannot skip or repeat
// claims after one was added, removed or edited.

const scopeOf = (parts: unknown) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

function claimSet(entries: readonly ClaimEntry[]) {
  return entries.map((e) => [e.bindingId, e.digest]);
}

function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number,
  scope: string,
  revision: string,
  what: string,
): { page: T[]; truncated: boolean; nextCursor?: string } | { error: EvidenceError } {
  let start = 0;
  if (cursor !== undefined) {
    const m = /^([^:]+):([0-9a-f]{16}):(0|[1-9]\d{0,8})$/.exec(cursor);
    if (!m) return { error: { code: "INVALID_CURSOR", message: `cursor is not one returned by ${what}` } };
    if (m[1] !== revision)
      return {
        error: {
          code: "REVISION_MISMATCH",
          message: `cursor belongs to revision ${m[1]}, current is ${revision}; start again`,
        },
      };
    if (m[2] !== scope)
      return {
        error: {
          code: "INVALID_CURSOR",
          message: `cursor was issued for a different ${what} request, or the claims changed since; start again`,
        },
      };
    start = Number(m[3]);
    if (start >= items.length)
      return {
        error: { code: "INVALID_CURSOR", message: `cursor offset ${start} is past the end of ${items.length} results` },
      };
  }
  const page = items.slice(start, start + limit);
  const end = start + page.length;
  return {
    page,
    truncated: end < items.length,
    ...(end < items.length ? { nextCursor: `${revision}:${scope}:${end}` } : {}),
  };
}

/** What a query body returns; `run` adds the context envelope. */
type Body<T> = { data: T } | { error: EvidenceError };
const fail = (error: EvidenceError): { error: EvidenceError } => ({ error });
const okResult = <T>(data: T): Body<T> => ({ data });

// ---- getEvidenceOverview -------------------------------------------------------------

function overview(req: z.output<typeof evidenceOverviewRequest>, obs: Observation): Body<EvidenceOverview> {
  const wanted = req.states ? new Set<string>(req.states) : null;
  const filtered = obs.verifications.filter((v) => !wanted || wanted.has(v.state));
  const scope = scopeOf(["overview", req.states ? [...new Set(req.states)].sort() : null, claimSet(obs.entries)]);
  const p = paginate(filtered, req.cursor, req.limit, scope, obs.status.model!.revision, "getEvidenceOverview");
  if ("error" in p) return fail(p.error);
  const missing = [
    ...new Set(
      obs.verifications.map((v) => v.claim?.modelObjectId).filter((id): id is string => !!id && !obs.objects.has(id)),
    ),
  ].sort();
  return okResult({
    counts: countsOf(obs.verifications),
    objectsMissingFromModel: missing,
    bindings: p.page.map(summaryOf),
    matched: filtered.length,
    truncated: p.truncated,
    ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}),
  });
}

// ---- getObjectEvidence ---------------------------------------------------------------

function objectEvidence(req: z.output<typeof objectEvidenceRequest>, obs: Observation): Body<ObjectEvidence> {
  const obj = obs.objects.get(req.id);
  const about = obs.verifications
    .map((v, i) => [v, obs.entries[i]!] as const)
    .filter(([v]) => v.claim?.modelObjectId === req.id);
  if (!obj && about.length === 0) {
    return fail({
      code: "UNKNOWN_ID",
      message: `no object with ID "${req.id}" in revision ${obs.status.model!.revision}, and no claim names it`,
    });
  }
  const rel = req.relations ? new Set<string>(req.relations) : null;
  const kinds = req.selectorKinds ? new Set<string>(req.selectorKinds) : null;
  const wanted = req.states ? new Set<string>(req.states) : null;
  const filtered = about.filter(
    ([v]) =>
      (!rel || rel.has(v.claim!.relation)) &&
      (!kinds || kinds.has(v.claim!.locator.selector.kind)) &&
      (!wanted || wanted.has(v.state)),
  );
  const norm = (a?: readonly string[]) => (a ? [...new Set(a)].sort() : null);
  const scope = scopeOf([
    "object",
    req.id,
    norm(req.relations),
    norm(req.selectorKinds),
    norm(req.states),
    claimSet(obs.entries),
  ]);
  const p = paginate(filtered, req.cursor, req.limit, scope, obs.status.model!.revision, "getObjectEvidence");
  if ("error" in p) return fail(p.error);
  return okResult({
    object: { id: req.id, kind: obj?.kind ?? null, name: obj?.name ?? null, inCurrentModel: Boolean(obj) },
    counts: countsOf(about.map(([v]) => v)),
    bindings: p.page.map(([v, e]) => evidenceOf(v, e)),
    matched: filtered.length,
    truncated: p.truncated,
    ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}),
    unreadableClaims: obs.verifications.filter((v) => !v.claim).length,
  });
}

// ---- getBindingEvidence --------------------------------------------------------------

function bindingEvidence(req: z.output<typeof bindingEvidenceRequest>, obs: Observation): Body<BindingEvidence> {
  if (obs.absent !== undefined)
    return fail({
      code: "UNKNOWN_BINDING",
      message: `no claim file .vcv/bindings/${req.bindingId}.json in this checkout; list claims with getEvidenceOverview`,
    });
  return okResult(evidenceOf(obs.verifications[0]!, obs.entries[0]!));
}

// ---- refreshEvidence -----------------------------------------------------------------

function refresh(req: z.output<typeof refreshEvidenceRequest>, obs: Observation): Body<EvidenceRefresh> {
  let pairs = obs.verifications.map((v, i) => [v, obs.entries[i]!] as const);
  if (req.bindingIds) {
    const ids = [...new Set(req.bindingIds)].sort();
    const unknown = ids.filter((id) => !obs.entries.some((e) => e.bindingId === id));
    if (unknown.length)
      return fail({
        code: "UNKNOWN_BINDING",
        message: `no claim file for ${unknown.map((i) => `"${i}"`).join(", ")} in this checkout`,
      });
    pairs = pairs.filter(([v]) => ids.includes(v.bindingId));
  }
  const token = createHash("sha256")
    .update(
      canonicalJson({
        revision: obs.status.model!.revision,
        revisionFile: obs.status.model!.fileDigest,
        evidence: pairs.map(([v, e]) => ({ ...evidenceOf(v, e) })),
      }),
    )
    .digest("hex");
  const scope = scopeOf([
    "refresh",
    req.bindingIds ? [...new Set(req.bindingIds)].sort() : null,
    claimSet(obs.entries),
  ]);
  const p = paginate(pairs, req.cursor, req.limit, scope, obs.status.model!.revision, "refreshEvidence");
  if ("error" in p) return fail(p.error);
  return okResult({
    observationToken: token,
    changedSince: req.since === undefined ? null : req.since !== token,
    counts: countsOf(pairs.map(([v]) => v)),
    bindings: p.page.map(([v]) => summaryOf(v)),
    matched: pairs.length,
    truncated: p.truncated,
    ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}),
    writes: "none",
  });
}
