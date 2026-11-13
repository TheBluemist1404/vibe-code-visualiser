// The ModelStore contract and the in-memory store used by tests and hosts without a disk.
import type { Model } from "@vcv/ir";
import type { AuditEvent, ChangeRecord } from "../engine.ts";
import { isChildRevision, parseRevisionId } from "../revisions.ts";
import { StoreError, assertPersistedId, sameRecord } from "./files.ts";

/**
 * One consistent read of the store: the current model, the history it heads and an opaque token
 * for exactly this state. The engine validates a change against a snapshot and commits with its
 * token, so the store can refuse if anything moved in between (ADR 0007 §2).
 */
export type StoreSnapshot = { model: Model; history: string[]; token: string };

/** Preconditions for a non-committing record write (ADR 0007 §2). */
export type ChangeGuard = { token: string; previous: ChangeRecord | null };

export interface ModelStore {
  current(): Model;
  snapshot(): StoreSnapshot;
  revision(rev: string): Model | undefined;
  /** Committed revisions, oldest first. */
  revisions(): string[];
  /**
   * Atomically make `model` the current revision, recording the applied change. With a token
   * (from snapshot()), refuse unless the store is still in exactly that state; with a full
   * ChangeGuard, also refuse unless the change's record on disk is exactly `previous` (none for a
   * new proposal, the pending record for an approval). Nothing is written when refused.
   */
  commit(model: Model, record: ChangeRecord, guard?: string | ChangeGuard): void;
  getChange(changeId: string): ChangeRecord | undefined;
  /**
   * Persist a non-committing record state (pending, rejected). With a guard, refuse
   * (STORE_CHANGED, nothing written) unless the store is still in the snapshot's state and the
   * record on disk is exactly `previous` (null: no record with that ID exists).
   */
  putChange(record: ChangeRecord, guard?: ChangeGuard): void;
  appendAudit(event: AuditEvent): void;
  audit(): AuditEvent[];
}

export function assertCommittable(model: Model, record: ChangeRecord, history: readonly string[]) {
  const rev = model.project.modelRevision;
  assertPersistedId("revision", rev);
  assertPersistedId("change id", record.changeId);
  if (record.status !== "applied" || record.resultingRevision !== rev) {
    throw new StoreError("BAD_COMMIT", `commit needs an applied record whose resultingRevision is ${rev}`);
  }
  if (history.includes(rev)) throw new StoreError("REVISION_EXISTS", `revision ${rev} already exists`);
  // The model must have been derived from the revision the store holds now: never append a model
  // validated against another line (or an earlier state) to this one.
  const head = history.at(-1)!;
  if (record.baseRevision !== head) {
    throw new StoreError(
      "HEAD_CHANGED",
      `change ${record.changeId} was validated against ${record.baseRevision}, but the store is now at ${head}; nothing was written`,
    );
  }
  if (parseRevisionId(rev).scheme === "branch-safe" && !isChildRevision(rev, model, head, history.length + 1)) {
    throw new StoreError(
      "BAD_COMMIT",
      `${rev} is not the digest of this model as revision ${history.length + 1} after ${head}; nothing was written`,
    );
  }
}

export class MemoryStore implements ModelStore {
  private readonly revs = new Map<string, Model>();
  private readonly order: string[] = [];
  private readonly changes = new Map<string, ChangeRecord>();
  private readonly log: AuditEvent[] = [];

  constructor(initial: Model) {
    assertPersistedId("revision", initial.project.modelRevision);
    this.revs.set(initial.project.modelRevision, structuredClone(initial));
    this.order.push(initial.project.modelRevision);
  }
  current(): Model {
    return structuredClone(this.revs.get(this.order.at(-1)!)!);
  }
  revision(rev: string): Model | undefined {
    const m = this.revs.get(rev);
    return m && structuredClone(m);
  }
  revisions(): string[] {
    return [...this.order];
  }
  snapshot(): StoreSnapshot {
    return { model: this.current(), history: this.revisions(), token: this.order.join("\0") };
  }
  commit(model: Model, record: ChangeRecord, guard?: string | ChangeGuard): void {
    const g = typeof guard === "string" ? { token: guard } : guard;
    if (g && g.token !== this.order.join("\0")) {
      throw new StoreError(
        "HEAD_CHANGED",
        "the store moved since the snapshot this change was validated against; nothing was written",
      );
    }
    if (g && "previous" in g && !sameRecord(this.changes.get(record.changeId) ?? null, g.previous)) {
      throw new StoreError(
        "STORE_CHANGED",
        `change ${record.changeId} is not in the state it was validated in; nothing was written`,
      );
    }
    assertCommittable(model, record, this.order);
    this.revs.set(model.project.modelRevision, structuredClone(model));
    this.order.push(model.project.modelRevision);
    this.changes.set(record.changeId, structuredClone(record));
  }
  getChange(id: string): ChangeRecord | undefined {
    assertPersistedId("change id", id);
    const r = this.changes.get(id);
    return r && structuredClone(r);
  }
  putChange(record: ChangeRecord, guard?: ChangeGuard): void {
    assertPersistedId("change id", record.changeId);
    if (guard) {
      const onDisk = this.changes.get(record.changeId);
      if (guard.token !== this.order.join("\0") || !sameRecord(onDisk ?? null, guard.previous)) {
        throw new StoreError(
          "STORE_CHANGED",
          `change ${record.changeId} or the store changed since validation; nothing was written`,
        );
      }
    }
    this.changes.set(record.changeId, structuredClone(record));
  }
  appendAudit(event: AuditEvent): void {
    this.log.push(structuredClone(event));
  }
  audit(): AuditEvent[] {
    return structuredClone(this.log);
  }
}
