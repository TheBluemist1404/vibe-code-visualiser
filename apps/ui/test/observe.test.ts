// The checkout identity is exact or it is refused (Issue #48 review): no size/mtime stand-in for
// bytes, no link-size stand-in for a link, no silent skip of an entry that cannot be read. And the
// host closes even while a page holds a keep-alive connection open.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { Agent, get } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { LayoutFileStore } from "../src/layout-store.ts";
import { OBSERVE_LIMITS, ObservationLimit, checkoutIdentity, consistentRead } from "../src/observe.ts";
import { startHost } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import { setup, submit, describeWeb, tempDir } from "./fixtures.ts";

/** Some file under .vcv/ outside cache/. */
function storeFile(repo: string): string {
  const walk = (dir: string, rel: string): string | undefined => {
    for (const n of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${n.name}` : n.name;
      if (r === "cache") continue;
      if (n.isDirectory()) {
        const f = walk(join(dir, n.name), r);
        if (f) return f;
      } else if (n.isFile() && statSync(join(dir, n.name)).size > 4) return join(dir, n.name);
    }
  };
  const f = walk(join(repo, ".vcv"), "");
  assert.ok(f, "the fixture has a store file");
  return f;
}

/** Rewrite a file with different bytes of the same length, at the same whole-second mtime. */
const PINNED = 1_700_000_000;
function sameSizeSameTime(p: string) {
  utimesSync(p, PINNED, PINNED);
  const s = statSync(p);
  const b = readFileSync(p);
  b[b.length - 2] = b[b.length - 2] === 0x20 ? 0x09 : 0x20;
  writeFileSync(p, b);
  utimesSync(p, PINNED, PINNED);
  const t = statSync(p);
  assert.equal(t.size, s.size);
  assert.equal(t.mtimeMs, s.mtimeMs);
}

test("a store file rewritten with the same size and mtime between reads is a different state: the reads run again", () => {
  const { repo } = setup();
  const p = storeFile(repo);
  utimesSync(p, PINNED, PINNED);
  const before = checkoutIdentity(repo);
  sameSizeSameTime(p);
  assert.notEqual(checkoutIdentity(repo), before, "content, not size and mtime, is the identity");

  let reads = 0;
  const out = consistentRead(repo, () => {
    reads += 1;
    if (reads === 1) sameSizeSameTime(p);
    return reads;
  });
  assert.equal(out, 2, "the first composition was discarded");
});

test("past the hashing budget nothing is served: OBSERVATION_LIMIT, also when the over-budget file changes mid-read; 422 over HTTP", async () => {
  const { repo } = setup();
  submit(repo, "chg-web", describeWeb("Pages."));
  const saved = { ...OBSERVE_LIMITS };
  try {
    OBSERVE_LIMITS.files = 1;
    assert.throws(() => checkoutIdentity(repo), ObservationLimit);
    let reads = 0;
    assert.throws(
      () =>
        consistentRead(repo, () => {
          reads += 1;
          sameSizeSameTime(storeFile(repo));
          return "an answer that must not be served";
        }),
      (e: { code?: string }) => e.code === "OBSERVATION_LIMIT",
    );
    assert.equal(reads, 0, "nothing is read before the store can be pinned down");

    OBSERVE_LIMITS.files = saved.files;
    OBSERVE_LIMITS.bytes = 16;
    assert.throws(
      () => checkoutIdentity(repo),
      (e: { code?: string }) => e.code === "OBSERVATION_LIMIT",
    );

    const host = await startHost({
      session: new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-"))),
      webDir: tempDir(),
    });
    try {
      const r = await fetch(`${host.url}api/proposals`);
      assert.equal(r.status, 422);
      assert.equal(((await r.json()) as { error: { code: string } }).error.code, "OBSERVATION_LIMIT");
    } finally {
      await host.close();
    }
  } finally {
    Object.assign(OBSERVE_LIMITS, saved);
  }
});

test("a symlink is hashed by its link text; a FIFO under .vcv/ is refused, not skipped", () => {
  const { repo } = setup();
  const link = join(repo, ".vcv", "odd-link");
  symlinkSync("target-a-0", link);
  const a = checkoutIdentity(repo);
  unlinkSync(link);
  symlinkSync("target-b-0", link); // same length, different target
  assert.notEqual(checkoutIdentity(repo), a);
  unlinkSync(link);

  const fifo = join(repo, ".vcv", "odd-fifo");
  execFileSync("mkfifo", [fifo]);
  assert.throws(
    () => checkoutIdentity(repo),
    (e: { code?: string }) => e.code === "OBSERVATION_LIMIT",
  );
  rmSync(fifo);
  checkoutIdentity(repo);
});

test("the host closes while a page keeps a keep-alive connection open", async () => {
  const { repo } = setup();
  const host = await startHost({
    session: new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-"))),
    webDir: tempDir(),
  });
  const agent = new Agent({ keepAlive: true, keepAliveMsecs: 60_000 });
  try {
    await new Promise<void>((ok, fail) => {
      get(`${host.url}api/project`, { agent }, (res) => {
        res.resume();
        res.on("end", ok);
      }).on("error", fail);
    });
    const started = Date.now();
    await Promise.race([
      host.close(),
      new Promise((_, fail) => setTimeout(() => fail(new Error("close() hung on a keep-alive connection")), 3000)),
    ]);
    assert.ok(Date.now() - started < 3000);
  } finally {
    agent.destroy();
  }
});
