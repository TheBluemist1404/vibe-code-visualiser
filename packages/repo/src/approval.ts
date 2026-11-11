// Trusted reviewer approval and signed approval attestations (Issue #17, M3.2).
//
// The threat model is in docs/approvals.md. In short: `--as`, `--perm` and `VCV_HOST_*` are
// assertions by whoever runs the CLI, so a shell-capable coding agent can make them too. They
// cannot be the reason a change counts as approved. Here, the reviewer's authority comes from a
// private key the agent does not hold:
//
//   - a reviewer has an Ed25519 key pair; the private key stays outside the repository (and
//     outside whatever the agent's sandbox can read); the public key is listed, with the
//     reviewer's principal ID, in a trust list (`.vcv/reviewers.json`, changed like any other
//     file through a reviewed PR to the protected branch);
//   - `reviewApprove` derives the principal and its permission from the key's entry in a trust
//     list, never from flags or the environment, calls ModelEngine.approve bound to the proposal
//     digest the reviewer saw, and writes a signed attestation `.vcv/approvals/<changeId>.json`
//     next to the change record;
//   - `checkIntegrity` (integrity.ts) verifies the attestation against a trust list read from a
//     place the change under review cannot alter (a protected base ref, or a file outside the
//     checkout).
//
// What this proves: the holder of a key trusted by that source signed exactly this change
// (content digest, base and resulting revision). It does not prove which person held the key.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { persistedIdProblem } from "@vcv/ir";
import { FileStore, ModelEngine, canonicalJson, durableWrite, proposalDigest, readStoreFile } from "@vcv/core";
import type { ChangeRecord, Outcome } from "@vcv/core";
import { fileAtCommit, resolveCommit } from "./git.ts";
import { VCV_DIR, projectStatus } from "./project.ts";

export const REVIEWERS_FILE = "reviewers.json";
export const APPROVALS_DIR = "approvals";
const MAX_TRUST_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
export const MAX_ATTESTATION_BYTES = 64 * 1024;

// ---- trust lists -----------------------------------------------------------------------

const principalId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:@-]+$/, "letters, digits and . _ : @ -");
const publicKey = z.string().regex(/^ed25519:[A-Za-z0-9+/]+=*$/, 'must be "ed25519:<base64 SPKI DER>"');

export const trustListSchema = z
  .object({
    format: z.literal(1),
    reviewers: z.array(z.object({ id: principalId, publicKey, permissions: z.array(z.literal("model:approve")).min(1).default(["model:approve"]) }).strict()).max(200),
  })
  .strict();

export type TrustList = z.infer<typeof trustListSchema>;
export type TrustEntry = TrustList["reviewers"][number];

/** Where a trust list comes from. Only a source the reviewed change cannot alter makes an attestation meaningful. */
export type TrustSource = { kind: "file"; path: string } | { kind: "git-ref"; ref: string } | { kind: "working-tree" };

export type LoadedTrust = { list: TrustList; source: string; commit?: string; protectedFromCheckout: boolean };

export class ApprovalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApprovalError";
  }
}

