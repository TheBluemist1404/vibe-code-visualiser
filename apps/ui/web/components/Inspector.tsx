// The inspector: project summary, a module with what it owns, or one object. Values shown are
// read from the current model revision; edits are only staged here (Fields.tsx, ChangeTray.tsx).
import { useEffect, useState } from "react";
import type {
  GraphView,
  ModelChange,
  ModuleView,
  ObjectRef,
  Observation,
  OwnedObject,
  Position,
} from "../../src/types.ts";
import { api } from "../api.ts";
import { useDraft } from "../draft.tsx";
import { Icon } from "../icons.tsx";
import { KIND_ORDER, kindLabel, kindTitle, kindVar } from "../kinds.ts";
import { Fields } from "./Fields.tsx";

export type InspectorTarget =
  | { kind: "project" }
  | { kind: "module"; id: string }
  /** `moduleId` is the module that owns the object, or null for project-level objects (actors). */
  | { kind: "object"; id: string; moduleId: string | null };

type Props = {
  target: InspectorTarget;
  graph: GraphView;
  observation: Observation;
  change: ModelChange | null;
  onSelectModule(id: string | null): void;
  onOpenObject(id: string, moduleId: string | null): void;
  onUnpin(id: string): void;
};

export function Inspector(props: Props) {
  const { target } = props;
  const key = target.kind === "project" ? "project" : `${target.kind}:${target.id}`;
  return (
    <aside className="insp" aria-label="Inspector">
      <div className="insp-anim" key={key}>
        {target.kind === "project" && <ProjectPanel {...props} />}
        {target.kind === "module" && <ModulePanel {...props} id={target.id} />}
        {target.kind === "object" && <ObjectPanel {...props} id={target.id} />}
      </div>
    </aside>
  );
}

/**
 * Load something for one model. The answer is stamped with the key it was requested for and
 * shown only while that key is current and the host read it from the same model (`modelKey`),
 * so after a branch switch or a new revision the inspector shows a loading state, never the
 * previous model's details beside the new canvas.
 */
