// End-to-end for M5.5 (Issue #45): the evidence explorer in a real browser against a real
// Course Desk checkout with claims, mapped criteria, an approved change with an agent's report,
// and a test run the agent captured. Every layer is labelled for what it is; the pre-merge page
// runs only against a base commit named at start; nothing on the page writes, reasserts or runs.
// Run with `npm run test:ui`. Set VCV_UI_SHOTS=<dir> to keep screenshots.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { EvidenceOptions } from "../src/evidence.ts";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import { FAIL, claimedRun, evidenceWorld } from "../test/evidence-fixture.ts";
import { renameModule, tempDir, tree } from "../test/fixtures.ts";

const WEB = join(import.meta.dirname, "../dist");
const SHOTS = process.env.VCV_UI_SHOTS;
let browser: Browser;
let w: ReturnType<typeof evidenceWorld>;
const hosts: Host[] = [];
const pages: Page[] = [];

before(async () => {
  assert.ok(existsSync(join(WEB, "index.html")), "build the client first: npm run build -w @vcv/ui");
  browser = await chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  w = evidenceWorld();
});
after(async () => {
  await Promise.all(pages.map((p) => p.close()));
  await Promise.all(hosts.map((h) => h.close()));
  await browser?.close();
});

async function open(repo: string, hash = "", evidence?: EvidenceOptions) {
  const h = await startHost({
    session: new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-"))),
    webDir: WEB,
    ...(evidence ? { evidence } : {}),
  });
  hosts.push(h);
  // The hosts share this process's event loop: earlier pages stop polling before a new one opens.
  await Promise.all(pages.splice(0).map((p) => p.close()));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  pages.push(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(h.url + hash);
  return { page, errors };
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    const settled = Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await Promise.race([settled, new Promise((r) => setTimeout(r, 2000))]);
  });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Nothing on the page can reassert, record, run, approve or merge. */
async function assertReadOnly(page: Page) {
  const names = await page
    .getByRole("button")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""));
  for (const n of names)
    assert.doesNotMatch(
      n.trim(),
      /^(reassert|record|run|re-?run|capture|approve|sign|submit|apply|merge|accept)\b/i,
      `button "${n}"`,
    );
}

test("a module's evidence by owned object, then one rule's claims: state, locator, provenance and why one is stale", async () => {
  const snapshot = tree(w.repo);
  const { page, errors } = await open(w.repo);
  await page.locator('[data-module="mod-enrollment"]').click();
  const mev = page.getByTestId("module-evidence");
  await mev.getByTestId("mev-rul-seat-limit").waitFor();
  assert.match(
    (await mev.getByTestId("mev-rul-seat-limit").textContent()) ?? "",
    /1Resolved.*1Stale|1Stale.*1Resolved/,
  );
  await mev.scrollIntoViewIfNeeded();
  await shot(page, "30-module-evidence");

  await mev.getByTestId("mev-rul-seat-limit").click();
  await page.getByTestId("object-name").filter({ hasText: "Course capacity" }).waitFor();
  const ev = page.getByTestId("object-evidence");
  const stale = ev.locator('[data-binding="test.rul-seat-limit"]');
  await stale.waitFor();
  assert.equal(await stale.getAttribute("data-state"), "stale");
  assert.match((await stale.textContent()) ?? "", /rul-seat-limit changed between rev-1/);
  const impl = ev.locator('[data-binding="impl.rul-seat-limit"]');
  assert.equal(await impl.getAttribute("data-state"), "resolved");
  assert.match((await impl.textContent()) ?? "", /agent:coder.*as the claim says/);
  assert.match((await ev.textContent()) ?? "", /not evidence that the code does what the model says/);
  await ev.scrollIntoViewIfNeeded();
  await shot(page, "31-object-evidence");
  await assertReadOnly(page);
  assert.deepEqual(tree(w.repo), snapshot, "browsing evidence changes nothing in the checkout");
  assert.deepEqual(errors, []);
});

