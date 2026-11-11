import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModel, parseYaml, checkModel } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import { FileStore, LayoutStore, MemoryStore, ModelEngine, assessBinding } from "../src/index.ts";
import type { Binding, HostContext, ProposedModelChange } from "../src/index.ts";
import { assertRev } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "../../../examples/enrollment");
const baseModel = (): Model => loadModel(readFileSync(join(FIXTURES, "model.rev-1.yaml"), "utf8")).model!;
const timeoutChange = (): ProposedModelChange => parseYaml(readFileSync(join(FIXTURES, "change.timeout.yaml"), "utf8")) as ProposedModelChange;

// Host-supplied identities. In the real product these come from the session, not the payload.
const owner: HostContext = { principalId: "user:hoang", permissions: ["model:propose", "model:apply", "model:approve"] };
const reviewer: HostContext = { principalId: "user:reviewer", permissions: ["model:propose", "model:approve"] };
const mcpAgent: HostContext = { principalId: "agent:mcp-session-1", permissions: ["model:propose"] };
const viewer: HostContext = { principalId: "user:viewer", permissions: [] };

const engine = (m = baseModel()) => new ModelEngine(new MemoryStore(m));
const change = (ops: ProposedModelChange["operations"], over: Partial<ProposedModelChange> = {}): ProposedModelChange => ({
  changeId: `ch-${Math.random().toString(36).slice(2, 8)}`,
  projectId: "prj-lms",
  expectedRevision: "rev-1",
  operations: ops,
  ...over,
});

test("the spec's seven-day timeout change applies at rev-1 and produces rev-2", () => {
  const e = engine();
  const r = e.propose(timeoutChange(), owner);
  assert.equal(r.status, "applied", JSON.stringify(r.diagnostics));
  assertRev(r.record!.resultingRevision, 2);
  const now = e.current();
  assertRev(now.project.modelRevision, 2);
  const tr = now.behaviors[0]!.transitions.find((t) => t.id === "tr-timeout")!;
  assert.deepEqual(tr.trigger, { kind: "elapsed", duration: "P7D", anchor: { dataId: "data-enrollment-request", attributeId: "attr-request-created-at" } });
  assert.equal(checkModel(now).ok, true);
});

test("AC13: a second change on the stale base revision is rejected, and a replay is rejected", () => {
  const e = engine();
  e.propose(timeoutChange(), owner);
  const stale = e.propose(change([{ type: "renameState", behaviorId: "beh-enrollment-approval", stateId: "st-pending", name: "Waiting" }]), owner);
  assert.equal(stale.status, "rejected");
  assert.equal(stale.diagnostics[0]!.code, "STALE_REVISION");

  const replay = e.propose(timeoutChange(), owner);
  assert.equal(replay.status, "rejected");
  assert.equal(replay.diagnostics[0]!.code, "DUPLICATE_CHANGE");
  assert.equal(e.record("ch-timeout-01")!.status, "applied", "replay does not overwrite the original record");
  assertRev(e.current().project.modelRevision, 2);
});

test("AC11: a change set applies atomically or not at all", () => {
  const e = engine();
  const r = e.propose(
    change([
      { type: "addState", behaviorId: "beh-enrollment-approval", state: { id: "st-withdrawn", name: "Withdrawn" } },
      // Second op is invalid: transition to a state that does not exist.
      {
        type: "addTransition",
        behaviorId: "beh-enrollment-approval",
        transition: { id: "tr-withdraw", fromStateId: "st-pending", toStateId: "st-gone", trigger: { kind: "event", eventId: "evt-rejection-submitted" } },
      },
    ]),
    owner,
  );
  assert.equal(r.status, "rejected");
  assert.ok(r.diagnostics.some((d) => d.code === "UNKNOWN_REF"));
  const now = e.current();
  assert.equal(now.project.modelRevision, "rev-1");
  assert.ok(!now.behaviors[0]!.states.some((s) => s.id === "st-withdrawn"), "the valid first op was not applied either");
});

test("AC12: an MCP agent can only propose; its change waits for a host-verified approver", () => {
  const e = engine();
  const r = e.propose(timeoutChange(), mcpAgent);
  assert.equal(r.status, "pending");
  assert.equal(r.record!.proposerId, "agent:mcp-session-1");
  assert.equal(e.current().project.modelRevision, "rev-1", "a pending proposal does not touch the approved snapshot");

  // The agent cannot approve its own change, even if it had approve rights.
  const self = e.approve("ch-timeout-01", { ...mcpAgent, permissions: ["model:propose", "model:approve"] });
  assert.equal(self.status, "denied");
  assert.equal(self.diagnostics[0]!.code, "SELF_APPROVAL");
  const noRight = e.approve("ch-timeout-01", viewer);
  assert.equal(noRight.status, "denied");
  assert.equal(e.record("ch-timeout-01")!.status, "pending", "denied approval attempts leave the proposal pending");

  const ok = e.approve("ch-timeout-01", reviewer);
  assert.equal(ok.status, "applied");
  assert.equal(ok.record!.approverId, "user:reviewer");
  assertRev(ok.record!.resultingRevision, 2);
});

