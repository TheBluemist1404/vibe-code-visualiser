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
import type { DraftView } from "../src/types.ts";
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
  // The implementation request: closed while empty, saved field by field on blur.
  const request = tray(page).getByTestId("request");
  await request.locator("summary").click();
  for (const [label, text] of [
    ["Behavior", "Enrollment reads Enrollments everywhere."],
    ["Acceptance criteria", "The API path reads /enrollments\n\nOld links redirect"],
    ["Scope", "src/enrollment/**"],
  ] as const) {
    const box = request.getByRole("textbox", { name: new RegExp(`^${label}`) });
    await box.fill(text);
    await box.blur();
  }

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

  // A short window: the dialog sits in the window, not inside the (animated) tray it opens from.
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.getByTestId("export-draft").click();
  const dialog = page.getByTestId("export-dialog");
  await dialog.getByTestId("export-change").waitFor();
  const box = await dialog.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 640, `dialog within the window: ${JSON.stringify(box)}`);
  assert.equal(await dialog.getByTestId("export-check").getAttribute("data-check"), "valid");
  const change = JSON.parse((await dialog.getByTestId("export-change").textContent()) ?? "");
  assert.equal(proposedChangeSchema.safeParse(change).success, true);
  assert.equal(change.expectedRevision, revision);
  assert.equal(change.rationale, "Clearer names");
  assert.deepEqual(change.implementation, {
    behavior: "Enrollment reads Enrollments everywhere.",
    acceptanceCriteria: ["The API path reads /enrollments", "Old links redirect"],
    scope: ["src/enrollment/**"],
  });
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

