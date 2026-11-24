// End-to-end: the built UI in a real browser against real checkouts (Issue #39, first-PR
// acceptance tests 1–5). Run with `npm run test:ui`, which builds the client first.
// Set VCV_UI_SHOTS=<dir> to keep screenshots of each step.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import {
  addAuditModule,
  addWebCriterion,
  renameModule,
  conflictedRepo,
  courseDesk,
  emptyRepo,
  git,
  invalidRepo,
  tempDir,
  tree,
} from "../test/fixtures.ts";

const WEB = join(import.meta.dirname, "../dist");
const SHOTS = process.env.VCV_UI_SHOTS;
let browser: Browser;
const hosts: Host[] = [];
const pages: Page[] = [];

before(async () => {
  assert.ok(existsSync(join(WEB, "index.html")), "build the client first: npm run build -w @vcv/ui");
  browser = await chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
// Pages a finished test left open keep polling hosts on this process's event loop and slow every
// later test; close them before the next one starts.
beforeEach(async () => {
  await Promise.allSettled(pages.splice(0).map((p) => p.close()));
});
// Pages first (they poll the hosts), then the hosts, even when a test failed.
after(async () => {
  try {
    await Promise.allSettled(pages.map((p) => p.close()));
    await browser?.close();
  } finally {
    await Promise.all(hosts.map((h) => h.close()));
  }
});

async function launch(repo: string, stateDir: string, opts: { reducedMotion?: "reduce" | "no-preference" } = {}) {
  const host = await startHost({ session: new ProjectSession(repo, new LayoutFileStore(stateDir)), webDir: WEB });
  hosts.push(host);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...opts });
  pages.push(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(host.url);
  return { host, page, errors };
}

/** Wait until every finite animation (entrances, slides, pulses) has finished. Looping ones keep running. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
/** A screenshot of a stable frame; runtime motion stays on. */
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await settle(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
const viewport = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);
const node = (page: Page, id: string) => page.locator(`[data-module="${id}"]`);
/** A node's position in canvas coordinates (independent of zoom and pan). */
const flowPos = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => (el as HTMLElement).style.transform);
const nodeBox = async (page: Page, id: string) => {
  const b = await node(page, id).boundingBox();
  assert.ok(b, `${id} is on the canvas`);
  return b;
};

test("1–2: open, see directed dependencies, select Enrollment and follow a dependency without touching the model", async () => {
  const repo = courseDesk();
  const before = tree(repo);
  const { page, errors } = await launch(repo, tempDir("vcv-ui-state-"));
  await page.getByTestId("project-state").getByText("Ready").waitFor();
  for (const name of ["Web", "Enrollment", "Notifications"])
    await page.locator(".react-flow__node").getByText(name, { exact: true }).waitFor();
  assert.equal(await page.getByTestId("revision").textContent(), "rev-1");

  // Edges carry the declared direction: Enrollment → Notifications, never the reverse.
  const edges = await page.locator(".react-flow__edge").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  assert.ok(edges.includes("dependsOn:mod-enrollment->mod-notifications"), edges.join());
  assert.ok(edges.includes("dependsOn:mod-web->mod-enrollment"));
  assert.ok(!edges.some((e) => e === "dependsOn:mod-notifications->mod-enrollment"));
  // Dependents sit above their dependencies.
  assert.ok((await nodeBox(page, "mod-enrollment")).y < (await nodeBox(page, "mod-notifications")).y);
  await shot(page, "1-overview");

  await node(page, "mod-enrollment").click();
  await page.getByTestId("inspector-name").getByText("Enrollment").waitFor();
  assert.match(
    (await page.getByTestId("inspector-purpose").textContent()) ?? "",
    /Holds the course catalog and decides, records and exposes enrollments/,
  );
  await page.getByTestId("owned-capability").getByText("Enroll in a course").waitFor();
  await page.locator(".insp").getByText("in rev-1").first().waitFor();
  await page.locator(".edge-label").getByText("Enrollment depends on Notifications").waitFor();
  await shot(page, "2-enrollment-selected");

  await page.getByTestId("link-mod-notifications").click();
  await page.getByTestId("inspector-name").getByText("Notifications").waitFor();
  assert.equal(await page.locator('.mod[aria-current="true"]').getByText("Notifications").count(), 1);
  await shot(page, "2-followed-dependency");

  await page.getByTestId("owned-data").getByText("Notification").first().click();
  await page.getByRole("heading", { name: /Attributes/ }).waitFor();
  assert.deepEqual(tree(repo), before, "selecting and inspecting wrote nothing");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.deepEqual(errors, []);
});

