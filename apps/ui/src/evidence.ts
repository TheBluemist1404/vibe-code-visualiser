// Evidence views (M5.5, Issue #45): thin, read-only adapters over @vcv/repo's existing evidence,
// criteria, handoff, implementation, reconciliation and gate functions. Every answer is a new
// observation of the checkout as it is now, tied to the model the explorer is showing (the
// served revision is passed as expectedRevision; a mismatch or a checkout that moves mid-read is
// STATE_CHANGED, never stitched together). Each answer's reads also run between two identity
// observations of the checkout (src/observe.ts) and are retried, or refused, if it moved.
// Nothing here writes, reasserts a claim, runs a test or decides anything the repo functions do not.
import { refId } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import {
  buildHandoff,
  createEvidenceApi,
  criteriaEvidence,
  implementationStatus,
  preMergeGate,
  reconcile,
} from "@vcv/repo";
import type { BindingEvidence, CriterionEvidence, EvidenceContext, EvidenceSummary } from "@vcv/repo";
import { consistentRead } from "./observe.ts";
import type { ProjectSession } from "./session.ts";
import type {
  BindingView,
  CriterionView,
  EvidenceObservation,
  GateInputs,
  GateView,
  ImplementationView,
  ModuleEvidenceView,
  ObjectEvidenceView,
} from "./types.ts";

export class EvidenceUnavailable extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Inputs the person who started the host supplied for the pre-merge views. Never guessed. */
export type EvidenceOptions = {
  /** The protected base as a full commit ID. Without it, reconciliation and the gate are not runnable. */
  baseCommit?: string;
  /** Test-run records (vcv-test-run JSON) read at start: claims, whatever they declare. */
  runs?: unknown[];
  /** A gate policy (vcv-policy-1) read at start. */
  policy?: unknown;
  /** Where those came from, for display. */
  sources?: { runs: string[]; policy: string | null };
  /** Test hook: called between the reads that make up one answer. */
  betweenReads?: (step: "after-handoff" | "after-reconcile") => void;
};