test("a criterion: unverified without runs; with a run the agent captured, passed but labelled claimed", async () => {
  const bare = await open(w.repo);
  await bare.page.locator('[data-module="mod-enrollment"]').click();
  await bare.page.getByTestId("mev-crt-full-course").click();
  await bare.page.locator('[data-testid="criterion-evidence"][data-result="unverified"]').waitFor();
  assert.match((await bare.page.getByTestId("criterion-evidence").textContent()) ?? "", /this page runs nothing/);

  const { page, errors } = await open(w.repo, "", {
    runs: [claimedRun(w.repo)],
    sources: { runs: ["agent-run.json"], policy: null },
  });
  await page.locator('[data-module="mod-enrollment"]').click();
  await page.getByTestId("mev-crt-full-course").click();
  const c = page.locator('[data-testid="criterion-evidence"][data-result="passed"]');
  await c.waitFor();
  assert.match((await c.textContent()) ?? "", /claimed, not observed here/);
  assert.match((await c.textContent()) ?? "", /RESULT_CLAIMED/);
  await c.scrollIntoViewIfNeeded();
  await shot(page, "32-criterion-claimed");
  assert.deepEqual(errors, []);
});

test("an applied change shows the approved intent, the agent's report as claims, and what VCV observes now as separate layers", async () => {
  const { page, errors } = await open(w.repo, `#/proposals/${w.changeId}`);
  await page.getByTestId("review-state").filter({ hasText: "Applied to model" }).waitFor();
  const impl = page.getByTestId("implementation");
  await impl.getByTestId("agent-report").waitFor();
  assert.match(
    (await impl.locator('[data-layer="approved"]').textContent()) ?? "",
    /tells the student the course's capacity/,
  );
  assert.match((await impl.getByTestId("agent-report").textContent()) ?? "", /claims.*verified none of it/is);
  assert.match((await impl.getByTestId("vcv-observed").textContent()) ?? "", /enrollment\.service\.ts/);
  const warnings = (await impl.getByTestId("impl-warnings").textContent()) ?? "";
  for (const code of ["CLAIMS_UNVERIFIED", "GAP", "BINDING_NOT_REASSERTED"]) assert.match(warnings, new RegExp(code));
  await impl.scrollIntoViewIfNeeded();
  await shot(page, "33-implementation");
  await assertReadOnly(page);
  assert.deepEqual(errors, []);
});

test("before merging: without a base commit the page names what is missing and runs nothing; with one it shows the gate's own decision and reconciliation", async () => {
  const none = await open(w.repo, "#/gate");
  await none.page.getByTestId("gate-missing").waitFor();
  assert.match((await none.page.getByTestId("gate-missing").textContent()) ?? "", /--base-commit/);
  assert.equal(await none.page.getByTestId("gate-decision").count(), 0);
  assert.equal(await none.page.getByTestId("reconciliation").count(), 0);
  assert.equal(await none.page.getByTestId("tab-gate").getAttribute("aria-current"), "page");
  await shot(none.page, "34-gate-missing-base");

  const { page, errors } = await open(w.repo, "#/gate", {
    baseCommit: w.base,
    runs: [claimedRun(w.repo, FAIL)],
    sources: { runs: ["agent-run.json"], policy: null },
  });
  const decision = page.locator('[data-testid="gate-decision"][data-decision="block"]');
  await decision.waitFor();
  assert.match((await decision.textContent()) ?? "", /blocked/i);
  await page.getByTestId("gate-reasons").locator("li").first().waitFor();
  assert.ok(
    (await page
      .getByTestId("gate-reasons")
      .locator('[data-code="RESULT_CLAIMED"], [data-code="TEST_FAILED"]')
      .count()) > 0,
  );
  const rec = page.getByTestId("reconciliation");
  await rec.waitFor();
  assert.equal(await rec.getByTestId("rec-integrity").getAttribute("data-ok"), "true");
  assert.match((await rec.textContent()) ?? "", /caller-asserted/);
  assert.match((await rec.textContent()) ?? "", new RegExp(w.base.slice(0, 12)));
  assert.equal(await page.getByTestId("gate-missing").count(), 0);
  await shot(page, "35-gate-decision");
  await assertReadOnly(page);
  assert.deepEqual(errors, []);
});

test("the page follows the checkout: when the model moves, evidence reloads for the new model instead of showing the old one", async () => {
  const { repo, base } = evidenceWorld();
  const { page, errors } = await open(repo, "#/gate", { baseCommit: base });
  await page.getByTestId("gate-decision").waitFor();
  const before = (await page.getByTestId("reconciliation").textContent()) ?? "";
  renameModule(repo, "chg-rename", "mod-enrollment", "Enrollment (renamed)");
  await page.waitForFunction(
    (prev) => {
      const t = document.querySelector('[data-testid="reconciliation"]')?.textContent ?? "";
      return t !== "" && t !== prev;
    },
    before,
    { timeout: 15_000 },
  );
  assert.equal(await page.getByTestId("evidence-moved").count(), 0);
  assert.deepEqual(errors, []);
});