test("11b: handing off right after editing waits for the save; a save that fails stops the handoff", async () => {
  const repo = courseDesk();
  const before = tree(repo);
  const { page, errors } = await tab(await host(repo, tempDir("vcv-ui-state-")));
  await selectModule(page, "Enrollment");
  await stage(page, "Name", "Enrollments", 1);
  const request = tray(page).getByTestId("request");
  await request.locator("summary").click();
  const behavior = request.getByRole("textbox", { name: /^Behavior/ });
  const criteria = request.getByRole("textbox", { name: /^Acceptance criteria/ });
  await behavior.fill("Enrollment reads Enrollments everywhere.");
  const saved = page.waitForResponse("**/api/drafts/*/request");
  await behavior.blur();
  await saved;

  // A slow host: the save started by clicking Hand off lands well after the dialog opens.
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/drafts/*/request", async (route) => {
    await held;
    await route.continue();
  });
  // Edit the last field and click Hand off straight away, with no blur of its own.
  await criteria.fill("The API path reads /enrollments");
  await page.getByTestId("export-draft").click();
  const dialog = page.getByTestId("export-dialog");
  await dialog.getByTestId("export-pending").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await dialog.getByTestId("export-change").count(), 0, "no handoff before the save is stored");
  release();
  await dialog.getByTestId("export-change").waitFor();
  const change = JSON.parse((await dialog.getByTestId("export-change").textContent()) ?? "");
  assert.deepEqual(change.implementation, {
    behavior: "Enrollment reads Enrollments everywhere.",
    acceptanceCriteria: ["The API path reads /enrollments"],
  });
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.unroute("**/api/drafts/*/request");

  // A host that refuses the save: the dialog says so and builds no handoff.
  await page.route("**/api/drafts/*/request", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL", message: "disk full" } }),
    }),
  );
  await criteria.fill("The API path reads /enrollments\nOld links redirect");
  await page.getByTestId("export-draft").click();
  await dialog
    .getByTestId("export-error")
    .getByText(/not saved.*disk full/)
    .waitFor();
  assert.equal(await dialog.getByTestId("export-change").count(), 0);
  await dialog.getByRole("button", { name: "Close" }).click();

  // Once the save goes through, the handoff carries the newest text.
  await page.unroute("**/api/drafts/*/request");
  await criteria.focus();
  await page.getByTestId("export-draft").click();
  await dialog.getByTestId("export-change").waitFor();
  const retried = JSON.parse((await dialog.getByTestId("export-change").textContent()) ?? "");
  assert.deepEqual(retried.implementation.acceptanceCriteria, [
    "The API path reads /enrollments",
    "Old links redirect",
  ]);
  assert.deepEqual(tree(repo), before);
  assert.deepEqual(errors, []);
});

/** Hold each matching request until released, in arrival order. */
async function holdRoute(page: Page, pattern: string) {
  const waiting: (() => void)[] = [];
  const arrived: Promise<void>[] = [];
  let signal!: () => void;
  const next = () => {
    arrived.push(new Promise<void>((r) => (signal = r)));
  };
  next();
  await page.route(pattern, async (route) => {
    const go = new Promise<void>((r) => waiting.push(r));
    signal();
    next();
    await go;
    await route.fallback(); // to an earlier handler (a refusal), else the host
  });
  return {
    /** Resolves once the n-th (0-based) call has arrived and is held. */
    arrival: (n: number) => arrived[n],
    release: () => waiting.shift()?.(),
  };
}

const storedDrafts = (page: Page) =>
  page.evaluate(async () => (await (await fetch("/api/drafts")).json()) as { drafts: DraftView[] });

test("11c: queued saves stay with the draft they were made in; older answers keep newer edits", async () => {
  const repo = courseDesk();
  const { page, errors } = await tab(await host(repo, tempDir("vcv-ui-state-")));
  await selectModule(page, "Enrollment");
  await stage(page, "Name", "Enrollments", 1);
  const a = (await storedDrafts(page)).drafts[0]?.draftId ?? "";
  const behaviorBox = () =>
    tray(page)
      .getByTestId("request")
      .getByRole("textbox", { name: /^Behavior/ });
  const openRequest = async () => {
    const request = tray(page).getByTestId("request");
    if ((await request.getAttribute("open")) === null) await request.locator("summary").click();
  };

  // Draft B, with a request of its own.
  await page.getByTestId("new-draft").click();
  await page.waitForFunction(async (a) => {
    const l = await (await fetch("/api/drafts")).json();
    return l.drafts.length === 2 && l.drafts.some((d: { draftId: string }) => d.draftId !== a);
  }, a);
  const b = (await storedDrafts(page)).drafts.find((d) => d.draftId !== a)?.draftId ?? "";
  await page.getByTestId("draft-select").selectOption(b);
  await openRequest();
  let saved = page.waitForResponse("**/api/drafts/*/request");
  await behaviorBox().fill("B behavior");
  await behaviorBox().blur();
  await saved;

  // Back on A: hold its rationale save, queue a request save behind it, then move to B and let
  // the held save fail.
  await page.getByTestId("draft-select").selectOption(a);
  await tray(page).getByTestId("steps").waitFor();
  await page.route("**/api/drafts/*/rationale", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL", message: "disk full" } }),
    }),
  );
  const rationaleHeld = await holdRoute(page, "**/api/drafts/*/rationale");
  const why = tray(page).getByRole("textbox", { name: /Why/ });
  await why.fill("A why");
  await why.blur();
  await rationaleHeld.arrival(0);
  await openRequest();
  await behaviorBox().fill("A behavior");
  await behaviorBox().blur();
  await page.getByTestId("draft-select").selectOption(b);
  saved = page.waitForResponse("**/api/drafts/*/request");
  rationaleHeld.release();
  await saved;
  await page.unroute("**/api/drafts/*/rationale");

  const after = (await storedDrafts(page)).drafts;
  const byId = new Map(after.map((d) => [d.draftId, d]));
  assert.equal(byId.get(a)?.request.behavior, "A behavior", "A's queued request saved to A");
  assert.equal(byId.get(a)?.rationale, "", "A's failed rationale not stored");
  assert.equal(byId.get(b)?.request.behavior, "B behavior", "B untouched");
  assert.equal(await page.getByTestId("draft-select").inputValue(), b, "a save does not change the selection");
  assert.equal(await behaviorBox().inputValue(), "B behavior");
  await tray(page)
    .getByTestId("draft-notice")
    .getByText(/disk full/)
    .waitFor();
  await tray(page).getByTestId("draft-notice").getByRole("button", { name: "Dismiss" }).click();

  // Rapid edits across fields with delayed saves: an older answer never resets newer text.
  await page.getByTestId("draft-select").selectOption(a);
  await tray(page).getByTestId("steps").waitFor();
  await openRequest();
  const field = (label: string) =>
    tray(page)
      .getByTestId("request")
      .getByRole("textbox", { name: new RegExp(`^${label}`) });
  const held = await holdRoute(page, "**/api/drafts/*/request");
  await field("Behavior").fill("A behavior, revised");
  await field("Behavior").blur();
  await held.arrival(0);
  await field("Acceptance criteria").fill("Criterion one");
  await field("Acceptance criteria").blur();
  const first = page.waitForResponse("**/api/drafts/*/request");
  held.release();
  await first;
  await held.arrival(1); // the criteria save, sent after the first answer
  await page.waitForTimeout(200);
  assert.equal(await field("Acceptance criteria").inputValue(), "Criterion one", "kept through the older answer");
  await field("Scope").fill("src/enrollment/**");
  await field("Scope").blur();
  const second = page.waitForResponse("**/api/drafts/*/request");
  held.release();
  await second;
  await held.arrival(2);
  const third = page.waitForResponse("**/api/drafts/*/request");
  held.release();
  await third;
  await page.unroute("**/api/drafts/*/request");
  const final = (await storedDrafts(page)).drafts.find((d) => d.draftId === a);
  assert.deepEqual(final?.request, {
    behavior: "A behavior, revised",
    acceptanceCriteria: ["Criterion one"],
    suggestedTests: [],
    scope: ["src/enrollment/**"],
  });
  assert.equal(await field("Acceptance criteria").inputValue(), "Criterion one");
  assert.equal(await field("Scope").inputValue(), "src/enrollment/**");
  assert.deepEqual(errors, []);
});

