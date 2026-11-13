// Implementation bindings (IR v0.2 §8, ADR 0007 §§4–5). Kept outside the canonical IR: a
// binding is a *claim* by an agent or a person that some source artifact implements, exposes,
// persists or tests a stable model object. VCV checks that the claim is well formed and that its
// pointer resolves; it never decides whether the code means what the claim says.
//
// Core only defines the shapes. Reading files, Git and source resolution live in @vcv/repo.
import type { Id } from "@vcv/ir";

export const BINDING_RELATIONS = ["implements", "exposes", "persists", "tests"] as const;
export type BindingRelation = (typeof BINDING_RELATIONS)[number];

/** Who made the claim. Supplied by the trusted host, never by the claim payload. */
export type ClaimSource = "agent" | "human" | "tool";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const SYMBOL_DECLARATIONS = [
  "class",
  "function",
  "method",
  "property",
  "accessor",
  "const",
  "interface",
  "type",
  "enum",
] as const;
export type SymbolDeclaration = (typeof SYMBOL_DECLARATIONS)[number];

export type Selector =
  | { kind: "file" }
  /** `name` is the dotted container path: `OrderService.place`. */
  | { kind: "symbol"; name: string; declaration?: SymbolDeclaration }
  /** Controller-relative route (`@Controller` path + method decorator path); no global prefix. */
  | { kind: "route"; method: HttpMethod; route: string; handler?: string }
  /** describe/it/test titles, outermost first, joined with " > ". */
  | { kind: "test"; name: string };

/** Where an artifact is. Written by the claimant; VCV only checks that it resolves. */
export type SourceLocator = {
  /** Repository-relative POSIX path, already normalized: no "..", ".", "//", leading "/" or "\\". */
  path: string;
  selector: Selector;
};

/** One claim, stored as `.vcv/bindings/<bindingId>.json` and versioned by Git. */
export type BindingClaim = {
  format: 1;
  /** Persisted-ID grammar. Minted once at creation and kept when the claim is reasserted. */
  bindingId: string;
  modelObjectId: Id;
  relation: BindingRelation;
  locator: SourceLocator;
  provenance: {
    source: ClaimSource;
    principalId: string;
    rationale?: string;
    /** The claimant's own estimate in [0, 1]; never computed by VCV. */
    confidence?: number;
  };
  /** The model revision the claim was made against. Must be in HEAD's history when recorded. */
  modelRevision: string;
  /** What was inspected when the claim was recorded. */
  observed: {
    /** Git commit of the checkout, or null outside Git / before the first commit. */
    commit: string | null;
    /** The bound file compared with `commit`: unchanged, edited, or not tracked by Git. */
    workingTree: "clean" | "modified" | "untracked" | "no-git";
    fingerprint: {
      /** Fingerprint scheme; a claim from another scheme is compared as "unknown", never as changed. */
      algorithm: string;
      /** sha256 of the file bytes with CRLF normalized to LF. */
      file: string;
      /** sha256 of the selected declaration's token sequence (comments and whitespace ignored). Absent for `file` selectors and unchecked claims. */
      selector?: string;
    };
  };
  /** A recorded fact, set only by an explicit dispute operation; never by verification. */
  disputed?: { by: string; reason: string };
};

/** Whether the pointer resolves now. Says nothing about behaviour or approval. */
export type LocatorState =
  /** Path and selector resolve to exactly one artifact. */
  | "resolved"
  /** The path or the selector does not resolve. */
  | "missing"
  /** The selector matches more than one artifact; none is picked. */
  | "ambiguous"
  /** The file type or selector cannot be checked by the resolver; only the claim is reported. */
  | "unchecked";

/**
 * Overall derived state (ADR 0007 §5). Never stored. `resolved` requires complete evidence: a
 * unique locator and both the source and the model axis known unchanged. `indeterminate`: the
 * locator resolves but some evidence is unknown (project not ready, the claim's revision is not
 * in this checkout's history, a fingerprint scheme this VCV does not know), so it is not a pass.
 */
export type BindingState = LocatorState | "stale" | "indeterminate";

/**
 * @deprecated M1 placeholder. It treats any commit change as staleness, which ADR 0007 §5
 * rejects ("a changed Git commit alone does not make a binding stale"). Use BindingClaim and
 * @vcv/repo's verifyBinding instead.
 */
export type BindingStatus = "confirmed" | "unverified" | "stale" | "missing" | "disputed";

/** @deprecated See BindingStatus. */
export type Binding = {
  modelObjectId: Id;
  modelRevision: string;
  repositoryId: string;
  commit: string;
  locator: string;
  relation: BindingRelation;
  provenance: "human" | "agent" | "inferred";
  confidence?: number;
  status: BindingStatus;
};

/** @deprecated See BindingStatus. */
export type Snapshot = {
  modelRevision: string;
  /** Current commit per repository. */
  commits: Record<string, string>;
  /** Model objects whose definition changed since the binding's revision, if known. */
  changedObjectIds?: ReadonlySet<Id>;
};

/** @deprecated See BindingStatus. */
export function assessBinding(b: Binding, now: Snapshot): BindingStatus {
  if (b.status === "disputed" || b.status === "missing") return b.status;
  const codeMoved = now.commits[b.repositoryId] !== b.commit;
  const modelMoved = now.modelRevision !== b.modelRevision;
  if (!codeMoved && !modelMoved) return b.status;
  if (!codeMoved && now.changedObjectIds && !now.changedObjectIds.has(b.modelObjectId)) return b.status;
  return "stale";
}
