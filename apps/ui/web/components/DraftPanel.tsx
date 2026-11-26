// The draft panel: this tab's local draft (staged typed operations, rationale, implementation request), the engine's
// dry run of it, the handoff for a coding agent, and every other draft or unreadable draft file
// for this checkout. It never submits or approves; a stale draft is shown as stale, not retargeted.
import { useEffect, useRef, useState } from "react";
import type { DraftRequest, DraftView, GraphView } from "../../src/types.ts";
import { api } from "../api.ts";
import { useDrafts } from "../drafts/DraftsProvider.tsx";
import { Icon } from "../icons.tsx";
import { CheckBadge, CheckBody } from "./DraftCheck.tsx";
import type { Check } from "./DraftCheck.tsx";
import { ExportDialog } from "./ExportDialog.tsx";

const fmt = (v: string | string[] | null, names: Map<string, string>) =>
  v === null || v === ""
    ? "none"
    : Array.isArray(v)
      ? v.length
        ? v.map((id) => names.get(id) ?? id).join(", ")
        : "none"
      : v;

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

/** The engine's dry run of the active draft, stamped with the draft version it was made for. */
function useCheck(draft: DraftView | null): Check | null {
  const key = draft?.steps.length ? `${draft.draftId}@${draft.version}@${draft.current.modelKey}` : null;
  const [stamped, setStamped] = useState<(Check & { key: string }) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names everything the dry run reads
  useEffect(() => {
    if (!draft || !key) return;
    let live = true;
    const t = setTimeout(() => {
      api.drafts.preview(draft.draftId).then(
        (preview) => live && setStamped({ state: "done", preview, key }),
        (e: Error) => live && setStamped({ state: "failed", message: e.message, key }),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  // Effects run after paint: without the stamp, the previous result would show for a newer draft.
  if (!key) return null;
  return stamped?.key === key ? stamped : { state: "checking" };
}

export function DraftPanel({ graph }: { graph: GraphView }) {
  const d = useDrafts();
  const { list, active } = d;
  const [open, setOpen] = useState(true);
  const [exporting, setExporting] = useState(false);
  const check = useCheck(active);
  const names = new Map(graph.modules.map((m) => [m.id, m.name]));
  if (!list || (list.drafts.length === 0 && list.problems.length === 0 && !d.notice)) return null;

  return (
    <section className={`tray${open ? " is-open" : ""}`} aria-label="Draft changes" data-testid="tray">
      <header className="tray-head">
        <button type="button" className="tray-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Icon name="chevron" small className="tray-chev" />
          <span className="tray-title">
            Draft changes
            {active && (
              <span className="count-pill" data-testid="staged-count">
                {active.steps.length}
              </span>
            )}
          </span>
        </button>
        {list.drafts.length > 0 && (
          <select
            className="select"
            aria-label="Open draft"
            value={active?.draftId ?? ""}
            onChange={(e) => d.select(e.target.value)}
            data-testid="draft-select"
          >
            {list.drafts.map((x) => (
              <option key={x.draftId} value={x.draftId}>
                {x.steps.length} edit{x.steps.length === 1 ? "" : "s"} on {x.base.revision}, {when(x.updatedAt)}
                {x.stale ? " (stale)" : ""}
              </option>
            ))}
          </select>
        )}
        {active && <CheckBadge check={check} stale={active.stale} />}
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={d.newDraft} data-testid="new-draft">
          New draft
        </button>
        {active && (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => d.discard(active.draftId, active.version)}
              data-testid="discard-draft"
            >
              Discard
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={active.steps.length === 0}
              onClick={() => {
                // Finish the field being edited first: its blur starts the save the handoff waits for.
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                setExporting(true);
              }}
              data-testid="export-draft"
            >
              <Icon name="send" small /> Hand off to agent
            </button>
          </>
        )}
      </header>
      {open && (
        <div className="tray-body">
          {d.notice && (
            <div className={`notice n-${d.notice.tone}`} data-testid="draft-notice">
              <Icon name="alert" />
              <div className="notice-body">
                <span>{d.notice.text}</span>
                <div className="row">
                  <button type="button" className="btn btn-ghost" onClick={d.dismissNotice}>
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}
          {list.problems.map((p) => (
            <div key={p.draftId} className="notice n-danger" data-testid={`draft-problem-${p.draftId}`}>
              <Icon name="alert" />
              <div className="notice-body">
                <div className="notice-title">
                  Draft file <span className="mono">{p.draftId}</span> cannot be read ({p.code})
                </div>
                <span>{p.message}. It was left as it is; nothing replaced it.</span>
                <div className="row">
                  <button type="button" className="btn" onClick={() => d.discard(p.draftId, null)}>
                    Discard this file
                  </button>
                </div>
              </div>
            </div>
          ))}
          {active?.stale && <StaleNotice draft={active} />}
          {active && (
            <div className="tray-cols">
              <div className="tray-col">
                <h3 className="tray-sub">
                  Staged operations{" "}
                  <span className="small muted">
                    local draft <span className="mono">{active.draftId}</span> on{" "}
                    <span className="mono">{active.base.revision}</span>
                  </span>
                </h3>
                {active.steps.length === 0 ? (
                  <p className="small muted" style={{ margin: 0 }}>
                    Empty. Edit a field in the inspector and stage it.
                  </p>
                ) : (
                  <ol className="staged" data-testid="steps">
                    {active.steps.map((s) => (
                      <li key={s.key} className="staged-item">
                        <span className="staged-main">
                          <span>
                            <span className="mono op">{s.operation.type}</span> <strong>{s.objectName}</strong>{" "}
                            <span className="muted">{s.label.toLowerCase()}</span>
                          </span>
                          <span className="small diff">
                            <s className="muted">{fmt(s.before, names)}</s> <Icon name="arrowRight" small />{" "}
                            <span>{fmt(s.after, names)}</span>
                          </span>
                        </span>
                        {!active.stale && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            aria-label={`Remove ${s.objectName} ${s.label}`}
                            onClick={() => d.unstage(s.key)}
                          >
                            <Icon name="x" small />
                          </button>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                <Rationale draft={active} onSave={d.setRationale} />
                <Request draft={active} onSave={d.setRequest} />
              </div>
              <div className="tray-col">
                <h3 className="tray-sub">Engine check</h3>
                {check ? (
                  <CheckBody check={check} />
                ) : (
                  <p className="small muted" style={{ margin: 0 }}>
                    Nothing to check yet.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {exporting && active && <ExportDialog draftId={active.draftId} onClose={() => setExporting(false)} />}
    </section>
  );
}

function StaleNotice({ draft }: { draft: DraftView }) {
  const where = (b: string | null) => (b ? ` on ${b}` : "");
  return (
    <div className="notice n-warn" data-testid="stale-draft">
      <Icon name="history" />
      <div className="notice-body">
        <div className="notice-title">Stale: needs agent integration</div>
        <span>
          This draft was staged on <span className="mono">{draft.base.revision}</span>
          {where(draft.base.branch)}; the checkout now holds <span className="mono">{draft.current.revision}</span>
          {where(draft.current.branch)}
          {draft.base.revision === draft.current.revision ? " (same name, different model)" : ""}. VCV keeps it exactly
          as staged and does not move it onto the new model. Hand it off so a coding agent can integrate it, or discard
          it.
        </span>
      </div>
    </div>
  );
}

function Rationale({ draft, onSave }: { draft: DraftView; onSave(text: string): Promise<void> }) {
  const [text, setText] = useState(draft.rationale);
  const shown = useRef(draft.rationale);
  // Take the stored text when the draft changes underneath (another tab, another draft).
  useEffect(() => {
    if (draft.rationale !== shown.current) {
      shown.current = draft.rationale;
      setText(draft.rationale);
    }
  }, [draft.rationale]);
  return (
    <>
      <label className="tray-sub" htmlFor="rationale">
        Why <span className="muted small">(goes into the handoff)</span>
      </label>
      <textarea
        id="rationale"
        className="input"
        rows={2}
        maxLength={4000}
        value={text}
        disabled={draft.stale}
        placeholder="What should the agent and the reviewer know?"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          shown.current = text;
          onSave(text);
        }}
      />
    </>
  );
}

type RequestText = { behavior: string; acceptanceCriteria: string; suggestedTests: string; scope: string };

const asText = (r: DraftRequest): RequestText => ({
  behavior: r.behavior,
  acceptanceCriteria: r.acceptanceCriteria.join("\n"),
  suggestedTests: r.suggestedTests.join("\n"),
  scope: r.scope.join("\n"),
});
const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
const asRequest = (t: RequestText): DraftRequest => ({
  behavior: t.behavior,
  acceptanceCriteria: lines(t.acceptanceCriteria),
  suggestedTests: lines(t.suggestedTests),
  scope: lines(t.scope),
});

const REQUEST_FIELDS: { key: keyof RequestText; label: string; hint: string; rows: number }[] = [
  { key: "behavior", label: "Behavior", hint: "What the code should do afterwards, in plain words", rows: 2 },
  { key: "acceptanceCriteria", label: "Acceptance criteria", hint: "One checkable statement per line", rows: 3 },
  { key: "suggestedTests", label: "Suggested tests", hint: "Optional, one per line", rows: 2 },
  { key: "scope", label: "Scope", hint: "Optional: paths or globs the agent may change, one per line", rows: 2 },
];

/**
 * What the coding agent is asked to build once the change is approved. It travels in the
 * handoff as the proposal's implementation request, so the reviewer approves it together with
 * the model edits and the digest covers it. Optional: a wording change may need none.
 */
function Request({ draft, onSave }: { draft: DraftView; onSave(r: DraftRequest): Promise<void> }) {
  const [text, setText] = useState(() => asText(draft.request));
  const shown = useRef(JSON.stringify(draft.request));
  useEffect(() => {
    const stored = JSON.stringify(draft.request);
    if (stored !== shown.current) {
      shown.current = stored;
      setText(asText(draft.request));
    }
  }, [draft.request]);
  const filled = Object.values(text).some((v) => v.trim());
  return (
    <details className="request" open={filled} data-testid="request">
      <summary className="tray-sub">
        Implementation request <span className="muted small">(optional; the agent builds this after approval)</span>
      </summary>
      {REQUEST_FIELDS.map((f) => (
        <div key={f.key} className="request-field">
          <label className="small" htmlFor={`request-${f.key}`}>
            {f.label} <span className="muted">· {f.hint}</span>
          </label>
          <textarea
            id={`request-${f.key}`}
            className="input"
            rows={f.rows}
            value={text[f.key]}
            disabled={draft.stale}
            onChange={(e) => setText((t) => ({ ...t, [f.key]: e.target.value }))}
            onBlur={() => {
              const next = asRequest(text);
              shown.current = JSON.stringify(next);
              onSave(next);
            }}
          />
        </div>
      ))}
    </details>
  );
}
