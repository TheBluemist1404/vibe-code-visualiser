// The routes behind the proposal detail and the evidence views read the repository through a checkout-rooted boundary
// (Issue #44/#48 review): a folder swapped for a symlink to somewhere outside the checkout while
// the answer is composed is never read through, and a host that cannot enforce that serves nothing.
import assert from "node:assert/strict";
import {
  cpSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { containedTestHooks } from "@vcv/core";
import { recordBinding } from "@vcv/repo";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import type { ObjectEvidenceView } from "../src/types.ts";
import { evidenceWorld } from "./evidence-fixture.ts";
import { describeWeb, git, setup, submit, tempDir } from "./fixtures.ts";

const hosts: Host[] = [];
after(() => Promise.all(hosts.map((h) => h.close())));

async function host(repo: string) {
  const h = await startHost({
    session: new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-"))),
    webDir: tempDir(),
  });
  hosts.push(h);
  return async (path: string) => {
    const r = await fetch(h.url + path.replace(/^\//, ""));
    return { status: r.status, text: await r.text() };
  };
}

const MARKER = "OUTSIDE-THE-CHECKOUT";

test("GET /api/proposals/:id never reads through a records folder swapped for a symlink out of the checkout mid-read: 422, nothing from outside", async () => {
  const { repo } = setup();
  assert.equal(submit(repo, "chg-web", describeWeb("Pages for students.")).status, 0);
  const call = await host(repo);
  const clean = await call("/api/proposals/chg-web");
  assert.equal(clean.status, 200, clean.text);

  const changes = join(realpathSync(repo), ".vcv", "changes");
  const [file] = readdirSync(changes).filter((f) => f.startsWith("chg-web"));
  assert.ok(file, "the record exists");
  // Outside: the same records, with the shown text changed, so a read through the link would show.
  const outside = join(tempDir("vcv-outside-"), "changes");
  cpSync(changes, outside, { recursive: true });
  const rec = join(outside, file);
  writeFileSync(rec, readFileSync(rec, "utf8").replaceAll("Pages for students.", MARKER));

  // Swap the folder just before the proposal read (not the identity check) opens the record, after
  // every check on its path, and put it back when the closing identity check starts, so the checkout looks the same
  // before and after the read.
  let state = "armed" as "armed" | "swapped" | "restored";
  containedTestHooks.beforeOpen = (abs) => {
    if (state === "armed" && abs === join(changes, file) && /previewProposal/.test(new Error().stack ?? "")) {
      renameSync(changes, `${changes}.keep`);
      symlinkSync(outside, changes);
      state = "swapped";
    } else if (state === "swapped" && /checkoutIdentity/.test(new Error().stack ?? "")) {
      rmSync(changes);
      renameSync(`${changes}.keep`, changes);
      state = "restored";
    }
  };
  try {
    const r = await call("/api/proposals/chg-web");
    assert.notEqual(state, "armed", "the swap happened");
    assert.equal(r.status, 422, r.text);
    assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "OBSERVATION_LIMIT");
    assert.ok(!r.text.includes(MARKER), "nothing read from outside the checkout");
  } finally {
    containedTestHooks.beforeOpen = undefined;
    if (state === "swapped") {
      rmSync(changes);
      renameSync(`${changes}.keep`, changes);
    }
  }
  const again = await call("/api/proposals/chg-web");
  assert.equal(again.status, 200, "served again once nothing is swapped");
});

test("a store outside Git opened through a symlinked path is contained the same way: a records folder swapped mid-read is 422", async () => {
  const { repo } = setup();
  assert.equal(submit(repo, "chg-web", describeWeb("Pages for students.")).status, 0);
  // The same initialized store, outside Git, reached through an alias (a symlink to its folder).
  const real = join(tempDir("vcv-nogit-"), "store");
  cpSync(repo, real, { recursive: true });
  rmSync(join(real, ".git"), { recursive: true, force: true });
  const alias = join(tempDir("vcv-alias-"), "via-link");
  symlinkSync(real, alias);
  const call = await host(alias);
  const clean = await call("/api/proposals/chg-web");
  assert.equal(clean.status, 200, clean.text);

  const keep = join(real, ".vcv", "changes.keep");
  const outside = join(tempDir("vcv-outside-"), "changes");
  cpSync(join(real, ".vcv", "changes"), outside, { recursive: true });
  let state = "armed" as "armed" | "swapped" | "restored";
  containedTestHooks.beforeOpen = (abs) => {
    if (
      state === "armed" &&
      abs.endsWith("/.vcv/changes/chg-web.json") &&
      /previewProposal/.test(new Error().stack ?? "")
    ) {
      renameSync(join(real, ".vcv", "changes"), keep);
      symlinkSync(outside, join(real, ".vcv", "changes"));
      state = "swapped";
    }
  };
  try {
    const r = await call("/api/proposals/chg-web");
    assert.notEqual(state, "armed", "the swap happened");
    assert.equal(r.status, 422, r.text);
    assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "OBSERVATION_LIMIT");
  } finally {
    containedTestHooks.beforeOpen = undefined;
    if (state === "swapped") {
      rmSync(join(real, ".vcv", "changes"));
      renameSync(keep, join(real, ".vcv", "changes"));
    }
  }
  assert.equal((await call("/api/proposals/chg-web")).status, 200, "served again once nothing is swapped");
});

test("where reads cannot be contained in the checkout, GET /api/proposals and /api/proposals/:id serve nothing: 422 OBSERVATION_LIMIT", async () => {
  const { repo } = setup();
  assert.equal(submit(repo, "chg-web", describeWeb("Pages.")).status, 0);
  const call = await host(repo);
  containedTestHooks.unavailable = true;
  try {
    for (const path of ["/api/proposals", "/api/proposals/chg-web"]) {
      const r = await call(path);
      assert.equal(r.status, 422, `${path}: ${r.text}`);
      const body = JSON.parse(r.text) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "OBSERVATION_LIMIT");
      assert.match(body.error.message, /cannot be contained/);
    }
  } finally {
    containedTestHooks.unavailable = undefined;
  }
  assert.equal((await call("/api/proposals/chg-web")).status, 200);
});

