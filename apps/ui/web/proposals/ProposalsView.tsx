// The proposal inbox (M5.4): every recorded proposal in this checkout, and for one of them the
// engine's check, the lifecycle as separate facts, and the hand-offs. Read-only: approving is the
// reviewer's own CLI step (their key never reaches this page), and a stale or rejected proposal
// goes back to an agent. Nothing here submits, approves, rebases or edits.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Inbox, InboxItem, ProposalLifecycle, ProposalReview, ReviewStep } from "../../src/types.ts";
import { api, HostError } from "../api.ts";
import { CheckDetails, Command, Diagnostics } from "../components/DraftCheck.tsx";
import { ImplementationSection } from "../evidence/Evidence.tsx";
import { Icon } from "../icons.tsx";
import type { IconName } from "../icons.tsx";

/** While the inbox is open it follows the checkout closely; elsewhere only the pending count is kept fresh. */
const POLL_MS = { open: 3000, background: 15000 };

export const LIFECYCLE: Record<ProposalLifecycle, { label: string; cls: string; icon: IconName; hint: string }> = {
  pending: { label: "Pending review", cls: "s-warn", icon: "history", hint: "Waiting for a separate reviewer" },
  stale: { label: "Stale", cls: "s-danger", icon: "alert", hint: "Its base is no longer the current model" },
  rejected: { label: "Rejected", cls: "s-danger", icon: "x", hint: "Failed validation; final" },
  applied: { label: "Applied to model", cls: "s-ok", icon: "ok", hint: "Committed as a model revision" },
  invalid: { label: "Unreadable", cls: "s-unknown", icon: "help", hint: "The record file cannot be read" },
};
const ORDER: ProposalLifecycle[] = ["pending", "stale", "rejected", "applied", "invalid"];

export function useInbox(modelKey: string | null, open: boolean) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await api.proposals.list();
      setInbox((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the served model changes
  useEffect(() => {
    if (modelKey === null) return;
    load();
    const t = setInterval(load, open ? POLL_MS.open : POLL_MS.background);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", load);
    };
  }, [load, modelKey, open]);
  return { inbox, error, reload: load };
}

export function ProposalsView({
  inbox,
  error,
  selected,
  onSelect,
}: {
  inbox: Inbox | null;
  error: string | null;
  selected: string | null;
  onSelect(id: string | null): void;
}) {
  const [filter, setFilter] = useState<ProposalLifecycle | "all">("all");
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (inbox?.items ?? [])
      .filter((i) => filter === "all" || i.lifecycle === filter)
      .filter(
        (i) =>
          !q ||
          i.changeId.includes(q) ||
          (i.rationale ?? "").toLowerCase().includes(q) ||
          (i.proposerId ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => ORDER.indexOf(a.lifecycle) - ORDER.indexOf(b.lifecycle) || a.changeId.localeCompare(b.changeId));
  }, [inbox, filter, query]);

  // Select the first pending proposal on first open, so the page is never an empty right pane.
  useEffect(() => {
    if (!selected && inbox?.items.length) {
      const first = [...inbox.items].sort((a, b) => ORDER.indexOf(a.lifecycle) - ORDER.indexOf(b.lifecycle))[0];
      if (first) onSelect(first.changeId);
    }
  }, [selected, inbox, onSelect]);

  return (
    <div className="body inbox" data-testid="inbox">
      <nav className="side inbox-side" aria-label="Proposals">
        <div className="side-head">
          Proposals<span className="count">{inbox?.total ?? 0}</span>
        </div>
        <label className="search">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search change ID, proposer, rationale"
            aria-label="Search proposals"
          />
        </label>
        <fieldset className="filters">
          <legend className="sr-only">Filter by state</legend>
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label="All" n={inbox?.total ?? 0} />
          {ORDER.filter((l) => (inbox?.counts[l] ?? 0) > 0).map((l) => (
            <FilterChip
              key={l}
              active={filter === l}
              onClick={() => setFilter(l)}
              label={LIFECYCLE[l].label}
              n={inbox?.counts[l] ?? 0}
              testId={`filter-${l}`}
            />
          ))}
        </fieldset>
        {error && (
          <div className="notice n-danger small">
            <Icon name="alert" />
            <div className="notice-body">{error}</div>
          </div>
        )}
        {inbox && inbox.items.length === 0 && (
          <p className="small muted inbox-empty" data-testid="inbox-empty">
            No proposals in this checkout. An agent submits one with <code className="mono">vcv proposal submit</code>;
            drafts you hand off appear here once it does.
          </p>
        )}
        <ul className="props">
          {items.map((i) => (
            <li key={i.changeId}>
              <ProposalRow item={i} current={i.changeId === selected} onClick={() => onSelect(i.changeId)} />
            </li>
          ))}
        </ul>
        {inbox?.truncated && <p className="small muted">Showing the first {inbox.items.length}.</p>}
      </nav>
      <main className="review-col">
        {selected ? (
          <Review key={selected} changeId={selected} inbox={inbox} />
        ) : (
          <div className="review-empty muted">Select a proposal to review it.</div>
        )}
      </main>
    </div>
  );
}

