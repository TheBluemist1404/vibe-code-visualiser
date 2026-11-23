import assert from "node:assert/strict";
import { test } from "node:test";
import { autoLayout, NODE, reconcile, tidy } from "../src/layout.ts";
import type { Position } from "../src/types.ts";

// Course Desk: Web → Enrollment → Notifications, Web → Notifications.
const COURSE_DESK = {
  ids: ["mod-web", "mod-notifications", "mod-enrollment"],
  edges: [
    { from: "mod-enrollment", to: "mod-notifications" },
    { from: "mod-web", to: "mod-enrollment" },
    { from: "mod-web", to: "mod-notifications" },
  ],
};

const boxesOverlap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < NODE.width && Math.abs(a.y - b.y) < NODE.height;

function assertNoOverlap(positions: Record<string, Position>) {
  const list = Object.entries(positions);
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      assert.ok(!boxesOverlap(list[i]![1], list[j]![1]), `${list[i]![0]} overlaps ${list[j]![0]}`);
}

test("auto layout puts every module above the modules it depends on", () => {
  const p = autoLayout(COURSE_DESK);
  for (const e of COURSE_DESK.edges) assert.ok(p.get(e.from)!.y < p.get(e.to)!.y, `${e.from} above ${e.to}`);
  assert.ok(p.get("mod-web")!.y < p.get("mod-enrollment")!.y);
  assert.ok(p.get("mod-enrollment")!.y < p.get("mod-notifications")!.y);
});

test("auto layout is deterministic: input order does not matter", () => {
  const a = autoLayout(COURSE_DESK);
  const b = autoLayout({ ids: [...COURSE_DESK.ids].reverse(), edges: [...COURSE_DESK.edges].reverse() });
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test("auto layout survives a dependency cycle and ignores edges to unknown modules", () => {
  const p = autoLayout({
    ids: ["mod-a", "mod-b", "mod-c"],
    edges: [
      { from: "mod-a", to: "mod-b" },
      { from: "mod-b", to: "mod-a" },
      { from: "mod-c", to: "mod-missing" },
    ],
  });
  assert.equal(p.size, 3);
  assertNoOverlap(Object.fromEntries([...p].map(([id, xy]) => [id, { ...xy, pinned: false }])));
});

test("reconcile keeps stored positions, drops removed modules and places a new one in free space", () => {
  const first = reconcile(COURSE_DESK, {});
  assert.deepEqual(first.placed.sort(), [...COURSE_DESK.ids].sort());
  // The user pinned Notifications partly over the new module's automatic slot.
  const auto = autoLayout({
    ids: [...COURSE_DESK.ids, "mod-audit"],
    edges: [...COURSE_DESK.edges, { from: "mod-audit", to: "mod-enrollment" }],
  });
  const stored: Record<string, Position> = {
    ...first.positions,
    "mod-notifications": { x: auto.get("mod-audit")!.x - 200, y: auto.get("mod-audit")!.y, pinned: true },
    "mod-gone": { x: 9999, y: 9999, pinned: true },
  };
  const next = reconcile(
    {
      ids: [...COURSE_DESK.ids, "mod-audit"],
      edges: [...COURSE_DESK.edges, { from: "mod-audit", to: "mod-enrollment" }],
    },
    stored,
  );
  assert.deepEqual(next.placed, ["mod-audit"]);
  for (const id of COURSE_DESK.ids) assert.deepEqual(next.positions[id], stored[id], `${id} did not move`);
  assert.equal(next.positions["mod-gone"], undefined);
  assert.equal(next.positions["mod-audit"]!.pinned, false);
  assert.equal(next.positions["mod-audit"]!.y, auto.get("mod-audit")!.y, "same row as its automatic slot");
  assertNoOverlap(next.positions);
});

test("tidy re-places unpinned modules and leaves pinned ones where the user put them", () => {
  const { positions } = reconcile(COURSE_DESK, {});
  const moved: Record<string, Position> = {
    ...positions,
    "mod-web": { x: 900, y: 40, pinned: true },
    "mod-enrollment": { x: -700, y: 600, pinned: false },
  };
  const t = tidy(COURSE_DESK, moved);
  assert.deepEqual(t["mod-web"], { x: 900, y: 40, pinned: true });
  const auto = autoLayout(COURSE_DESK).get("mod-enrollment")!;
  assert.deepEqual(t["mod-enrollment"], { ...auto, pinned: false });
  assertNoOverlap(t);
});
