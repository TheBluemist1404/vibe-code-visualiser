// Approved acceptance criteria and their test-case mappings (Issue #22, M4.2).
//
// Two things with different authority, kept apart:
//
//   intent    a criterion is an IR object (`criteria` in the model): an ID, an observable
//             statement, the objects it is about and a `required`/`optional` verification policy.
//             It changes only through a typed proposal and a separate human approval (M3).
//   evidence  which individual test cases check it is an agent-maintained `tests` binding claim
//             on the criterion's ID, naming one test case (file + full title). Reasserting it after
//             a test is renamed or moved is routine binding maintenance: no approval, no new model
//             revision. One claim per (criterion, test) pair, so mappings are many-to-many.
//
// This read surface reports, for each criterion, its mappings as verifyBinding sees them now
// (resolved, stale because the test or the criterion changed, missing after a rename, ambiguous
// for a duplicated test title) and what is wrong with them. A mapping is a claim that a test
// checks the criterion; it is not a test result (M4.3) and not evidence that the test is enough.
//
// One observation, like every read surface since M2.4: store, HEAD, change records, claim files and
// the bytes of every mapped test file are rechecked before answering (STATE_CHANGED). Bounded,
// deterministic, redacted; nothing is written.
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildIndex, refId } from "@vcv/ir";
import type { Criterion, Id } from "@vcv/ir";
import { canonicalJson } from "@vcv/core";
import { verifyBinding, verifyMemo } from "./bindings.ts";
import type { ClaimEntry, Verification } from "./bindings.ts";
import { redact } from "./handoff.ts";
import { failFinal, finish, moduleOf, observed, readClaims } from "./proposals.ts";
import type { ProposalHooks, ProposalResult } from "./proposals.ts";
import { worktreeState } from "./worktree.ts";

export const CRITERIA_LIMITS = {
  criteria: 200,
  mappingsPerCriterion: 50,
  problemsPerCriterion: 100,
  /** Other criteria listed per mapping (`alsoMapsTo`) and per test in the many-to-many index. */
  relatedCriteria: 20,
  tests: 500,
  invalidClaims: 50,
  textChars: 1000,
  testNameChars: 300,
  /** The whole serialized report (JSON, 2-space indent). Lists are cut further, and flagged, to fit; past that, REPORT_TOO_LARGE. */
  bytes: 512 * 1024,
} as const;

export const criteriaRequest = z
  .object({
    /** Only these criteria (all when absent). */
    ids: z.array(z.string().min(1).max(256)).min(1).max(CRITERIA_LIMITS.criteria).optional(),
  })
  .strict();
export type CriteriaRequest = z.input<typeof criteriaRequest>;

export type MappingProblemCode =
  /** No test case is mapped to this criterion. */
  | "NO_MAPPING"
  /** The criterion changed since the mapping was claimed: check the test still matches, then reassert. */
  | "CRITERION_CHANGED"
  /** The mapped test case's code changed since the mapping was claimed. */
  | "TEST_CHANGED"
  /** The mapped test case no longer resolves (renamed, moved or removed). */
  | "TEST_MISSING"
  /** The test title matches more than one test case in the file. */
  | "TEST_AMBIGUOUS"
  /** The mapping could not be checked (unknown fingerprint scheme, revision from another branch…). */
  | "MAPPING_NOT_CHECKED"
  /** Two claims map the same test case to this criterion. */
  | "DUPLICATE_MAPPING"
  /** A claim on this criterion that is not a `tests` claim on an individual test case. */
  | "NOT_A_TEST_MAPPING"
  /**
   * Some claim files cannot be read, or the claim store cannot be read at all. Which criterion an
   * unreadable file is about is unknown, so every criterion's assessment is then incomplete.
   */
  | "MAPPING_INVALID";

export type TestIdentity = {
  path: string;
  /** Full title, outermost suite first, joined with " > "; cut at CRITERIA_LIMITS.testNameChars. */
  name: string;
  /** sha256 of the full title, present when `name` was cut. */
  nameDigest?: string;
};

export type CriterionMapping = {
  bindingId: string;
  test: TestIdentity | null;
  relation: string | null;
  /** verifyBinding now. */
  state: Verification["state"];
  source: { state: string; cause: string } | null;
  model: { state: string; cause: string } | null;
  provenance: { source: string; principalId: string } | null;
  claimedAtRevision: string | null;
  /** Other criteria mapped to the same test case (many-to-many), at most CRITERIA_LIMITS.relatedCriteria. */
  alsoMapsTo: Id[];
  alsoMapsToTotal: number;
};