function FilterChip({
  active,
  label,
  n,
  onClick,
  testId,
}: {
  active: boolean;
  label: string;
  n: number;
  onClick(): void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`fchip${active ? " is-on" : ""}`}
      aria-pressed={active}
      onClick={onClick}
      data-testid={testId}
    >
      {label} <span className="count">{n}</span>
    </button>
  );
}

function ProposalRow({ item, current, onClick }: { item: InboxItem; current: boolean; onClick(): void }) {
  const l = LIFECYCLE[item.lifecycle];
  return (
    <button
      type="button"
      className={`prop lc-${item.lifecycle}`}
      aria-current={current}
      onClick={onClick}
      data-testid={`proposal-${item.changeId}`}
    >
      <span className="prop-top">
        <span className="mono prop-id">{item.changeId}</span>
        <span className={`state ${l.cls}`} data-testid="row-state">
          <Icon name={l.icon} small /> {l.label}
        </span>
      </span>
      {item.rationale && <span className="item-sub">{item.rationale}</span>}
      <span className="small muted">
        {item.operations} operation{item.operations === 1 ? "" : "s"} · on{" "}
        <span className="mono">{item.baseRevision ?? "?"}</span> · {item.proposerId ?? "unknown proposer"}
      </span>
    </button>
  );
}

type Loaded = { state: "loading" } | { state: "ready"; review: ProposalReview } | { state: "failed"; message: string };

