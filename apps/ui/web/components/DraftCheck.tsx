// The engine's dry run of a draft, as the draft panel shows it: a status badge and the body
// (errors and warnings with hints, operations, the delta, modules touched, and what nobody checked).
import { useState } from "react";
import type { DraftPreview, ProposalDiagnostic } from "../../src/types.ts";
import { Icon } from "../icons.tsx";

export type Check =
  | { state: "checking" }
  | { state: "done"; preview: DraftPreview }
  | { state: "failed"; message: string };

export function CheckBadge({ check, stale }: { check: Check | null; stale: boolean }) {
  if (!check || check.state === "checking")
    return (
      <span className="state s-unknown" data-testid="check-state">
        <Icon name="refresh" small className="spin" /> Checking
      </span>
    );
  if (check.state === "failed")
    return (
      <span className="state s-danger" data-testid="check-state">
        <Icon name="alert" small /> Not checked
      </span>
    );
  const v = check.preview.validation;
  if (v.errors.length || !v.appliesToCurrent)
    return (
      <span className="state s-danger" data-testid="check-state">
        <Icon name="alert" small />{" "}
        {stale ? "Stale: needs agent integration" : `${v.errors.length} error${v.errors.length === 1 ? "" : "s"}`}
      </span>
    );
  return (
    <span className="state s-ok" data-testid="check-state">
      <Icon name="ok" small /> {check.preview.validation.warnings.length ? "Valid with warnings" : "Valid"} on{" "}
      {check.preview.expectedRevision}
    </span>
  );
}

function Diagnostics({ items, tone }: { items: ProposalDiagnostic[]; tone: "danger" | "warn" }) {
  return (
    <ul className="diag" data-testid={tone === "danger" ? "check-errors" : "check-warnings"}>
      {items.map((d) => (
        <li key={`${d.code}:${d.path}:${d.message}`} className={`diag-${tone}`}>
          <span className="mono">{d.code}</span>
          <span>
            {d.message}
            {d.path && <span className="mono muted"> at {d.path}</span>}
            {d.hint && <span className="small muted diag-hint">{d.hint}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CheckBody({ check }: { check: Check | null }) {
  if (!check || check.state === "checking")
    return (
      <div aria-busy="true" className="col-gap">
        <div className="skel" style={{ width: "70%", height: 14 }} />
        <div className="skel" style={{ width: "90%", height: 14 }} />
      </div>
    );
  if (check.state === "failed")
    return (
      <div className="notice n-danger">
        <Icon name="alert" />
        <div className="notice-body">{check.message}</div>
      </div>
    );
  const p = check.preview;
  return (
    <div className="col-gap" data-testid="check-body">
      {p.validation.errors.length > 0 && <Diagnostics items={p.validation.errors} tone="danger" />}
      {p.validation.warnings.length > 0 && <Diagnostics items={p.validation.warnings} tone="warn" />}
      <ol className="ops">
        {p.operations.map((o) => (
          <li key={o.index}>
            <span className="mono op">{o.type}</span> <span className="small">{o.summary}</span>
          </li>
        ))}
      </ol>
      <div className="small muted">Unsubmitted draft. Dry run on {p.expectedRevision}; nothing was recorded.</div>
      {p.delta && (
        <div className="delta" data-testid="check-delta">
          <span className="small muted">
            Before and after, against {p.delta.revision}
            {p.delta.against === "base" ? " (the draft's base, not the current model)" : ""}
          </span>
          <ul className="delta-list">
            {p.delta.changes.map((c) => (
              <li key={c.id}>
                <span className="small">
                  <strong>{c.name}</strong> <span className="mono muted">{c.id}</span> {c.change}
                </span>
                {c.fields.map((f) => (
                  <span key={f.field} className="small diff">
                    <span className="mono muted">{f.field}</span> <s className="muted">{f.before ?? "none"}</s>{" "}
                    <Icon name="arrowRight" small /> <span>{f.after ?? "none"}</span>
                    {f.truncated && <span className="muted"> (cut)</span>}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {p.delta.truncated && (
            <span className="small muted">
              Showing {p.delta.changes.length} of {p.delta.total} changes.
            </span>
          )}
        </div>
      )}
      {p.impact && p.impact.modules.length > 0 && (
        <div className="small" data-testid="check-impact">
          <span className="muted">Modules touched: </span>
          {p.impact.modules.map((m) => `${m.name} (${m.via})`).join(", ")}
          {p.impact.crossModule === "yes" ? ". Crosses modules." : ""}
        </div>
      )}
      {p.assumptions.length > 0 && (
        <details className="small assumptions">
          <summary>Not verified by this dry run ({p.assumptions.length})</summary>
          <ul>
            {p.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function Command({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <span className="small muted">{label}</span>
      <div className="cmd-row">
        <code className="code">{text}</code>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={`Copy: ${label}`}
          onClick={() =>
            navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              },
              () => {},
            )
          }
        >
          <Icon name={copied ? "ok" : "copy"} small />
        </button>
      </div>
    </div>
  );
}