export type CriterionEvidence = {
  id: Id;
  name: string;
  statement: string;
  verification: Criterion["verification"];
  verifies: Id[];
  moduleId: Id | null;
  /**
   * Over the readable test-case mappings: resolved: every one resolves and is fresh; partial: some
   * do; unresolved: none does; none: there is no mapping and every claim file was read; unknown:
   * there is no readable mapping but some claim files (or the whole store) could not be read, so
   * one of them may map this criterion.
   */
  mapping: "none" | "resolved" | "partial" | "unresolved" | "unknown";
  /** incomplete: some claim files could not be read, so `mapping` may leave out mappings of this criterion. */
  assessment: "complete" | "incomplete";
  mappings: CriterionMapping[];
  mappingsTotal: number;
  mappingsTruncated: boolean;
  problems: { code: MappingProblemCode; message: string; bindingId?: string }[];
  problemsTotal: number;
  problemsTruncated: boolean;
};

export type CriteriaReport = {
  format: "vcv-criteria-1";
  modelRevision: string;
  criteria: CriterionEvidence[];
  total: number;
  truncated: boolean;
  /** Many-to-many index: each mapped test case and the criteria it is claimed to check (at most CRITERIA_LIMITS.relatedCriteria each). */
  tests: { test: TestIdentity; criteria: Id[]; criteriaTotal: number; criteriaTruncated: boolean }[];
  testsTotal: number;
  testsTruncated: boolean;
  counts: {
    criteria: number;
    required: number;
    optional: number;
    /** Required criteria with no mapping, every claim file read. */
    requiredUnmapped: number;
    /** Required criteria not shown resolved with a complete assessment (unmapped, unresolved, partial, unknown or incomplete). */
    requiredNotResolved: number;
    /** Required criteria whose assessment is incomplete. */
    requiredIncomplete: number;
    optionalUnmapped: number;
    /** Readable claims on criteria. */
    mappings: number;
  };
  /** complete: every claim file was read. incomplete: some (or the store) could not be, see invalidClaims / mappingsProblem. */
  assessment: "complete" | "incomplete";
  /** False when `.vcv/bindings/` could not be read: every criterion's mapping is then `unknown`. */
  mappingsAvailable: boolean;
  mappingsProblem?: string;
  /** Every claim file that could not be read. Not attributed to a criterion: its content is what would say which. */
  invalidClaims: { items: { bindingId: string; file: string; problem: string }[]; total: number; truncated: boolean };
  budget: { limit: number; bytes: number; shrunk: boolean };
  meaning: string;
  implementationChecked: false;
};

const MEANING =
  "A mapping is an agent's claim that a test case checks a criterion. It is not a test result (runner evidence is M4.3) and not evidence that the test is sufficient. Changing a criterion or its verification policy is a model change (proposal + approval); remapping a renamed test is not.";

const cut = (t: string, max: number = CRITERIA_LIMITS.textChars) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function identityOf(path: string, name: string): TestIdentity {
  return name.length > CRITERIA_LIMITS.testNameChars ? { path, name: cut(name, CRITERIA_LIMITS.testNameChars), nameDigest: sha(name) } : { path, name };
}

