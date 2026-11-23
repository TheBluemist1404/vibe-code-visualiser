// The architecture canvas: one node per module, one arrow per declared module relationship,
// pointing at the module depended on. Dragging pins a module (presentation state only).
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position as Side,
  ReactFlow,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import type { Edge, EdgeProps, Node, NodeChange, NodeProps } from "@xyflow/react";
import { applyNodeChanges } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphView, ModuleEdgeView, ModuleNodeView, Position } from "../../src/types.ts";
import { useDraft } from "../draft.tsx";
import { Icon } from "../icons.tsx";
import { kindLabel, kindVar } from "../kinds.ts";

type NodeData = {
  module: ModuleNodeView;
  pinned: boolean;
  isNew: boolean;
  role: "sel" | "nb" | "dim" | "none";
  index: number;
};
type EdgeData = { view: ModuleEdgeView; hot: boolean; dim: boolean; label: string; bow: number };
type ModuleFlowNode = Node<NodeData, "module">;
type DependencyFlowEdge = Edge<EdgeData, "dependency">;

const ModuleNode = memo(function ModuleNode({ data }: NodeProps<ModuleFlowNode>) {
  const { module: m, pinned, isNew, role, index } = data;
  const counts = Object.entries(m.owned).filter(([k]) => k !== "attribute" && k !== "state" && k !== "transition");
  const staged = useDraft().draft?.edits.some((e) => e.objectId === m.id) ?? false;
  const cls = ["node", role !== "none" ? `is-${role}` : "", isNew ? "is-new" : "", staged ? "is-staged" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} style={{ "--i": index } as React.CSSProperties} data-module={m.id} data-pinned={pinned}>
      <Handle type="target" position={Side.Top} isConnectable={false} />
      <div className="node-name">
        {m.name}
        {isNew && <span className="chip chip-new">New</span>}
        {staged && (
          <span className="chip chip-staged" title="You staged an edit to this module; it is not in the model yet">
            Staged
          </span>
        )}
        {pinned && (
          <span className="node-pin" title="Pinned: you placed it">
            <Icon name="pin" small />
          </span>
        )}
      </div>
      <div className="node-id">{m.id}</div>
      {m.purpose && <div className="node-purpose">{m.purpose}</div>}
      {counts.length > 0 && (
        <div className="node-counts">
          {counts.map(([kind, n]) => (
            <span key={kind} className="chip" style={kindVar(kind)}>
              <span className="dot" />
              {n} {kindLabel(kind, n)}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Side.Bottom} isConnectable={false} />
    </div>
  );
});

/** A cubic path from the dependent's bottom to the dependency's top. An edge that would cross
 *  another module bows out to the side instead. */
function edgeGeometry(sx: number, sy: number, tx: number, ty: number, bow: number) {
  const dy = ty - sy;
  const reach = Math.max(Math.abs(dy) / 2, 80);
  const c1 = { x: sx + bow, y: sy + (bow ? Math.abs(dy) * 0.3 : reach) };
  const c2 = { x: tx + bow, y: ty - (bow ? Math.abs(dy) * 0.3 : reach) };
  const path = `M${sx},${sy} C${c1.x},${c1.y} ${c2.x},${c2.y} ${tx},${ty}`;
  const mid = { x: (sx + 3 * c1.x + 3 * c2.x + tx) / 8, y: (sy + 3 * c1.y + 3 * c2.y + ty) / 8 };
  const angle = Math.atan2(ty - c2.y, tx - c2.x);
  return { path, mid, angle };
}

function Arrowhead({ x, y, angle, className }: { x: number; y: number; angle: number; className: string }) {
  const deg = (angle * 180) / Math.PI;
  return <path className={className} d="M0,0 L-11,-5.5 L-11,5.5 z" transform={`translate(${x},${y}) rotate(${deg})`} />;
}

function DependencyEdge(props: EdgeProps<DependencyFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, data } = props;
  if (!data) return null;
  const { path, mid, angle } = edgeGeometry(sourceX, sourceY, targetX, targetY, data.bow);
  const kind = data.view.kind;
  const state = data.hot ? "is-hot" : data.dim ? "is-dim" : "";
  const cls = ["edge-path", kind, state].filter(Boolean).join(" ");
  const arrow = [
    "arrow",
    data.hot ? "arrow-hot" : kind === "consumes" ? "arrow-con" : "arrow-dep",
    data.dim ? "is-dim" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <BaseEdge id={props.id} path={path} className={cls} interactionWidth={16} />
      <Arrowhead x={targetX} y={targetY} angle={angle} className={arrow} />
      {data.hot && (
        <EdgeLabelRenderer>
          <div
            className="edge-label-pos"
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
          >
            <span className="edge-label">{data.label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { module: ModuleNode };
const edgeTypes = { dependency: DependencyEdge };

const BOX = { width: 260, height: 150 };

/** Whether the straight run from `from` (bottom) to `to` (top) passes through another module. */
function crossesAnother(from: string, to: string, positions: Record<string, Position>): boolean {
  const a = positions[from];
  const b = positions[to];
  if (!a || !b) return false;
  const x1 = a.x + BOX.width / 2;
  const x2 = b.x + BOX.width / 2;
  const top = Math.min(a.y + BOX.height, b.y);
  const bottom = Math.max(a.y + BOX.height, b.y);
  return Object.entries(positions).some(([id, p]) => {
    if (id === from || id === to) return false;
    const overlapY = p.y < bottom && p.y + BOX.height > top;
    const left = Math.min(x1, x2) - 10;
    const right = Math.max(x1, x2) + 10;
    return overlapY && p.x < right && p.x + BOX.width > left;
  });
}

export type CanvasProps = {
  graph: GraphView;
  selected: string | null;
  fresh: ReadonlySet<string>;
  onSelect(id: string | null): void;
  onPin(id: string, x: number, y: number): void;
  onTidy(): void;
  /** Bring these modules into view (module list, inspector link, "Locate new"). */
  focusRequest: { ids: string[]; seq: number } | null;
};

export function Canvas({ graph, selected, fresh, onSelect, onPin, onTidy, focusRequest }: CanvasProps) {
  const names = useMemo(() => new Map(graph.modules.map((m) => [m.id, m.name])), [graph.modules]);
  const neighbours = useMemo(() => {
    const s = new Set<string>();
    if (!selected) return s;
    for (const e of graph.edges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    return s;
  }, [graph.edges, selected]);

  const build = useCallback(
    (positions: Record<string, Position>): ModuleFlowNode[] =>
      graph.modules.map((m, index) => {
        const p = positions[m.id] ?? { x: 0, y: 0, pinned: false };
        const role = !selected ? "none" : m.id === selected ? "sel" : neighbours.has(m.id) ? "nb" : "dim";
        return {
          id: m.id,
          type: "module",
          position: { x: p.x, y: p.y },
          selected: m.id === selected,
          ariaLabel: `Module ${m.name}`,
          data: { module: m, pinned: p.pinned, isNew: fresh.has(m.id), role, index },
        };
      }),
    [graph.modules, selected, neighbours, fresh],
  );

  const [nodes, setNodes] = useState<ModuleFlowNode[]>(() => build(graph.positions));
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setNodes(build(graph.positions));
  }, [build, graph.positions]);

  const edges: DependencyFlowEdge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const hot = !!selected && (e.from === selected || e.to === selected);
        const bow = crossesAnother(e.from, e.to, graph.positions) ? 270 : 0;
        const verb = e.kind === "consumes" ? `consumes ${e.via.join(", ")} from` : "depends on";
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: "dependency",
          focusable: false,
          data: {
            view: e,
            hot,
            dim: !!selected && !hot,
            label: `${names.get(e.from)} ${verb} ${names.get(e.to)}`,
            bow,
          },
        };
      }),
    [graph.edges, graph.positions, selected, names],
  );

  const onNodesChange = useCallback((changes: NodeChange<ModuleFlowNode>[]) => {
    setNodes((ns) =>
      applyNodeChanges(
        changes.filter((c) => c.type === "position" || c.type === "dimensions"),
        ns,
      ),
    );
  }, []);

  return (
    <main className="canvas" aria-label="Architecture canvas">
      <ReactFlow<ModuleFlowNode, DependencyFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        onNodeDragStart={() => {
          dragging.current = true;
        }}
        onNodeDragStop={(_, n) => {
          dragging.current = false;
          const before = graph.positions[n.id];
          if (!before || Math.abs(before.x - n.position.x) > 1 || Math.abs(before.y - n.position.y) > 1)
            onPin(n.id, n.position.x, n.position.y);
        }}
        nodesConnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={32} size={1.4} />
        <MiniMap
          pannable
          zoomable
          nodeBorderRadius={6}
          nodeColor="var(--accent-tint)"
          nodeStrokeColor="var(--accent)"
          maskColor="color-mix(in srgb, var(--surface-canvas) 70%, transparent)"
        />
        <Tools onTidy={onTidy} />
        <Zoom />
        <FocusOn request={focusRequest} />
      </ReactFlow>
      <div className="legend" role="note" aria-label="Legend">
        <span>
          <svg width="30" height="10" aria-hidden="true">
            <path className="edge-path" d="M0,5 L20,5" />
            <Arrowhead x={28} y={5} angle={0} className="arrow arrow-dep" />
          </svg>
          depends on
        </span>
        <span>
          <svg width="30" height="10" aria-hidden="true">
            <path className="edge-path consumes" d="M0,5 L20,5" />
            <Arrowhead x={28} y={5} angle={0} className="arrow arrow-con" />
          </svg>
          consumes a contract
        </span>
        <span>
          <Icon name="pin" small /> pinned by you
        </span>
      </div>
    </main>
  );
}

function Tools({ onTidy }: { onTidy(): void }) {
  const flow = useReactFlow();
  return (
    <div className="tools" role="toolbar" aria-label="Canvas">
      <button
        type="button"
        className="btn btn-ghost"
        title="Re-places unpinned modules. Pinned modules stay where you put them."
        onClick={onTidy}
      >
        <Icon name="grid" />
        Tidy layout
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label="Fit to screen"
        title="Fit to screen"
        onClick={() => flow.fitView({ padding: 0.3, maxZoom: 1, duration: 450 })}
      >
        <Icon name="fit" />
      </button>
    </div>
  );
}

function Zoom() {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="zoom">
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label="Zoom out"
        onClick={() => flow.zoomOut({ duration: 200 })}
      >
        <Icon name="minus" />
      </button>
      <span className="mono" aria-live="polite">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label="Zoom in"
        onClick={() => flow.zoomIn({ duration: 200 })}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

/**
 * Move the view only when the user asks: one module is centred, several are fitted. Model
 * refreshes never move the view, so a user's pan and zoom survive added or removed modules.
 */
function FocusOn({ request }: { request: { ids: string[]; seq: number } | null }) {
  const flow = useReactFlow();
  useEffect(() => {
    if (!request || request.ids.length === 0) return;
    if (request.ids.length > 1) {
      flow.fitView({ nodes: request.ids.map((id) => ({ id })), padding: 0.4, maxZoom: 1, duration: 500 });
      return;
    }
    const n = flow.getNode(request.ids[0] as string);
    if (!n) return;
    const w = n.measured?.width ?? 260;
    const h = n.measured?.height ?? 150;
    flow.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(flow.getZoom(), 0.8), duration: 500 });
  }, [request, flow]);
  return null;
}
