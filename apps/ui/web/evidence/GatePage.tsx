// The pre-merge page (M5.5): reconciliation and the policy gate, exactly as `vcv reconcile` and
// `vcv gate` compute them, against the base commit the person named when starting the explorer.
// The base is never guessed from local branch names; without it the page says what is missing
// and runs nothing. The decision shown is the gate's own; this page adds no verdict.
import { useState } from "react";
import type { GateView } from "../../src/types.ts";
import { api } from "../api.ts";
import { Command } from "../components/DraftCheck.tsx";
import { Icon } from "../icons.tsx";
import type { IconName } from "../icons.tsx";
import { useEvidence } from "./Evidence.tsx";

const DECISION: Record<"pass" | "warn" | "block", { label: string; cls: string; icon: IconName }> = {
  pass: { label: "Pass", cls: "s-ok", icon: "ok" },
  warn: { label: "Pass with warnings", cls: "s-warn", icon: "alert" },
  block: { label: "Blocked", cls: "s-danger", icon: "x" },
};
const BASIS: Record<string, string> = {
  checked: "checked by VCV",
  observed: "observed by VCV",
  "not-checked": "not checked",
  claim: "from a claim",
};

export function GatePage({ modelKey, root }: { modelKey: string; root: string }) {
  // Source edits do not move the model, so a person can ask for a fresh read; it is still only a read.
  const [round, setRound] = useState(0);
  const { data, error } = useEvidence(() => api.evidence.gate(modelKey), `${modelKey}#${round}`);
  return (
    <div className="review-col" data-testid="gate-page">
      <div className="review">
        <header className="review-head">
          <div className="row">
            <h2 className="review-title" style={{ fontFamily: "var(--font-sans)", flex: 1 }}>
              Before merging
            </h2>
            <button
              type="button"
              className="btn"
              onClick={() => setRound((r) => r + 1)}
              disabled={!data && !error}
              data-testid="gate-recheck"
            >
              Check again
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Reconciliation and the policy gate for this checkout against a protected base, as{" "}
            <span className="mono">vcv reconcile</span> and <span className="mono">vcv gate</span> compute them. Read
            when the page opens and whenever the model moves; after editing code, check again. Nothing is run, recorded
            or reasserted here.
          </p>
        </header>
        {error && (
          <div className="notice n-danger">
            <Icon name="alert" />
            <div className="notice-body">{error.message}</div>
          </div>
        )}
        {!data && !error && <div className="skel" style={{ width: "100%", height: 120 }} />}
        {data && <GateBody v={data} root={root} />}
      </div>
    </div>
  );
}

function GateBody({ v, root }: { v: GateView; root: string }) {
  return (
    <>
      <section className="review-sec" data-testid="gate-inputs" aria-labelledby="inputs-title">
        <h3 id="inputs-title" className="sec-head">
          <Icon name="info" /> Inputs
        </h3>
        <dl className="kv">
          <dt>Base commit</dt>
          <dd className="mono">{v.inputs.baseCommit ?? <span className="muted">not given</span>}</dd>
          <dt>Test runs</dt>
          <dd>
            {v.inputs.runs.length === 0 ? (
              <span className="muted">none given (every required criterion stays unverified)</span>
            ) : (
              <>
                <span className="mono">{v.inputs.runs.join(", ")}</span>{" "}
                <span className="muted">(records handed to this host are claims)</span>
              </>
            )}
          </dd>
          <dt>Policy</dt>
          <dd>{v.inputs.policy ? <span className="mono">{v.inputs.policy}</span> : "the built-in default"}</dd>
        </dl>
        {v.inputs.missing.length > 0 && (
          <div className="notice n-info" data-testid="gate-missing">
            <Icon name="info" />
            <div className="notice-body">
              <div className="notice-title">Not run: the protected base is not known</div>
              <span>
                Reconciliation and the gate compare against the protected branch's commit as the hosting service reports
                it. This explorer never guesses it from local branch names, which anyone with the checkout can move.
                Restart it with:
              </span>
              <ul className="small handoff-notes">
                {v.inputs.missing.map((m) => (
                  <li key={m} className="mono">
                    {m}
                  </li>
                ))}
              </ul>
              <Command label="Start the explorer with a base" text={`npm run ui -- ${root} --base-commit <sha>`} />
            </div>
          </div>
        )}
      </section>
      {v.problem && (
        <div className="notice n-danger" data-testid="gate-problem">
          <Icon name="alert" />
          <div className="notice-body">{v.problem}</div>
        </div>
      )}
      {v.gate && <Decision g={v.gate} />}
      {v.reconciliation && <Reconciliation r={v.reconciliation} />}
    </>
  );
}

