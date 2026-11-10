import { test } from "node:test";
import assert from "node:assert/strict";
import { checkModel, dumpModel, loadModel, ownershipTree, referenceGraph, collectRefs, refId } from "../src/index.ts";
import type { Model } from "../src/index.ts";
import { approval, broken, fixtureRaw, fixtureText, notifications } from "./fixture.ts";

const codes = (m: unknown) => checkModel(m).diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
const expectError = (m: unknown, code: string) => {
  const r = checkModel(m);
  assert.equal(r.ok, false, `expected ${code}, model was accepted`);
  assert.ok(r.diagnostics.some((d) => d.code === code), `expected ${code}, got ${JSON.stringify(r.diagnostics)}`);
};

test("the Enrollment fixture is valid with no diagnostics", () => {
  const r = loadModel(fixtureText());
  assert.equal(r.ok, true);
  assert.deepEqual(r.diagnostics, []);
});

test("AC1: serialize and load without changing IDs, names or meaning", () => {
  const first = loadModel(fixtureText()).model!;
  const again = loadModel(dumpModel(first));
  assert.equal(again.ok, true);
  assert.deepEqual(again.model, first);
  assert.equal(dumpModel(again.model!), dumpModel(first), "serialization is deterministic");
});

test("AC2: duplicate IDs are rejected, including nested state and attribute IDs", () => {
  expectError(broken((m) => m.events.push({ ...m.events[0]! })), "DUPLICATE_ID");
  expectError(broken((m) => approval(m).states.push({ id: "st-pending", name: "Again" })), "DUPLICATE_ID");
  expectError(broken((m) => m.data[0]!.attributes.push({ id: "st-approved", name: "Clash", type: "string" })), "DUPLICATE_ID");
});

test("AC2: references to the wrong kind are rejected", () => {
  // A transition triggered by a capability ID instead of an event ID.
  expectError(broken((m) => { const t = approval(m).transitions[0]!; t.trigger = { kind: "event", eventId: "cap-review-enrollment" }; }), "WRONG_KIND");
  expectError(broken((m) => { notifications(m).dependsOn = ["ctr-enrollment-events"]; }), "WRONG_KIND");
});

test("AC3: missing owners, owners of the wrong kind, and objects declared under two parents are rejected", () => {
  expectError(broken((m) => { delete (m.capabilities[0] as Partial<Model["capabilities"][0]>).owner; }), "SCHEMA");
  // Capabilities must be owned by a module, not a project or another capability.
  expectError(broken((m) => { m.capabilities[0]!.owner = "prj-lms"; }), "WRONG_KIND");
  expectError(broken((m) => { m.events[0]!.owner = "cap-review-enrollment"; }), "WRONG_KIND");
  // The same object listed again under a second module is two canonical parents for one ID.
  expectError(broken((m) => m.capabilities.push({ ...m.capabilities[0]!, owner: "mod-notifications" })), "DUPLICATE_ID");
  expectError(broken((m) => { m.modules[0]!.dependsOn = ["mod-enrollment"]; }), "SELF_DEPENDENCY");
});

test("AC4: unknown initialStateId, fromStateId or toStateId are rejected", () => {
  expectError(broken((m) => { approval(m).initialStateId = "st-nope"; }), "UNKNOWN_REF");
  expectError(broken((m) => { approval(m).transitions[0]!.fromStateId = "st-nope"; }), "UNKNOWN_REF");
  expectError(broken((m) => { approval(m).transitions[0]!.toStateId = "st-nope"; }), "UNKNOWN_REF");
  // A real state, but from a different behavior.
  expectError(broken((m) => { approval(m).transitions[0]!.toStateId = "st-notice-sent"; }), "STATE_NOT_IN_BEHAVIOR");
});

test("AC6: triggers and effects naming nonexistent events are rejected", () => {
  expectError(broken((m) => { approval(m).transitions[0]!.trigger = { kind: "event", eventId: "evt-missing" }; }), "UNKNOWN_REF");
  expectError(broken((m) => { approval(m).transitions[1]!.effects = [{ kind: "emitEvent", eventId: "evt-missing" }]; }), "UNKNOWN_REF");
  // Dotted display-name strings are no longer references.
  expectError(broken((m) => { approval(m).transitions[0]!.trigger = { kind: "event", eventId: "lecturer.approved" }; }), "UNKNOWN_REF");
});

