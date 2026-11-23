// End-to-end for M5.3: inspector edits staged as typed proposals, in a real browser against real
// checkouts. Run with `npm run test:ui`. Set VCV_UI_SHOTS=<dir> to keep screenshots.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { projectStatus } from "@vcv/repo";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import { addAuditModule, courseDesk, git, tempDir } from "../test/fixtures.ts";

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

async function launch(repo: string) {
  const session = new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-")));
  const host = await startHost({ session, webDir: WEB, proposer: "user:hoang" });
  hosts.push(host);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(host.url);
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

const uiRecords = (repo: string) => readdirSync(join(repo, ".vcv", "changes")).filter((f) => f.startsWith("ui-"));

async function selectModule(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await page.getByTestId("inspector-name").filter({ hasText: name }).waitFor();
}

test("10: edit a module, preview it with the engine, submit a pending proposal; the model and HEAD stay put", async () => {
  const repo = courseDesk();
  const head = git(repo, "rev-parse", "HEAD");
  const revision = projectStatus(repo).model?.revision;
  const { page, errors } = await launch(repo);
  await selectModule(page, "Enrollment");

  // Editable fields name their typed operation; purpose is read-only, with the reason.
  const fields = page.getByTestId("fields");
  await assert.doesNotReject(fields.getByTestId("field-name").getByText("renameObject").waitFor());
  await assert.doesNotReject(
    fields
      .getByTestId("readonly-purpose")
      .getByText(/No typed operation/)
      .waitFor(),
  );
  await shot(page, "10-fields");

  await fields.getByRole("button", { name: "Edit Name" }).click();
  await fields.getByRole("textbox", { name: "Name" }).fill("Enrollments");
  await fields.getByRole("button", { name: "Stage", exact: true }).click();
  await fields.getByRole("button", { name: "Edit Description" }).click();
  await fields.getByRole("textbox", { name: "Description" }).fill("Seats, enrollments and their decisions.");
  await fields.getByRole("button", { name: "Stage", exact: true }).click();

  const tray = page.getByTestId("tray");
  assert.equal(await tray.getByTestId("staged-count").textContent(), "2");
  await tray
    .getByTestId("check-state")
    .filter({ hasText: `Valid on ${revision}` })
    .waitFor();
  assert.match((await tray.getByTestId("check-body").textContent()) ?? "", /renameObject.*setDescription/s);
  // The canvas marks the module, and the canvas itself still shows the model's name.
  await page.locator('[data-module="mod-enrollment"].is-staged').waitFor();
  assert.match((await page.locator('[data-module="mod-enrollment"] .node-name').textContent()) ?? "", /^Enrollment/);
  await tray.getByRole("textbox", { name: /Why/ }).fill("Name it for what it holds");
  await shot(page, "11-staged");

  await page.getByTestId("submit-proposal").click();
  const done = page.getByTestId("submit-result");
  await done.waitFor();
  assert.match((await done.textContent()) ?? "", /ui-\d{8}-\d{6}-[0-9a-f]{4}.*waiting for review/s);
  assert.match((await done.textContent()) ?? "", /vcv review approve/);
  assert.equal(await page.getByRole("button", { name: /^approve/i }).count(), 0, "the browser never approves");
  await shot(page, "12-submitted");

  assert.equal(uiRecords(repo).length, 1);
  assert.equal(projectStatus(repo).model?.revision, revision, ".vcv/HEAD did not move");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);

  // The project view lists it as waiting for review.
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("Escape");
  await page
    .getByTestId("pending-proposals")
    .getByText(/1 operation|2 operations/)
    .waitFor();
  assert.deepEqual(errors, []);
});

test("11: engine errors block submit and warnings are shown; nothing is recorded", async () => {
  const repo = courseDesk();
  const { page, errors } = await launch(repo);
  await selectModule(page, "Notifications");
  const fields = page.getByTestId("fields");
  const tray = page.getByTestId("tray");
  // Notifications depending on Web closes a cycle: the engine accepts it with a warning.
  await fields.getByRole("button", { name: "Edit Depends on" }).click();
  await fields.getByRole("checkbox", { name: /Web/ }).check();
  await fields.getByRole("button", { name: "Stage", exact: true }).click();
  await tray.getByTestId("check-warnings").getByText("DEPENDENCY_CYCLE").first().waitFor();
  // An empty name does not match renameObject: an error, and submit is disabled.
  await fields.getByRole("button", { name: "Edit Name" }).click();
  await fields.getByRole("textbox", { name: "Name" }).fill("");
  await fields.getByRole("button", { name: "Stage", exact: true }).click();
  await tray.getByTestId("check-state").filter({ hasText: /error/ }).waitFor();
  assert.match((await tray.getByTestId("check-errors").textContent()) ?? "", /SCHEMA.*operations\.1\.name/s);
  assert.ok(await page.getByTestId("submit-proposal").isDisabled());
  await shot(page, "13-invalid");
  assert.deepEqual(uiRecords(repo), []);
  assert.deepEqual(errors, []);
});

test("12: a draft keeps its revision when the model moves, is reported stale, and can be restaged", async () => {
  const repo = courseDesk();
  const { page, errors } = await launch(repo);
  const before = projectStatus(repo).model?.revision;
  await selectModule(page, "Web");
  const fields = page.getByTestId("fields");
  await fields.getByRole("button", { name: "Edit Name" }).click();
  await fields.getByRole("textbox", { name: "Name" }).fill("Web app");
  await fields.getByRole("button", { name: "Stage", exact: true }).click();
  const tray = page.getByTestId("tray");
  await tray.getByTestId("check-state").filter({ hasText: "Valid" }).waitFor();

  const now = addAuditModule(repo); // someone else's change lands
  await page.getByTestId("stale-draft").waitFor();
  await tray.getByTestId("check-state").filter({ hasText: "Stale" }).waitFor();
  assert.match((await tray.getByTestId("check-errors").textContent()) ?? "", /STALE_REVISION/);
  assert.match((await tray.textContent()) ?? "", new RegExp(`on ${before}`));
  assert.ok(await page.getByTestId("submit-proposal").isDisabled());
  await shot(page, "14-stale");

  await tray.getByRole("button", { name: `Restage on ${now}` }).click();
  await tray
    .getByTestId("check-state")
    .filter({ hasText: `Valid on ${now}` })
    .waitFor();
  assert.equal(await page.getByTestId("stale-draft").count(), 0);
  assert.deepEqual(errors, []);
});
