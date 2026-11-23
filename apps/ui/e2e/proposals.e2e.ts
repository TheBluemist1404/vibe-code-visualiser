// End-to-end for M5.4 (Issue #44): the proposal inbox in a real browser against a real checkout.
// An agent submits with the CLI, the page shows what `vcv proposal preview` shows, a reviewer
// approves in their own terminal with a test-only key while the page is open, and the page
// follows without ever offering an approve or submit control. Run with `npm run test:ui`.
// Set VCV_UI_SHOTS=<dir> to keep screenshots.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import { approve, cliPreview, describeWeb, setup, submit, tempDir, tree } from "../test/fixtures.ts";

const WEB = join(import.meta.dirname, "../dist");
const SHOTS = process.env.VCV_UI_SHOTS;
let browser: Browser;
const hosts: Host[] = [];

before(async () => {
  assert.ok(existsSync(join(WEB, "index.html")), "build the client first: npm run build -w @vcv/ui");
  browser = await chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await Promise.all(hosts.map((h) => h.close()));
  await browser?.close();
});

async function open(repo: string, hash = "", protectedBase?: string) {
  const h = await startHost({
    session: new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-"))),
    webDir: WEB,
    ...(protectedBase ? { protectedBase } : {}),
  });
  hosts.push(h);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

/** No control on the page can approve, sign, submit or apply anything. */
async function assertNoAuthorityControls(page: Page) {
  const names = await page
    .getByRole("button")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""));
  for (const n of names)
    assert.doesNotMatch(n.trim(), /^(approve|sign|submit|apply|reject|rebase)\b/i, `button "${n}"`);
}

test("pending: the tab counts it, the review shows the CLI's digest and operations and the reviewer's own command; no approve control exists", async () => {
  const { repo } = setup();
  assert.equal(submit(repo, "chg-web", describeWeb("Pages for students and staff.")).status, 0);
  assert.equal(
    submit(repo, "chg-bad", [{ type: "setDescription", objectId: "mod-nowhere", description: "x" }]).status,
    1,
  );
  const before = tree(repo);
  const { page, errors } = await open(repo);
  await page.locator('[data-module="mod-enrollment"]').waitFor();
  await page.getByTestId("pending-count").filter({ hasText: "1" }).waitFor();
  await page.getByTestId("tab-proposals").click();
  await page.getByTestId("inbox").waitFor();
  assert.match(page.url(), /#\/proposals/);
  await page.getByTestId("review-state").filter({ hasText: "Pending review" }).waitFor();

  const cli = cliPreview(repo, "chg-web");
  assert.equal((await page.getByTestId("review-digest").textContent())?.trim(), cli.proposal.proposalDigest);
  const handoff = page.getByTestId("reviewer-handoff");
  await handoff.waitFor();
  assert.match((await handoff.textContent()) ?? "", new RegExp(`--digest ${cli.proposal.proposalDigest}`));
  assert.match((await handoff.textContent()) ?? "", /never sees/);
  const steps = page.getByTestId("review-steps").locator("li");
  assert.deepEqual(
    await steps.evaluateAll((els) => els.map((e) => `${e.getAttribute("data-step")}:${e.getAttribute("data-state")}`)),
    ["recorded:done", "signed:not-yet", "integrity:not-yet", "model:not-yet", "implementation:unknown"],
  );
  await assertNoAuthorityControls(page);
  await shot(page, "20-inbox-pending");

  // The rejected one: engine errors and a hand-back to an agent, no reviewer section.
  await page.getByTestId("proposal-chg-bad").click();
  await page.getByTestId("review-state").filter({ hasText: "Rejected" }).waitFor();
  await page.getByTestId("agent-handoff").waitFor();
  assert.equal(await page.getByTestId("reviewer-handoff").count(), 0);
  await assertNoAuthorityControls(page);
  await shot(page, "21-inbox-rejected");
  assert.deepEqual(tree(repo), before, "browsing the inbox changes nothing in the checkout");
  assert.deepEqual(errors, []);
});

test("a reviewer approves in their own terminal while the page is open: the page follows to applied and signed, integrity unknown here; the other proposal turns stale with an agent hand-off", async () => {
  const { repo, key, mainSha } = setup();
  submit(repo, "chg-web", describeWeb("Approved description."));
  submit(repo, "chg-other", describeWeb("A competing description."));
  const { page, errors } = await open(repo, "#/proposals/chg-web");
  await page.getByTestId("review-state").filter({ hasText: "Pending review" }).waitFor();
  await shot(page, "22-before-approval");

  const digest = cliPreview(repo, "chg-web").proposal.proposalDigest;
  const r = approve(repo, "chg-web", digest, key, "--trust-ref", "main", "--trust-commit", mainSha);
  assert.equal(r.status, 0, r.stderr);

  await page.getByTestId("review-state").filter({ hasText: "Applied to model" }).waitFor({ timeout: 15_000 });
  await page.locator('[data-step="signed"][data-state="done"]').waitFor();
  await page.locator('[data-step="integrity"][data-state="unknown"]').waitFor();
  await page.locator('[data-step="implementation"][data-state="unknown"]').waitFor();
  assert.equal(await page.getByTestId("reviewer-handoff").count(), 0);
  await shot(page, "23-after-approval");

  await page.getByTestId("proposal-chg-other").click();
  await page.getByTestId("review-state").filter({ hasText: "Stale" }).waitFor();
  const back = page.getByTestId("agent-handoff");
  await back.waitFor();
  assert.match((await back.textContent()) ?? "", /Nothing here rebases it/);
  assert.equal(await page.getByTestId("reviewer-handoff").count(), 0);
  await assertNoAuthorityControls(page);
  await shot(page, "24-stale");
  assert.deepEqual(errors, []);
});

test("with a protected base named at start, a trusted signature is checked and labelled caller-asserted", async () => {
  const { repo, key, mainSha } = setup();
  submit(repo, "chg-web", describeWeb("Checked under main."));
  const digest = cliPreview(repo, "chg-web").proposal.proposalDigest;
  assert.equal(approve(repo, "chg-web", digest, key, "--trust-ref", "main", "--trust-commit", mainSha).status, 0);
  const { page } = await open(repo, "#/proposals/chg-web", "main");
  const integrity = page.locator('[data-step="integrity"][data-state="done"]');
  await integrity.waitFor();
  assert.match((await integrity.textContent()) ?? "", /caller-asserted/);
  await shot(page, "25-integrity-checked");
});

test("keyboard: the tabs and the proposal list are reachable and labelled", async () => {
  const { repo } = setup();
  submit(repo, "chg-web", describeWeb("x"));
  const { page } = await open(repo);
  await page.getByRole("navigation", { name: "Pages" }).waitFor();
  await page.getByRole("button", { name: /Proposals/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("navigation", { name: "Proposals" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Proposals/ }).getAttribute("aria-current"), "page");
  await page.getByRole("heading", { name: "chg-web" }).waitFor();
  await page.getByRole("button", { name: /Explorer/ }).click();
  await page.locator('[data-module="mod-enrollment"]').waitFor();
});
