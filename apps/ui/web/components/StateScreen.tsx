// Full-screen states for a checkout whose model cannot be served, the first load, and a host
// that stopped answering. Each one says what VCV saw and that it changed nothing.
import type { Observation, ProjectState } from "../../src/types.ts";
import { Icon } from "../icons.tsx";
import type { IconName } from "../icons.tsx";

type Copy = { title: string; icon: IconName; color: string; lead: string; next?: string };

const COPY: Record<Exclude<ProjectState, "ready">, Copy> = {
  absent: {
    title: "No VCV project in this checkout",
    icon: "folder",
    color: "var(--unknown)",
    lead: "There is no .vcv/ directory here. VCV does not create one on its own.",
    next: "vcv project init <path> <model.yaml>",
  },
  uninitialized: {
    title: "The model store is not initialized",
    icon: "folder",
    color: "var(--unknown)",
    lead: ".vcv/ exists but has no HEAD, so there is no model to show. Nothing was created or repaired.",
    next: "vcv project init <path> <model.yaml>",
  },
  conflicted: {
    title: "The model has unresolved merge conflicts",
    icon: "merge",
    color: "var(--danger)",
    lead: "Files under .vcv/ contain Git conflict markers. VCV does not merge model histories, so nothing is shown until the merge is resolved.",
    next: "git status   # then resolve the merge, or check out one side",
  },
  diverged: {
    title: "Revisions from another branch are mixed in",
    icon: "branch",
    color: "var(--danger)",
    lead: "Some revision files are not in .vcv/HEAD's history. VCV will not drop or merge them on its own.",
  },
  invalid: {
    title: "The model store cannot be read",
    icon: "alert",
    color: "var(--danger)",
    lead: "HEAD or a committed revision is unreadable or inconsistent. Nothing was overwritten or repaired.",
  },
};

export function StateScreen({ observation, onRefresh }: { observation: Observation; onRefresh(): void }) {
  if (observation.state === "ready") return null;
  const c = COPY[observation.state];
  return (
    <div className="state-screen" data-testid={`state-${observation.state}`}>
      <div className="state-card" role="alert">
        <div className="row" style={{ gap: 16, flexWrap: "nowrap" }}>
          <span className="state-icon" style={{ "--c": c.color } as React.CSSProperties}>
            <Icon name={c.icon} />
          </span>
          <div>
            <h1>{c.title}</h1>
            <div className="small muted mono">{observation.root}</div>
          </div>
        </div>
        <p style={{ margin: 0 }}>{c.lead}</p>
        <ul className="diag" aria-label="Diagnostics">
          {observation.diagnostics.map((d) => (
            <li key={d.code + d.message}>
              <span
                className={`state ${d.severity === "error" ? "s-danger" : d.severity === "warning" ? "s-warn" : "s-unknown"}`}
              >
                {d.code}
              </span>
              <span>{d.message}</span>
            </li>
          ))}
        </ul>
        {c.next && (
          <div className="stack" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="small muted">Run this yourself when you are ready:</span>
            <code className="code">{c.next}</code>
          </div>
        )}
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={onRefresh}>
            <Icon name="refresh" />
            Check again
          </button>
          <span className="small muted">The explorer keeps watching and opens the model as soon as it is ready.</span>
        </div>
      </div>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <div className="body" aria-busy="true" data-testid="loading">
      <nav className="side">
        <div className="skel" style={{ height: 20, width: 100 }} />
        <div className="skel" style={{ height: 32 }} />
        {[0, 1, 2].map((i) => (
          <div key={i} className="skel" style={{ height: 40 }} />
        ))}
      </nav>
      <main className="canvas" style={{ display: "grid", placeItems: "center" }}>
        <div style={{ display: "grid", gap: 60, justifyItems: "center" }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skel" style={{ width: 260, height: 120, borderRadius: 8 }} />
          ))}
        </div>
      </main>
      <aside className="insp" style={{ padding: 16, gap: 12, display: "flex", flexDirection: "column" }}>
        <div className="skel" style={{ height: 24, width: 180 }} />
        <div className="skel" style={{ height: 60 }} />
      </aside>
    </div>
  );
}

export function HostDown({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="state-screen" data-testid="host-down">
      <div className="state-card" role="alert">
        <div className="row" style={{ gap: 16, flexWrap: "nowrap" }}>
          <span className="state-icon" style={{ "--c": "var(--warn)" } as React.CSSProperties}>
            <Icon name="plug" />
          </span>
          <h1>Lost the connection to the VCV host</h1>
        </div>
        <p style={{ margin: 0 }}>{message}</p>
        <code className="code">npm run ui -- &lt;checkout&gt;</code>
        <div>
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            <Icon name="refresh" />
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
