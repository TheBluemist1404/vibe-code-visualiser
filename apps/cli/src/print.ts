// Human-readable output for every command (the --json forms print the results as they are).
import type { Diagnostic, TreeNode } from "@vcv/ir";
import { formatLocator } from "@vcv/repo";
import type {
  GateReport,
  Reconciliation,
  HintedDiagnostic,
  IntegrityReport,
  ProjectStatus,
  ProposalPreview,
  RepoResult,
  Verification,
} from "@vcv/repo";
import type { ImplementationRequest, Outcome } from "@vcv/core";

export function printVerification(v: Verification) {
  const c = v.claim;
  if (!c) {
    console.log(`${v.bindingId}: invalid (${v.problem})`);
    return;
  }
  console.log(`${v.bindingId}: ${v.state}  ${c.modelObjectId} ${c.relation} ${formatLocator(c.locator)}`);
  console.log(
    `  claimed by ${c.provenance.source} ${c.provenance.principalId} at ${c.modelRevision}${c.provenance.confidence !== undefined ? `, confidence ${c.provenance.confidence}` : ""}; meaning not verified by VCV`,
  );
  console.log(`  locator: ${v.locator!.state}: ${v.locator!.detail}`);
  console.log(`  source:  ${v.source!.state}: ${v.source!.cause}`);
  console.log(`  model:   ${v.model!.state}: ${v.model!.cause}`);
  if (v.git.commitMoved)
    console.log(
      `  git:     commit moved since the claim (not evidence of drift by itself); file is ${v.git.workingTree}`,
    );
  if (v.disputed) console.log(`  disputed by ${v.disputed.by}: ${v.disputed.reason}`);
}

export function printDiagnostics(ds: Diagnostic[]) {
  for (const d of ds)
    console.log(`  ${d.severity === "error" ? "✗" : "!"} ${d.code} at ${d.path || "(root)"}: ${d.message}`);
}
export function printOutcome(o: Outcome) {
  const r = o.record;
  const rev = o.status === "applied" && r?.resultingRevision ? ` → ${r.resultingRevision}` : "";
  const who = r
    ? ` (proposed by ${r.proposerId}${r.approverId ? `, approved by ${r.approverId}` : ""}; record is ${r.status})`
    : " (not recorded)";
  console.log(`${o.changeId ?? "(no change id)"}: ${o.status}${rev}${who}`);
  printDiagnostics(o.diagnostics);
  return o.status === "applied" || o.status === "pending" ? 0 : 1;
}
export function printTree(n: TreeNode, depth = 0) {
  console.log(`${"  ".repeat(depth)}${n.kind} ${n.id}${n.name !== n.id ? ` "${n.name}"` : ""}`);
  n.children.forEach((c) => printTree(c, depth + 1));
}

export function printProject(s: ProjectStatus) {
  console.log(`project: ${s.state} (${s.storeDir})`);
  if (s.model)
    console.log(
      `model:   ${s.model.projectId} at ${s.model.revision} [${s.model.status}], ${s.model.history.length} revision(s)`,
    );
  if (s.git) {
    const where = s.git.branch ?? `detached at ${s.git.commit?.slice(0, 12) ?? "(no commits)"}`;
    console.log(
      `git:     ${where}${s.git.commit ? ` ${s.git.commit.slice(0, 12)}` : ""}${s.git.dirty ? ", working tree dirty" : ", clean"}${s.git.operation ? `, ${s.git.operation} in progress` : ""}`,
    );
  }
  for (const d of s.diagnostics)
    console.log(`  ${d.severity === "error" ? "✗" : d.severity === "warning" ? "!" : "·"} ${d.code}: ${d.message}`);
}

export function printHinted(ds: HintedDiagnostic[]) {
  for (const d of ds) {
    console.log(`  ${d.severity === "error" ? "✗" : "!"} ${d.code} at ${d.path || "(root)"}: ${d.message}`);
    if (d.hint) console.log(`      → ${d.hint}`);
  }
}

export function printResultError(r: Extract<RepoResult<unknown>, { ok: false }>) {
  console.log(`✗ ${r.error.code}: ${r.error.message}`);
  for (const d of r.error.details ?? []) console.log(`  ${d.path || "(root)"}: ${d.message}`);
}