function useRead<T extends { modelKey: string }>(
  load: () => Promise<T>,
  id: string,
  modelKey: string,
): { data?: T; error?: string } {
  const key = `${id}@${modelKey}`;
  const [state, set] = useState<{ key: string; data?: T; error?: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names everything `load` reads
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && set({ key, data }),
      (e: Error) => live && set({ key, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  if (!state || state.key !== key) return {};
  if (state.data && state.data.modelKey !== modelKey) return {}; // the host already moved on; the next poll catches up
  return state;
}

function Crumbs({ parts }: { parts: { label: string; onClick?: () => void }[] }) {
  return (
    <div className="crumbs" data-testid="crumbs">
      {parts.map((p, i) => (
        <span key={p.label} className="row" style={{ gap: 4 }}>
          {i > 0 && <Icon name="right" small />}
          {p.onClick ? (
            <button type="button" className="link" onClick={p.onClick}>
              {p.label}
            </button>
          ) : (
            p.label
          )}
        </span>
      ))}
    </div>
  );
}

function Loading() {
  return (
    <div className="insp-head" aria-busy="true">
      <div className="skel" style={{ width: 120, height: 14 }} />
      <div className="skel" style={{ width: 220, height: 24 }} />
      <div className="skel" style={{ width: "100%", height: 40 }} />
      <div className="skel" style={{ width: "80%", height: 14 }} />
    </div>
  );
}

function ReadError({ message }: { message: string }) {
  return (
    <div className="sec">
      <div className="notice n-danger">
        <Icon name="alert" />
        <div className="notice-body">{message}</div>
      </div>
    </div>
  );
}

const LINE: Record<ModelChange["modelLine"], string> = {
  advanced: "Advanced to a newer revision",
  rewound: "Went back to an earlier revision",
  switched: "Switched to another line of history",
  appeared: "A model appeared",
  disappeared: "The model is no longer readable",
};

function ProjectPanel({ graph, observation, change, onSelectModule }: Props) {
  const names = new Map(graph.modules.map((m) => [m.id, m.name]));
  const inventory: Record<string, number> = {};
  for (const m of graph.modules) for (const [k, n] of Object.entries(m.owned)) inventory[k] = (inventory[k] ?? 0) + n;
  const pinned = Object.values(graph.positions).filter((p) => p.pinned).length;
  return (
    <>
      <div className="insp-head">
        <Crumbs parts={[{ label: "Project" }]} />
        <h1 className="insp-name">{graph.project.name}</h1>
        <div className="row small muted">
          <span className="mono">{graph.project.id}</span>
          <span>in {graph.revision}</span>
        </div>
        {graph.project.description && <p className="note">{graph.project.description}</p>}
      </div>
      <div className="insp-scroll">
        {change && (
          <section className="sec" style={{ "--i": 0 } as React.CSSProperties} data-testid="what-changed">
            <h2 className="sec-head">
              <Icon name="history" /> What changed
            </h2>
            <dl className="kv">
              <dt>Movement</dt>
              <dd>{LINE[change.modelLine]}</dd>
              <dt>Before</dt>
              <dd>
                <span className="mono">{change.before.revision ?? "none"}</span>
                {change.before.branch && ` on ${change.before.branch}`}
              </dd>
              <dt>Now</dt>
              <dd>
                <span className="mono">{change.after.revision ?? "none"}</span>
                {change.after.branch && ` on ${change.after.branch}`}
              </dd>
              <dt>Modules</dt>
              <dd>
                {change.added.length === 0 && change.removed.length === 0 && "Same modules"}
                {change.added.map((id) => (
                  <div key={id}>
                    +{" "}
                    <button type="button" className="link" onClick={() => onSelectModule(id)}>
                      {names.get(id) ?? id}
                    </button>
                  </div>
                ))}
                {change.removed.map((id) => (
                  <div key={id} className="muted">
                    − {id}
                  </div>
                ))}
              </dd>
              <dt>Layout</dt>
              <dd>Pinned and already-placed modules kept their positions; new modules were placed in free space.</dd>
            </dl>
          </section>
        )}
        <section className="sec" style={{ "--i": 1 } as React.CSSProperties}>
          <div className="stat-row">
            <div className="stat">
              <b>{graph.modules.length}</b>
              <span>modules</span>
            </div>
            <div className="stat">
              <b>{graph.edges.length}</b>
              <span>relationships</span>
            </div>
            <div className="stat">
              <b>{pinned}</b>
              <span>pinned by you</span>
            </div>
          </div>
        </section>
        <section className="sec" style={{ "--i": 2 } as React.CSSProperties}>
          <h2 className="sec-head">Declared objects</h2>
          <div className="inv">
            {KIND_ORDER.filter((k) => inventory[k]).map((k) => (
              <span key={k} className="chip" style={kindVar(k)}>
                <span className="dot" />
                {inventory[k]} {kindLabel(k, inventory[k])}
              </span>
            ))}
          </div>
        </section>
        <section className="sec" style={{ "--i": 3 } as React.CSSProperties}>
          <h2 className="sec-head">Modules</h2>
          <ul className="list">
            {graph.modules.map((m) => (
              <li key={m.id}>
                <button type="button" className="item" onClick={() => onSelectModule(m.id)}>
                  <Icon name="layers" />
                  <span className="item-main">
                    <span className="item-title">{m.name}</span>
                    {m.purpose && <span className="item-sub">{m.purpose}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="sec" style={{ "--i": 4 } as React.CSSProperties}>
          <h2 className="sec-head">Checkout</h2>
          <dl className="kv">
            <dt>Path</dt>
            <dd className="mono">{observation.root}</dd>
            <dt>History</dt>
            <dd>{observation.model?.history.length ?? 0} revisions</dd>
            <dt>Validation</dt>
            <dd>
              {graph.validation.errors} errors, {graph.validation.warnings} warnings
            </dd>
          </dl>
        </section>
        <PendingProposals modelKey={graph.modelKey} />
        <Diagnostics observation={observation} />
      </div>
    </>
  );
}

/** Proposals recorded in this checkout and waiting for a reviewer. Read-only: no approve here. */
function PendingProposals({ modelKey }: { modelKey: string }) {
  const { submitted } = useDraft();
  const { data, error } = useRead(() => api.proposals(), `proposals:${submitted}`, modelKey);
  if (error || !data || data.total === 0) return null;
  return (
    <section className="sec" data-testid="pending-proposals">
      <h2 className="sec-head">
        <Icon name="send" /> Waiting for review<span className="count">{data.total}</span>
      </h2>
      <ul className="list">
        {data.proposals.map((p) => (
          <li key={p.changeId} className="pending">
            <span className="item-main">
              <span className="item-title mono">{p.changeId}</span>
              <span className="item-sub">
                {p.lifecycle === "stale" ? "stale, " : ""}
                {p.operations} operation{p.operations === 1 ? "" : "s"} on {p.baseRevision} by {p.proposerId}
                {p.rationale ? `: ${p.rationale}` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="small muted" style={{ margin: "var(--space-2) 0 0" }}>
        A reviewer approves with <span className="mono">vcv review approve</span> and their own key. The browser cannot.
      </p>
    </section>
  );
}

function Diagnostics({ observation }: { observation: Observation }) {
  if (observation.diagnostics.length === 0) return null;
  return (
    <section className="sec">
      <h2 className="sec-head">Notes from the host</h2>
      <ul className="diag">
        {observation.diagnostics.map((d) => (
          <li key={d.code + d.message}>
            <span className="mono">{d.code}</span>
            <span>{d.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PinPanel({ position, onUnpin }: { position?: Position; onUnpin(): void }) {
  if (!position?.pinned) return null;
  return (
    <div className="pin-panel" data-testid="pin-panel">
      <Icon name="pin" small />
      <span className="small" style={{ flex: 1 }}>
        <strong>Pinned here.</strong> Saved on this computer only. Not part of the model.
      </span>
      <button type="button" className="btn" onClick={onUnpin}>
        Unpin
      </button>
    </div>
  );
}

function LinkList({
  title,
  icon,
  links,
  onSelect,
  declarer,
}: {
  title: string;
  icon: "arrowRight" | "arrowLeft";
  links: ModuleView["dependsOn"];
  onSelect(id: string): void;
  declarer(l: ModuleView["dependsOn"][number]): string;
}) {
  return (
    <section className="sec">
      <h2 className="sec-head">
        {title}
        <span className="count">{links.length}</span>
      </h2>
      {links.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          None declared.
        </p>
      ) : (
        <ul className="list">
          {links.map((l) => (
            <li key={`${l.kind}:${l.id}`}>
              <button type="button" className="item" onClick={() => onSelect(l.id)} data-testid={`link-${l.id}`}>
                <Icon name={icon} />
                <span className="item-main">
                  <span className="item-title">{l.name}</span>
                  <span className="item-sub">
                    {l.kind === "consumes" ? `consumes ${l.via.join(", ")}` : "dependsOn"}, declared by{" "}
                    <span className="mono">{declarer(l)}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OwnedSection({ kind, items, onOpen }: { kind: string; items: OwnedObject[]; onOpen(id: string): void }) {
  return (
    <section className="sec" data-testid={`owned-${kind}`}>
      <h2 className="sec-head" style={kindVar(kind)}>
        <span className="dot" />
        {kindTitle(kind, items.length)}
        <span className="count">{items.length}</span>
      </h2>
      <ul className="list">
        {items.map((o) => (
          <li key={o.id}>
            <button type="button" className="item" onClick={() => onOpen(o.id)}>
              <span className="item-main">
                <span className="item-title">{o.name}</span>
                {o.text && <span className="item-sub">{o.text}</span>}
                {o.facts.length > 0 && (
                  <span className="facts">
                    {o.facts.map((f) => (
                      <span key={f} className="chip">
                        {f}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ModulePanel({ id, graph, onSelectModule, onOpenObject, onUnpin }: Props & { id: string }) {
  const { data, error } = useRead(() => api.module(id), id, graph.modelKey);
  if (error) return <ReadError message={error} />;
  if (!data) return <Loading />;
  const kinds = [...KIND_ORDER, ...Object.keys(data.owned).filter((k) => !KIND_ORDER.includes(k))].filter(
    (k) => data.owned[k]?.length,
  );
  return (
    <>
      <div className="insp-head">
        <Crumbs parts={[{ label: "Project", onClick: () => onSelectModule(null) }, { label: "Module" }]} />
        <h1 className="insp-name" data-testid="inspector-name">
          {data.module.name}
        </h1>
        <div className="row small muted">
          <span className="mono">{data.module.id}</span>
          <span>in {data.revision}</span>
        </div>
        {data.module.purpose ? (
          <p className="declared" data-testid="inspector-purpose">
            {data.module.purpose}
            <span className="ro-mark" title="Read-only: no typed operation changes a module's purpose yet">
              <Icon name="lock" small />
            </span>
          </p>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            No purpose declared.
          </p>
        )}
        {data.module.description && <p className="note">{data.module.description}</p>}
        <PinPanel position={graph.positions[id]} onUnpin={() => onUnpin(id)} />
      </div>
      <div className="insp-scroll">
        <Fields
          access={data.access}
          objectId={data.module.id}
          objectName={data.module.name}
          objectKind="module"
          graph={graph}
        />
        <LinkList
          title="Depends on"
          icon="arrowRight"
          links={data.dependsOn}
          onSelect={onSelectModule}
          declarer={() => data.module.id}
        />
        <LinkList
          title="Used by"
          icon="arrowLeft"
          links={data.usedBy}
          onSelect={onSelectModule}
          declarer={(l) => l.id}
        />
        {kinds.map((k) => (
          <OwnedSection key={k} kind={k} items={data.owned[k] ?? []} onOpen={(oid) => onOpenObject(oid, id)} />
        ))}
        {kinds.length === 0 && (
          <section className="sec">
            <p className="small muted">
              This module owns no capabilities, data, rules, contracts, events, behaviors or criteria yet.
            </p>
          </section>
        )}
        {data.truncated && (
          <section className="sec">
            <p className="small muted">Some relationships were cut by the query budget.</p>
          </section>
        )}
      </div>
    </>
  );
}

const HIDDEN_FIELDS = new Set(["id", "kind", "owner", "name", "description", "statement"]);

function Value({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="muted">none</span>;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return <>{String(v)}</>;
  return <code className="code">{JSON.stringify(v, null, 2)}</code>;
}

function ObjectPanel({ id, graph, onSelectModule, onOpenObject }: Props & { id: string }) {
  const { data, error } = useRead(() => api.object(id), id, graph.modelKey);
  if (error) return <ReadError message={error} />;
  if (!data) return <Loading />;
  const o = data.object;
  const r = o.record as Record<string, unknown> & {
    attributes?: { id: string; name: string; type: string; nullable?: boolean }[];
  };
  // The owner comes from the object itself, never from where the user came from.
  const moduleId = o.moduleId ?? null;
  const moduleName = moduleId ? (graph.modules.find((m) => m.id === moduleId)?.name ?? moduleId) : null;
  const open = (ref: ObjectRef & { moduleId?: string }) =>
    ref.kind === "module" ? onSelectModule(ref.id) : onOpenObject(ref.id, ref.moduleId ?? null);
  // Attributes are listed in their own table above.
  const relations = data.relations.filter((rel) => !(rel.relation === "contains" && rel.other.kind === "attribute"));
  const fields = Object.entries(r).filter(([k]) => !HIDDEN_FIELDS.has(k) && k !== "attributes");
  return (
    <>
      <div className="insp-head">
        <Crumbs
          parts={[
            { label: "Project", onClick: () => onSelectModule(null) },
            ...(moduleId && moduleName ? [{ label: moduleName, onClick: () => onSelectModule(moduleId) }] : []),
            { label: kindTitle(o.kind, 1) },
          ]}
        />
        <h1 className="insp-name" data-testid="object-name">
          {o.name}
        </h1>
        <div className="row small muted">
          <span className="kind-badge" style={kindVar(o.kind)}>
            {kindLabel(o.kind, 1)}
          </span>
          <span className="mono">{o.id}</span>
          <span>in {data.revision}</span>
        </div>
        {typeof r.statement === "string" && <p className="declared">{r.statement}</p>}
        {typeof r.description === "string" && <p className="note">{r.description}</p>}
      </div>
      <div className="insp-scroll">
        <Fields access={data.access} objectId={o.id} objectName={o.name} objectKind={o.kind} graph={graph} />
        {r.attributes && (
          <section className="sec">
            <h2 className="sec-head">
              Attributes<span className="count">{r.attributes.length}</span>
            </h2>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {r.attributes.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.name}</td>
                    <td>
                      {a.type}
                      {a.nullable ? ", nullable" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {fields.length > 0 && (
          <section className="sec">
            <h2 className="sec-head">Declared fields</h2>
            <dl className="kv">
              {fields.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt className="mono">{k}</dt>
                  <dd>
                    <Value v={v} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <section className="sec">
          <h2 className="sec-head">
            Relations<span className="count">{relations.length}</span>
          </h2>
          <ul className="list">
            {relations.map((rel) => (
              <li key={`${rel.direction}:${rel.relation}:${rel.other.id}:${rel.declaredAt}`}>
                <button type="button" className="item" onClick={() => open(rel.other)}>
                  <Icon name={rel.direction === "outgoing" ? "arrowRight" : "arrowLeft"} />
                  <span className="item-main">
                    <span className="item-title">{rel.other.name}</span>
                    <span className="item-sub">
                      {rel.direction === "outgoing" ? rel.relation : `${rel.relation} (from it)`} ·{" "}
                      {kindLabel(rel.other.kind, 1)} · <span className="mono">{rel.declaredAt}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="sec">
          <p className="small muted" style={{ margin: 0 }}>
            Declared at <span className="mono">{o.irPath}</span>. This is the model's intent; code and test evidence for
            it are not shown in this view.
          </p>
        </section>
      </div>
    </>
  );
}
