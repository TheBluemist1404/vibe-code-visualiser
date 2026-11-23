// Module placement for the architecture canvas. Pure and deterministic: the same modules,
// edges and stored positions always give the same result. Presentation only; nothing here
// reads or writes the model.
import type { Position } from "./types.ts";

export const NODE = { width: 260, height: 150 } as const;
const GAP = { x: 60, y: 110 } as const;
const STEP_X = NODE.width + GAP.x;
const STEP_Y = NODE.height + GAP.y;

export type LayoutInput = {
  /** Module IDs. */
  ids: readonly string[];
  /** Directed edges, dependent → dependency. Edges to unknown IDs are ignored. */
  edges: readonly { from: string; to: string }[];
};

/**
 * Layered placement, top to bottom: a module sits one row below every module that depends on
 * it, so arrows point down to dependencies. Rows are ordered by module ID and centred on x = 0.
 * A dependency cycle is broken at the edge that closes it (in ID order).
 */
export function autoLayout({ ids, edges }: LayoutInput): Map<string, { x: number; y: number }> {
  const sorted = [...new Set(ids)].sort();
  const known = new Set(sorted);
  const dependents = new Map<string, string[]>(sorted.map((id) => [id, []]));
  for (const e of edges) {
    if (e.from !== e.to && known.has(e.from) && known.has(e.to)) dependents.get(e.to)?.push(e.from);
  }
  for (const list of dependents.values()) list.sort();

  // layer(m) = 1 + max layer of the modules that depend on m; 0 when nothing depends on m.
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const done = layer.get(id);
    if (done !== undefined) return done;
    if (visiting.has(id)) return -1; // back edge of a cycle: ignore it
    visiting.add(id);
    let d = 0;
    for (const p of dependents.get(id) ?? []) d = Math.max(d, depth(p) + 1);
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const id of sorted) depth(id);

  const rows = new Map<number, string[]>();
  for (const id of sorted) {
    const l = layer.get(id) ?? 0;
    rows.set(l, [...(rows.get(l) ?? []), id]);
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [l, row] of rows) {
    const start = -((row.length - 1) * STEP_X) / 2;
    row.forEach((id, i) => {
      out.set(id, { x: Math.round(start + i * STEP_X - NODE.width / 2), y: l * STEP_Y });
    });
  }
  return out;
}

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < NODE.width + GAP.x / 2 && Math.abs(a.y - b.y) < NODE.height + GAP.y / 2;

/** The first spot in `want`'s row, searching outward, that keeps clear of every taken box. */
function freeSpot(want: { x: number; y: number }, taken: readonly { x: number; y: number }[]) {
  for (let i = 0; i < 1000; i++) {
    // 0, +1, -1, +2, -2, ... steps along the row
    const k = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2);
    const at = { x: want.x + k * STEP_X, y: want.y };
    if (!taken.some((t) => overlaps(at, t))) return at;
  }
  return want;
}

export type Reconciled = { positions: Record<string, Position>; placed: string[] };

/**
 * Reconcile stored positions with the current modules: every stored module that still exists
 * keeps its position (pinned or not), stored modules that no longer exist are dropped, and a
 * module without a position gets its automatic slot, moved along its row to the first free
 * spot. Nothing that was already placed moves.
 */
export function reconcile(input: LayoutInput, stored: Readonly<Record<string, Position>>): Reconciled {
  const auto = autoLayout(input);
  const positions: Record<string, Position> = {};
  const placed: string[] = [];
  const ids = [...new Set(input.ids)].sort();
  for (const id of ids) {
    const s = stored[id];
    if (s) positions[id] = { x: s.x, y: s.y, pinned: s.pinned };
  }
  for (const id of ids) {
    if (positions[id]) continue;
    const want = auto.get(id) ?? { x: 0, y: 0 };
    positions[id] = { ...freeSpot(want, Object.values(positions)), pinned: false };
    placed.push(id);
  }
  return { positions, placed };
}

/**
 * Tidy layout: pinned modules stay where the user put them; every other module returns to
 * its automatic slot, moved along its row if a pinned module is in the way.
 */
export function tidy(input: LayoutInput, stored: Readonly<Record<string, Position>>): Record<string, Position> {
  const auto = autoLayout(input);
  const ids = [...new Set(input.ids)].sort();
  const positions: Record<string, Position> = {};
  for (const id of ids) {
    const s = stored[id];
    if (s?.pinned) positions[id] = { ...s };
  }
  for (const id of ids) {
    if (positions[id]) continue;
    positions[id] = { ...freeSpot(auto.get(id) ?? { x: 0, y: 0 }, Object.values(positions)), pinned: false };
  }
  return positions;
}
