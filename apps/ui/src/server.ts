// The UI host: a small HTTP server on 127.0.0.1 that serves the built web client and a JSON
// API over one ProjectSession. It refuses requests whose Host or Origin is not this server
// (DNS rebinding, other sites), and every write takes a JSON body, which a cross-site form
// cannot send.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { draftRoute } from "./drafts/routes.ts";
import { DraftRefused, DraftDesk } from "./drafts/service.ts";
import { DraftConflict, DraftMissing, DraftUnreadable } from "./drafts/store.ts";
import { PreviewFailed } from "./drafts/preview.ts";
import { BadEdit } from "./edits.ts";
import { EvidenceDesk, EvidenceUnavailable } from "./evidence.ts";
import type { EvidenceOptions } from "./evidence.ts";
import { NotFoundError } from "./inspector.ts";
import { ObservationLimit } from "./observe.ts";
import { InboxUnavailable, ProposalInbox } from "./proposals.ts";
import { StateChangedError } from "./session.ts";
import type { ProjectSession } from "./session.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};

export type HostOptions = {
  session: ProjectSession;
  webDir: string;
  port?: number;
  /** Where local drafts are kept: the UI state directory, outside every checkout. Default: the layout store's. */
  stateDir?: string;
  /** A Git ref naming the protected base (e.g. origin/main): the inbox checks integrity against it. */
  protectedBase?: string;
  /** Inputs for the evidence and pre-merge views (base commit, test-run records, policy). */
  evidence?: EvidenceOptions;
};

export type Host = { server: Server; url: string; close(): Promise<void> };