const OWNED = ["capabilities", "data", "rules", "events", "contracts", "behaviors", "criteria"] as const;
/** The UI host observes nothing itself: it captures no test run, so every run is a claim. */
const HOST = { principalId: "vcv-ui", permissions: [] as const };
const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export class EvidenceDesk {
  private readonly session: ProjectSession;
  private readonly opts: EvidenceOptions;

  constructor(session: ProjectSession, opts: EvidenceOptions = {}) {
    this.session = session;
    this.opts = opts;
  }

  /** Binding claims about one object, verified now; for a criterion also its test mappings. */
  object(id: string, expect?: string): ObjectEvidenceView {
    return consistentRead(this.session.path, () => this.objectOnce(id, expect));
  }

  private objectOnce(id: string, expect?: string): ObjectEvidenceView {
    checkId(id);
    const s = this.snapshot(expect);
    const api = createEvidenceApi(this.session.path);
    const r = api.getObjectEvidence({ id, expectedRevision: s.model.project.modelRevision, limit: 50 });
    if (!r.ok) throw unavailable(r.error.code, r.error.message);
    const crit = s.model.criteria?.some((c) => c.id === id) ? this.criterion(id, s.model) : null;
    return {
      observed: observedOf(r.context, s.key),
      object: r.data.object,
      counts: r.data.counts,
      bindings: r.data.bindings.map(bindingView),
      matched: r.data.matched,
      truncated: r.data.truncated,
      unreadableClaims: r.data.unreadableClaims,
      criterion: crit,
      limits: [
        "A binding is a claim: the claimant's reading of where the code is. VCV checks only that its pointer resolves and whether the code or the model object changed since the claim.",
        "Resolved and fresh is not evidence that the code does what the model says.",
      ],
    };
  }

  /** Per owned object of a module: how many claims, in which states. */
  module(moduleId: string, expect?: string): ModuleEvidenceView {
    return consistentRead(this.session.path, () => this.moduleOnce(moduleId, expect));
  }

  private moduleOnce(moduleId: string, expect?: string): ModuleEvidenceView {
    checkId(moduleId);
    const s = this.snapshot(expect);
    const ids = ownedIds(s.model, moduleId);
    if (!ids) throw new EvidenceUnavailable("UNKNOWN_ID", `no module ${moduleId} in the current model`);
    const api = createEvidenceApi(this.session.path);
    const r = api.getEvidenceOverview({ expectedRevision: s.model.project.modelRevision, limit: 200 });
    if (!r.ok) throw unavailable(r.error.code, r.error.message);
    const by = new Map<string, EvidenceSummary[]>();
    for (const b of r.data.bindings)
      if (b.modelObjectId) by.set(b.modelObjectId, [...(by.get(b.modelObjectId) ?? []), b]);
    const invalid = r.data.bindings.filter((b) => !b.modelObjectId).length;
    return {
      observed: observedOf(r.context, s.key),
      moduleId,
      objects: ids.map((o) => {
        const claims = by.get(o.id) ?? [];
        const states: Record<string, number> = {};
        for (const c of claims) states[c.state] = (states[c.state] ?? 0) + 1;
        return { ...o, claims: claims.length, states, disputed: claims.filter((c) => c.disputed).length };
      }),
      // Overview pages are bounded: past the page, per-object counts may leave claims out.
      truncated: r.data.truncated,
      unreadableClaims: invalid,
    };
  }

  /** The approved change's handoff and the agent's report, as separate layers. */
  implementation(changeId: string, expect?: string): ImplementationView {
    return consistentRead(this.session.path, () => this.implementationOnce(changeId, expect));
  }

  private implementationOnce(changeId: string, expect?: string): ImplementationView {
    checkId(changeId);
    const s = this.snapshot(expect);
    const h = buildHandoff(this.session.path, changeId);
    if (!h.ok) {
      // Not approved and attested here, or unreadable: say why, do not guess.
      return {
        changeId,
        modelKey: s.key,
        handoff: null,
        handoffProblem: `${h.error.code}: ${h.error.message}`,
        report: null,
        reportProblem: null,
      };
    }
    this.opts.betweenReads?.("after-handoff");
    const st = implementationStatus(this.session.path, changeId);
    const d = h.data;
    return {
      changeId,
      modelKey: s.key,
      handoff: {
        digest: d.digest,
        approvedRevision: d.change.approvedRevision,
        request: d.request
          ? {
              behavior: d.request.behavior,
              acceptanceCriteria: d.request.acceptanceCriteria,
              suggestedTests: d.request.suggestedTests ?? [],
              scope: d.request.scope ?? null,
            }
          : null,
        scopeFromBindings: d.scope.fromBindings,
        bindings: d.bindings.items.map((b) => ({
          bindingId: b.bindingId,
          modelObjectId: b.modelObjectId,
          relation: b.relation,
          locator: b.locator,
          why: b.why,
          state: b.state,
          reassert: b.reassertAfterImplementing,
        })),
        bindingsTotal: d.bindings.total,
        baseCommit: d.git.baseCommit,
        caveats: d.caveats,
      },
      handoffProblem: null,
      report: st.ok
        ? {
            file: st.data.file,
            digest: st.data.digest,
            claims: {
              by: st.data.report.agentClaims.claimedBy,
              confidence: st.data.report.agentClaims.confidence,
              testsRun: st.data.report.agentClaims.testsRun,
              acceptance: st.data.report.agentClaims.acceptance ?? [],
              gaps: st.data.report.agentClaims.gaps ?? [],
              outOfScope: st.data.report.agentClaims.outOfScope ?? [],
              notes: st.data.report.agentClaims.notes ?? null,
              note: st.data.report.agentClaims.note,
            },
            observedThen: {
              filesModified: st.data.report.vcvObserved.filesModified,
              outOfScope: st.data.report.vcvObserved.outOfScope,
            },
            observedNow: {
              baseCommit: st.data.now.baseCommit,
              headCommit: st.data.now.headCommit,
              dirty: st.data.now.dirty,
              filesModified: st.data.now.filesModified,
              filesTruncated: st.data.now.filesTruncated,
              outOfScope: st.data.now.outOfScope,
              bindings: st.data.now.bindings.map((b) => ({
                bindingId: b.bindingId,
                locator: b.locator,
                state: b.state,
                reasserted: b.reasserted,
              })),
            },
            changedSinceReport: st.data.changedSinceReport,
            warnings: st.data.warningsNow,
            notReconciled: st.data.report.notReconciled.note,
          }
        : null,
      reportProblem: st.ok ? null : `${st.error.code}: ${st.error.message}`,
    };
  }

  /** What the pre-merge views need, and which of it the host was given. */
  inputs(): GateInputs {
    const missing: string[] = [];
    if (!this.opts.baseCommit)
      missing.push("--base-commit <full commit ID of the protected base, from the hosting service>");
    return {
      baseCommit: this.opts.baseCommit ?? null,
      runs: this.opts.sources?.runs ?? [],
      policy: this.opts.sources?.policy ?? null,
      missing,
    };
  }

  /** Reconciliation and the gate against the base the host was given. Never a guessed base. */
  gate(expect?: string): GateView {
    return consistentRead(this.session.path, () => this.gateOnce(expect));
  }

  private gateOnce(expect?: string): GateView {
    const s = this.snapshot(expect);
    const inputs = this.inputs();
    if (!this.opts.baseCommit || !COMMIT.test(this.opts.baseCommit))
      return { modelKey: s.key, inputs, reconciliation: null, gate: null, problem: null };
    const base = this.opts.baseCommit;
    // The same reconciliation the gate runs: pinned to the base, attestation required.
    const rec = reconcile(this.session.path, {
      base,
      trust: { kind: "git-ref", ref: base, pinnedCommit: base },
      requireAttestation: true,
    });
    this.opts.betweenReads?.("after-reconcile");
    const gate = preMergeGate(
      this.session.path,
      {
        base,
        ...(this.opts.runs?.length ? { runs: this.opts.runs } : {}),
        ...(this.opts.policy !== undefined ? { policy: this.opts.policy } : {}),
      },
      HOST,
    );
    const problem = !rec.ok
      ? `${rec.error.code}: ${rec.error.message}`
      : !gate.ok
        ? `${gate.error.code}: ${gate.error.message}`
        : null;
    return {
      modelKey: s.key,
      inputs,
      problem,
      reconciliation: rec.ok
        ? {
            base: rec.data.base,
            candidate: {
              commit: rec.data.candidate.commit,
              branch: rec.data.candidate.branch,
              dirty: rec.data.candidate.dirty,
              modelRevision: rec.data.candidate.modelRevision,
            },
            lineage: rec.data.model.lineage,
            integrity: {
              ok: rec.data.model.integrity.ok,
              errors: rec.data.model.integrity.errors,
              authorization: rec.data.model.integrity.authorization,
            },
            summary: rec.data.summary,
            files: rec.data.source.files.map((f) => ({
              path: f.path,
              area: f.area,
              committed: f.committed,
              uncommitted: f.uncommitted,
              objectIds: f.objectIds,
            })),
            filesTotal: rec.data.source.total,
            findings: rec.data.findings.map((f) => ({
              code: f.code,
              category: f.category,
              basis: f.basis,
              related: f.related,
              message: f.message,
              checked: f.checked,
              ...(f.objectIds ? { objectIds: f.objectIds } : {}),
              ...(f.path ? { path: f.path } : {}),
            })),
            findingsTotal: rec.data.findingsTotal,
            findingsTruncated: rec.data.findingsTruncated,
            limits: rec.data.limits,
          }
        : null,
      gate: gate.ok
        ? {
            decision: gate.data.decision,
            headline: gate.data.headline,
            changeKind: gate.data.change.kind,
            policy: { source: gate.data.policy.source, changedByCandidate: gate.data.policy.changedByCandidate },
            reasons: gate.data.reasons.map((r) => ({
              severity: r.severity,
              code: r.code,
              rule: r.rule,
              basis: r.basis,
              message: r.message,
              ...(r.criterionId ? { criterionId: r.criterionId } : {}),
            })),
            reasonsTotal: gate.data.reasonsTotal,
            criteria: gate.data.criteria.items,
            runs: gate.data.runs.map((r) => ({
              index: r.index,
              observedBy: r.observedBy,
              runner: r.runner.name,
              fresh: r.fresh,
              staleBecause: r.staleBecause,
              summary: r.summary,
            })),
            limits: gate.data.limits,
          }
        : null,
    };
  }

  /**
   * The checkout as it is now. `expect` is the model the page is showing (its model key): when the
   * checkout has moved on since, the answer would describe a model the page is not showing, so it
   * is STATE_CHANGED rather than silently about something else.
   */
  private snapshot(expect?: string) {
    const s = this.session.ready();
    if (expect !== undefined && expect !== s.key)
      throw new EvidenceUnavailable(
        "STATE_CHANGED",
        `the checkout now holds ${s.model.project.modelRevision}, not the model this page shows; reload to see the current one`,
      );
    return s;
  }

  private criterion(id: string, model: Model): CriterionView | null {
    const r = criteriaEvidence(this.session.path, {
      ids: [id],
      ...(this.opts.runs?.length ? { runs: this.opts.runs } : {}),
    });
    if (!r.ok) return null;
    if (r.data.modelRevision !== model.project.modelRevision)
      throw new EvidenceUnavailable("STATE_CHANGED", "the model moved while the criterion was read; re-check");
    const c = r.data.criteria.find((x) => x.id === id);
    return c ? criterionView(c, r.data.runs.length) : null;
  }
}