export function printGate(d: GateReport) {
  const short = (c: string) => c.slice(0, 12);
  console.log(`vcv gate: ${d.decision.toUpperCase()}: ${d.headline}`);
  console.log(
    `  candidate ${short(d.candidate.commit)}${d.candidate.branch ? ` (${d.candidate.branch})` : ""} against base ${short(d.base.commit)}; ${d.change.kind} change (${d.change.changedFiles} file(s), ${d.change.introducedRevisions} new model revision(s), lineage ${d.change.lineage})`,
  );
  console.log(
    `  policy: ${d.policy.source} (${short(d.policy.digest)})${d.policy.changedByCandidate ? "; the candidate changes it (applies after merge)" : ""}`,
  );
  for (const run of d.runs) {
    const s = run.summary;
    console.log(
      `  run ${run.index}: ${run.observedBy === "host" ? "host-observed (captured here)" : "CLAIMED (imported)"} ${run.runner.name}: ${s.tests} case(s), ${s.passed} passed, ${s.failed} failed, ${s.errors} error(s), ${s.skipped} skipped; suite ${run.green ? "green" : "red"}${run.fresh ? "" : `; STALE: ${run.staleBecause.join("; ")}`}`,
    );
  }
  for (const c of d.criteria.items)
    console.log(
      `  ${c.result === "passed" && c.observedBy === "host" ? "✓" : "✗"} ${c.id} [${c.verification}] ${c.result}${c.observedBy ? ` (${c.observedBy})` : ""}  verifies ${c.verifies.join(", ")}`,
    );
  for (const r of d.reasons) {
    console.log(
      `  ${r.severity === "block" ? "BLOCK" : "warn "} ${r.code} [${r.rule}; ${r.basis}]${r.criterionId ? ` ${r.criterionId}` : ""}: ${r.message}`,
    );
  }
  if (d.reasonsTruncated || d.criteria.truncated || d.observationsTruncated)
    console.log(`  ! lists were cut (${d.reasonsTotal} reasons in total); use --json`);
  for (const n of d.notes) console.log(`  note: ${n}`);
  for (const o of d.observations)
    console.log(`  agent claim ${o.id} (${o.kind}, references ${o.references}): ${o.statement.slice(0, 200)}`);
  console.log("  not established here:");
  for (const l of d.limits) console.log(`    - ${l}`);
}

export function printReconciliation(d: Reconciliation) {
  const short = (c: string) => c.slice(0, 12);
  console.log(
    `reconciliation of ${d.candidate.projectId}: candidate ${short(d.candidate.commit)}${d.candidate.branch ? ` (${d.candidate.branch})` : ""}${d.candidate.dirty ? " + uncommitted edits" : ""} against base ${d.base.ref === d.base.commit ? short(d.base.commit) : `${d.base.ref} = ${short(d.base.commit)} (ref resolved locally; not pinned)`}`,
  );
  if (!d.base.containedInCandidate)
    console.log(
      `  ! the candidate does not contain the base; changes are measured from the merge base ${short(d.base.mergeBase)}`,
    );
  console.log(
    `  model: ${d.model.lineage}, ${d.base.modelRevision ?? "(no model)"} → ${d.candidate.modelRevision}; integrity ${d.model.integrity.ok ? "ok" : "FAILED"}; ${d.model.delta.total} object change(s)${d.model.impact ? `, ${d.model.impact.candidates.length} impact candidate(s), cross-module ${d.model.impact.crossModule}` : ""}`,
  );
  for (const r of d.model.introduced)
    console.log(`    ${r.revision}: ${r.derivation}${r.changeId ? ` by ${r.changeId}` : ""}; approval ${r.approval}`);
  for (const c of d.model.delta.changes)
    console.log(
      `    ${c.change} ${c.kind} ${c.id}${c.fields.length ? ` (${c.fields.map((f) => f.field).join(", ")})` : ""}`,
    );
  console.log(
    `  source: ${d.source.total} changed file(s), ${d.source.unmapped ?? "unknown (claims unreadable)"} file(s) outside .vcv/ unmapped`,
  );
  for (const f of d.source.files)
    console.log(
      `    ${f.committed ? "C" : " "}${f.uncommitted ? "W" : " "} ${f.area.padEnd(12)} ${f.path}${f.bindings.length ? `  ← ${f.bindings.join(", ")}` : ""}`,
    );
  if (d.sourceImpact) {
    const si = d.sourceImpact;
    console.log(
      `  source impact (declared-model context, not evidence of drift): seeds ${si.seeds.map((x) => x.objectId).join(", ")}; modules ${si.modules.map((m) => m.id).join(", ")}; ${si.total} impact candidate(s); cross-module ${si.crossModule}`,
    );
    if (si.contracts.length) console.log(`    contracts: ${si.contracts.map((c) => `${c.id} (${c.via})`).join(", ")}`);
    if (si.rules.length) console.log(`    rules: ${si.rules.map((r) => `${r.id} (${r.via})`).join(", ")}`);
  }
  if (!d.bindings.available) console.log(`  bindings: NOT ASSESSED (${d.bindings.problem})`);
  else console.log(`  bindings: ${d.bindings.total} shown, ${d.bindings.unaffected} unaffected and resolved`);
  for (const b of d.bindings.items)
    console.log(
      `    ${b.bindingId}: ${b.state ?? "removed"}; claim ${b.atBase}; object ${b.object}${b.boundFileChanged ? "; bound file changed" : ""}`,
    );
  console.log(`  findings (${d.findingsTotal}):`);
  for (const f of d.findings)
    console.log(`    [${f.category}/${f.basis}${f.related ? "" : ", unrelated"}] ${f.code}: ${f.message}`);
  if (d.budget.shrunk || d.findingsTruncated)
    console.log(
      `  ! lists were cut to fit the report budget (${d.budget.bytes}/${d.budget.limit} bytes); use --json for totals`,
    );
  console.log(`  semantic: ${d.semantic.note}`);
  console.log("  not established here:");
  for (const l of d.limits) console.log(`    - ${l}`);
}

