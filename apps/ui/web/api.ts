// Calls to the local UI host. Same origin only; every write sends a JSON body.
import type {
  DraftPreview,
  DraftRequest,
  ModuleView,
  ObjectView,
  Position,
  ProjectView,
  ProposalsView,
  SubmitView,
} from "../src/types.ts";

export class HostError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit, accept: number[] = []): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new HostError(0, "HOST_UNREACHABLE", "the VCV host is not answering; is `npm run ui` still running?");
  }
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok && !accept.includes(res.status))
    throw new HostError(res.status, body?.error?.code ?? "HTTP", body?.error?.message ?? res.statusText);
  return body as T;
}

const post = <T>(path: string, body: unknown, accept: number[] = []) =>
  call<T>(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    accept,
  );

type Positions = { positions: Record<string, Position> };

export const api = {
  project: () => call<ProjectView>("/api/project"),
  module: (id: string) => call<ModuleView>(`/api/modules/${encodeURIComponent(id)}`),
  object: (id: string) => call<ObjectView>(`/api/objects/${encodeURIComponent(id)}`),
  pin: (id: string, x: number, y: number) => post<Positions>("/api/layout/pin", { id, x, y }),
  unpin: (id: string) => post<Positions>("/api/layout/unpin", { id }),
  tidy: () => post<Positions>("/api/layout/tidy", {}),
  proposals: () => call<ProposalsView>("/api/proposals"),
  preview: (draft: DraftRequest) => post<DraftPreview>("/api/proposals/preview", draft),
  /** 422 is an answer, not a failure: the draft was checked and nothing was recorded. */
  submit: (draft: DraftRequest) => post<SubmitView>("/api/proposals/submit", draft, [422]),
};