test("3–4: a dragged module stays pinned after a relaunch; a new revision keeps it and places the new module", async () => {
  const repo = courseDesk();
  const stateDir = tempDir("vcv-ui-state-");
  const first = await launch(repo, stateDir);
  const web = await nodeBox(first.page, "mod-web");
  await first.page.mouse.move(web.x + 40, web.y + 20);
  await first.page.mouse.down();
  await first.page.mouse.move(web.x + 300, web.y + 60, { steps: 12 });
  await first.page.mouse.up();
  await node(first.page, "mod-web").locator(".node-pin").waitFor();
  const pinnedAt = await flowPos(first.page, "mod-web");
  await first.page.close();
  await first.host.close();

  const second = await launch(repo, stateDir);
  await node(second.page, "mod-web").locator(".node-pin").waitFor();
  const webTransform = await flowPos(second.page, "mod-web");
  assert.equal(webTransform, pinnedAt, "same canvas position as where it was dropped");
  assert.equal(await node(second.page, "mod-enrollment").getAttribute("data-pinned"), "false");
  assert.equal(git(repo, "status", "--porcelain"), "", "the drag wrote nothing into the checkout");
  assert.equal(await second.page.getByTestId("revision").textContent(), "rev-1", "no revision for a layout action");
  await node(second.page, "mod-web").click();
  await second.page.getByTestId("pin-panel").waitFor();
  await shot(second.page, "3-pinned-after-relaunch");

  // A branch whose model adds a module, through the typed createModule operation.
  git(repo, "checkout", "-q", "-b", "feature/audit");
  const rev = addAuditModule(repo);
  await second.page.getByTestId("change-banner").waitFor({ timeout: 15_000 });
  await node(second.page, "mod-audit").waitFor();
  await node(second.page, "mod-audit").getByText("New").waitFor();
  assert.equal(await second.page.getByTestId("revision").textContent(), rev);
  assert.equal(await second.page.getByTestId("branch").textContent(), "feature/audit");
  assert.equal(await flowPos(second.page, "mod-web"), webTransform, "the pinned module did not move");
  const edges = await second.page
    .locator(".react-flow__edge")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  assert.ok(edges.includes("dependsOn:mod-audit->mod-enrollment"));
  await second.page.getByRole("button", { name: "Show what changed" }).click();
  await second.page.getByTestId("what-changed").getByText("Audit log").waitFor();
  await shot(second.page, "4-model-changed");
  assert.deepEqual(second.errors, []);
});

test("5: absent, conflicted and invalid checkouts show diagnostics and are never initialized or repaired", async () => {
  const cases: [string, string, string][] = [
    [emptyRepo(), "absent", "NO_PROJECT"],
    [conflictedRepo(), "conflicted", "CONFLICTED"],
    [invalidRepo(), "invalid", "INVALID_STORE"],
  ];
  for (const [repo, state, code] of cases) {
    const before = tree(repo);
    const { page } = await launch(repo, tempDir("vcv-ui-state-"));
    const screen = page.getByTestId(`state-${state}`);
    await screen.waitFor();
    await screen.getByText(code).waitFor();
    await shot(page, `5-${state}`);
    await page.getByRole("button", { name: "Check again" }).click();
    await screen.waitFor();
    assert.equal(await page.locator(".react-flow__node").count(), 0);
    assert.deepEqual(tree(repo), before, `${state}: nothing written`);
    await page.close();
  }
});

test("6: with a module selected, a branch switch never shows the previous model's details in the inspector", async () => {
  const repo = courseDesk();
  git(repo, "checkout", "-q", "-b", "renamed");
  const renamedRev = renameModule(repo, "chg-rename", "mod-enrollment", "Enrollment (renamed)");
  git(repo, "checkout", "-q", "main");
  const { page, errors } = await launch(repo, tempDir("vcv-ui-state-"));
  await node(page, "mod-enrollment").click();
  await page.getByTestId("inspector-name").getByText("Enrollment", { exact: true }).waitFor();

  // Record any frame where the bar already shows the new revision but the inspector still names the old module.
  await page.evaluate((rev) => {
    const w = window as unknown as { mixed: string[] };
    w.mixed = [];
    const check = () => {
      const bar = document.querySelector('[data-testid="revision"]')?.textContent;
      const name = document.querySelector('[data-testid="inspector-name"]')?.textContent;
      if (bar === rev && name === "Enrollment") w.mixed.push(`${bar} / ${name}`);
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, renamedRev);
  git(repo, "checkout", "-q", "renamed");
  await page.getByTestId("inspector-name").getByText("Enrollment (renamed)").waitFor({ timeout: 15_000 });
  assert.equal(await page.getByTestId("revision").textContent(), renamedRev);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { mixed: string[] }).mixed), []);
  assert.equal(await page.getByTestId("change-banner").count(), 1);
  await shot(page, "6-selected-across-branch-switch");
  assert.deepEqual(errors, []);
});