export function printWarnings(ws: { code: string; message: string }[]) {
  for (const w of ws) console.log(`  ! ${w.code}: ${w.message}`);
}

function printImplementationRequest(r: ImplementationRequest) {
  console.log("implementation requested (approved together with the operations):");
  console.log(`  behavior: ${r.behavior}`);
  for (const c of r.acceptanceCriteria) console.log(`  ✓? ${c}`);
  for (const t of r.suggestedTests ?? []) console.log(`  test: ${t}`);
  console.log(`  scope: ${r.scope?.join(", ") ?? "(not declared)"}`);
}

export function printPreview(p: ProposalPreview, revision: string) {
  const q = p.proposal;
  console.log(
    `proposal ${q.changeId} (${q.origin === "record" ? `${q.lifecycle}, proposed by ${q.proposerId}` : "not submitted: dry run"})`,
  );
  console.log(`  digest:   ${q.proposalDigest}`);
  console.log(
    `  base:     ${q.baseRevision}; this checkout is at ${revision}${p.validation.appliesToCurrent ? " (applies)" : " (does not apply now)"}`,
  );
  if (q.rationale) console.log(`  why:      ${q.rationale}`);
  console.log(
    `  states:   change ${p.states.change}; approval ${p.states.approval}; snapshot ${p.states.snapshotStatus}; implementation ${p.states.implementation}`,
  );
  console.log("operations:");
  for (const o of q.operations) console.log(`  ${o.index + 1}. ${o.summary}`);
  if (q.implementation) printImplementationRequest(q.implementation);
  if (p.validation.errors.length || p.validation.warnings.length) {
    console.log("validation now:");
    printHinted([...p.validation.errors, ...p.validation.warnings]);
  }
  if (p.delta) {
    console.log(
      `model delta (against ${p.delta.against} ${p.delta.revision}; ${p.delta.total} object(s)${p.delta.truncated ? ", truncated" : ""}):`,
    );
    for (const c of p.delta.changes) {
      console.log(
        `  ${c.change === "added" ? "+" : c.change === "removed" ? "-" : "~"} ${c.kind} ${c.id}${c.moduleId ? ` [${c.moduleId}]` : ""}`,
      );
      if (c.change === "modified")
        for (const f of c.fields)
          console.log(`      ${f.field}: ${f.before ?? "(none)"}\n        → ${f.after ?? "(none)"}`);
    }
  }
  if (p.impact) {
    console.log(
      `impact (structural candidates only)${p.impact.crossModule === "yes" ? ": CROSS-MODULE" : p.impact.crossModule === "not-determined" ? ": cross-module not determined" : ""}:`,
    );
    console.log(`  modules:   ${p.impact.modules.map((m) => `${m.id} (${m.via})`).join(", ") || "(none)"}`);
    console.log(`  contracts: ${p.impact.contracts.map((c) => `${c.id} (${c.via})`).join(", ") || "(none)"}`);
    for (const c of p.impact.candidates) console.log(`  · ${c.kind} ${c.id}: ${c.reason}`);
    if (p.impact.truncated) console.log(`  … ${p.impact.total} candidates in all (cut by budget)`);
  }
  console.log(`binding claims to revisit (${p.bindings.total}):`);
  for (const b of p.bindings.items)
    console.log(`  ${b.bindingId}: ${b.modelObjectId} ${b.relation} ${b.locator} (${b.why})`);
  console.log("not verified by anyone yet:");
  for (const a of p.assumptions) console.log(`  - ${a}`);
}

export function printIntegrity(r: IntegrityReport) {
  console.log(`integrity: ${r.ok ? "ok" : "FAILED"}${r.projectId ? ` (${r.projectId} at ${r.revision})` : ""}`);
  if (r.base) console.log(`  base:  ${r.base.ref} ${r.base.commit.slice(0, 12)} at ${r.base.revision ?? "(no .vcv/)"}`);
  console.log(
    `  trust: ${r.trust ? `${r.trust.source}, ${r.trust.reviewers} reviewer(s); ${r.trust.anchor}` : "none"}`,
  );
  console.log(`  authorization: ${r.authorization}`);
  for (const c of r.revisions) {
    console.log(
      `  ${c.seq}. ${c.revision}${c.introduced ? " (new)" : ""}: ${c.derivation}${c.changeId ? ` by ${c.changeId}` : ""}; approval ${c.approval.state}${c.approval.detail ? ` (${c.approval.detail})` : ""}`,
    );
  }
  for (const p of r.problems) console.log(`  ${p.severity === "error" ? "✗" : "!"} ${p.code}: ${p.message}`);
  console.log("  not provable here:");
  for (const l of r.limits) console.log(`    - ${l}`);
}
