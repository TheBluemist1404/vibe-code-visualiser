// A separate VCV process for the repository-level concurrency tests (Issue #43): the reviewer
// approval (engine commit + attestation) and the proposal surface, as the CLI runs them.
// Usage: node --experimental-strip-types repo-writer.ts '<json task>'; prints JSON lines.
import { existsSync } from "node:fs";
import { reviewApprove, submitProposal } from "../../src/index.ts";
import type { ReviewApproveInput } from "../../src/index.ts";
import type { HostContext } from "../../../core/src/index.ts";

type Task = {
  repo: string;
  action: "approve" | "submit";
  approve?: ReviewApproveInput;
  change?: unknown;
  host?: HostContext;
  barrier?: string;
  /** Exit abruptly after the model commit, before the attestation is written. */
  crashAfterCommit?: boolean;
};

const task = JSON.parse(process.argv[2]!) as Task;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
out({ ready: true });
if (task.barrier) while (!existsSync(task.barrier)) Atomics.wait(sleeper, 0, 0, 1);
try {
  if (task.action === "approve") {
    const r = reviewApprove(task.repo, {
      ...task.approve!,
      ...(task.crashAfterCommit ? { afterCommit: () => process.exit(137) } : {}),
    });
    out({
      status: r.outcome.status,
      codes: r.outcome.diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
      resultingRevision: r.outcome.record?.resultingRevision,
      attestation: r.attestation?.attestation ?? null,
    });
  } else {
    const r = submitProposal(task.repo, task.change, task.host!);
    out(r.ok ? { status: r.data.status, codes: r.data.diagnostics.map((d) => d.code) } : { error: r.error.code });
  }
} catch (e) {
  out({ error: (e as { code?: string }).code ?? "THROWN", message: (e as Error).message });
}