test("GET /api/evidence/objects/:id reads source through the same boundary: an in-checkout symlinked folder still resolves; a source folder swapped out of the checkout mid-read is 422", async () => {
  const { repo, base } = evidenceWorld();
  // A claim through an in-checkout symlinked folder: a supported layout, resolved as before.
  symlinkSync("enrollment", join(repo, "server/src/enrollment-link"));
  recordBinding(
    repo,
    {
      bindingId: "impl.linked",
      modelObjectId: "cap-enroll",
      relation: "implements",
      locator: { path: "server/src/enrollment-link/enrollment.service.ts", selector: { kind: "file" } },
    },
    { principalId: "agent:coder", permissions: ["binding:record"], source: "agent" } as never,
    null,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "a claim through a symlinked folder");

  const folder = join(realpathSync(repo), "server/src/enrollment");
  const outside = join(tempDir("vcv-outside-"), "enrollment");
  cpSync(folder, outside, { recursive: true });
  writeFileSync(join(outside, "enrollment.service.ts"), `// ${MARKER}\n`);
  let state = "armed" as "armed" | "swapped" | "restored";
  const restore = () => {
    if (state !== "swapped") return;
    rmSync(folder);
    renameSync(`${folder}.keep`, folder);
    state = "restored";
  };
  const h = await startHost({
    session: new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-"))),
    webDir: tempDir(),
    // Put the folder back before the closing identity check, so only containment can refuse.
    evidence: { baseCommit: base, betweenReads: () => restore() },
  });
  hosts.push(h);
  const get = async (path: string) => {
    const r = await fetch(h.url + path.replace(/^\//, ""));
    return { status: r.status, text: await r.text() };
  };

  const clean = await get("/api/evidence/objects/cap-enroll");
  assert.equal(clean.status, 200, clean.text);
  const linked = (JSON.parse(clean.text) as ObjectEvidenceView).bindings.find((b) => b.bindingId === "impl.linked");
  assert.equal(linked?.pointer?.state, "resolved", "the in-checkout symlinked folder still resolves");

  // Swap the folder just before the evidence read (not the identity check) opens the source file.
  containedTestHooks.beforeOpen = (abs) => {
    if (
      state === "armed" &&
      abs === join(folder, "enrollment.service.ts") &&
      /getObjectEvidence/.test(new Error().stack ?? "")
    ) {
      renameSync(folder, `${folder}.keep`);
      symlinkSync(outside, folder);
      state = "swapped";
    }
  };
  try {
    const r = await get("/api/evidence/objects/cap-enroll");
    assert.notEqual(state, "armed", "the swap happened");
    assert.equal(r.status, 422, r.text);
    assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "OBSERVATION_LIMIT");
  } finally {
    containedTestHooks.beforeOpen = undefined;
    restore();
  }
  assert.equal((await get("/api/evidence/objects/cap-enroll")).status, 200, "served again once nothing is swapped");
});