/** The criteria of the current model with their test-case mappings, verified now. Read-only, one observation. */
export function criteriaEvidence(path: string, input: unknown = {}, hooks: ProposalHooks = {}): ProposalResult<CriteriaReport> {
  const parsed = criteriaRequest.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, error: { code: "INVALID_REQUEST", message: "request does not match the criteria input schema", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
  }
  return observed(path, hooks, (obs) => {
    const root = obs.status.root;
    const model = obs.model;
    const all = model.criteria ?? [];
    const wanted = parsed.data.ids ? new Set(parsed.data.ids) : null;
    if (wanted) {
      const unknown = [...wanted].filter((id) => !all.some((c) => c.id === id)).sort();
      if (unknown.length) return failFinal({ code: "INVALID_REQUEST", message: `no criterion ${unknown.map((u) => `"${u}"`).join(", ")} at ${model.project.modelRevision}` }, obs, hooks);
    }
    const claims = readClaims(root);
    const available = !claims.key.startsWith("unreadable:");
    const criterionIds = new Set(all.map((c) => c.id));
    const about = claims.entries.filter((e) => !!e.claim && criterionIds.has(e.claim.modelObjectId));
    // An unreadable claim file may be about any criterion (or none); its bytes are what would say.
    const invalid = claims.entries.filter((e) => !e.claim).sort((a, b) => (a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0));
    const complete = available && invalid.length === 0;
    // The bytes of every mapped test file, before verification reads them and again before answering.
    const files = [...new Set(about.map((e) => e.claim?.locator.path).filter((p): p is string => !!p))].sort();
    const tree = worktreeState(root, files);
    const memo = verifyMemo(); // one observation: the guard rechecks every input before answering
    const verified = new Map(about.map((e) => [e.bindingId, verifyBinding(root, e, obs.status, memo)] as const));

    // Many-to-many: test identity → criteria.
    const key = (e: ClaimEntry) => (e.claim && e.claim.relation === "tests" && e.claim.locator.selector.kind === "test" ? `${e.claim.locator.path}\0${e.claim.locator.selector.name}` : null);
    const byTest = new Map<string, Set<Id>>();
    for (const e of about) {
      const k = key(e);
      if (k) byTest.set(k, (byTest.get(k) ?? new Set()).add(e.claim!.modelObjectId));
    }

    const evidence = all
      .filter((c) => !wanted || wanted.has(c.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => criterionOf(c, about, verified, byTest, key, available ? invalid.length : null, claims.key, moduleOf(model, c.id)));
    const shown = evidence.slice(0, CRITERIA_LIMITS.criteria);
    const tests = [...byTest.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, ids]) => {
        const [p, n] = k.split("\0") as [string, string];
        const sorted = [...ids].sort();
        return { test: identityOf(p, n), criteria: sorted.slice(0, CRITERIA_LIMITS.relatedCriteria), criteriaTotal: sorted.length, criteriaTruncated: sorted.length > CRITERIA_LIMITS.relatedCriteria };
      });
    const notResolved = (e: CriterionEvidence) => e.mapping !== "resolved" || e.assessment !== "complete";
    const data: CriteriaReport = {
      format: "vcv-criteria-1",
      modelRevision: model.project.modelRevision,
      criteria: shown,
      total: evidence.length,
      truncated: evidence.length > shown.length,
      tests: tests.slice(0, CRITERIA_LIMITS.tests),
      testsTotal: tests.length,
      testsTruncated: tests.length > CRITERIA_LIMITS.tests,
      counts: {
        criteria: evidence.length,
        required: evidence.filter((e) => e.verification === "required").length,
        optional: evidence.filter((e) => e.verification === "optional").length,
        requiredUnmapped: evidence.filter((e) => e.verification === "required" && e.mapping === "none").length,
        requiredNotResolved: evidence.filter((e) => e.verification === "required" && notResolved(e)).length,
        requiredIncomplete: evidence.filter((e) => e.verification === "required" && e.assessment !== "complete").length,
        optionalUnmapped: evidence.filter((e) => e.verification === "optional" && e.mapping === "none").length,
        mappings: about.length,
      },
      assessment: complete ? "complete" : "incomplete",
      mappingsAvailable: available,
      ...(available ? {} : { mappingsProblem: cut(claims.key.slice("unreadable:".length)) }),
      invalidClaims: {
        items: invalid.slice(0, CRITERIA_LIMITS.invalidClaims).map((e) => ({ bindingId: cut(e.bindingId, 300), file: cut(e.file, 300), problem: cut(e.problem ?? "unreadable") })),
        total: invalid.length,
        truncated: invalid.length > CRITERIA_LIMITS.invalidClaims,
      },
      budget: { limit: CRITERIA_LIMITS.bytes, bytes: 0, shrunk: false },
      meaning: MEANING,
      implementationChecked: false,
    };
    const guard = {
      key: canonicalJson([claims.key, tree.digest]),
      again: () => {
        const c = readClaims(root);
        const f = [...new Set(c.entries.filter((e) => e.claim && criterionIds.has(e.claim.modelObjectId)).map((e) => e.claim!.locator.path))].sort();
        return canonicalJson([c.key, worktreeState(root, f.length ? f : files).digest]);
      },
    };
    const bounded = fitBudget(redact(data, root));
    if (!bounded) return failFinal({ code: "REPORT_TOO_LARGE", message: `the criteria report exceeds ${CRITERIA_LIMITS.bytes} bytes even with every list cut to one item; ask for fewer criteria with ids` }, obs, hooks);
    return finish(obs, hooks, bounded, guard);
  });
}

/**
 * Fit the serialized report into CRITERIA_LIMITS.bytes by halving the longest list (top-level or
 * nested, across all rows) until it fits, flagging every cut. Null if even one item per list is too much.
 */