/** Read a file outside the store safely: regular, not a symlink, bounded, never blocking. */
function readPlainFile(path: string, max: number, what: string): Buffer {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new ApprovalError("NOT_FOUND", `${what} ${path} does not exist`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new ApprovalError("UNSAFE_PATH", `${what} ${path} is ${st.isSymbolicLink() ? "a symlink" : "not a regular file"}; it was not read`);
  if (st.size > max) throw new ApprovalError("UNSAFE_PATH", `${what} ${path} is larger than ${max} bytes`);
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new ApprovalError("UNSAFE_PATH", `${what} ${path} is not a regular file`);
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0; ) n += r;
    if (n > max) throw new ApprovalError("UNSAFE_PATH", `${what} ${path} is larger than ${max} bytes`);
    return Buffer.from(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

function parseTrust(bytes: Buffer, where: string): TrustList {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ApprovalError("INVALID_TRUST", `trust list ${where} is not valid JSON`);
  }
  const r = trustListSchema.safeParse(raw);
  if (!r.success) throw new ApprovalError("INVALID_TRUST", `trust list ${where} is invalid: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (new Set(r.data.reviewers.map((x) => x.publicKey)).size !== r.data.reviewers.length) throw new ApprovalError("INVALID_TRUST", `trust list ${where} lists a key twice`);
  return r.data;
}

/** Load a trust list. Throws ApprovalError when it is missing or invalid. */
export function loadTrust(root: string, source: TrustSource): LoadedTrust {
  switch (source.kind) {
    case "file":
      return { list: parseTrust(readPlainFile(source.path, MAX_TRUST_BYTES, "trust list"), source.path), source: `file ${source.path}`, protectedFromCheckout: !source.path.startsWith(root + "/") };
    case "git-ref": {
      const commit = resolveCommit(root, source.ref);
      if (!commit) throw new ApprovalError("UNKNOWN_REF", `${source.ref} is not a commit in this repository`);
      const bytes = fileAtCommit(root, commit, `${VCV_DIR}/${REVIEWERS_FILE}`, MAX_TRUST_BYTES);
      if (!bytes) throw new ApprovalError("NO_TRUST_LIST", `${source.ref} (${commit.slice(0, 12)}) has no ${VCV_DIR}/${REVIEWERS_FILE}`);
      return { list: parseTrust(bytes, `${VCV_DIR}/${REVIEWERS_FILE} at ${source.ref}`), source: `${VCV_DIR}/${REVIEWERS_FILE} at ${source.ref} (${commit.slice(0, 12)})`, commit, protectedFromCheckout: true };
    }
    case "working-tree": {
      const f = readStoreFile(join(root, VCV_DIR), REVIEWERS_FILE, MAX_TRUST_BYTES);
      if (f.kind === "absent") throw new ApprovalError("NO_TRUST_LIST", `${VCV_DIR}/${REVIEWERS_FILE} does not exist`);
      if (f.kind === "unsafe") throw new ApprovalError("UNSAFE_PATH", f.problem);
      return { list: parseTrust(f.bytes, `${VCV_DIR}/${REVIEWERS_FILE}`), source: `${VCV_DIR}/${REVIEWERS_FILE} in the working tree`, protectedFromCheckout: false };
    }
  }
}

// ---- keys ------------------------------------------------------------------------------

const encodePublic = (k: KeyObject) => `ed25519:${(k.export({ type: "spki", format: "der" }) as Buffer).toString("base64")}`;
const decodePublic = (s: string): KeyObject => createPublicKey({ key: Buffer.from(s.slice("ed25519:".length), "base64"), format: "der", type: "spki" });

/** Short, stable identifier of a public key (sha256 of its DER, first 16 hex). */
export function keyFingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey.slice("ed25519:".length), "base64")).digest("hex").slice(0, 16);
}

/**
 * Create a reviewer key pair. The private key is written to `keyPath` (mode 0600, never
 * overwritten); keep it outside the repository and outside any agent sandbox. Returns the trust
 * list entry for the public key.
 */
export function createReviewerKey(id: string, keyPath: string): TrustEntry {
  const pid = principalId.safeParse(id);
  if (!pid.success) throw new ApprovalError("INVALID_ID", `reviewer id: ${pid.error.issues[0]!.message}`);
  const { privateKey, publicKey: pub } = generateKeyPairSync("ed25519");
  try {
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600, flag: "wx" });
  } catch (e) {
    throw new ApprovalError("KEY_EXISTS", `cannot create ${keyPath}: ${(e as NodeJS.ErrnoException).code === "EEXIST" ? "it already exists (never overwritten)" : (e as Error).message}`);
  }
  return { id, publicKey: encodePublic(pub), permissions: ["model:approve"] };
}

/** Add an entry to the checkout's `.vcv/reviewers.json` (created if absent). Commit it through a reviewed PR. */
export function addTrustedReviewer(path: string, entry: TrustEntry): string {
  const status = projectStatus(path);
  if (status.state !== "ready") throw new ApprovalError("PROJECT_NOT_READY", `the VCV project is ${status.state}`);
  const f = readStoreFile(status.storeDir, REVIEWERS_FILE, MAX_TRUST_BYTES);
  if (f.kind === "unsafe") throw new ApprovalError("UNSAFE_PATH", f.problem);
  const list: TrustList = f.kind === "file" ? parseTrust(f.bytes, `${VCV_DIR}/${REVIEWERS_FILE}`) : { format: 1, reviewers: [] };
  if (list.reviewers.some((r) => r.publicKey === entry.publicKey)) throw new ApprovalError("KEY_EXISTS", "this key is already listed");
  list.reviewers.push(entry);
  const file = join(status.storeDir, REVIEWERS_FILE);
  durableWrite(file, JSON.stringify(list, null, 2) + "\n");
  return `${VCV_DIR}/${REVIEWERS_FILE}`;
}

function loadPrivateKey(keyFile: string): KeyObject {
  const bytes = readPlainFile(keyFile, MAX_KEY_BYTES, "reviewer key");
  try {
    const k = createPrivateKey(bytes);
    if (k.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
    return k;
  } catch (e) {
    throw new ApprovalError("INVALID_KEY", `reviewer key ${keyFile} is not an Ed25519 private key (${(e as Error).message})`);
  }
}

// ---- attestations ----------------------------------------------------------------------

export const attestationSchema = z
  .object({
    format: z.literal(1),
    changeId: z.string(),
    projectId: z.string(),
    proposalDigest: z.string().regex(/^[0-9a-f]{64}$/),
    proposerId: z.string(),
    approverId: z.string(),
    baseRevision: z.string(),
    resultingRevision: z.string(),
    publicKey,
    keyFingerprint: z.string(),
    signedAt: z.string(),
    signature: z.string().regex(/^[A-Za-z0-9+/]+=*$/),
  })
  .strict();

export type Attestation = z.infer<typeof attestationSchema>;

const payloadOf = (a: Omit<Attestation, "signature">) => Buffer.from(`vcv-approval-v1\0${canonicalJson(a)}`);

/** Whether the signature is a valid Ed25519 signature of the attestation by its own public key. */
export function signatureValid(a: Attestation): boolean {
  try {
    const { signature, ...rest } = a;
    return verify(null, payloadOf(rest), decodePublic(a.publicKey), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** The attestation file for a change, read safely. */
export function readAttestation(storeDir: string, changeId: string): { attestation?: Attestation; problem?: string } | null {
  if (persistedIdProblem(changeId)) return { problem: "invalid change id" };
  const f = readStoreFile(storeDir, `${APPROVALS_DIR}/${changeId}.json`, MAX_ATTESTATION_BYTES);
  if (f.kind === "absent") return null;
  if (f.kind === "unsafe") return { problem: f.problem };
  let raw: unknown;
  try {
    raw = JSON.parse(f.text);
  } catch {
    return { problem: `${APPROVALS_DIR}/${changeId}.json is not valid JSON` };
  }
  const r = attestationSchema.safeParse(raw);
  return r.success ? { attestation: r.data } : { problem: `${APPROVALS_DIR}/${changeId}.json is not an attestation: ${r.error.issues[0]!.message}` };
}

// ---- the reviewer step -----------------------------------------------------------------

export type ReviewApproveInput = {
  changeId: string;
  /** The proposalDigest the reviewer saw in `vcv proposal preview`. Required. */
  expectedDigest: string;
  keyFile: string;
  trust: TrustSource;
  now?: () => Date;
};

export type ReviewApproveResult = {
  outcome: Outcome;
  reviewer: { id: string; keyFingerprint: string; trustSource: string };
  attestation?: { file: string; attestation: Attestation };
};

/**
 * The trusted reviewer invocation. Identity and permission come only from the key and the trust
 * list; the engine then rechecks everything (pending, authorized, not self-approval, digest,
 * still valid on the current revision) and commits through FileStore. On success a signed
 * attestation is written next to the change record. Throws ApprovalError for key/trust problems.
 */
export function reviewApprove(path: string, input: ReviewApproveInput): ReviewApproveResult {
  const status = projectStatus(path);
  if (status.state !== "ready") throw new ApprovalError("PROJECT_NOT_READY", `the VCV project is ${status.state}`);
  if (!/^[0-9a-f]{64}$/.test(input.expectedDigest)) throw new ApprovalError("INVALID_DIGEST", "--digest must be the 64-hex proposalDigest shown by vcv proposal preview");
  const trust = loadTrust(status.root, input.trust);
  const key = loadPrivateKey(input.keyFile);
  const pub = encodePublic(createPublicKey(key));
  const entry = trust.list.reviewers.find((r) => r.publicKey === pub);
  if (!entry) throw new ApprovalError("UNTRUSTED_KEY", `the key ${keyFingerprint(pub)} is not in the trust list (${trust.source})`);
  const reviewer = { id: entry.id, keyFingerprint: keyFingerprint(pub), trustSource: trust.source };

  const engine = new ModelEngine(new FileStore(status.storeDir), { now: input.now });
  const outcome = engine.approve(input.changeId, { principalId: entry.id, permissions: entry.permissions }, { expectedDigest: input.expectedDigest });
  if (outcome.status !== "applied" || !outcome.record) return { outcome, reviewer };

  const r: ChangeRecord = outcome.record;
  const body: Omit<Attestation, "signature"> = {
    format: 1,
    changeId: r.changeId,
    projectId: r.projectId,
    proposalDigest: proposalDigest(r.change),
    proposerId: r.proposerId,
    approverId: r.approverId!,
    baseRevision: r.baseRevision,
    resultingRevision: r.resultingRevision!,
    publicKey: pub,
    keyFingerprint: reviewer.keyFingerprint,
    signedAt: (input.now?.() ?? new Date()).toISOString(),
  };
  const attestation: Attestation = { ...body, signature: sign(null, payloadOf(body), key).toString("base64") };
  const dirStat = (() => {
    try {
      return lstatSync(join(status.storeDir, APPROVALS_DIR));
    } catch {
      return null;
    }
  })();
  if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) {
    // The change is applied; only the attestation could not be written. Say so plainly.
    throw new ApprovalError("UNSAFE_PATH", `${VCV_DIR}/${APPROVALS_DIR}/ is not a plain directory; change ${r.changeId} was applied as ${r.resultingRevision} but its attestation was not written`);
  }
  mkdirSync(join(status.storeDir, APPROVALS_DIR), { recursive: true });
  const rel = `${APPROVALS_DIR}/${r.changeId}.json`;
  durableWrite(join(status.storeDir, rel), JSON.stringify(attestation, null, 2) + "\n");
  return { outcome, reviewer, attestation: { file: `${VCV_DIR}/${rel}`, attestation } };
}