test("AC12: callers cannot claim approval or identity inside the change payload", () => {
  const e = engine();
  const smuggled = { ...timeoutChange(), approverId: "user:hoang", status: "applied" };
  const r = e.propose(smuggled, mcpAgent);
  assert.equal(r.status, "rejected");
  assert.ok(r.diagnostics.every((d) => d.code === "SCHEMA"));
  assert.equal(r.record, undefined, "a malformed proposal creates no record");

  const denied = e.propose(timeoutChange(), viewer);
  assert.equal(denied.status, "denied");
});

test("AC13: approval revalidates against the current revision", () => {
  const e = engine();
  e.propose(timeoutChange(), mcpAgent); // pending at rev-1
  e.propose(change([{ type: "renameState", behaviorId: "beh-enrollment-approval", stateId: "st-pending", name: "Waiting" }]), owner); // now rev-2
  const r = e.approve("ch-timeout-01", reviewer);
  assert.equal(r.status, "rejected");
  assert.equal(r.diagnostics[0]!.code, "STALE_REVISION");
  assertRev(e.current().project.modelRevision, 2);
});

test("AC5/AC14: renaming a state keeps every reference by ID", () => {
  const e = engine();
  const r = e.propose(change([{ type: "renameState", behaviorId: "beh-enrollment-approval", stateId: "st-pending", name: "Awaiting lecturer" }]), owner);
  assert.equal(r.status, "applied");
  const b = e.current().behaviors[0]!;
  assert.equal(b.states.find((s) => s.id === "st-pending")!.name, "Awaiting lecturer");
  assert.equal(b.initialStateId, "st-pending");
  assert.ok(b.transitions.every((t) => t.fromStateId === "st-pending"));
});

test("AC14: removing a referenced object is rejected unless the same change unlinks it first", () => {
  const e = engine();
  const blocked = e.propose(change([{ type: "removeObject", objectId: "st-rejected" }]), owner);
  assert.equal(blocked.status, "rejected");
  assert.equal(blocked.diagnostics[0]!.code, "REFERENCED");

  const attr = e.propose(change([{ type: "removeObject", objectId: "attr-request-note" }]), owner);
  assert.equal(attr.status, "applied", "an unreferenced nested attribute can be removed");

  const ok = e.propose(
    change(
      [
        { type: "removeObject", objectId: "tr-reject" },
        { type: "removeObject", objectId: "st-rejected" },
      ],
      { expectedRevision: e.current().project.modelRevision },
    ),
    owner,
  );
  assert.equal(ok.status, "applied", JSON.stringify(ok.diagnostics));
  assert.ok(!e.current().behaviors[0]!.states.some((s) => s.id === "st-rejected"));

  const module = e.propose(change([{ type: "removeObject", objectId: "mod-notifications" }], { expectedRevision: e.current().project.modelRevision }), owner);
  assert.equal(module.status, "rejected");
  assert.equal(module.diagnostics[0]!.code, "HAS_OWNED_OBJECTS", "no cascading deletion of owned objects");
});

test("AC10: a draft with unresolved references cannot be approved until they are fixed", () => {
  const draft = baseModel();
  draft.project.status = "draft";
  draft.modules[1]!.dependsOn = [{ unresolved: "Identity" }];
  const e = engine(draft);

  const tooEarly = e.propose(change([{ type: "approveDraft" }]), owner);
  assert.equal(tooEarly.status, "rejected");
  assert.equal(tooEarly.diagnostics[0]!.code, "UNRESOLVED_IN_APPROVED");

  // Resolve the placeholder and approve in one atomic change. An agent may propose this...
  const fixAndApprove = [
    { type: "setModuleDependencies" as const, moduleId: "mod-notifications", dependsOn: ["mod-enrollment"] },
    { type: "approveDraft" as const },
  ];
  const fromAgent = e.propose(change(fixAndApprove, { changeId: "ch-approve-draft" }), { ...mcpAgent, permissions: ["model:propose", "model:apply"] });
  assert.equal(fromAgent.status, "pending", "approving a draft needs approve rights, not just apply");

  // ...but only a principal with approve rights turns it into an approved snapshot.
  const done = e.approve("ch-approve-draft", reviewer);
  assert.equal(done.status, "applied", JSON.stringify(done.diagnostics));
  assert.equal(e.current().project.status, "approved");
  assert.equal(checkModel(e.current()).diagnostics.length, 0);
});