test("7: a related object in another module opens under its own module", async () => {
  const repo = courseDesk();
  addWebCriterion(repo);
  const { page, errors } = await launch(repo, tempDir("vcv-ui-state-"));
  await node(page, "mod-web").click();
  await page.getByTestId("owned-criterion").getByText("The page enrolls through the API").click();
  await page.getByTestId("crumbs").getByText("Web").waitFor();
  await page.locator(".insp .item").getByText("Enroll in a course").click();
  await page.getByTestId("object-name").getByText("Enroll in a course").waitFor();
  const crumbs = await page.getByTestId("crumbs").textContent();
  assert.match(crumbs ?? "", /Enrollment/, "breadcrumbs name the owning module");
  assert.doesNotMatch(crumbs ?? "", /Web/);
  assert.equal(
    await page
      .locator('.mod[aria-current="true"]')
      .textContent()
      .then((t) => t?.startsWith("Enrollment")),
    true,
  );
  assert.equal(await node(page, "mod-enrollment").evaluate((el) => el.classList.contains("is-sel")), true);
  // A project-level object (the Student actor) has no module.
  await page.locator(".insp .item").getByText("Student").click();
  await page.getByTestId("object-name").getByText("Student").waitFor();
  assert.equal(await page.locator('.mod[aria-current="true"]').count(), 0);
  await shot(page, "7-cross-module-object");
  assert.deepEqual(errors, []);
});

test("8: a refresh that adds a module keeps the user's pan and zoom; Locate new moves only when asked", async () => {
  const repo = courseDesk();
  const { page, errors } = await launch(repo, tempDir("vcv-ui-state-"));
  await node(page, "mod-web").waitFor();
  await settle(page);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const pane = await page.locator(".react-flow__pane").boundingBox();
  assert.ok(pane);
  await page.mouse.move(pane.x + 40, pane.y + pane.height - 120);
  await page.mouse.down();
  await page.mouse.move(pane.x + 160, pane.y + pane.height - 200, { steps: 8 });
  await page.mouse.up();
  await settle(page);
  const before = await viewport(page);

  git(repo, "checkout", "-q", "-b", "feature/audit");
  addAuditModule(repo);
  await page.getByTestId("change-banner").waitFor({ timeout: 15_000 });
  await node(page, "mod-audit").waitFor({ state: "attached" });
  await settle(page);
  assert.equal(await viewport(page), before, "the view did not pan or zoom on refresh");

  git(repo, "checkout", "-q", "main");
  await page.getByText("The model went back on disk").waitFor({ timeout: 15_000 });
  await settle(page);
  assert.equal(await viewport(page), before, "nor when a module was removed");

  git(repo, "checkout", "-q", "feature/audit");
  await page.getByRole("button", { name: "Locate new" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Locate new" }).click();
  await page.waitForTimeout(700);
  assert.notEqual(await viewport(page), before, "Locate new brings the new module into view");
  await node(page, "mod-audit").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

test("9: reduced motion switches the animations off; the default keeps them", async () => {
  const repo = courseDesk();
  const durations = async (reducedMotion: "reduce" | "no-preference") => {
    const { page } = await launch(repo, tempDir("vcv-ui-state-"), { reducedMotion });
    await node(page, "mod-enrollment").click();
    await page.locator(".edge-path.is-hot").first().waitFor({ state: "attached" });
    const out = await page.evaluate(() => ({
      edge: getComputedStyle(document.querySelector(".edge-path.is-hot") as Element).animationDuration,
      node: getComputedStyle(document.querySelector(".node") as Element).animationDuration,
    }));
    await page.close();
    return out;
  };
  assert.deepEqual(await durations("reduce"), { edge: "0.001s", node: "0.001s" });
  const moving = await durations("no-preference");
  assert.notEqual(moving.edge, "0.001s");
  assert.notEqual(moving.node, "0.001s");
});