export async function startHost({
  session,
  webDir,
  port = 0,
  stateDir,
  protectedBase,
  evidence,
}: HostOptions): Promise<Host> {
  const desk = new DraftDesk(session, stateDir ?? session.stateDir);
  const inbox = new ProposalInbox(session, protectedBase ? { protectedBase } : {});
  const facts = new EvidenceDesk(session, evidence ?? {});
  const server = createServer((req, res) => {
    handle(req, res, session, desk, inbox, facts, webDir, server).catch((err: unknown) => {
      send(res, 500, { error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } });
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok());
  });
  const { port: bound } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${bound}/`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

function allowedHosts(server: Server): Set<string> {
  const { port } = server.address() as AddressInfo;
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  session: ProjectSession,
  desk: DraftDesk,
  inbox: ProposalInbox,
  facts: EvidenceDesk,
  webDir: string,
  server: Server,
) {
  const hosts = allowedHosts(server);
  if (!hosts.has(req.headers.host ?? "")) return send(res, 403, err("BAD_HOST", "unexpected Host header"));
  const origin = req.headers.origin;
  if (origin && !hosts.has(origin.replace(/^http:\/\//, "")))
    return send(res, 403, err("BAD_ORIGIN", "cross-origin request"));

  const url = new URL(req.url ?? "/", "http://host");
  if (!url.pathname.startsWith("/api/")) return serveStatic(res, webDir, url.pathname);

  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
  try {
    if (method === "GET" && parts[1] === "project" && parts.length === 2) return send(res, 200, session.view());
    if (method === "GET" && parts[1] === "modules" && parts[2] && parts.length === 3)
      return send(res, 200, session.module(parts[2]));
    if (method === "GET" && parts[1] === "objects" && parts[2] && parts.length === 3)
      return send(res, 200, session.object(parts[2]));
    if (parts[1] === "layout") {
      if (method !== "POST") return send(res, 405, err("METHOD", "layout changes use POST"));
      const body = await readJson(req);
      if (parts[2] === "pin" && typeof body.id === "string" && Number.isFinite(body.x) && Number.isFinite(body.y))
        return send(res, 200, { positions: session.pin(body.id, body.x as number, body.y as number) });
      if (parts[2] === "unpin" && typeof body.id === "string")
        return send(res, 200, { positions: session.unpin(body.id) });
      if (parts[2] === "tidy") return send(res, 200, { positions: session.tidy() });
      return send(res, 400, err("INVALID_REQUEST", "unknown layout request"));
    }
    if (parts[1] === "proposals") {
      // Read-only by design (Issue #44): submitting and approving happen through the CLI, and
      // approval needs a reviewer key this host never holds. There is no write route here.
      if (method !== "GET")
        return send(
          res,
          405,
          err(
            "READ_ONLY",
            "proposals are read-only here; submit with `vcv proposal submit`, approve with `vcv review approve`",
          ),
        );
      if (parts.length === 2) return send(res, 200, inbox.list());
      if (parts.length === 4 && parts[2] && parts[3] === "implementation")
        return send(res, 200, facts.implementation(parts[2], shown(url)));
      if (parts.length === 3 && parts[2]) return send(res, 200, inbox.review(parts[2]));
      return send(res, 404, err("NOT_FOUND", `no API route ${method} ${url.pathname}`));
    }
    if (parts[1] === "evidence" || parts[1] === "gate") {
      // Read-only observations (Issue #45): nothing here reasserts a claim, runs a test or writes.
      if (method !== "GET") return send(res, 405, err("READ_ONLY", "evidence is read-only"));
      const model = shown(url);
      if (parts[1] === "gate" && parts.length === 2) return send(res, 200, facts.gate(model));
      if (parts[2] === "objects" && parts[3] && parts.length === 4)
        return send(res, 200, facts.object(parts[3], model));
      if (parts[2] === "modules" && parts[3] && parts.length === 4)
        return send(res, 200, facts.module(parts[3], model));
      return send(res, 404, err("NOT_FOUND", `no API route ${method} ${url.pathname}`));
    }
    const draft = await draftRoute(desk, method, parts, () => readJson(req));
    if (draft) return send(res, draft.status, draft.body);
    return send(res, 404, err("NOT_FOUND", `no API route ${method} ${url.pathname}`));
  } catch (e) {
    if (e instanceof NotFoundError) return send(res, e.code === "NOT_READY" ? 409 : 404, err(e.code, e.message));
    if (e instanceof StateChangedError) return send(res, 409, err(e.code, e.message));
    if (e instanceof ObservationLimit) return send(res, 422, err(e.code, e.message));
    if (e instanceof BadRequest) return send(res, 400, err("INVALID_REQUEST", e.message));
    if (e instanceof BadEdit) return send(res, 400, err(e.code, e.message));
    if (e instanceof EvidenceUnavailable)
      return send(
        res,
        e.code === "UNKNOWN_ID" ? 404 : e.code === "INVALID_REQUEST" ? 400 : e.code === "UNSAFE_PATH" ? 422 : 409,
        err(e.code, e.message),
      );
    if (e instanceof InboxUnavailable)
      return send(
        res,
        e.code === "UNKNOWN_CHANGE" ? 404 : e.code === "INVALID_REQUEST" ? 400 : 409,
        err(e.code, e.message),
      );
    if (e instanceof DraftMissing) return send(res, 404, err(e.code, e.message));
    if (e instanceof DraftConflict)
      return send(res, 409, { ...err(e.code, e.message), ...(e.current ? { current: e.current } : {}) });
    if (e instanceof DraftUnreadable) return send(res, 422, err(e.code, e.message));
    if (e instanceof DraftRefused)
      return send(
        res,
        e.code === "INVALID_REQUEST" ? 400 : e.code === "UNKNOWN_STEP" ? 404 : 409,
        err(e.code, e.message),
      );
    if (e instanceof PreviewFailed)
      return send(res, e.code === "PROJECT_NOT_READY" ? 409 : 422, err(e.code, e.message));
    throw e;
  }
}

class BadRequest extends Error {}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
    throw new BadRequest("send a JSON body (Content-Type: application/json)");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65_536) throw new BadRequest("request body too large");
  }
  try {
    const v = JSON.parse(raw || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new BadRequest("the body is not a JSON object");
  }
}

function serveStatic(res: ServerResponse, webDir: string, pathname: string) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(webDir, rel);
  if (!file.startsWith(webDir + sep) && file !== webDir)
    return send(res, 403, err("FORBIDDEN", "outside the web root"));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, "index.html"); // client-side routes
  if (!existsSync(file))
    return send(res, 503, err("NOT_BUILT", "the web client is not built; run `npm run build -w @vcv/ui`"));
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(readFileSync(file));
}

const err = (code: string, message: string) => ({ error: { code, message } });

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/** The model key the page says it is showing (`?model=`), if it sent one. */
const shown = (url: URL): string | undefined => url.searchParams.get("model") ?? undefined;