function fitBudget(r: CriteriaReport): CriteriaReport | null {
  const size = (x: CriteriaReport) => Buffer.byteLength(JSON.stringify(x, null, 2));
  const most = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0);
  const lists: { get: () => number; set: (n: number) => void }[] = [
    { get: () => r.criteria.length, set: (n) => ((r.criteria = r.criteria.slice(0, n)), (r.truncated = true)) },
    { get: () => r.tests.length, set: (n) => ((r.tests = r.tests.slice(0, n)), (r.testsTruncated = true)) },
    { get: () => r.invalidClaims.items.length, set: (n) => ((r.invalidClaims.items = r.invalidClaims.items.slice(0, n)), (r.invalidClaims.truncated = true)) },
    { get: () => most(r.tests.map((t) => t.criteria.length)), set: (n) => r.tests.forEach((t) => t.criteria.length > n && ((t.criteria = t.criteria.slice(0, n)), (t.criteriaTruncated = true))) },
    { get: () => most(r.criteria.map((c) => c.mappings.length)), set: (n) => r.criteria.forEach((c) => c.mappings.length > n && ((c.mappings = c.mappings.slice(0, n)), (c.mappingsTruncated = true))) },
    { get: () => most(r.criteria.map((c) => c.problems.length)), set: (n) => r.criteria.forEach((c) => c.problems.length > n && ((c.problems = c.problems.slice(0, n)), (c.problemsTruncated = true))) },
    // alsoMapsTo has its own total; cutting it is visible as alsoMapsTo.length < alsoMapsToTotal.
    { get: () => most(r.criteria.flatMap((c) => c.mappings.map((m) => m.alsoMapsTo.length))), set: (n) => r.criteria.forEach((c) => c.mappings.forEach((m) => (m.alsoMapsTo = m.alsoMapsTo.slice(0, n)))) },
  ];
  let bytes = size(r);
  let shrunk = false;
  while (bytes > CRITERIA_LIMITS.bytes) {
    const longest = lists.reduce((a, b) => (b.get() > a.get() ? b : a));
    const n = longest.get();
    if (n <= 1) return null;
    longest.set(Math.floor(n / 2));
    shrunk = true;
    r.budget = { limit: CRITERIA_LIMITS.bytes, bytes: 0, shrunk };
    bytes = size(r);
  }
  r.budget = { limit: CRITERIA_LIMITS.bytes, bytes, shrunk };
  r.budget.bytes = size(r);
  return r;
}