function Review({ changeId, inbox }: { changeId: string; inbox: Inbox | null }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const row = inbox?.items.find((i) => i.changeId === changeId);
  // What a refresh must notice: the record's state and digest, and the served model.
  const watch = `${row?.lifecycle}|${row?.proposalDigest}|${row?.resultingRevision}|${inbox?.modelKey}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the record or model moves
  useEffect(() => {
    let live = true;
    api.proposals.review(changeId).then(
      (review) => live && setLoaded({ state: "ready", review }),
      (e: unknown) =>
        live &&
        setLoaded({
          state: "failed",
          message:
            e instanceof HostError && e.code === "UNKNOWN_CHANGE"
              ? "This proposal is not in the checkout any more."
              : String((e as Error).message ?? e),
        }),
    );
    return () => {
      live = false;
    };
  }, [changeId, watch]);

  if (loaded.state === "loading")
    return (
      <div className="review" aria-busy="true">
        <div className="skel" style={{ width: "40%", height: 24 }} />
        <div className="skel" style={{ width: "80%", height: 14 }} />
      </div>
    );
  if (loaded.state === "failed")
    return (
      <div className="review">
        <div className="notice n-danger">
          <Icon name="alert" />
          <div className="notice-body">{loaded.message}</div>
        </div>
      </div>
    );
  const r = loaded.review;
  const l = LIFECYCLE[r.lifecycle];
  return (
    <article className="review" data-testid="review" aria-labelledby="review-title">
      <header className="review-head">
        <div className="row">
          <h2 id="review-title" className="review-title mono">
            {r.changeId}
          </h2>
          <span className={`state ${l.cls}`} data-testid="review-state">
            <Icon name={l.icon} small /> {l.label}
          </span>
        </div>
        {r.rationale && <p className="declared">{r.rationale}</p>}
        <dl className="kv">
          <dt>Digest</dt>
          <dd className="mono" data-testid="review-digest">
            {r.proposalDigest}
          </dd>
          <dt>Proposer</dt>
          <dd>
            {r.proposerId ?? "unknown"} <span className="muted small">(as recorded)</span>
          </dd>
          <dt>Base</dt>
          <dd className="mono">{r.baseRevision}</dd>
          <dt>Model now</dt>
          <dd className="mono">
            {r.currentRevision}
            {r.baseRevision !== r.currentRevision && r.lifecycle !== "applied" && (
              <span className="chip chip-warn">differs from base</span>
            )}
          </dd>
          {r.resultingRevision && (
            <>
              <dt>Applied as</dt>
              <dd className="mono">{r.resultingRevision}</dd>
            </>
          )}
          {r.recordedApproverId && (
            <>
              <dt>Approver</dt>
              <dd>
                {r.recordedApproverId} <span className="muted small">(as written in the record; not proof)</span>
              </dd>
            </>
          )}
        </dl>
      </header>

      <Steps steps={r.steps} />

      {r.reviewer && <ReviewerHandoff reviewer={r.reviewer} />}
      {r.agent && (
        <section className="handoff handoff-agent" data-testid="agent-handoff" aria-labelledby="agent-title">
          <h3 id="agent-title" className="sec-head">
            <Icon name="send" /> Back to an agent
          </h3>
          <p className="small">{r.agent.note}</p>
          {r.agent.commands.map((c) => (
            <Command key={c.label} label={c.label} text={c.text} />
          ))}
        </section>
      )}

      {r.lifecycle === "applied" && inbox && <ImplementationSection changeId={r.changeId} modelKey={inbox.modelKey} />}

      <section className="review-sec" aria-labelledby="check-title">
        <h3 id="check-title" className="sec-head">
          <Icon name="layers" /> What it changes
        </h3>
        <CheckDetails
          p={r.check}
          note={
            r.lifecycle === "applied"
              ? `Applied as ${r.resultingRevision ?? "a revision"}. Shown against its base ${r.baseRevision}; an applied change is not rechecked.`
              : r.check.validation.appliesToCurrent
                ? `Checked by the engine against ${r.currentRevision} just now. Nothing was recorded by this check.`
                : `Does not apply to ${r.currentRevision}: the errors above are the engine's own.`
          }
        />
        {r.atSubmission.length > 0 && r.lifecycle === "rejected" && (
          <div className="col-gap">
            <span className="small muted">Recorded when it was submitted</span>
            <Diagnostics items={r.atSubmission} tone="danger" />
          </div>
        )}
      </section>

      {r.bindings.total > 0 && (
        <section className="review-sec" aria-labelledby="bind-title" data-testid="review-bindings">
          <h3 id="bind-title" className="sec-head">
            <Icon name="plug" /> Code that probably moves with it ({r.bindings.total})
          </h3>
          <ul className="list small">
            {r.bindings.items.map((b) => (
              <li key={b.bindingId}>
                <span className="mono">{b.locator}</span>{" "}
                <span className="muted">
                  {b.relation} {b.modelObjectId} ({b.why})
                </span>
              </li>
            ))}
          </ul>
          <p className="small muted">{r.bindings.note}</p>
        </section>
      )}

      {r.integrityLimits.length > 0 && (
        <details className="small assumptions review-sec">
          <summary>What the integrity check cannot establish ({r.integrityLimits.length})</summary>
          <ul>
            {r.integrityLimits.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

const STEP: Record<ReviewStep["state"], { icon: IconName; cls: string; word: string }> = {
  done: { icon: "ok", cls: "st-done", word: "yes" },
  "not-yet": { icon: "circle", cls: "st-todo", word: "not yet" },
  failed: { icon: "x", cls: "st-failed", word: "no" },
  unknown: { icon: "help", cls: "st-unknown", word: "unknown" },
};

function Steps({ steps }: { steps: ReviewStep[] }) {
  return (
    <section className="review-sec" aria-labelledby="steps-title">
      <h3 id="steps-title" className="sec-head">
        <Icon name="shield" /> Where it stands
      </h3>
      <ol className="steps" data-testid="review-steps">
        {steps.map((s, i) => (
          <li
            key={s.id}
            className={`step ${STEP[s.state].cls}`}
            data-step={s.id}
            data-state={s.state}
            style={{ "--i": i } as React.CSSProperties}
          >
            <span className="step-mark">
              <Icon name={STEP[s.state].icon} small />
            </span>
            <span className="step-main">
              <span className="step-label">
                {s.label} <span className="sr-only">: {STEP[s.state].word}</span>
              </span>
              <span className="small muted">{s.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReviewerHandoff({ reviewer }: { reviewer: NonNullable<ProposalReview["reviewer"]> }) {
  return (
    <section className="handoff" data-testid="reviewer-handoff" aria-labelledby="reviewer-title">
      <h3 id="reviewer-title" className="sec-head">
        <Icon name="key" /> Approve in your own terminal
      </h3>
      <p className="small">
        Approval is signed with your reviewer key, which this page never sees. Run these yourself, outside any agent
        session. They are pinned to digest <span className="mono">{reviewer.digest.slice(0, 12)}…</span>
      </p>
      {reviewer.commands.map((c) => (
        <Command key={c.label} label={c.label} text={c.text} />
      ))}
      <ul className="small muted handoff-notes">
        {reviewer.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </section>
  );
}