function Decision({ g }: { g: NonNullable<GateView["gate"]> }) {
  const d = DECISION[g.decision];
  return (
    <section className="review-sec" data-testid="gate-decision" data-decision={g.decision} aria-labelledby="dec-title">
      <div className="row">
        <h3 id="dec-title" className="sec-head" style={{ margin: 0 }}>
          <Icon name="shield" /> Gate decision
        </h3>
        <span className={`state ${d.cls}`} data-testid="gate-state">
          <Icon name={d.icon} small /> {d.label}
        </span>
      </div>
      <p className="declared" style={{ margin: 0 }}>
        {g.headline}
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        {g.changeKind} change · policy {g.policy.source}
        {g.policy.changedByCandidate && " (changed by this candidate)"}
      </p>
      {g.reasons.length > 0 && (
        <ul className="diag" data-testid="gate-reasons">
          {g.reasons.map((r) => (
            <li
              key={`${r.code}:${r.criterionId ?? ""}:${r.rule}:${r.message}`}
              className={r.severity === "block" ? "diag-danger" : "diag-warn"}
              data-code={r.code}
            >
              <span className="mono">{r.code}</span>
              <span>
                {r.message}{" "}
                <span className="muted small">
                  ({r.severity}, {BASIS[r.basis] ?? r.basis}, rule {r.rule})
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {g.reasonsTotal > g.reasons.length && (
        <p className="small muted">
          Showing {g.reasons.length} of {g.reasonsTotal} reasons.
        </p>
      )}
      {g.criteria.length > 0 && (
        <table className="tbl" data-testid="gate-criteria">
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Verification</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {g.criteria.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td>{c.verification}</td>
                <td>
                  {c.result}
                  {c.observedBy && <span className="muted"> ({c.observedBy})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {g.runs.length > 0 && (
        <ul className="list small">
          {g.runs.map((r) => (
            <li key={r.index}>
              Run {r.index + 1}: {r.runner}, {r.summary.passed}/{r.summary.tests} passed, {r.summary.failed} failed ·{" "}
              {r.observedBy === "claimed" ? "a claim" : "captured by the host"}
              {!r.fresh && ` · stale (${r.staleBecause.join(", ")})`}
            </li>
          ))}
        </ul>
      )}
      <Limits items={g.limits} />
    </section>
  );
}

function Reconciliation({ r }: { r: NonNullable<GateView["reconciliation"]> }) {
  return (
    <section className="review-sec" data-testid="reconciliation" aria-labelledby="rec-title">
      <h3 id="rec-title" className="sec-head">
        <Icon name="pull" /> Reconciliation
      </h3>
      <dl className="kv">
        <dt>Base</dt>
        <dd>
          <span className="mono">{r.base.commit.slice(0, 12)}</span>{" "}
          <span className="muted">
            {r.base.containedInCandidate ? "contained in this checkout" : "not an ancestor of this checkout"}
            {r.base.modelRevision && `, model ${r.base.modelRevision}`}
          </span>
        </dd>
        <dt>Candidate</dt>
        <dd>
          <span className="mono">{r.candidate.commit.slice(0, 12)}</span>{" "}
          {r.candidate.branch && `on ${r.candidate.branch}`}
          {r.candidate.dirty && <span className="chip chip-warn">uncommitted changes</span>}{" "}
          <span className="muted">model {r.candidate.modelRevision}</span>
        </dd>
        <dt>Model line</dt>
        <dd>{r.lineage}</dd>
        <dt>Integrity</dt>
        <dd data-testid="rec-integrity" data-ok={String(r.integrity.ok)}>
          {r.integrity.ok ? "consistent and attested" : "failed"}{" "}
          <span className="muted small">({r.integrity.authorization})</span>
          {r.integrity.errors.map((e) => (
            <div key={e.code + e.message}>
              <span className="mono">{e.code}</span> {e.message}
            </div>
          ))}
        </dd>
      </dl>
      <p className="small muted" style={{ margin: 0 }}>
        Findings are facts, not a verdict: the gate above is what decides.
      </p>
      {r.findings.length > 0 && (
        <ul className="diag" data-testid="rec-findings">
          {r.findings.map((f) => (
            <li key={`${f.code}:${f.path ?? ""}:${f.message}`} data-category={f.category}>
              <span className="mono">{f.code}</span>
              <span>
                {f.message}{" "}
                <span className="muted small">
                  ({f.category}, {BASIS[f.basis] ?? f.basis}
                  {f.related ? ", about this change" : ""})
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {r.findingsTruncated && (
        <p className="small muted">
          Showing {r.findings.length} of {r.findingsTotal} findings.
        </p>
      )}
      {r.files.length > 0 && (
        <details className="small assumptions">
          <summary>
            Files changed since the base ({r.filesTotal}
            {r.filesTotal > r.files.length ? `, showing ${r.files.length}` : ""})
          </summary>
          <ul>
            {r.files.map((f) => (
              <li key={f.path}>
                <span className="mono">{f.path}</span> <span className="muted">{f.area}</span>
                {f.uncommitted && " (uncommitted)"}
                {f.objectIds.length > 0 && <span className="muted"> · {f.objectIds.join(", ")}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Limits items={r.limits} />
    </section>
  );
}

function Limits({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <details className="small assumptions">
      <summary>What this cannot establish ({items.length})</summary>
      <ul>
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </details>
  );
}
