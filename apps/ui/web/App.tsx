// Application shell: watches the checkout through the host, routes between the explorer and
// the state screens, and owns selection and the inspector target (presentation state only).
import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelChange, Position, ProjectView } from "../src/types.ts";
import { api, HostError } from "./api.ts";
import { Canvas } from "./components/Canvas.tsx";
import { DraftPanel } from "./components/DraftPanel.tsx";
import { Inspector } from "./components/Inspector.tsx";
import type { InspectorTarget } from "./components/Inspector.tsx";
import { ModuleList } from "./components/ModuleList.tsx";
import { ProjectBar } from "./components/ProjectBar.tsx";
import { HostDown, LoadingScreen, StateScreen } from "./components/StateScreen.tsx";
import { DraftsProvider } from "./drafts/DraftsProvider.tsx";
import { Icon } from "./icons.tsx";
import { ProposalsView, useInbox } from "./proposals/ProposalsView.tsx";

/** Which page is open, from the URL hash: `#/proposals` or `#/proposals/<changeId>`; anything else is the explorer. */
type Route = { page: "explorer" } | { page: "proposals"; changeId: string | null };
function parseRoute(hash: string): Route {
  const m = /^#\/proposals(?:\/([^/]+))?$/.exec(hash);
  return m ? { page: "proposals", changeId: m[1] ? decodeURIComponent(m[1]) : null } : { page: "explorer" };
}
function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route) => {
    const hash = r.page === "explorer" ? "#/" : `#/proposals${r.changeId ? `/${encodeURIComponent(r.changeId)}` : ""}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(r);
  }, []);
  return [route, go];
}

const POLL_MS = 3000;

export function App() {
  const [view, setView] = useState<ProjectView | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pulse, setPulse] = useState(0);
  const [target, setTarget] = useState<InspectorTarget>({ kind: "project" });
  const [focus, setFocus] = useState<{ ids: string[]; seq: number } | null>(null);
  const [banner, setBanner] = useState<ModelChange | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const seenChange = useRef<number | null>(null);
  const busy = useRef(false);
  const [route, go] = useRoute();

  const load = useCallback(async (manual = false) => {
    if (busy.current) return;
    busy.current = true;
    if (manual) setRefreshing(true);
    try {
      const next = await api.project();
      setDown(null);
      setPulse((p) => p + 1);
      setView((prev) => (prev && sameView(prev, next) ? { ...prev, observation: next.observation } : next));
      const seq = next.lastChange?.seq ?? 0;
      if (seenChange.current === null)
        seenChange.current = seq; // nothing to announce on first open
      else if (seq > seenChange.current && next.lastChange) {
        seenChange.current = seq;
        setBanner(next.lastChange);
        setFresh(new Set(next.graph?.placed ?? next.lastChange.added));
      }
    } catch (e) {
      if (e instanceof HostError && e.code === "HOST_UNREACHABLE") setDown(e.message);
      else setDown(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      if (manual) setTimeout(() => setRefreshing(false), 300);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const graph = view?.graph ?? null;
  const { inbox, error: inboxError } = useInbox(graph ? graph.modelKey : null, route.page === "proposals");
  const selected = target.kind === "module" ? target.id : target.kind === "object" ? target.moduleId : null;

  // Drop a selection whose module no longer exists after a refresh.
  useEffect(() => {
    if (graph && selected && !graph.modules.some((m) => m.id === selected)) setTarget({ kind: "project" });
  }, [graph, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) setTarget({ kind: "project" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectModule = useCallback((id: string | null, pan = false) => {
    setTarget(id ? { kind: "module", id } : { kind: "project" });
    if (id && pan) setFocus((f) => ({ ids: [id], seq: (f?.seq ?? 0) + 1 }));
  }, []);

  const applyPositions = useCallback((positions: Record<string, Position>) => {
    setView((v) => (v?.graph ? { ...v, graph: { ...v.graph, positions } } : v));
  }, []);
  const layoutCall = useCallback(
    (p: Promise<{ positions: Record<string, Position> }>) =>
      p.then((r) => applyPositions(r.positions)).catch((e: Error) => setDown(e.message)),
    [applyPositions],
  );

  const title = graph?.project.name ?? "VCV explorer";
  useEffect(() => {
    document.title = graph ? `${graph.project.name} · VCV` : "VCV explorer";
  }, [graph]);

  const content = useMemo(() => {
    if (down) return <HostDown message={down} onRetry={() => load(true)} />;
    if (!view) return <LoadingScreen />;
    if (!graph) return <StateScreen observation={view.observation} onRefresh={() => load(true)} />;
    if (route.page === "proposals")
      return (
        <ProposalsView
          inbox={inbox}
          error={inboxError}
          selected={route.changeId}
          onSelect={(id) => go({ page: "proposals", changeId: id })}
        />
      );
    return (
      <div className="body">
        <ModuleList graph={graph} selected={selected} fresh={fresh} onSelect={(id) => selectModule(id, true)} />
        <ReactFlowProvider>
          <div className="canvas-col">
            {banner && (
              <ChangeBanner
                change={banner}
                onShow={() => setTarget({ kind: "project" })}
                onLocate={
                  fresh.size > 0 ? () => setFocus((f) => ({ ids: [...fresh], seq: (f?.seq ?? 0) + 1 })) : undefined
                }
                onDismiss={() => {
                  setBanner(null);
                  setFresh(new Set());
                }}
              />
            )}
            <Canvas
              graph={graph}
              selected={selected}
              fresh={fresh}
              onSelect={(id) => selectModule(id)}
              onPin={(id, x, y) => layoutCall(api.pin(id, x, y))}
              onTidy={() => layoutCall(api.tidy())}
              focusRequest={focus}
            />
            <DraftPanel graph={graph} />
          </div>
        </ReactFlowProvider>
        <Inspector
          target={target}
          graph={graph}
          observation={view.observation}
          change={banner ?? null}
          onSelectModule={(id) => selectModule(id, true)}
          onOpenObject={(id, moduleId) => setTarget({ kind: "object", id, moduleId })}
          onUnpin={(id) => layoutCall(api.unpin(id))}
        />
      </div>
    );
  }, [
    down,
    view,
    graph,
    selected,
    fresh,
    focus,
    banner,
    target,
    load,
    selectModule,
    layoutCall,
    route,
    go,
    inbox,
    inboxError,
  ]);

  return (
    <div className="app">
      <ProjectBar
        title={title}
        observation={view?.observation ?? null}
        refreshing={refreshing}
        pulse={pulse}
        onRefresh={() => load(true)}
        page={route.page}
        pending={graph ? (inbox?.counts.pending ?? 0) : null}
        onPage={(page) => go(page === "explorer" ? { page } : { page, changeId: null })}
      />
      <DraftsProvider projectId={graph?.project.id ?? null} modelKey={graph?.modelKey ?? null}>
        {content}
      </DraftsProvider>
    </div>
  );
}

/** True when the canvas would not change: same revision, modules, edges and positions. */
function sameView(a: ProjectView, b: ProjectView): boolean {
  if (a.observation.state !== b.observation.state) return false;
  if (a.lastChange?.seq !== b.lastChange?.seq) return false;
  return JSON.stringify(a.graph) === JSON.stringify(b.graph);
}

const LINE: Record<ModelChange["modelLine"], string> = {
  advanced: "advanced",
  rewound: "went back",
  switched: "switched",
  appeared: "appeared",
  disappeared: "disappeared",
};

function ChangeBanner({
  change,
  onShow,
  onLocate,
  onDismiss,
}: {
  change: ModelChange;
  onShow(): void;
  onLocate?: () => void;
  onDismiss(): void;
}) {
  const branch =
    change.before.branch !== change.after.branch
      ? `Branch switched from ${change.before.branch ?? "none"} to ${change.after.branch ?? "none"}: `
      : "";
  const added = change.added.length;
  return (
    <div className="banner" data-testid="change-banner">
      <div className="notice n-warn">
        <Icon name="history" />
        <div className="notice-body">
          <div className="notice-title">The model {LINE[change.modelLine]} on disk</div>
          <span>
            {branch}
            <span className="mono">{change.before.revision ?? "none"}</span> →{" "}
            <span className="mono">{change.after.revision ?? "none"}</span>. Pinned and placed modules stayed put
            {added > 0 ? `; ${added} new module${added === 1 ? " was" : "s were"} placed in free space.` : "."}
          </span>
          <div className="row">
            <button type="button" className="btn" onClick={onShow}>
              Show what changed
            </button>
            {onLocate && (
              <button type="button" className="btn" onClick={onLocate}>
                Locate new
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