test("11d: an edit queued behind a conflicting save gets a conflict, not another tab's version", async () => {
  const repo = courseDesk();
  const h = await host(repo, tempDir("vcv-ui-state-"));
  const { page: a, errors } = await tab(h);
  await selectModule(a, "Enrollment");
  await stage(a, "Name", "Enrollments", 1);
  const field = (page: Page, label: string) =>
    tray(page)
      .getByTestId("request")
      .getByRole("textbox", { name: new RegExp(`^${label}`) });
  const openRequest = async (page: Page) => {
    const request = tray(page).getByTestId("request");
    if ((await request.getAttribute("open")) === null) await request.locator("summary").click();
  };
  await openRequest(a);
  let saved = a.waitForResponse("**/api/drafts/*/request");
  await field(a, "Behavior").fill("Original behavior");
  await field(a, "Behavior").blur();
  await saved;

  const { page: b } = await tab(h);
  await tray(b).getByTestId("steps").waitFor();

  // Tab A: its rationale save is held before it reaches the host; a Scope edit queues behind it.
  const held = await holdRoute(a, "**/api/drafts/*/rationale");
  const why = tray(a).getByRole("textbox", { name: /Why/ });
  await why.fill("A why");
  await why.blur();
  await held.arrival(0);
  await field(a, "Scope").fill("src/enrollment/**");
  await field(a, "Scope").blur();

  // Tab B saves a different Behavior meanwhile.
  await openRequest(b);
  saved = b.waitForResponse("**/api/drafts/*/request");
  await field(b, "Behavior").fill("B behavior");
  await field(b, "Behavior").blur();
  assert.equal((await saved).status(), 200);

  // A's held save conflicts, and so does the Scope edit queued behind it.
  const rationale = a.waitForResponse("**/api/drafts/*/rationale");
  const queued = a.waitForResponse("**/api/drafts/*/request");
  held.release();
  assert.equal((await rationale).status(), 409);
  assert.equal((await queued).status(), 409, "the queued edit is sent on the version it was made on");
  await a.unroute("**/api/drafts/*/rationale");

  const draft = (await storedDrafts(a)).drafts[0];
  assert.equal(draft?.request.behavior, "B behavior", "tab B's saved Behavior survives");
  assert.deepEqual(draft?.request.scope, []);
  assert.equal(draft?.rationale, "");
  await tray(a)
    .getByTestId("draft-notice")
    .getByText(/changed in another tab/)
    .waitFor();
  assert.equal(await field(a, "Behavior").inputValue(), "B behavior", "tab A reloads B's text");
  // A handoff from A says the edit was not saved.
  await a.getByTestId("export-draft").click();
  await a
    .getByTestId("export-error")
    .getByText(/not saved/)
    .waitFor();
  assert.equal(await a.getByTestId("export-change").count(), 0);
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
