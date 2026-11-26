// Calls to the local UI host. Same origin only; every write sends a JSON body.
import type {
  DraftExport,
  DraftList,
  DraftPreview,
  DraftRequest,
  DraftView,
  GateView,
  ImplementationView,
  Inbox,
  ModuleEvidenceView,
  ObjectEvidenceView,
  ModuleView,
  ObjectView,
  Position,
  ProjectView,
  ProposalReview,
  StagedEdit,
} from "../src/types.ts";

export class HostError extends Error {
  readonly code: string;
  readonly status: number;
  /** For DRAFT_CONFLICT: the draft as it is now on disk. */
  readonly current?: unknown;
  constructor(status: number, code: string, message: string, current?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.current = current;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new HostError(0, "HOST_UNREACHABLE", "the VCV host is not answering; is `npm run ui` still running?");
  }
  const body = (await res.json().catch(() => null)) as {
    error?: { code: string; message: string };
    current?: unknown;
  } | null;
  if (!res.ok)
    throw new HostError(res.status, body?.error?.code ?? "HTTP", body?.error?.message ?? res.statusText, body?.current);
  return body as T;
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type Positions = { positions: Record<string, Position> };
const shown = (model: string) => `?model=${encodeURIComponent(model)}`;
const draft = (id: string, rest = "") => `/api/drafts/${encodeURIComponent(id)}${rest}`;

export const api = {
  project: () => call<ProjectView>("/api/project"),
  module: (id: string) => call<ModuleView>(`/api/modules/${encodeURIComponent(id)}`),
  object: (id: string) => call<ObjectView>(`/api/objects/${encodeURIComponent(id)}`),
  pin: (id: string, x: number, y: number) => post<Positions>("/api/layout/pin", { id, x, y }),
  unpin: (id: string) => post<Positions>("/api/layout/unpin", { id }),
  tidy: () => post<Positions>("/api/layout/tidy", {}),
  /** Read-only: there is no submit or approve call (approval is the reviewer's CLI step). */
  proposals: {
    list: () => call<Inbox>("/api/proposals"),
    review: (id: string) => call<ProposalReview>(`/api/proposals/${encodeURIComponent(id)}`),
  },
  /**
   * Read-only evidence (M5.5). `model` is the model key the page is showing: if the checkout has
   * moved on, the host answers STATE_CHANGED instead of describing a model the page is not showing.
   */
  evidence: {
    object: (id: string, model: string) =>
      call<ObjectEvidenceView>(`/api/evidence/objects/${encodeURIComponent(id)}${shown(model)}`),
    module: (id: string, model: string) =>
      call<ModuleEvidenceView>(`/api/evidence/modules/${encodeURIComponent(id)}${shown(model)}`),
    implementation: (changeId: string, model: string) =>
      call<ImplementationView>(`/api/proposals/${encodeURIComponent(changeId)}/implementation${shown(model)}`),
    gate: (model: string) => call<GateView>(`/api/gate${shown(model)}`),
  },
  drafts: {
    list: () => call<DraftList>("/api/drafts"),
    create: () => post<DraftView>("/api/drafts", {}),
    get: (id: string) => call<DraftView>(draft(id)),
    stage: (id: string, version: number, edit: StagedEdit) => post<DraftView>(draft(id, "/stage"), { version, edit }),
    unstage: (id: string, version: number, key: string) => post<DraftView>(draft(id, "/unstage"), { version, key }),
    rationale: (id: string, version: number, rationale: string) =>
      post<DraftView>(draft(id, "/rationale"), { version, rationale }),
    request: (id: string, version: number, request: DraftRequest) =>
      post<DraftView>(draft(id, "/request"), { version, request }),
    /** `version: null` discards an unreadable file. */
    discard: (id: string, version: number | null) => post<{ discarded: string }>(draft(id, "/discard"), { version }),
    preview: (id: string) => post<DraftPreview>(draft(id, "/preview"), {}),
    export: (id: string) => call<DraftExport>(draft(id, "/export")),
  },
};
