// The contained-read scope (Issue #44/#45 review): inside it, no helper read leaves the root.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContainmentUnavailable, existsContained, readdirContained, withContainedReads } from "../src/index.ts";

const dir = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

test("inside a scope, a read outside the root is refused, even if the caller catches it; an alias of the root is contained", () => {
  const root = dir("vcv-root-");
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "x"), "x");
  const other = dir("vcv-other-");
  assert.throws(
    () =>
      withContainedReads(root, () => {
        try {
          readdirContained(other);
        } catch {
          // swallowed: the scope still fails
        }
        return "answer";
      }),
    (e) => e instanceof ContainmentUnavailable && /outside the checkout/.test(e.message),
  );
  const alias = join(dir("vcv-alias-"), "link");
  symlinkSync(root, alias);
  assert.deepEqual(
    withContainedReads(root, () => readdirContained(join(alias, "a")), [alias]),
    ["x"],
  );
  assert.throws(() => withContainedReads(root, () => existsContained(join(alias, "a", "x"))), ContainmentUnavailable);
  assert.equal(existsContained(other), true, "outside a scope the helpers are plain fs");
});
