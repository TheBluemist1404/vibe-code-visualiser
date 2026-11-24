// The routes behind the proposal detail read the repository through a checkout-rooted boundary
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
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import { describeWeb, setup, submit, tempDir } from "./fixtures.ts";

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
