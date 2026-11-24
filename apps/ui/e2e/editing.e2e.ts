// End-to-end for M5.3 (Issue #41): inspector edits staged into local drafts, checked by the
// engine and handed off to a coding agent, in a real browser against real checkouts. Nothing is
// submitted or approved, and the checkout stays byte-identical. Run with `npm run test:ui`.
// Set VCV_UI_SHOTS=<dir> to keep screenshots.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { proposedChangeSchema } from "@vcv/core";
import { previewProposal, projectStatus } from "@vcv/repo";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { DraftFileStore } from "../src/drafts/store.ts";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import { addAuditModule, courseDesk, git, tempDir, tree } from "../test/fixtures.ts";

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

async function host(repo: string, stateDir: string) {
  const h = await startHost({ session: new ProjectSession(repo, new LayoutFileStore(stateDir)), webDir: WEB });
  hosts.push(h);
  return h;
}

async function tab(h: Host) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  pages.push(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(h.url);
  await page.locator('[data-module="mod-enrollment"]').waitFor();
  return { page, errors };
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function selectModule(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await page.getByTestId("inspector-name").filter({ hasText: name }).waitFor();
}

/** Edit one field in the inspector and stage it; waits until the draft shows `count` steps. */
async function stage(page: Page, label: string, value: string | { check: string }, count: number) {
  const fields = page.getByTestId("fields");
  await fields.getByRole("button", { name: `Edit ${label}` }).click();
  if (typeof value === "string") await fields.getByRole("textbox", { name: label }).fill(value);
  else await fields.getByRole("checkbox", { name: new RegExp(value.check) }).check();
  await fields.getByRole("button", { name: "Stage", exact: true }).click();
  await page
    .getByTestId("staged-count")
    .filter({ hasText: String(count) })
    .waitFor();
}

const tray = (page: Page) => page.getByTestId("tray");

test("10: a multi-module draft is checked by the engine and handed off as a change the CLI layer accepts", async () => {
  const repo = courseDesk();
  const before = tree(repo);
  const head = git(repo, "rev-parse", "HEAD");
  const revision = projectStatus(repo).model?.revision;
  const { page, errors } = await tab(await host(repo, tempDir("vcv-ui-state-")));

  await selectModule(page, "Enrollment");
  const fields = page.getByTestId("fields");
  await fields.getByTestId("field-name").getByText("renameObject").waitFor();
  await fields
    .getByTestId("readonly-purpose")
    .getByText(/No typed operation/)
    .waitFor();
  await shot(page, "10-fields");
  await stage(page, "Name", "Enrollments", 1);
  // A rule in another module.
  await selectModule(page, "Notifications");
  await page
    .getByTestId("owned-rule")
    .getByRole("button", { name: /recipientId required/ })
    .click();
  await page.getByTestId("object-name").filter({ hasText: "recipientId required" }).waitFor();
  await stage(page, "Statement", "Listing notifications needs a recipientId.", 2);
  await tray(page).getByRole("textbox", { name: /Why/ }).fill("Clearer names");
  await tray(page).getByRole("textbox", { name: /Why/ }).blur();

  const steps = tray(page).getByTestId("steps");
  assert.match(
    (await steps.textContent()) ?? "",
    /renameObject\s*Enrollment.*setRuleStatement\s*recipientId required/s,
  );
  await tray(page)
    .getByTestId("check-state")
    .filter({ hasText: `Valid on ${revision}` })
    .waitFor();
  assert.match(
    (await tray(page).getByTestId("check-delta").textContent()) ?? "",
    /Enrollments.*Listing notifications needs/s,
  );
  // The canvas marks the module and still shows the model's own name.
  await page.locator('[data-module="mod-enrollment"].is-staged').waitFor();
  assert.match((await page.locator('[data-module="mod-enrollment"] .node-name').textContent()) ?? "", /^Enrollment/);
  await shot(page, "11-draft");

  await page.getByTestId("export-draft").click();
  const dialog = page.getByTestId("export-dialog");
  await dialog.getByTestId("export-change").waitFor();
  assert.equal(await dialog.getByTestId("export-check").getAttribute("data-check"), "valid");
  const change = JSON.parse((await dialog.getByTestId("export-change").textContent()) ?? "");
  assert.equal(proposedChangeSchema.safeParse(change).success, true);
  assert.equal(change.expectedRevision, revision);
  assert.equal(change.rationale, "Clearer names");
  const direct = previewProposal(repo, { change });
  assert.ok(direct.ok && direct.data.validation.appliesToCurrent);
  await shot(page, "12-handoff");

  for (const name of [/submit/i, /^approve/i]) assert.equal(await page.getByRole("button", { name }).count(), 0);
  assert.deepEqual(tree(repo), before, "checkout, .vcv/ and change records unchanged");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.deepEqual(errors, []);
});

test("11: an invalid operation and a warning are reported; the handoff says it needs repair", async () => {
  const repo = courseDesk();
  const before = tree(repo);
  const { page, errors } = await tab(await host(repo, tempDir("vcv-ui-state-")));
  await selectModule(page, "Notifications");
  // Notifications depending on Web closes a cycle: the engine accepts it with a warning.
  await stage(page, "Depends on", { check: "Web" }, 1);
  await tray(page).getByTestId("check-warnings").getByText("DEPENDENCY_CYCLE").first().waitFor();
  // An empty name does not match renameObject.
  await stage(page, "Name", "", 2);
  await tray(page).getByTestId("check-state").filter({ hasText: /error/ }).waitFor();
  assert.match((await tray(page).getByTestId("check-errors").textContent()) ?? "", /SCHEMA.*operations\.1\.name/s);
  await shot(page, "13-invalid");
  await page.getByTestId("export-draft").click();
  await page.getByTestId("export-change").waitFor();
  assert.equal(await page.getByTestId("export-check").getAttribute("data-check"), "invalid");
  assert.deepEqual(tree(repo), before);
  assert.deepEqual(errors, []);
});

test("12: a draft survives reload and host restart; a second tab gets an explicit conflict, not an overwrite", async () => {
  const repo = courseDesk();
  const stateDir = tempDir("vcv-ui-state-");
  const h1 = await host(repo, stateDir);
  const one = await tab(h1);
  await selectModule(one.page, "Web");
  await stage(one.page, "Name", "Web app", 1);
  const two = await tab(h1); // opens the same draft
  await two.page.getByTestId("staged-count").filter({ hasText: "1" }).waitFor();

  await selectModule(one.page, "Enrollment");
  await stage(one.page, "Name", "Enrollments", 2);
  // Tab two still holds version 2 of the draft; its edit is refused and the draft reloaded.
  await selectModule(two.page, "Notifications");
  const fields = two.page.getByTestId("fields");
  await fields.getByRole("button", { name: "Edit Name" }).click();
  await fields.getByRole("textbox", { name: "Name" }).fill("Alerts");
  await fields.getByRole("button", { name: "Stage", exact: true }).click();
  await two.page
    .getByTestId("draft-notice")
    .getByText(/changed in another tab/)
    .waitFor();
  await two.page.getByTestId("staged-count").filter({ hasText: "2" }).waitFor();
  await shot(two.page, "14-conflict");
  // A second, independent draft in tab two leaves tab one's draft alone.
  await fields.getByRole("button", { name: "Cancel" }).click();
  await two.page.getByTestId("new-draft").click();
  await two.page.getByTestId("staged-count").filter({ hasText: "0" }).waitFor();
  await stage(two.page, "Name", "Alerts", 1);

  // Reload tab one: same draft, same two steps.
  await one.page.reload();
  await one.page.getByTestId("staged-count").filter({ hasText: "2" }).waitFor();
  // Restart the host on the same state directory.
  await h1.close();
  const three = await tab(await host(repo, stateDir));
  assert.equal(await three.page.getByTestId("draft-select").locator("option").count(), 2);
  assert.deepEqual([...one.errors, ...two.errors, ...three.errors], []);
});

test("13: a draft from R1 stays on R1 when the model moves: stale, no restage, handoff needs an agent", async () => {
  const repo = courseDesk();
  const r1 = projectStatus(repo).model?.revision as string;
  const { page, errors } = await tab(await host(repo, tempDir("vcv-ui-state-")));
  await selectModule(page, "Web");
  await stage(page, "Name", "Web app", 1);
  await tray(page).getByTestId("check-state").filter({ hasText: "Valid" }).waitFor();

  const r2 = addAuditModule(repo); // someone else's change lands
  const after = tree(repo);
  const stale = page.getByTestId("stale-draft");
  await stale.waitFor();
  assert.match((await stale.textContent()) ?? "", new RegExp(`${r1}.*${r2}`, "s"));
  await tray(page).getByTestId("check-state").filter({ hasText: "Stale" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /restage/i }).count(), 0);
  assert.ok(await page.getByTestId("fields").getByRole("button", { name: "Edit Name" }).isDisabled());
  await shot(page, "15-stale");

  await page.getByTestId("export-draft").click();
  await page.getByTestId("export-change").waitFor();
  assert.equal(await page.getByTestId("export-check").getAttribute("data-check"), "stale");
  const change = JSON.parse((await page.getByTestId("export-change").textContent()) ?? "");
  assert.equal(change.expectedRevision, r1, "the original base, never retargeted");
  assert.deepEqual(tree(repo), after, "R2 untouched");
  assert.deepEqual(errors, []);
});

test("14: an unreadable draft file is reported and removed only when asked", async () => {
  const repo = courseDesk();
  const stateDir = tempDir("vcv-ui-state-");
  const store = new DraftFileStore(stateDir);
  const dir = store.dirFor({ root: projectStatus(repo).root, projectId: "prj-course-desk" });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "d-20260101-000000-aaaa.json"), "{ not json");
  const { page, errors } = await tab(await host(repo, stateDir));
  const problem = page.getByTestId("draft-problem-d-20260101-000000-aaaa");
  await problem.getByText(/DRAFT_CORRUPT/).waitFor();
  await shot(page, "16-corrupt");
  assert.deepEqual(readdirSync(dir), ["d-20260101-000000-aaaa.json"], "left as it was");
  await problem.getByRole("button", { name: "Discard this file" }).click();
  await problem.waitFor({ state: "detached" });
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(errors, []);
});
