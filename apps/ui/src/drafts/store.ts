// Local drafts on disk, outside the checkout: one directory per checkout and project, one file
// per draft. Every write checks the version the caller read, so a second tab gets an explicit
// conflict instead of silently replacing the first tab's edits. Files that cannot be read are
// reported and left alone until someone discards them on purpose.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DraftProblem } from "../types.ts";
import { DRAFT_LIMITS, DraftFileProblem, isDraftId, parseDraft } from "./format.ts";
import type { DraftFile } from "./format.ts";

export class DraftConflict extends Error {
  readonly code = "DRAFT_CONFLICT";
  readonly current: DraftFile | null;
  constructor(message: string, current: DraftFile | null) {
    super(message);
    this.current = current;
  }
}

export class DraftMissing extends Error {
  readonly code = "UNKNOWN_DRAFT";
}

export class DraftUnreadable extends Error {
  readonly code: string;
  constructor(problem: DraftFileProblem) {
    super(problem.message);
    this.code = `DRAFT_${problem.code}`;
  }
}

export type Scope = { root: string; projectId: string };

export class DraftFileStore {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "drafts");
  }

  /** The directory for one checkout and project. Two checkouts never share one. */
  dirFor({ root, projectId }: Scope): string {
    const key = createHash("sha256").update(`${root}\0${projectId}`).digest("hex").slice(0, 24);
    return join(this.dir, key);
  }

  private file(scope: Scope, draftId: string): string {
    if (!isDraftId(draftId)) throw new DraftMissing(`"${draftId}" is not a draft ID`);
    return join(this.dirFor(scope), `${draftId}.json`);
  }

  /** Every draft for this checkout and project, newest first, and the files that are unusable. */
  list(scope: Scope): { drafts: DraftFile[]; problems: DraftProblem[] } {
    const dir = this.dirFor(scope);
    const drafts: DraftFile[] = [];
    const problems: DraftProblem[] = [];
    if (!existsSync(dir)) return { drafts, problems };
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const draftId = name.slice(0, -5);
      if (!isDraftId(draftId)) continue;
      try {
        drafts.push(this.read(scope, draftId));
      } catch (e) {
        if (e instanceof DraftUnreadable) problems.push({ draftId, code: e.code, message: e.message });
        else throw e;
      }
    }
    drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.draftId.localeCompare(a.draftId));
    return { drafts, problems };
  }

  read(scope: Scope, draftId: string): DraftFile {
    const path = this.file(scope, draftId);
    if (!existsSync(path)) throw new DraftMissing(`no draft ${draftId} for this checkout and project`);
    try {
      if (statSync(path).size > DRAFT_LIMITS.fileBytes)
        throw new DraftFileProblem("TOO_LARGE", `larger than ${DRAFT_LIMITS.fileBytes} bytes; not read`);
      return parseDraft(readFileSync(path, "utf8"), { draftId, ...scope });
    } catch (e) {
      if (e instanceof DraftFileProblem) throw new DraftUnreadable(e);
      throw e;
    }
  }

  /**
   * Write a draft when the file still holds `expectedVersion` (null: the draft must not exist
   * yet). The new file replaces the old one atomically (temporary file, then rename).
   */
  write(scope: Scope, draft: DraftFile, expectedVersion: number | null): DraftFile {
    const path = this.file(scope, draft.draftId);
    const exists = existsSync(path);
    if (expectedVersion === null) {
      if (exists) throw new DraftConflict(`draft ${draft.draftId} already exists`, null);
      if (this.list(scope).drafts.length >= DRAFT_LIMITS.drafts)
        throw new DraftConflict(`at most ${DRAFT_LIMITS.drafts} drafts per project; discard one first`, null);
    } else {
      if (!exists) throw new DraftMissing(`no draft ${draft.draftId} for this checkout and project`);
      const current = this.read(scope, draft.draftId);
      if (current.version !== expectedVersion)
        throw new DraftConflict(
          `draft ${draft.draftId} changed elsewhere (version ${current.version}, this edit was made on ${expectedVersion}); nothing was overwritten`,
          current,
        );
    }
    const text = `${JSON.stringify(draft, null, 2)}\n`;
    if (Buffer.byteLength(text) > DRAFT_LIMITS.fileBytes)
      throw new DraftConflict(`the draft would be larger than ${DRAFT_LIMITS.fileBytes} bytes; not saved`, null);
    mkdirSync(this.dirFor(scope), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return draft;
  }

  /**
   * Delete a draft on purpose. A readable draft needs the version the caller saw; an unreadable
   * file (corrupt, too large, foreign) is deleted only when the caller names it explicitly.
   */
  discard(scope: Scope, draftId: string, expectedVersion: number | null): void {
    const path = this.file(scope, draftId);
    if (!existsSync(path)) throw new DraftMissing(`no draft ${draftId} for this checkout and project`);
    let current: DraftFile | null = null;
    try {
      current = this.read(scope, draftId);
    } catch (e) {
      if (!(e instanceof DraftUnreadable)) throw e;
    }
    if (current && current.version !== expectedVersion)
      throw new DraftConflict(
        `draft ${draftId} changed elsewhere (version ${current.version}); look at it again before discarding`,
        current,
      );
    rmSync(path);
  }
}
