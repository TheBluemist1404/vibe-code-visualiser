// A separate VCV writer process for the multi-process tests (Issue #43). Usage:
//   node --experimental-strip-types store-writer.ts '<json task>'
// Prints one JSON line with the outcome. Waits for `barrier` (a file) to exist before acting, so
// several workers can be released at the same moment.
import { existsSync } from "node:fs";
import { FileStore, ModelEngine, withStoreLock } from "../../src/index.ts";
import type { CommitStep, HostContext, ProposedModelChange } from "../../src/index.ts";

type Task = {
  dir: string;
  action: "propose" | "approve" | "hold" | "open";
  ctx?: HostContext;
  change?: ProposedModelChange;
  changeId?: string;
  barrier?: string;
  /** Sleep this long at this commit step (while holding the lock). */
  pauseAt?: { step: CommitStep; ms: number };
  /** Exit the process abruptly at this commit step (simulated crash). */
  crashAt?: CommitStep;
  /** For "hold": keep the lock this long. */
  holdMs?: number;
  timeoutMs?: number;
};

const task = JSON.parse(process.argv[2]!) as Task;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(sleeper, 0, 0, ms);
const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
out({ ready: true });
if (task.barrier) while (!existsSync(task.barrier)) sleep(1);

try {
  if (task.action === "hold") {
    withStoreLock(
      task.dir,
      () => {
        out({ held: true });
        sleep(task.holdMs ?? 1000);
      },
      { purpose: "test hold", timeoutMs: task.timeoutMs },
    );
    out({ released: true });
  } else {
    const store = new FileStore(task.dir, {
      lock: { timeoutMs: task.timeoutMs },
      beforeStep: (step) => {
        if (task.crashAt === step) process.exit(137);
        if (task.pauseAt?.step === step) {
          out({ paused: step });
          sleep(task.pauseAt.ms);
        }
      },
    });
    if (task.action === "open") out({ recovery: store.recovery });
    else {
      const engine = new ModelEngine(store);
      const r =
        task.action === "propose" ? engine.propose(task.change, task.ctx!) : engine.approve(task.changeId!, task.ctx!);
      out({
        status: r.status,
        changeId: r.changeId,
        codes: r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
        resultingRevision: r.record?.resultingRevision,
      });
    }
  }
} catch (e) {
  out({ error: (e as { code?: string }).code ?? "THROWN", message: (e as Error).message });
}