test("AC7: using another module's event requires a consumed contract that exposes it", () => {
  // Notifications stops consuming the Enrollment events contract.
  expectError(broken((m) => { notifications(m).consumes = []; }), "EVENT_BOUNDARY");
  // Notifications listens to a private Enrollment event not published by any contract.
  expectError(
    broken((m) => { m.behaviors[1]!.transitions[0]!.trigger = { kind: "event", eventId: "evt-approval-submitted" }; }),
    "EVENT_BOUNDARY",
  );
  // A contract cannot list an event owned by a different module.
  expectError(
    broken((m) => {
      m.events.push({ id: "evt-notice-sent", owner: "mod-notifications", kind: "event", name: "Notice sent" });
      m.contracts[1]!.publishes!.push("evt-notice-sent");
    }),
    "CONTRACT_FOREIGN_EVENT",
  );
});

test("AC8: permission guards must point to a permission rule with a real actor and capability", () => {
  expectError(broken((m) => { approval(m).transitions[0]!.guards = [{ kind: "permission", ruleId: "rule-no-reopen" }]; }), "GUARD_NOT_PERMISSION");
  expectError(broken((m) => { (m.rules[0] as { actorId: string }).actorId = "actor-ghost"; }), "UNKNOWN_REF");
  expectError(broken((m) => { (m.rules[0] as { capabilityId: string }).capabilityId = "actor-lecturer"; }), "WRONG_KIND");
});

test("AC9: timer anchors must be an existing temporal attribute of the named data", () => {
  const timeout = (attributeId: string, dataId = "data-enrollment-request") => (m: Model) => {
    approval(m).transitions.push({
      id: "tr-timeout",
      fromStateId: "st-pending",
      toStateId: "st-rejected",
      trigger: { kind: "elapsed", duration: "P7D", anchor: { dataId, attributeId } },
    });
  };
  assert.equal(checkModel(broken(timeout("attr-request-created-at"))).ok, true, "the valid timeout is accepted");
  expectError(broken(timeout("attr-request-note")), "ANCHOR_NOT_TEMPORAL");
  expectError(broken(timeout("attr-missing")), "UNKNOWN_REF");
  expectError(broken(timeout("attr-request-created-at", "data-missing")), "UNKNOWN_REF");
  expectError(broken((m) => { timeout("attr-request-created-at")(m); (approval(m).transitions.at(-1)!.trigger as { duration: string }).duration = "7 days"; }), "SCHEMA");
});

test("AC10: unresolved references are allowed only in a draft snapshot", () => {
  const withUnresolved = (status: "draft" | "approved") =>
    broken((m) => {
      m.project.status = status;
      notifications(m).dependsOn = [{ unresolved: "Identity", diagnostic: "imported code imports ./auth but no module was confirmed" }];
    });
  const draft = checkModel(withUnresolved("draft"));
  assert.equal(draft.ok, true);
  assert.deepEqual(draft.diagnostics.map((d) => [d.code, d.severity]), [["UNRESOLVED_REF", "warning"]]);
  expectError(withUnresolved("approved"), "UNRESOLVED_IN_APPROVED");
});

test("hierarchy and graph projections are derived without changing the model", () => {
  const m = fixtureRaw();
  const before = structuredClone(m);
  const tree = ownershipTree(m);
  const graph = referenceGraph(m);
  assert.deepEqual(m, before, "projections never write back");

  const enrollment = tree.children.find((c) => c.id === "mod-enrollment")!;
  assert.ok(enrollment.children.some((c) => c.id === "beh-enrollment-approval"));
  const beh = enrollment.children.find((c) => c.id === "beh-enrollment-approval")!;
  assert.deepEqual(beh.children.filter((c) => c.kind === "state").map((c) => c.id), ["st-pending", "st-approved", "st-rejected"]);

  // Every resolvable reference appears as exactly one graph edge.
  const refCount = collectRefs(m).filter((s) => refId(s.ref)).length;
  assert.equal(graph.edges.filter((e) => e.relation !== "contains").length, refCount);
  assert.ok(graph.edges.some((e) => e.from === "tr-send-notice" && e.to === "evt-enrollment-rejected" && e.relation === "triggerEvent"));
});

test("a dependency cycle is reported as a warning, not rejected", () => {
  const m = broken((x) => { x.modules[0]!.dependsOn = ["mod-notifications"]; });
  const r = checkModel(m);
  assert.equal(r.ok, true);
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["DEPENDENCY_CYCLE"]);
  assert.deepEqual(codes(m), []);
});
