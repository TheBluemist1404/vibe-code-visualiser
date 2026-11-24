// Evidence views (M5.5): what the checkout's claims say about the model, verified now, with
// every layer labelled for what it is. A binding is a claim, an agent's report is a claim, a run
// handed to this host is a claim; VCV's own checks are shown as observations with their limits.
// Nothing here reasserts a claim, runs a test or records anything.
import { useEffect, useState } from "react";
import type {
  BindingView,
  CriterionView,
  EvidenceObservation,
  EvidenceStateName,
  ImplementationView,
  ModuleEvidenceView,
  ObjectEvidenceView,
} from "../../src/types.ts";
import { api, HostError } from "../api.ts";
import { Icon } from "../icons.tsx";
import type { IconName } from "../icons.tsx";
import { kindLabel, kindVar } from "../kinds.ts";

/** Load one evidence answer for the model the page is showing; a new key reloads it. */
export function useEvidence<T>(load: () => Promise<T>, key: string): { data?: T; error?: HostError | Error } {
  const [state, set] = useState<{ key: string; data?: T; error?: HostError | Error } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names everything `load` reads
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && set({ key, data }),
      (e: Error) => live && set({ key, error: e }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state && state.key === key ? state : {};
}

export const EV_STATE: Record<EvidenceStateName, { label: string; cls: string; icon: IconName; hint: string }> = {
  resolved: {
    label: "Resolved",
    cls: "ev-ok",
    icon: "ok",
    hint: "The pointer resolves and nothing changed since the claim",
  },
  stale: {
    label: "Stale",
    cls: "ev-warn",
    icon: "history",
    hint: "The code or the model object changed since the claim",
  },
  missing: { label: "Missing", cls: "ev-bad", icon: "x", hint: "The pointer no longer finds its code" },
  ambiguous: { label: "Ambiguous", cls: "ev-bad", icon: "alert", hint: "The pointer finds more than one place" },
  unchecked: { label: "Unchecked", cls: "ev-unknown", icon: "help", hint: "This kind of pointer is not checked here" },
  indeterminate: {
    label: "Indeterminate",
    cls: "ev-unknown",
    icon: "help",
    hint: "VCV could not tell (for example, no baseline)",
  },
  invalid: { label: "Unreadable", cls: "ev-bad", icon: "alert", hint: "The claim file cannot be read" },
};

export function StateChip({ state, count }: { state: EvidenceStateName | string; count?: number }) {
  const s = EV_STATE[state as EvidenceStateName] ?? { label: state, cls: "ev-unknown", icon: "help", hint: "" };
  return (
    <span className={`ev ${s.cls}`} title={s.hint} data-ev={state}>
      <Icon name={s.icon} small />
      {count !== undefined && <b>{count}</b>}
      {s.label}
    </span>
  );
}

function Problem({ error }: { error: HostError | Error }) {
  const moved = error instanceof HostError && error.code === "STATE_CHANGED";
  return (
    <div className={`notice ${moved ? "n-warn" : "n-danger"}`} data-testid={moved ? "evidence-moved" : undefined}>
      <Icon name={moved ? "history" : "alert"} />
      <div className="notice-body">
        {moved ? "The checkout moved while this was read. It reloads with the page." : error.message}
      </div>
    </div>
  );
}

function Observed({ o }: { o: EvidenceObservation }) {
  return (
    <p className="small muted ev-observed">
      Read just now from <span className="mono">{o.modelRevision}</span>
      {o.branch && ` on ${o.branch}`}
      {o.commit && (
        <>
          {" "}
          at <span className="mono">{o.commit.slice(0, 7)}</span>
        </>
      )}
      {o.dirty && ", with uncommitted changes"}.
    </p>
  );
}

/** For one object: every claim about it and what VCV observes about each, and for a criterion its tests. */
export function ObjectEvidence({ id, modelKey }: { id: string; modelKey: string }) {
  const { data, error } = useEvidence(() => api.evidence.object(id, modelKey), `${id}@${modelKey}`);
  return (
    <section className="sec" data-testid="object-evidence" aria-labelledby="ev-title">
      <h2 className="sec-head" id="ev-title">
        <Icon name="plug" /> Code and test evidence
        {data && <span className="count">{data.counts.total}</span>}
      </h2>
      {error && <Problem error={error} />}
      {!data && !error && <div className="skel" style={{ width: "100%", height: 48 }} />}
      {data && <ObjectEvidenceBody v={data} />}
    </section>
  );
}

function ObjectEvidenceBody({ v }: { v: ObjectEvidenceView }) {
  const states = (Object.keys(EV_STATE) as EvidenceStateName[]).filter((s) => v.counts[s] > 0);
  return (
    <>
      {v.criterion && <Criterion c={v.criterion} />}
      {v.counts.total === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          No claim points at code for this object yet. An agent records one with{" "}
          <span className="mono">vcv binding add</span>.
        </p>
      ) : (
        <>
          <div className="facts" data-testid="evidence-counts">
            {states.map((s) => (
              <StateChip key={s} state={s} count={v.counts[s]} />
            ))}
            {v.counts.disputed > 0 && <span className="chip chip-warn">{v.counts.disputed} disputed</span>}
          </div>
          <ul className="bindings">
            {v.bindings.map((b, i) => (
              <Binding key={b.bindingId} b={b} i={i} />
            ))}
          </ul>
          {v.truncated && (
            <p className="small muted" data-testid="evidence-truncated">
              Showing {v.bindings.length} of {v.matched} claims.
            </p>
          )}
        </>
      )}
      {v.unreadableClaims > 0 && (
        <p className="small muted">{v.unreadableClaims} claim files elsewhere could not be read.</p>
      )}
      <ul className="small muted handoff-notes">
        {v.limits.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <Observed o={v.observed} />
    </>
  );
}

function Binding({ b, i }: { b: BindingView; i: number }) {
  return (
    <li className="binding" data-binding={b.bindingId} data-state={b.state} style={{ "--i": i } as React.CSSProperties}>
      <div className="row binding-top">
        <StateChip state={b.state} />
        <span className="mono small">{b.bindingId}</span>
        {b.relation && <span className="small muted">{b.relation}</span>}
      </div>
      {b.locator && <div className="mono small binding-loc">{b.locator}</div>}
      {b.problem && <div className="small">{b.problem}</div>}
      <dl className="kv kv-tight">
        {b.pointer && (
          <>
            <dt>Pointer</dt>
            <dd>
              {b.pointer.state}: {b.pointer.detail}
              {b.pointer.matches[0] && (
                <span className="muted">
                  {" "}
                  (line {b.pointer.matches[0].line}
                  {b.pointer.matchesTotal > 1 ? `, ${b.pointer.matchesTotal} matches` : ""})
                </span>
              )}
            </dd>
          </>
        )}
        {b.sourceFreshness && (
          <>
            <dt>Code</dt>
            <dd>
              {b.sourceFreshness.state}: <span className="muted">{b.sourceFreshness.cause}</span>
            </dd>
          </>
        )}
        {b.modelFreshness && (
          <>
            <dt>Model</dt>
            <dd>
              {b.modelFreshness.state}: <span className="muted">{b.modelFreshness.cause}</span>
            </dd>
          </>
        )}
        {b.provenance && (
          <>
            <dt>Claimed by</dt>
            <dd>
              {b.provenance.principalId} <span className="muted">({b.provenance.source}, as the claim says)</span>
              {b.claimedAtRevision && (
                <>
                  {" "}
                  at <span className="mono">{b.claimedAtRevision}</span>
                </>
              )}
            </dd>
          </>
        )}
        {b.disputed && (
          <>
            <dt>Disputed</dt>
            <dd>
              by {b.disputed.by}: {b.disputed.reason}
            </dd>
          </>
        )}
        <dt>File</dt>
        <dd className="mono">{b.file}</dd>
      </dl>
    </li>
  );
}

const RESULT: Record<CriterionView["result"], { cls: string; word: string }> = {
  passed: { cls: "ev-ok", word: "Passed" },
  failed: { cls: "ev-bad", word: "Failed" },
  stale: { cls: "ev-warn", word: "Stale result" },
  missing: { cls: "ev-bad", word: "Not in the runs" },
  unknown: { cls: "ev-unknown", word: "Unknown" },
  unverified: { cls: "ev-unknown", word: "Unverified" },
};

function Criterion({ c }: { c: CriterionView }) {
  const r = RESULT[c.result];
  return (
    <div className="crit" data-testid="criterion-evidence" data-result={c.result}>
      <div className="row">
        <span className={`ev ${r.cls}`}>
          <Icon name="flask" small /> {r.word}
        </span>
        {c.resultObservedBy === "claimed" && <span className="chip chip-warn">claimed, not observed here</span>}
        <span className="small muted">
          {c.verification} criterion · mapping {c.mapping}
        </span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {c.runsSupplied === 0
          ? "No test runs were given to this host, so no result is known. Results come only from runs named when the explorer starts (--run); this page runs nothing."
          : `${c.runsSupplied} test run${c.runsSupplied === 1 ? "" : "s"} given at start. A run handed to this host is a claim, whatever it declares.`}
      </p>
      {c.mappings.length > 0 && (
        <ul className="list small">
          {c.mappings.map((m) => (
            <li key={m.bindingId} className="crit-map">
              <StateChip state={m.state} />
              <span className="mono">{m.test ?? m.bindingId}</span>
              {m.result && (
                <span className="muted">
                  {" "}
                  {m.result.status} ({m.result.observedBy.join(", ")}){m.result.message ? `: ${m.result.message}` : ""}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {c.problems.length > 0 && (
        <ul className="diag">
          {c.problems.map((p) => (
            <li key={p.code + p.message}>
              <span className="mono">{p.code}</span>
              <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** For a module: claims per owned object, by state. */
export function ModuleEvidence({
  id,
  modelKey,
  onOpen,
}: {
  id: string;
  modelKey: string;
  onOpen(objectId: string): void;
}) {
  const { data, error } = useEvidence(() => api.evidence.module(id, modelKey), `${id}@${modelKey}`);
  return (
    <section className="sec" data-testid="module-evidence" aria-labelledby="mev-title">
      <h2 className="sec-head" id="mev-title">
        <Icon name="plug" /> Evidence
      </h2>
      {error && <Problem error={error} />}
      {!data && !error && <div className="skel" style={{ width: "100%", height: 32 }} />}
      {data && <ModuleEvidenceBody v={data} id={id} onOpen={onOpen} />}
    </section>
  );
}

function ModuleEvidenceBody({ v, id, onOpen }: { v: ModuleEvidenceView; id: string; onOpen(o: string): void }) {
  const claimed = v.objects.filter((o) => o.claims > 0);
  const none = v.objects.length - claimed.length;
  return (
    <>
      {claimed.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          No claim points at code for anything this module owns.
        </p>
      ) : (
        <ul className="list">
          {claimed.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className="item"
                onClick={() => o.id !== id && onOpen(o.id)}
                data-testid={`mev-${o.id}`}
              >
                <span className="item-main">
                  <span className="item-title">
                    <span className="kind-badge" style={kindVar(o.kind)}>
                      {kindLabel(o.kind, 1)}
                    </span>{" "}
                    {o.name}
                  </span>
                  <span className="facts">
                    {Object.entries(o.states).map(([s, n]) => (
                      <StateChip key={s} state={s} count={n} />
                    ))}
                    {o.disputed > 0 && <span className="chip chip-warn">{o.disputed} disputed</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {none > 0 && claimed.length > 0 && (
        <p className="small muted" style={{ margin: 0 }}>
          {none} owned object{none === 1 ? " has" : "s have"} no claim yet.
        </p>
      )}
      {v.truncated && <p className="small muted">Only the first 200 claims were read; counts may leave some out.</p>}
      <Observed o={v.observed} />
    </>
  );
}

/** For an applied change: what was approved, what the agent says it did, and what VCV sees now. */
export function ImplementationSection({ changeId, modelKey }: { changeId: string; modelKey: string }) {
  const { data, error } = useEvidence(() => api.evidence.implementation(changeId, modelKey), `${changeId}@${modelKey}`);
  return (
    <section className="review-sec" data-testid="implementation" aria-labelledby="impl-title">
      <h3 id="impl-title" className="sec-head">
        <Icon name="pencil" /> Implementation
      </h3>
      {error && <Problem error={error} />}
      {!data && !error && <div className="skel" style={{ width: "100%", height: 48 }} />}
      {data && <ImplementationBody v={data} />}
    </section>
  );
}

function ImplementationBody({ v }: { v: ImplementationView }) {
  if (!v.handoff)
    return (
      <p className="small muted" style={{ margin: 0 }} data-testid="no-handoff">
        No implementation handoff here: {v.handoffProblem}
      </p>
    );
  const h = v.handoff;
  const r = v.report;
  return (
    <div className="impl">
      <div className="impl-layer" data-layer="approved">
        <span className="layer-tag">Approved intent</span>
        {h.request ? (
          <>
            <p className="declared">{h.request.behavior}</p>
            <ul className="small handoff-notes">
              {h.request.acceptanceCriteria.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            {h.request.scope && (
              <p className="small muted" style={{ margin: 0 }}>
                Scope: <span className="mono">{h.request.scope.join(", ")}</span>
              </p>
            )}
          </>
        ) : (
          <p className="small muted">The proposal carried no implementation request.</p>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          Handoff digest <span className="mono">{h.digest.slice(0, 12)}…</span> for{" "}
          <span className="mono">{h.approvedRevision}</span>; {h.bindingsTotal} claim
          {h.bindingsTotal === 1 ? "" : "s"} point at code that probably moves with it.
        </p>
      </div>

      {!r ? (
        <div className="impl-layer" data-layer="report">
          <span className="layer-tag">Agent's report</span>
          <p className="small muted" style={{ margin: 0 }} data-testid="no-report">
            No implementation report is recorded yet{v.reportProblem ? ` (${v.reportProblem})` : ""}. The implementing
            agent records one with <span className="mono">vcv implementation record</span>.
          </p>
        </div>
      ) : (
        <>
          <div className="impl-layer layer-claim" data-layer="report" data-testid="agent-report">
            <span className="layer-tag">Agent's report: claims</span>
            <p className="small" style={{ margin: 0 }}>
              {r.claims.note}
            </p>
            <dl className="kv kv-tight">
              <dt>By</dt>
              <dd>
                {r.claims.by} <span className="muted">(confidence {r.claims.confidence})</span>
              </dd>
              <dt>Tests run</dt>
              <dd>
                {r.claims.testsRun.length === 0
                  ? "none reported"
                  : r.claims.testsRun.map((t) => (
                      <div key={t.command}>
                        <span className="mono">{t.command}</span>: {t.outcome}
                        {t.summary ? ` (${t.summary})` : ""}
                      </div>
                    ))}
              </dd>
              {r.claims.acceptance.length > 0 && (
                <>
                  <dt>Acceptance</dt>
                  <dd>
                    {r.claims.acceptance.map((a) => (
                      <div key={a.criterion}>
                        {a.status}: {a.criterion}
                      </div>
                    ))}
                  </dd>
                </>
              )}
              {r.claims.gaps.length > 0 && (
                <>
                  <dt>Gaps</dt>
                  <dd>{r.claims.gaps.join("; ")}</dd>
                </>
              )}
            </dl>
          </div>
          <div className="impl-layer" data-layer="observed" data-testid="vcv-observed">
            <span className="layer-tag">What VCV observes now</span>
            <dl className="kv kv-tight">
              <dt>Files changed</dt>
              <dd>
                {r.observedNow.filesModified.length === 0 ? (
                  "none"
                ) : (
                  <span className="mono">{r.observedNow.filesModified.join(", ")}</span>
                )}
                {r.observedNow.filesTruncated && " (list cut)"}
              </dd>
              {r.observedNow.outOfScope.length > 0 && (
                <>
                  <dt>Out of scope</dt>
                  <dd className="mono">{r.observedNow.outOfScope.join(", ")}</dd>
                </>
              )}
              <dt>Claims</dt>
              <dd>
                {r.observedNow.bindings.map((b) => (
                  <div key={b.bindingId}>
                    <StateChip state={b.state} /> <span className="mono">{b.bindingId}</span>{" "}
                    <span className="muted">{b.reasserted ? "re-claimed after implementing" : "not re-claimed"}</span>
                  </div>
                ))}
              </dd>
            </dl>
            {r.changedSinceReport && (
              <p className="small" style={{ margin: 0 }}>
                The checkout changed since the report was recorded.
              </p>
            )}
          </div>
          {r.warnings.length > 0 && (
            <ul className="diag" data-testid="impl-warnings">
              {r.warnings.map((w) => (
                <li key={`${w.code}:${w.message}`} className="diag-warn">
                  <span className="mono">{w.code}</span>
                  <span>{w.message}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted" style={{ margin: 0 }}>
            {r.notReconciled}
          </p>
        </>
      )}
    </div>
  );
}