function criterionOf(
  c: Criterion,
  about: readonly ClaimEntry[],
  verified: Map<string, Verification>,
  byTest: Map<string, Set<Id>>,
  key: (e: ClaimEntry) => string | null,
  /** Number of unreadable claim files, or null when the claim store itself could not be read. */
  invalidCount: number | null,
  claimsKey: string,
  moduleId: Id | null,
): CriterionEvidence {
  const base = { id: c.id, name: cut(c.name, 200), statement: cut(c.statement), verification: c.verification, verifies: c.verifies.map(refId).filter((x): x is Id => !!x), moduleId };
  if (invalidCount === null) {
    return {
      ...base,
      mapping: "unknown",
      assessment: "incomplete",
      mappings: [],
      mappingsTotal: 0,
      mappingsTruncated: false,
      problems: [{ code: "MAPPING_INVALID", message: cut(`the binding claims could not be read (${claimsKey.slice("unreadable:".length)}); whether this criterion is mapped is unknown`) }],
      problemsTotal: 1,
      problemsTruncated: false,
    };
  }
  const mine = about.filter((e) => e.claim?.modelObjectId === c.id).sort((a, b) => (a.bindingId < b.bindingId ? -1 : 1));
  const problems: CriterionEvidence["problems"] = [];
  const mappings: CriterionMapping[] = [];
  const seen = new Map<string, string>();
  let resolved = 0;
  let testMappings = 0;
  for (const e of mine) {
    const v = verified.get(e.bindingId)!;
    const cl = e.claim!;
    const k = key(e);
    const isTest = k !== null;
    if (!isTest) problems.push({ code: "NOT_A_TEST_MAPPING", bindingId: e.bindingId, message: `claim ${e.bindingId} is a ${cl.relation} claim on a ${cl.locator.selector.kind} selector; a criterion is mapped only to individual test cases (tests + #test:)` });
    else {
      testMappings++;
      const dup = seen.get(k);
      if (dup) problems.push({ code: "DUPLICATE_MAPPING", bindingId: e.bindingId, message: `claims ${dup} and ${e.bindingId} map the same test case to ${c.id}` });
      else seen.set(k, e.bindingId);
    }
    const name = cl.locator.selector.kind === "test" ? cl.locator.selector.name : null;
    const at = name ? `${cl.locator.path} > ${cut(name, CRITERIA_LIMITS.testNameChars)}` : cl.locator.path;
    if (isTest) {
      if (v.state === "resolved") resolved++;
      else if (v.state === "missing") problems.push({ code: "TEST_MISSING", bindingId: e.bindingId, message: cut(`mapped test ${at} does not resolve (renamed, moved or removed?): ${v.locator?.detail ?? ""}; reassert the mapping to the test that now checks ${c.id}`) });
      else if (v.state === "ambiguous") problems.push({ code: "TEST_AMBIGUOUS", bindingId: e.bindingId, message: cut(`mapped test title ${at} matches more than one test case; make the titles unique`) });
      else if (v.state === "stale") {
        if (v.model && (v.model.state === "changed" || v.model.state === "removed")) problems.push({ code: "CRITERION_CHANGED", bindingId: e.bindingId, message: cut(`${c.id} changed since the mapping was claimed (${v.model.cause}); check that ${at} still checks it, then reassert`) });
        if (v.source?.state === "changed") problems.push({ code: "TEST_CHANGED", bindingId: e.bindingId, message: cut(`the code of mapped test ${at} changed since the mapping was claimed; check it still checks ${c.id}, then reassert`) });
      } else if (v.state === "invalid") problems.push({ code: "MAPPING_INVALID", bindingId: e.bindingId, message: cut(`mapping ${e.bindingId} is invalid: ${[v.locator?.detail, v.source?.cause, v.model?.cause].filter(Boolean).join("; ") || "the claim does not verify"}`) });
      else problems.push({ code: "MAPPING_NOT_CHECKED", bindingId: e.bindingId, message: cut(`mapping ${e.bindingId} is ${v.state}: ${[v.source?.cause, v.model?.cause, v.locator?.detail].filter(Boolean).join("; ")}`) });
    }
    mappings.push({
      bindingId: e.bindingId,
      test: name !== null ? identityOf(cl.locator.path, name) : null,
      relation: cl.relation,
      state: v.state,
      source: v.source ? { state: v.source.state, cause: cut(v.source.cause) } : null,
      model: v.model ? { state: v.model.state, cause: cut(v.model.cause) } : null,
      provenance: { source: cl.provenance.source, principalId: cl.provenance.principalId },
      claimedAtRevision: cl.modelRevision,
      ...(() => {
        const others = k ? [...(byTest.get(k) ?? [])].filter((x) => x !== c.id).sort() : [];
        return { alsoMapsTo: others.slice(0, CRITERIA_LIMITS.relatedCriteria), alsoMapsToTotal: others.length };
      })(),
    });
  }
  const incomplete = invalidCount > 0;
  // Unreadable claim files are not attributed by name: any of them may be a mapping of this criterion.
  if (incomplete) problems.unshift({ code: "MAPPING_INVALID", message: `${invalidCount} claim file(s) in .vcv/bindings/ cannot be read, and any of them may map ${c.id}; this assessment is incomplete (see invalidClaims)` });
  if (testMappings === 0 && !incomplete) problems.unshift({ code: "NO_MAPPING", message: `no test case is mapped to ${c.verification} criterion ${c.id}` });
  return {
    ...base,
    mapping: testMappings === 0 ? (incomplete ? "unknown" : "none") : resolved === testMappings ? "resolved" : resolved > 0 ? "partial" : "unresolved",
    assessment: incomplete ? "incomplete" : "complete",
    mappings: mappings.slice(0, CRITERIA_LIMITS.mappingsPerCriterion),
    mappingsTotal: mappings.length,
    mappingsTruncated: mappings.length > CRITERIA_LIMITS.mappingsPerCriterion,
    problems: problems.slice(0, CRITERIA_LIMITS.problemsPerCriterion),
    problemsTotal: problems.length,
    problemsTruncated: problems.length > CRITERIA_LIMITS.problemsPerCriterion,
  };
}

/** A criterion is an IR object; `buildIndex` lists it with kind "criterion". */
export const isCriterion = (model: Parameters<typeof buildIndex>[0], id: Id) => buildIndex(model).byId.get(id)?.kind === "criterion";
