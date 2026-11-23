// The staged change: the edits, the engine's dry run of them, and submitting them as a pending
// proposal. The dry run reruns on every change to the draft and whenever the model moves.
// There is no approve button: approval is the reviewer's `vcv review approve` with their key.
import { useEffect, useRef, useState } from "react";
import type { DraftPreview, DraftRequest, GraphView, ProposalDiagnostic, SubmitView } from "../../src/types.ts";
import { api } from "../api.ts";
import type { Draft } from "../draft.tsx";
import { useDraft } from "../draft.tsx";
import { Icon } from "../icons.tsx";

type Check = { state: "checking" } | { state: "done"; preview: DraftPreview } | { state: "failed"; message: string };
/** A check result, stamped with the draft and model it was made for. */
type Stamped = Check & { key: string };

const request = (d: Draft): DraftRequest => ({
  expectedRevision: d.base.expectedRevision,
  modelKey: d.base.modelKey,
  ...(d.rationale.trim() ? { rationale: d.rationale } : {}),
  edits: d.edits.map(({ objectId, field, value }) => ({ objectId, field, value })),
});

export function ChangeTray({ graph }: { graph: GraphView }) {
  const draftApi = useDraft();
  const { draft } = draftApi;
  const [open, setOpen] = useState(true);
  const [stamped, setStamped] = useState<Stamped | null>(null);
  const [result, setResult] = useState<SubmitView | null>(null);
  const [sending, setSending] = useState(false);
  const seq = useRef(0);

  // What the dry run depends on: the edits and the model they are staged on, and the model now.
  const editsKey = draft ? JSON.stringify([request({ ...draft, rationale: "" }), graph.modelKey]) : null;
  // A result is shown only for the draft and model it was made for. Effects run after paint, so
  // without the stamp the previous result would show (and enable submit) for a newer draft.
  const check: Check | null = stamped && stamped.key === editsKey ? stamped : editsKey ? { state: "checking" } : null;
  const setCheck = (c: Check | null) => setStamped(c && editsKey ? { ...c, key: editsKey } : null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `editsKey` names everything the dry run reads
  useEffect(() => {
    if (!draft || !editsKey) return;
    const mine = ++seq.current;
    const key = editsKey;
    const t = setTimeout(() => {
      api.preview(request(draft)).then(
        (preview) => mine === seq.current && setStamped({ state: "done", preview, key }),
        (e: Error) => mine === seq.current && setStamped({ state: "failed", message: e.message, key }),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [editsKey]);

  if (result) return <Submitted result={result} onDone={() => setResult(null)} />;
  if (!draft) return null;

  const stale = draft.base.modelKey !== graph.modelKey;
  const preview = check?.state === "done" ? check.preview : null;
  const ready = !!preview && preview.validation.appliesToCurrent && preview.validation.errors.length === 0;
  const submit = async () => {
    setSending(true);
    try {
      const out = await api.submit(request(draft));
      if (out.recorded) {
        draftApi.clear();
        draftApi.markSubmitted();
        setResult(out);
      } else setCheck({ state: "done", preview: out.preview });
    } catch (e) {
      setCheck({ state: "failed", message: (e as Error).message });
    } finally {
      setSending(false);
    }
  };

  return (
    <section className={`tray${open ? " is-open" : ""}`} aria-label="Staged change" data-testid="tray">
      <header className="tray-head">
        <button type="button" className="tray-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Icon name="chevron" small className="tray-chev" />
          <span className="tray-title">
            Staged change
            <span className="count-pill" data-testid="staged-count">
              {draft.edits.length}
            </span>
          </span>
          <span className="small muted">
            on <span className="mono">{draft.base.expectedRevision}</span>
          </span>
        </button>
        <CheckBadge check={check} stale={stale} />
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={draftApi.clear}>
          Discard
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || sending}
          onClick={submit}
          data-testid="submit-proposal"
        >
          <Icon name="send" small /> Submit as proposal
        </button>
      </header>
      {open && (
        <div className="tray-body">
          {stale && (
            <div className="notice n-warn" data-testid="stale-draft">
              <Icon name="history" />
              <div className="notice-body">
                <div className="notice-title">The model moved since these edits were staged</div>
                <span>
                  They were staged on <span className="mono">{draft.base.expectedRevision}</span>; the checkout now
                  holds <span className="mono">{graph.revision}</span>. They are still checked against the revision they
                  were staged on, so the engine reports them stale. Restage them to check them against the current
                  model.
                </span>
                <div className="row">
                  <button type="button" className="btn" onClick={draftApi.restage}>
                    Restage on {graph.revision}
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="tray-cols">
            <div className="tray-col">
              <h3 className="tray-sub">Edits</h3>
              <ul className="staged">
                {draft.edits.map((e) => (
                  <li key={`${e.objectId}:${e.field}`} className="staged-item">
                    <span className="staged-main">
                      <span>
                        <strong>{e.objectName}</strong> <span className="muted">{e.label.toLowerCase()}</span>
                      </span>
                      <span className="small diff">
                        <s className="muted">{fmt(e.before)}</s> <Icon name="arrowRight" small />{" "}
                        <span>{fmt(e.value)}</span>
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label={`Unstage ${e.objectName} ${e.label}`}
                      onClick={() => draftApi.unstage(e.objectId, e.field)}
                    >
                      <Icon name="x" small />
                    </button>
                  </li>
                ))}
              </ul>
              <label className="tray-sub" htmlFor="rationale">
                Why <span className="muted small">(recorded with the proposal)</span>
              </label>
              <textarea
                id="rationale"
                className="input"
                rows={2}
                value={draft.rationale}
                placeholder="What should the reviewer know?"
                onChange={(e) => draftApi.setRationale(e.target.value)}
              />
            </div>
            <div className="tray-col">
              <h3 className="tray-sub">Engine check</h3>
              <CheckBody check={check} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

const fmt = (v: string | string[] | null) =>
  v === null || v === "" ? "none" : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : v;

function CheckBadge({ check, stale }: { check: Check | null; stale: boolean }) {
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
        <Icon name="alert" small /> {stale ? "Stale" : `${v.errors.length} error${v.errors.length === 1 ? "" : "s"}`}
      </span>
    );
  return (
    <span className="state s-ok" data-testid="check-state">
      <Icon name="ok" small /> Valid on {check.preview.currentRevision}
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

function CheckBody({ check }: { check: Check | null }) {
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
      {p.delta && (
        <div className="small">
          <span className="muted">Changes against {p.delta.revision}: </span>
          {p.delta.changes.map((c) => `${c.name} (${c.fields.map((f) => f.field).join(", ") || c.change})`).join("; ")}
        </div>
      )}
      {p.impact && p.impact.modules.length > 0 && (
        <div className="small" data-testid="check-impact">
          <span className="muted">Modules touched: </span>
          {p.impact.modules.map((m) => `${m.name} (${m.via})`).join(", ")}
        </div>
      )}
    </div>
  );
}

function Submitted({ result, onDone }: { result: SubmitView; onDone(): void }) {
  return (
    <section className="tray is-open is-done" aria-label="Proposal submitted" data-testid="submit-result">
      <div className="tray-body">
        <div className="notice n-ok">
          <Icon name="ok" />
          <div className="notice-body">
            <div className="notice-title">
              Proposal <span className="mono">{result.changeId}</span> is waiting for review
            </div>
            <span>
              Recorded as pending for <span className="mono">{result.proposerId}</span>. The model is still at{" "}
              <span className="mono">{result.modelRevision.after}</span>; nothing changes until a reviewer approves it
              with their own key. The browser cannot approve.
            </span>
            {result.commands && (
              <>
                <Command label="Review it" text={result.commands.preview} />
                <Command label="Approve it (reviewer)" text={result.commands.approve} />
              </>
            )}
            <div className="row">
              <button type="button" className="btn" onClick={onDone}>
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Command({ label, text }: { label: string; text: string }) {
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
