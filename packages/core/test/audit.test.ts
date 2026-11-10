// Audit behaviour: which attempts create ChangeRecords, and that every attempt is logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, ModelEngine } from "../src/index.ts";
import { baseModel, mcpAgent, owner, renamePending, reviewer, timeoutChange, viewer } from "./helpers.ts";

const engine = () => new ModelEngine(new MemoryStore(baseModel()), { now: () => new Date("2026-11-10T15:00:00Z") });

test("a denied proposal is logged but creates no record, so it cannot claim the change ID", () => {
  const e = engine();
  const denied = e.propose(timeoutChange(), viewer);
  assert.equal(denied.status, "denied");
  assert.equal(denied.record, undefined);
  assert.equal(e.record("ch-timeout-01"), undefined);
  assert.equal(e.propose(timeoutChange(), owner).status, "applied", "an authorized proposer can still use the ID");
  assert.deepEqual(
    e.audit().map((a) => [a.action, a.principalId, a.changeId, a.status, a.codes]),
    [
      ["propose", "user:viewer", "ch-timeout-01", "denied", ["NOT_AUTHORIZED"]],
      ["propose", "user:hoang", "ch-timeout-01", "applied", []],
    ],
  );
  assert.equal(e.audit()[1]!.resultingRevision, "rev-2");
  assert.equal(e.audit()[0]!.at, "2026-11-10T15:00:00.000Z");
});

test("malformed and replayed proposals are logged without touching records", () => {
  const e = engine();
  e.propose(timeoutChange(), owner);
  e.propose({ ...timeoutChange(), approverId: "user:hoang" }, mcpAgent); // smuggled field
  e.propose(timeoutChange(), mcpAgent); // replay
  assert.equal(e.record("ch-timeout-01")!.proposerId, "user:hoang");
  assert.deepEqual(
    e.audit().map((a) => [a.principalId, a.status, a.codes]),
    [
      ["user:hoang", "applied", []],
      ["agent:mcp-session-1", "rejected", ["SCHEMA"]],
      ["agent:mcp-session-1", "rejected", ["DUPLICATE_CHANGE"]],
    ],
  );
});

test("a rejected proposal from an authorized caller is a durable record", () => {
  const e = engine();
  const r = e.propose(renamePending("ch-stale", "rev-0"), owner);
  assert.equal(r.status, "rejected");
  assert.equal(e.record("ch-stale")!.status, "rejected");
  assert.equal(e.record("ch-stale")!.validationResults[0]!.code, "STALE_REVISION");
});

test("unauthorized and self-approval attempts are logged and leave the proposal pending", () => {
  const e = engine();
  e.propose(timeoutChange(), mcpAgent);
  const before = e.record("ch-timeout-01");

  const noRight = e.approve("ch-timeout-01", viewer);
  assert.equal(noRight.status, "denied");
  assert.equal(noRight.record!.status, "pending", "the outcome reports the persisted state, still pending");
  const self = e.approve("ch-timeout-01", { ...mcpAgent, permissions: ["model:propose", "model:approve"] });
  assert.equal(self.diagnostics[0]!.code, "SELF_APPROVAL");
  assert.deepEqual(e.record("ch-timeout-01"), before, "the record is byte-for-byte unchanged");

  assert.equal(e.approve("ch-timeout-01", reviewer).status, "applied");
  assert.deepEqual(
    e.audit().map((a) => [a.action, a.principalId, a.status, a.codes]),
    [
      ["propose", "agent:mcp-session-1", "pending", []],
      ["approve", "user:viewer", "denied", ["NOT_AUTHORIZED"]],
      ["approve", "agent:mcp-session-1", "denied", ["SELF_APPROVAL"]],
      ["approve", "user:reviewer", "applied", []],
    ],
  );
});

test("approving an already-applied change is rejected and logged, the record is unchanged", () => {
  const e = engine();
  e.propose(timeoutChange(), owner);
  const r = e.approve("ch-timeout-01", reviewer);
  assert.equal(r.status, "rejected");
  assert.equal(r.diagnostics[0]!.code, "NOT_PENDING");
  assert.equal(e.record("ch-timeout-01")!.status, "applied");
  assert.equal(e.audit().at(-1)!.codes[0], "NOT_PENDING");
});
