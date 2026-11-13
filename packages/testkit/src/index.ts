// Helpers shared by the test suites: deterministic Git, temporary directories that are removed
// when the test process exits, and one-shot hooks. Test-only; nothing in src/ imports this.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Git with a fixed identity and no system or global configuration. */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "VCV Test",
  GIT_AUTHOR_EMAIL: "vcv-test@example.invalid",
  GIT_COMMITTER_NAME: "VCV Test",
  GIT_COMMITTER_EMAIL: "vcv-test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** Run git in `cwd` with GIT_ENV; returns trimmed stdout and throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const created: string[] = [];
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A new empty directory under the OS temp dir, removed when the test process exits. */
export function tempDir(prefix = "vcv-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A function that runs `fn` on its first call only: for "change something mid-read" hooks. */
export function once(fn: () => unknown): () => void {
  let pending = true;
  return () => {
    if (!pending) return;
    pending = false;
    fn();
  };
}
