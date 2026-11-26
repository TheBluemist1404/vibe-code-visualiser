// The handoff for a coding agent: the strict proposed change (what `vcv proposal preview --file`
// and `vcv proposal submit` read) and, separately, the context it came from. Labelled with what
// the engine's dry run found; it never claims a submission, an approval or an implementation.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DraftExport } from "../../src/types.ts";
import { api } from "../api.ts";
import { Icon } from "../icons.tsx";
import { Command } from "./DraftCheck.tsx";

const LABEL: Record<DraftExport["metadata"]["check"], { tone: string; title: string }> = {
  valid: { tone: "n-ok", title: "Checked by the engine: applies to its base revision" },
  warnings: { tone: "n-ok", title: "Checked by the engine: applies, with warnings" },
  invalid: { tone: "n-danger", title: "Needs repair: the engine refused this change" },
  stale: { tone: "n-warn", title: "Stale: needs agent integration" },
};

export function ExportDialog({ draftId, onClose }: { draftId: string; onClose(): void }) {
  const [out, setOut] = useState<DraftExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.drafts.export(draftId).then(setOut, (e: Error) => setError(e.message));
  }, [draftId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changeText = out ? `${JSON.stringify(out.change, null, 2)}\n` : "";
  const download = () => {
    if (!out) return;
    const url = URL.createObjectURL(new Blob([changeText], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = out.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };
  const label = out ? LABEL[out.metadata.check] : null;

  // Rendered into <body>: the draft tray it opens from keeps a transform from its entry
  // animation, and a transformed ancestor would pin this fixed backdrop to the tray, not the window.
  return createPortal(
    <div className="dialog-backdrop">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Hand off to a coding agent"
        data-testid="export-dialog"
      >
        <header className="dialog-head">
          <h2>Hand off to a coding agent</h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" small />
          </button>
        </header>
        {error && (
          <div className="notice n-danger">
            <Icon name="alert" />
            <div className="notice-body">{error}</div>
          </div>
        )}
        {!out && !error && <div className="skel" style={{ height: 160 }} />}
        {out && label && (
          <div className="dialog-body">
            <div className={`notice ${label.tone}`} data-testid="export-check" data-check={out.metadata.check}>
              <Icon name={out.metadata.needsAgent ? "alert" : "ok"} />
              <div className="notice-body">
                <div className="notice-title">{label.title}</div>
                <span>{out.metadata.note}</span>
              </div>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              An unsubmitted proposed change on <span className="mono">{out.change.expectedRevision}</span>. Give it to
              your coding agent: it integrates the change with the code and tests and decides when to submit it. A
              reviewer approves it later with their own key.
            </p>
            <div className="cmd">
              <div className="row">
                <span className="tray-sub">Proposed change</span>
                <span className="mono small muted">{out.fileName}</span>
                <span className="spacer" />
                <CopyButton text={changeText} label="Copy change" testId="copy-change" />
                <button type="button" className="btn" onClick={download}>
                  Download
                </button>
              </div>
              <pre className="code export" data-testid="export-change">
                {changeText}
              </pre>
            </div>
            <Command label="Check it with the CLI" text={out.commands.preview} />
            <details className="small">
              <summary>Context for the agent (separate from the change)</summary>
              <pre className="code export" data-testid="export-metadata">
                {JSON.stringify(out.metadata, null, 2)}
              </pre>
              <CopyButton text={JSON.stringify(out.metadata, null, 2)} label="Copy context" testId="copy-metadata" />
            </details>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="btn"
      data-testid={testId}
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => setState("copied"),
          () => setState("failed"),
        ) ?? setState("failed")
      }
    >
      <Icon name={state === "copied" ? "ok" : "copy"} small />
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed; select the text" : label}
    </button>
  );
}