/** IDs the explorer can show: bounded, printable, no whitespace. */
function checkId(id: string) {
  if (id.length > 200 || !/^[\x21-\x7e]+$/.test(id))
    throw new EvidenceUnavailable("INVALID_REQUEST", "not an object or change ID");
}

function unavailable(code: string, message: string) {
  // A served revision that is no longer the checkout's is the same situation as a move mid-read.
  return new EvidenceUnavailable(code === "REVISION_MISMATCH" ? "STATE_CHANGED" : code, message);
}

function observedOf(c: EvidenceContext, modelKey: string): EvidenceObservation {
  return {
    at: new Date().toISOString(),
    modelRevision: c.modelRevision,
    modelKey,
    commit: c.observed.commit,
    branch: c.observed.branch,
    dirty: c.observed.dirty,
    resolver: c.observed.resolver,
  };
}

function bindingView(b: BindingEvidence): BindingView {
  return {
    bindingId: b.bindingId,
    file: b.file,
    state: b.state,
    ...(b.problem ? { problem: b.problem } : {}),
    relation: b.claim?.relation ?? null,
    locator: b.claim?.locator.text ?? null,
    path: b.claim?.locator.path ?? null,
    selectorKind: b.claim?.locator.selector.kind ?? null,
    claimedAtRevision: b.claim?.modelRevision ?? null,
    provenance: b.claim ? { source: b.claim.provenance.source, principalId: b.claim.provenance.principalId } : null,
    pointer: b.locator
      ? {
          state: b.locator.state,
          detail: b.locator.detail,
          matches: b.locator.matches.slice(0, 5),
          matchesTotal: b.locator.matchesTotal,
        }
      : null,
    sourceFreshness: b.freshness ? { state: b.freshness.source.state, cause: b.freshness.source.cause } : null,
    modelFreshness: b.freshness ? { state: b.freshness.model.state, cause: b.freshness.model.cause } : null,
    disputed: b.disputed,
  };
}

function criterionView(c: CriterionEvidence, runs: number): CriterionView {
  return {
    verification: c.verification,
    mapping: c.mapping,
    assessment: c.assessment,
    result: c.result,
    resultObservedBy: c.resultObservedBy,
    runsSupplied: runs,
    mappings: c.mappings.map((m) => ({
      bindingId: m.bindingId,
      test: m.test ? `${m.test.path} > ${m.test.name}` : null,
      state: m.state,
      claimedAtRevision: m.claimedAtRevision,
      result: m.result
        ? {
            status: m.result.status,
            observedBy: m.result.observedBy,
            ...(m.result.message ? { message: m.result.message } : {}),
          }
        : null,
    })),
    problems: c.problems.map((p) => ({ code: p.code, message: p.message })),
  };
}

function ownedIds(model: Model, moduleId: string): { id: string; kind: string; name: string }[] | null {
  const mod = model.modules.find((m) => m.id === moduleId);
  if (!mod) return null;
  const out = [{ id: mod.id, kind: "module", name: mod.name ?? mod.id }];
  for (const coll of OWNED)
    for (const o of model[coll] ?? [])
      if (refId(o.owner) === moduleId) out.push({ id: o.id, kind: o.kind, name: o.name ?? o.id });
  return out;
}