test("AC15: bindings record model revision and commit; moving either marks them stale, not disputed", () => {
  const b: Binding = {
    modelObjectId: "tr-timeout",
    modelRevision: "rev-2",
    repositoryId: "lms-backend",
    commit: "a1b2c3d",
    locator: "src/enrollment/enrollment.scheduler.ts#expirePending",
    relation: "implements",
    provenance: "human",
    status: "confirmed",
  };
  assert.equal(assessBinding(b, { modelRevision: "rev-2", commits: { "lms-backend": "a1b2c3d" } }), "confirmed");
  assert.equal(assessBinding(b, { modelRevision: "rev-2", commits: { "lms-backend": "ffff000" } }), "stale");
  assert.equal(assessBinding(b, { modelRevision: "rev-3", commits: { "lms-backend": "a1b2c3d" } }), "stale");
  assert.equal(
    assessBinding(b, { modelRevision: "rev-3", commits: { "lms-backend": "a1b2c3d" }, changedObjectIds: new Set(["st-pending"]) }),
    "confirmed",
    "an unrelated model change does not invalidate the binding",
  );
});

test("AC16: canvas layout edits never create a model revision", () => {
  const e = engine();
  const layout = new LayoutStore();
  layout.set("behavior:beh-enrollment-approval", "st-pending", { x: 120, y: 40 });
  assert.deepEqual(layout.get("behavior:beh-enrollment-approval", "st-pending"), { x: 120, y: 40 });
  assert.equal(e.current().project.modelRevision, "rev-1");
});

test("FileStore persists revisions and change records and reloads them", () => {
  const dir = mkdtempSync(join(tmpdir(), "vcv-"));
  const e = new ModelEngine(FileStore.init(dir, baseModel()));
  e.propose(timeoutChange(), owner);
  const reopened = new ModelEngine(new FileStore(dir));
  assertRev(reopened.current().project.modelRevision, 2);
  assert.ok(reopened.current().behaviors[0]!.transitions.some((t) => t.id === "tr-timeout"));
  assert.equal(reopened.record("ch-timeout-01")!.status, "applied");
  assert.deepEqual(readdirSync(join(dir, "revisions")).sort(), ["rev-1.yaml", `${reopened.current().project.modelRevision}.yaml`].sort());
});

test("rule and description edits: createRule, setRuleStatement and setDescription are typed, validated and pending for an agent", () => {
  const e = engine();
  const rule = e.current().rules.find((r) => r.ruleKind !== "permission")!;
  const ops: ProposedModelChange["operations"] = [
    { type: "setRuleStatement", ruleId: rule.id, statement: "A new statement." },
    { type: "setDescription", objectId: rule.id, description: "Changed because the code changed." },
    { type: "setDescription", objectId: "prj-lms", description: "Project text." },
    { type: "createRule", rule: { id: "rule-new", kind: "rule", owner: rule.owner, name: "New rule", ruleKind: "policy", statement: "Something holds." } },
  ];
  const pending = e.propose(change(ops), mcpAgent);
  assert.equal(pending.status, "pending", JSON.stringify(pending.diagnostics));
  assert.equal(e.current().rules.find((r) => r.id === rule.id)!.statement, rule.statement, "pending changes nothing");
  assert.equal(e.approve(pending.changeId!, mcpAgent).status, "denied");
  const applied = e.approve(pending.changeId!, reviewer);
  assert.equal(applied.status, "applied", JSON.stringify(applied.diagnostics));
  const now = e.current();
  const r = now.rules.find((x) => x.id === rule.id)!;
  assert.equal(r.statement, "A new statement.");
  assert.equal(r.description, "Changed because the code changed.");
  assert.equal(now.project.description, "Project text.");
  assert.ok(now.rules.some((x) => x.id === "rule-new"));

  const next = now.project.modelRevision;
  const bad = (op: ProposedModelChange["operations"][number]) => e.propose(change([op], { expectedRevision: next }), owner);
  assert.equal(bad({ type: "setRuleStatement", ruleId: "rule-none", statement: "x" }).diagnostics[0]!.code, "TARGET_MISSING");
  assert.equal(bad({ type: "setDescription", objectId: now.behaviors[0]!.states[0]!.id, description: "x" }).diagnostics[0]!.code, "NOT_DESCRIBABLE");
  assert.equal(bad({ type: "createRule", rule: { ...(now.rules[0] as object), id: "rule-new" } as never }).diagnostics[0]!.code, "ID_IN_USE");
  assert.equal(bad({ type: "setRuleStatement", ruleId: rule.id, statement: "" } as never).diagnostics[0]!.code, "SCHEMA");
});
