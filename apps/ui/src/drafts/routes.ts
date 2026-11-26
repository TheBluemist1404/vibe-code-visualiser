// HTTP routes for local drafts. Thin: each route reads its JSON body and calls the DraftDesk.
// There is no submit or approve route: a draft leaves the browser only as an export.
import type { DraftDesk } from "./service.ts";

type Reply = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

/** Answer /api/drafts[/...], or null when the path is not a draft route. */
export async function draftRoute(
  desk: DraftDesk,
  method: string,
  parts: string[],
  body: ReadBody,
): Promise<Reply | null> {
  if (parts[1] !== "drafts") return null;
  const [, , id, action] = parts;
  const ok = (b: unknown, status = 200): Reply => ({ status, body: b });
  if (!id) {
    if (method === "GET") return ok(desk.list());
    if (method === "POST") {
      await body();
      return ok(desk.create(), 201);
    }
    return methodNotAllowed();
  }
  if (!action) return method === "GET" ? ok(desk.get(id)) : methodNotAllowed();
  if (action === "export") return method === "GET" ? ok(desk.export(id)) : methodNotAllowed();
  if (method !== "POST") return methodNotAllowed();
  const b = await body();
  switch (action) {
    case "stage":
      return ok(desk.stage(id, b));
    case "unstage":
      return ok(desk.unstage(id, b));
    case "rationale":
      return ok(desk.annotate(id, b));
    case "request":
      return ok(desk.request(id, b));
    case "discard":
      return ok(desk.discard(id, b));
    case "preview":
      return ok(desk.preview(id));
    default:
      return { status: 404, body: { error: { code: "NOT_FOUND", message: `no draft action ${action}` } } };
  }
}

const methodNotAllowed = (): Reply => ({
  status: 405,
  body: { error: { code: "METHOD", message: "draft reads use GET and changes use POST with a JSON body" } },
});
