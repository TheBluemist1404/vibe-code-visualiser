// A writer in a worker thread for the stale-takeover race test (Issue #43): same process, another
// thread, so it is live by the lock's rules. It takes the lock (breaking a stale one if it must),
// sets flag[0] = 1, and holds the lock until the test sets flag[1] = 1.
import { workerData } from "node:worker_threads";
import { withStoreLock } from "../../src/store/lock.ts";

const { dir, flags } = workerData as { dir: string; flags: SharedArrayBuffer };
const f = new Int32Array(flags);
withStoreLock(
  dir,
  () => {
    Atomics.store(f, 0, 1);
    Atomics.notify(f, 0);
    while (Atomics.load(f, 1) === 0) Atomics.wait(f, 1, 0, 50);
  },
  { purpose: "live writer B", timeoutMs: 10_000 },
);
