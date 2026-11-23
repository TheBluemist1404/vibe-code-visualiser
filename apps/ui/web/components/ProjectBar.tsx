// Which model, which commit, and whether the host is still watching the checkout.
import type { Observation, ProjectState } from "../../src/types.ts";
import type { Page } from "../App.tsx";
import { Icon } from "../icons.tsx";

const STATE: Record<ProjectState, { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "s-ok" },
  absent: { label: "No project", cls: "s-unknown" },
  uninitialized: { label: "Not initialized", cls: "s-unknown" },
  conflicted: { label: "Conflicted", cls: "s-danger" },
  diverged: { label: "Diverged", cls: "s-danger" },
  invalid: { label: "Invalid", cls: "s-danger" },
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ProjectBar({
  title,
  observation,
  refreshing,
  pulse,
  onRefresh,
  page,
  pending,
  onPage,
}: {
  title: string;
  observation: Observation | null;
  refreshing: boolean;
  pulse: number;
  onRefresh(): void;
  page: Page;
  /** Pending proposals in this checkout; null while there is no model to show. */
  pending: number | null;
  onPage(page: Page): void;
}) {
  const s = observation ? STATE[observation.state] : null;
  const git = observation?.git;
  return (
    <header className="bar">
      <span className="bar-title">
        <span className="logo" aria-hidden="true">
          V
        </span>
        {title}
      </span>
      {s && (
        <span className={`state ${s.cls}`} data-testid="project-state">
          <Icon name={observation?.state === "ready" ? "ok" : "alert"} small />
          {s.label}
        </span>
      )}
      {pending !== null && (
        <nav className="tabs" aria-label="Pages">
          <button
            type="button"
            className="tab"
            aria-current={page === "explorer" ? "page" : undefined}
            onClick={() => onPage("explorer")}
          >
            <Icon name="grid" /> Explorer
          </button>
          <button
            type="button"
            className="tab"
            aria-current={page === "proposals" ? "page" : undefined}
            onClick={() => onPage("proposals")}
            data-testid="tab-proposals"
          >
            <Icon name="inbox" /> Proposals
            {pending > 0 && (
              <span className="tab-badge" data-testid="pending-count">
                {pending}
                <span className="sr-only"> pending</span>
              </span>
            )}
          </button>
          <button
            type="button"
            className="tab"
            aria-current={page === "gate" ? "page" : undefined}
            onClick={() => onPage("gate")}
            data-testid="tab-gate"
          >
            <Icon name="pull" /> Before merging
          </button>
        </nav>
      )}
      <div className="bar-meta">
        {observation?.model && (
          <span title="Model revision in .vcv/HEAD">
            <Icon name="layers" />
            <span className="mono" data-testid="revision">
              {observation.model.revision}
            </span>
            {observation.model.status}
          </span>
        )}
        {git && (
          <>
            <span className="sep" />
            <span title="Checked-out branch">
              <Icon name="branch" />
              <span data-testid="branch">{git.branch ?? (git.detached ? "detached HEAD" : "no branch")}</span>
            </span>
            <span title="Git commit">
              <Icon name="commit" />
              <span className="mono">{git.commit ? git.commit.slice(0, 7) : "no commits"}</span>
            </span>
            <span className={git.dirty ? "dirty" : ""}>{git.dirty ? "uncommitted changes" : "clean"}</span>
          </>
        )}
      </div>
      <span className="spacer" />
      {observation && (
        <span className="live" title={observation.root}>
          <span key={pulse} className={`live-dot${refreshing ? " flash" : ""}`} />
          Watching {observation.root.split(/[\\/]/).pop()} · checked {time(observation.observedAt)}
        </span>
      )}
      <button type="button" className="btn" onClick={onRefresh} disabled={refreshing}>
        <Icon name="refresh" className={refreshing ? "spin" : ""} />
        Refresh
      </button>
    </header>
  );
}
