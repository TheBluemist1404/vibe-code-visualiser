// One consistent observation of a checkout, for every read that must not mix two states.
import { FileStoreReader, digestOf, listChangeRecords, storeFingerprint } from "@vcv/core";
import type { ChangeRecordEntry } from "@vcv/core";
import type { Model } from "@vcv/ir";
import { GitRefusedError, headCommit } from "../git/git.ts";
import { projectStatus } from "../project.ts";
import type { ProjectStatus } from "../project.ts";
import { contextOf, notReady } from "./result.ts";
import type { RepoError, RepoResult } from "./result.ts";
/** Test hook: called after everything was read and before the consistency recheck. */
export type ObserveHooks = { afterRead?: () => void };

/**
 * One observation of the checkout (review of PR #18): the project status, the model and history
 * it names, and the change records, read once. Everything a result reports comes from this one
 * observation, and before returning, the store fingerprint, the Git commit and the change records
 * (and, for previews, the claim files) are read again; if any moved (a checkout, a record rewrite),
 * the call fails with STATE_CHANGED instead of mixing two generations. No locks, no writes.
 */
export type Observation = {
  status: ProjectStatus;
  model: Model;
  history: string[];
  reader: FileStoreReader;
  records: ChangeRecordEntry[];
  store: string;
  commit: string | null;
  recordsKey: string;
};

const recordsKeyOf = (records: ChangeRecordEntry[]) => digestOf(records);
const commitOf = (status: ProjectStatus) => (status.git ? headCommit(status.root) : null);

export function observed<T>(
  path: string,
  hooks: ObserveHooks,
  body: (obs: Observation) => RepoResult<T>,
): RepoResult<T> {
  try {
    return observedUnsafe(path, hooks, body);
  } catch (e) {
    // Git refused to run on this checkout (driver configuration not enumerable): nothing was read
    // through it, and nothing is reported as clean or absent in its place.
    if (e instanceof GitRefusedError)
      return {
        ok: false,
        error: { code: "SOURCE_IDENTITY_UNAVAILABLE", message: `Git was not run on this checkout: ${e.message}` },
      };
    throw e;
  }
}

function observedUnsafe<T>(
  path: string,
  _hooks: ObserveHooks,
  body: (obs: Observation) => RepoResult<T>,
): RepoResult<T> {
  const status = projectStatus(path);
  if (status.state !== "ready" || !status.model) return notReady(status);
  let obs: Observation;
  try {
    const store = storeFingerprint(status.storeDir);
    const reader = new FileStoreReader(status.storeDir);
    const model = reader.current();
    const history = reader.revisions();
    const records = listChangeRecords(status.storeDir);
    obs = {
      status,
      model,
      history,
      reader,
      records,
      store,
      commit: status.git?.commit ?? null,
      recordsKey: recordsKeyOf(records),
    };
    if (model.project.modelRevision !== status.model.revision) return changed(obs);
  } catch (e) {
    return {
      ok: false,
      error: { code: "STORE_ERROR", message: `the model store could not be read: ${(e as Error).message}` },
    };
  }
  return body(obs);
}

/** Whether the checkout is still exactly as observed. Read-only. */
function unchanged(obs: Observation, hooks: ObserveHooks, extra?: { key: string; again: () => string }): boolean {
  hooks.afterRead?.();
  try {
    return (
      storeFingerprint(obs.status.storeDir) === obs.store &&
      commitOf(obs.status) === obs.commit &&
      recordsKeyOf(listChangeRecords(obs.status.storeDir)) === obs.recordsKey &&
      (!extra || extra.again() === extra.key)
    );
  } catch {
    return false;
  }
}

function changed<T>(obs: Observation): RepoResult<T> {
  return {
    ok: false,
    error: {
      code: "STATE_CHANGED",
      message: `the checkout changed while it was read (a Git checkout, or an edit of .vcv/, of binding claims or of the observed source files); nothing was mixed, retry the call`,
    },
    context: contextOf(obs.status, obs.model),
  } as RepoResult<T>;
}

export function finish<T>(
  obs: Observation,
  hooks: ObserveHooks,
  data: T,
  extra?: { key: string; again: () => string },
): RepoResult<T> {
  if (!unchanged(obs, hooks, extra)) return changed(obs);
  return { ok: true, context: contextOf(obs.status, obs.model), data };
}

/** An error about what was observed (e.g. UNKNOWN_CHANGE), still only if the observation held. */
export function failFinal<T>(error: RepoError, obs: Observation, hooks: ObserveHooks): RepoResult<T> {
  if (!unchanged(obs, hooks)) return changed(obs);
  return { ok: false, context: contextOf(obs.status, obs.model), error };
}

/** A revision of this store, or undefined if it cannot be read. */
export function readRevision(reader: FileStoreReader, rev: string): Model | undefined {
  try {
    return reader.revision(rev);
  } catch {
    return undefined;
  }
}
