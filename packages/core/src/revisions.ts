// Branch-safe model revision identity (docs/adr/0007-repository-projects.md).
//
// A revision ID is `rev-<seq>-<digest>`:
//   seq     position in this store's linear history (1-based); for people, not for identity
//   digest  first 12 hex chars of sha256 over the parent revision ID and the canonical model
//
// Two Git branches that both commit after rev-1 therefore produce different IDs
// (rev-2-3f9a… and rev-2-c01d…) unless they made exactly the same change, in which case
// the two states are identical and sharing an ID is correct. Legacy IDs (rev-1, rev-2, v7…)
// stay valid: they are read as-is and simply cannot be verified against their content.
import { canonicalJson, sha256Hex } from "./digest.ts";
import { dumpModel, loadModel } from "@vcv/ir";
import type { Model } from "@vcv/ir";

const BRANCH_SAFE = /^rev-(\d+)-([0-9a-f]{12})$/;
export const REVISION_DIGEST_LENGTH = 12;

/**
 * Digest of a model state as a child of `parent`. The model's own modelRevision is excluded
 * (it is what we are computing). The model is round-tripped through the persisted YAML form
 * first, so the digest of a model before it is written equals the digest of the file read back.
 */
export function revisionDigest(model: Model, parent: string): string {
  const blank = structuredClone(model);
  blank.project.modelRevision = "rev-0";
  const persisted = loadModel(dumpModel(blank)).model ?? blank;
  persisted.project.modelRevision = "";
  return sha256Hex(`vcv-revision-v1\0${parent}\0${canonicalJson(persisted)}`).slice(0, REVISION_DIGEST_LENGTH);
}

/** The ID a model committed as the `seq`-th revision, directly after `parent`, receives. */
export function branchSafeRevisionId(model: Model, parent: string, seq: number): string {
  return `rev-${seq}-${revisionDigest(model, parent)}`;
}

export type ParsedRevisionId = { scheme: "branch-safe"; seq: number; digest: string } | { scheme: "legacy" };

export function parseRevisionId(id: string): ParsedRevisionId {
  const m = BRANCH_SAFE.exec(id);
  return m ? { scheme: "branch-safe", seq: Number(m[1]), digest: m[2]! } : { scheme: "legacy" };
}

/**
 * Whether `model`, stored under `id`, is exactly the `seq`-th revision committed after
 * `parent`. True only for branch-safe IDs; legacy IDs carry no digest to check.
 */
export function isChildRevision(id: string, model: Model, parent: string, seq: number): boolean {
  const p = parseRevisionId(id);
  return p.scheme === "branch-safe" && p.seq === seq && p.digest === revisionDigest(model, parent);
}
