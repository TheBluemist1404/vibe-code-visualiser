// The browser half of the M5.7 acceptance walkthrough (Issue #46): the owner's view of the real
// Course Desk in the explorer, driven in Chromium against a host started as its own process.
//
//   node --experimental-strip-types walkthrough.ts <phase> <work-dir> <out-dir>
//
// Phases, in run.sh order:
//   explore   open the project; ready, branch and revision; Enrollment → Notifications in the
//             declared direction; follow the dependency and come back without losing the view;
//             pin Web by dragging it
//   draft     stage three typed edits in the inspector, write a rationale, dry-run them
//   recover   stop the host and the browser, start both again: the same draft, steps in the same
//             order, the same base identity; then export the handoff for the agent
//   inbox     the agent's submitted proposal: the same digest as the CLI, its checks and what is
//             still unverified; the draft is still current (a pending proposal moves nothing)
//   approve   the fixture reviewer approves in a separate process while the pages are open: the
//             inbox follows to applied and signed, the canvas keeps the pinned position and the
//             draft turns stale; a branch switch back to the base makes it current again
//   evidence  after the agent's implementation: the implementation layers, object and criterion
//             evidence, and the pre-merge page against the test base
//   states    empty, invalid and conflicted copies of the real checkout
//
// Every phase asserts what it shows and writes <out>/ui/<phase>.json; screenshots go to
// <out>/shots. The checkout is compared byte for byte before and after every read-only phase.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

const [phase, workArg, outArg] = process.argv.slice(2);
if (!phase || !workArg || !outArg) {
  console.error("usage: walkthrough.ts <phase> <work-dir> <out-dir>");
  process.exit(2);
}
const work = resolve(workArg);
const out = resolve(outArg);
const here = import.meta.dirname;
const vcvHome = resolve(here, "../../..");
const repo = join(work, "course-desk");
const stateDir = join(work, "state");
const base = readFileSync(join(work, "main.sha"), "utf8").trim();
const CHANGE = "chg-full-course-notice";
const SHOTS = join(out, "shots");
mkdirSync(SHOTS, { recursive: true });
mkdirSync(join(out, "ui"), { recursive: true });

// ---------------------------------------------------------------------------------------------
// Host, browser and helpers

type Host = { url: string; proc: ChildProcess; log: string[] };

/** Start the explorer exactly as a person would (`npm run ui -- <checkout> …`), as its own process. */
async function startHost(checkout: string, args: string[] = []): Promise<Host> {
  const proc = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      join(vcvHome, "apps/ui/src/main.ts"),
      checkout,
      "--port",
      "0",
      ...args,
    ],
    { env: { ...process.env, VCV_UI_STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log: string[] = [];
  const url = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`host did not start:\n${log.join("")}`)), 30_000);
    proc.stderr?.on("data", (d) => log.push(String(d)));
    proc.stdout?.on("data", (d) => {
      log.push(String(d));
      const m = /open (http:\/\/127\.0\.0\.1:\d+\/?)/.exec(log.join(""));
      if (m?.[1]) {
        clearTimeout(timer);
        ok(m[1]);
      }
    });
    proc.on("exit", (code) => fail(new Error(`host exited ${code}:\n${log.join("")}`)));
  });
  return { url, proc, log };
}
async function stopHost(h: Host) {
  if (h.proc.exitCode !== null) return;
  const done = new Promise((r) => h.proc.once("exit", r));
  h.proc.kill("SIGTERM");
  await done;
}

let browser: Browser;
const errors: string[] = [];
async function open(h: Host, hash = "") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(h.url + hash);
  return page;
}
async function settle(page: Page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
async function shot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
const text = async (page: Page, id: string) => ((await page.getByTestId(id).first().textContent()) ?? "").trim();
const node = (page: Page, id: string) => page.locator(`[data-module="${id}"]`);
const flowPos = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => (el as HTMLElement).style.transform);
const viewport = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);
async function selectModule(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await page.getByTestId("inspector-name").filter({ hasText: name }).waitFor();
}
async function stage(page: Page, label: string, value: string, count: number) {
  const fields = page.getByTestId("fields");
  await fields.getByRole("button", { name: `Edit ${label}` }).click();
  await fields.getByRole("textbox", { name: label }).fill(value);
  await fields.getByRole("button", { name: "Stage", exact: true }).click();
  await page
    .getByTestId("staged-count")
    .filter({ hasText: String(count) })
    .waitFor();
}

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
/** Every file under the checkout except .git/ and node_modules/, with a hash of its bytes. */
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (rel === ".git" || name === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else files[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return files;
}
/** The one draft file in the state directory (outside the checkout). */
function draftFile(): { path: string; draft: Record<string, unknown> } {
  const root = join(stateDir, "drafts");
  const found: string[] = [];
  for (const key of existsSync(root) ? readdirSync(root) : [])
    for (const f of readdirSync(join(root, key))) if (f.endsWith(".json")) found.push(join(root, key, f));
  assert.equal(found.length, 1, `exactly one draft file: ${found.join(", ")}`);
  const path = found[0] as string;
  return { path, draft: JSON.parse(readFileSync(path, "utf8")) };
}
const facts: Record<string, unknown> = { phase, checkout: "<repo>", base };
function record(key: string, value: unknown) {
  facts[key] = value;
}

// ---------------------------------------------------------------------------------------------
// Phases

const RULE = "Only a confirmed decision is notified";
const RULE_NAME = "Confirmations and full-course rejections are notified";
const RULE_STATEMENT =
  "Each enrollment decision is recorded. A confirmed decision results in exactly one enrollment-confirmed notification, and a rejection because the course is full (COURSE_FULL) in exactly one enrollment-rejected notification; a repeat request (ALREADY_ENROLLED) results in none.";
const CRITERION = "A rejected enrollment is not announced";
const CRITERION_STATEMENT =
  "A request for a full course is recorded as rejected with COURSE_FULL, and the student receives exactly one enrollment-rejected notification for that enrollment.";
const RATIONALE =
  "Students turned away from a full course should hear about it (they may pick another course); a repeat request stays quiet because the student already holds the seat.";

const phases: Record<string, () => Promise<void>> = {
  async explore() {
    const before = tree(repo);
    const h = await startHost(repo, ["--protected-base", "test-base"]);
    const page = await open(h);
    await page.getByTestId("project-state").getByText("Ready").waitFor();
    for (const name of ["Web", "Enrollment", "Notifications"])
      await page.locator(".react-flow__node").getByText(name, { exact: true }).waitFor();
    record("revision", await text(page, "revision"));
    record("branch", await text(page, "branch"));
    assert.equal(facts.branch, "test-base");
    assert.match(String(facts.revision), /^rev-4-d704dd46aee2$/);
    const edges = await page
      .locator(".react-flow__edge")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
    record("edges", edges);
    assert.ok(edges.includes("dependsOn:mod-enrollment->mod-notifications"), "Enrollment depends on Notifications");
    assert.ok(!edges.includes("dependsOn:mod-notifications->mod-enrollment"), "never the reverse");
    const yE = (await node(page, "mod-enrollment").boundingBox())?.y ?? 0;
    const yN = (await node(page, "mod-notifications").boundingBox())?.y ?? 0;
    assert.ok(yE < yN, "the dependent sits above its dependency");
    await shot(page, "01-overview");

    await node(page, "mod-enrollment").click();
    await page.getByTestId("inspector-name").getByText("Enrollment").waitFor();
    await page.locator(".edge-label").getByText("Enrollment depends on Notifications").waitFor();
    await settle(page);
    const view = await viewport(page);
    await shot(page, "02-enrollment-selected");
    await page.getByTestId("link-mod-notifications").click();
    await page.getByTestId("inspector-name").getByText("Notifications").waitFor();
    assert.equal(await page.locator('.mod[aria-current="true"]').getByText("Notifications").count(), 1);
    await shot(page, "03-followed-to-notifications");
    // Back the other way: Notifications is used by Enrollment.
    await page.getByTestId("link-mod-enrollment").click();
    await page.getByTestId("inspector-name").getByText("Enrollment").waitFor();
    await page.waitForTimeout(800); // the 500 ms pan to the selected module (not a CSS animation)
    await settle(page);
    // Following a link centres the module it leads to; coming back centres Enrollment again, at
    // the same zoom, with Enrollment selected in both the canvas and the module list.
    const back = await viewport(page);
    const scale = (t: string) => /scale\(([\d.]+)\)/.exec(t)?.[1];
    assert.equal(scale(back), scale(view), "the zoom is kept");
    assert.equal(await page.locator('.mod[aria-current="true"]').getByText("Enrollment").count(), 1);
    const box = await node(page, "mod-enrollment").boundingBox();
    const pane = await page.locator(".react-flow__pane").boundingBox();
    assert.ok(box && pane && box.y >= pane.y && box.y + box.height <= pane.y + pane.height, "Enrollment is in view");
    record("returnTrip", { before: view, after: back, selected: "mod-enrollment", zoomKept: true });

    // Pin Web by dragging it: the position is saved outside the checkout.
    const web = await node(page, "mod-web").boundingBox();
    assert.ok(web);
    await page.mouse.move(web.x + web.width / 2, web.y + 10);
    await page.mouse.down();
    await page.mouse.move(web.x + web.width / 2 + 220, web.y + 40, { steps: 10 });
    await page.mouse.up();
    await node(page, "mod-web").locator(".node-pin").waitFor();
    await settle(page);
    record("webPinnedAt", await flowPos(page, "mod-web"));
    await shot(page, "04-web-pinned");
    assert.deepEqual(tree(repo), before, "exploring and pinning wrote nothing to the checkout");
    assert.equal(git(repo, "status", "--porcelain"), "");
    record("checkoutUnchanged", true);
    await page.close();
    await stopHost(h);
  },

  async draft() {
    const before = tree(repo);
    const h = await startHost(repo, ["--protected-base", "test-base"]);
    const page = await open(h);
    await node(page, "mod-enrollment").waitFor();
    await selectModule(page, "Enrollment");
    await page
      .getByTestId("owned-rule")
      .getByRole("button", { name: new RegExp(RULE) })
      .click();
    await page.getByTestId("object-name").filter({ hasText: RULE }).waitFor();
    await stage(page, "Statement", RULE_STATEMENT, 1);
    await stage(page, "Name", RULE_NAME, 2);
    await selectModule(page, "Enrollment");
    await page.getByTestId("owned-criterion").getByText(CRITERION).click();
    await page.getByTestId("object-name").filter({ hasText: CRITERION }).waitFor();
    await stage(page, "Statement", CRITERION_STATEMENT, 3);
    const why = page.getByTestId("tray").getByRole("textbox", { name: /Why/ });
    await why.fill(RATIONALE);
    await why.blur();
    await page
      .getByTestId("tray")
      .getByTestId("check-state")
      .filter({ hasText: /Valid on rev-4-d704dd46aee2/ })
      .waitFor();
    record("dryRun", await text(page, "check-state"));
    record("steps", await text(page, "steps"));
    await shot(page, "05-draft-staged");
    const { path, draft } = draftFile();
    assert.ok(!path.startsWith(repo), "the draft lives outside the checkout");
    record("draftPath", path.replace(work, "<work>"));
    record("draftVersion", draft.version);
    writeFileSync(join(out, "ui", "draft-before-restart.json"), `${JSON.stringify(draft, null, 2)}\n`);
    assert.deepEqual(tree(repo), before, "staging wrote nothing to the checkout");
    assert.equal(git(repo, "status", "--porcelain"), "");
    record("checkoutUnchanged", true);
    await page.close();
    await browser.close(); // the browser goes away too
    await stopHost(h);
  },

  async recover() {
    const before = tree(repo);
    const saved = JSON.parse(readFileSync(join(out, "ui", "draft-before-restart.json"), "utf8"));
    const h = await startHost(repo, ["--protected-base", "test-base"]);
    const page = await open(h);
    await page.getByTestId("staged-count").filter({ hasText: "3" }).waitFor();
    assert.equal(await page.getByTestId("draft-select").locator("option").count(), 1);
    const { draft } = draftFile();
    assert.deepEqual(draft, saved, "byte-equal draft after a host and browser restart");
    const ops = (draft.steps as { operation: { type: string } }[]).map((s) => s.operation.type);
    record("operationOrder", ops);
    assert.deepEqual(ops, ["setRuleStatement", "renameObject", "reviseCriterion"]);
    record("base", draft.base);
    await page.getByTestId("tray").getByTestId("check-state").filter({ hasText: /Valid/ }).waitFor();
    await shot(page, "06-draft-recovered");

    await page.getByTestId("export-draft").click();
    const dialog = page.getByTestId("export-dialog");
    await dialog.getByTestId("export-change").waitFor();
    assert.equal(await dialog.getByTestId("export-check").getAttribute("data-check"), "valid");
    const change = JSON.parse((await dialog.getByTestId("export-change").textContent()) ?? "");
    const metadata = JSON.parse((await dialog.getByTestId("export-metadata").textContent()) ?? "");
    assert.equal(change.expectedRevision, "rev-4-d704dd46aee2");
    for (const forbidden of ["proposerId", "approverId", "status", "signature"]) assert.ok(!(forbidden in change));
    mkdirSync(join(out, "handoff"), { recursive: true });
    writeFileSync(join(out, "handoff", "change.json"), `${JSON.stringify(change, null, 2)}\n`);
    writeFileSync(join(out, "handoff", "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    record("exportedChangeId", change.changeId);
    await shot(page, "07-handoff-export");
    for (const name of [/submit/i, /^approve/i]) assert.equal(await page.getByRole("button", { name }).count(), 0);
    assert.deepEqual(tree(repo), before, "recovering and exporting wrote nothing to the checkout");
    record("checkoutUnchanged", true);
    await page.close();
    await stopHost(h);
  },

  async inbox() {
    const cliDigest = readFileSync(join(out, "agent", "digest.txt"), "utf8").trim();
    const before = tree(repo);
    const h = await startHost(repo, ["--protected-base", "test-base"]);
    const page = await open(h);
    await page.getByTestId("pending-count").filter({ hasText: "1" }).waitFor();
    // A pending proposal moves nothing: the draft is still current.
    assert.equal(await page.getByTestId("stale-draft").count(), 0);
    await page.getByTestId("tab-proposals").click();
    await page.getByTestId(`proposal-${CHANGE}`).click();
    await page.getByTestId("review-state").filter({ hasText: "Pending review" }).waitFor();
    const digest = await text(page, "review-digest");
    assert.equal(digest, cliDigest, "the inbox shows the digest the CLI previewed");
    record("digest", digest);
    record("steps", await page.getByTestId("review-steps").locator("li").allTextContents());
    record("reviewerHandoff", await text(page, "reviewer-handoff"));
    assert.match(String(facts.reviewerHandoff), new RegExp(digest));
    assert.equal(await page.getByRole("button", { name: /^approve/i }).count(), 0, "no approve control");
    await shot(page, "08-inbox-pending");
    await page.getByTestId("review-bindings").scrollIntoViewIfNeeded();
    await shot(page, "09-inbox-pending-claims");
    assert.deepEqual(tree(repo), before);
    record("checkoutUnchanged", true);
    await page.close();
    await stopHost(h);
  },

  async approve() {
    const digest = readFileSync(join(out, "agent", "digest.txt"), "utf8").trim();
    const h = await startHost(repo, ["--protected-base", "test-base"]);
    const canvas = await open(h);
    await node(canvas, "mod-web").locator(".node-pin").waitFor();
    await settle(canvas);
    const pinned = await flowPos(canvas, "mod-web");
    const review = await open(h, `#/proposals/${CHANGE}`);
    await review.getByTestId("review-state").filter({ hasText: "Pending review" }).waitFor();

    // The fixture reviewer, in its own process; the host and the browser never see the key.
    const approval = execFileSync("bash", [join(here, "reviewer.sh"), work, "approve", CHANGE, digest], {
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VCV_HOST_"))),
    });
    writeFileSync(join(out, "ui", "approval.txt"), approval.replaceAll(repo, "<repo>").replaceAll(work, "<work>"));
    git(repo, "add", ".vcv");
    git(
      repo,
      "commit",
      "-q",
      "-m",
      `vcv: approve ${CHANGE} (TEST-ONLY fixture reviewer; digest ${digest.slice(0, 12)})`,
    );

    await review.getByTestId("review-state").filter({ hasText: "Applied to model" }).waitFor({ timeout: 20_000 });
    record("reviewSteps", await review.getByTestId("review-steps").locator("li").allTextContents());
    assert.equal(await review.getByTestId("reviewer-handoff").count(), 0);
    await shot(review, "10-inbox-applied");

    await canvas.getByTestId("change-banner").waitFor({ timeout: 20_000 });
    const rev5 = await text(canvas, "revision");
    record("revisionAfterApproval", rev5);
    assert.match(rev5, /^rev-5-/);
    await settle(canvas);
    assert.equal(await flowPos(canvas, "mod-web"), pinned, "the pinned module stays where it was put");
    record("pinnedStable", pinned);
    const stale = canvas.getByTestId("stale-draft");
    await stale.waitFor();
    record("staleDraft", ((await stale.textContent()) ?? "").trim());
    await canvas.getByTestId("tray").getByTestId("check-state").filter({ hasText: /Stale/ }).waitFor();
    await canvas.getByTestId("pending-count").waitFor({ state: "detached", timeout: 20_000 });
    await shot(canvas, "11-model-changed-draft-stale");

    // A branch switch back to the base: the draft is current there again, the pin is unchanged.
    const branch = git(repo, "branch", "--show-current");
    git(repo, "checkout", "-q", "test-base");
    await canvas.getByTestId("revision").filter({ hasText: "rev-4-d704dd46aee2" }).waitFor({ timeout: 20_000 });
    await stale.waitFor({ state: "detached" });
    await canvas.getByTestId("tray").getByTestId("check-state").filter({ hasText: /Valid/ }).waitFor();
    await settle(canvas);
    assert.equal(await flowPos(canvas, "mod-web"), pinned);
    await shot(canvas, "12-branch-switch-draft-current");
    git(repo, "checkout", "-q", branch);
    await canvas.getByTestId("revision").filter({ hasText: rev5 }).waitFor({ timeout: 20_000 });
    await stale.waitFor();
    record("staleAcrossBranchSwitch", "stale on the approved branch, current on test-base, stale again");
    await review.close();
    await canvas.close();
    await stopHost(h);
  },

  async evidence() {
    const before = tree(repo);
    // The same inputs CI had, handed to the explorer at start: the base commit, the base's own
    // policy file, and the record of the host's test run. The explorer captures nothing itself, so
    // to it that record is a claim (RESULT_CLAIMED), and it says so instead of passing.
    const run = join(out, "gate", "3-implemented", "test-run.json");
    const policy = join(out, "gate", "base-policy.json");
    const h = await startHost(repo, [
      "--protected-base",
      "test-base",
      "--base-commit",
      base,
      "--run",
      run,
      "--policy",
      policy,
    ]);
    const page = await open(h, `#/proposals/${CHANGE}`);
    await page.getByTestId("review-state").filter({ hasText: "Applied to model" }).waitFor();
    const impl = page.getByTestId("implementation");
    await impl.getByTestId("agent-report").waitFor();
    record("agentReport", await text(page, "agent-report"));
    record("vcvObserved", await text(page, "vcv-observed"));
    await impl.scrollIntoViewIfNeeded();
    await shot(page, "13-implementation");

    await page.goto(`${h.url}#/`);
    await selectModule(page, "Enrollment");
    await page
      .getByTestId("owned-rule")
      .getByRole("button", { name: new RegExp(RULE_NAME) })
      .click();
    await page.getByTestId("object-name").filter({ hasText: RULE_NAME }).waitFor();
    const ev = page.getByTestId("object-evidence");
    await ev.waitFor();
    await ev.locator("li").first().waitFor();
    record("ruleEvidence", ((await ev.textContent()) ?? "").trim());
    await ev.scrollIntoViewIfNeeded();
    await shot(page, "14-rule-evidence");
    await selectModule(page, "Enrollment");
    await page
      .getByTestId("owned-criterion")
      .getByText(/full-course rejection|rejected enrollment/i)
      .first()
      .click();
    const crit = page.getByTestId("criterion-evidence");
    await crit.waitFor();
    record("criterionEvidence", ((await crit.textContent()) ?? "").trim());
    await crit.scrollIntoViewIfNeeded();
    await shot(page, "15-criterion-evidence");

    await page.getByTestId("tab-gate").click();
    await page.getByTestId("gate-decision").waitFor({ timeout: 30_000 });
    record("gateDecision", await text(page, "gate-decision"));
    record("gateReasons", await page.getByTestId("gate-reasons").locator("li").allTextContents());
    record("integrity", await page.getByTestId("rec-integrity").getAttribute("data-ok"));
    assert.match(String(facts.gateDecision), /Blocked/, "a run handed to the explorer is never host-observed");
    assert.match(String(facts.gateDecision), /RESULT_CLAIMED/);
    assert.doesNotMatch(String(facts.gateDecision), /policy default/, "the base's policy, not the default");
    assert.equal(facts.integrity, "true");
    assert.match(String(facts.criterionEvidence), /claimed/);
    await shot(page, "16-gate-page");
    assert.deepEqual(tree(repo), before, "evidence and the pre-merge page wrote nothing");
    record("checkoutUnchanged", true);
    await page.close();
    await stopHost(h);
  },

  async states() {
    const dir = join(work, "states");
    const cases = readdirSync(dir).sort();
    const seen: Record<string, string> = {};
    for (const name of cases) {
      const checkout = join(dir, name);
      const before = tree(checkout);
      const h = await startHost(checkout);
      const page = await open(h);
      const screen = page.locator('[data-testid^="state-"]');
      await screen.first().waitFor();
      seen[name] =
        `${await screen.first().getAttribute("data-testid")}: ${((await screen.first().textContent()) ?? "").replace(/\s+/g, " ").slice(0, 240)}`;
      await shot(page, `17-state-${name}`);
      assert.equal(await page.locator(".react-flow__node").count(), 0);
      assert.deepEqual(tree(checkout), before, `${name}: nothing initialized or repaired`);
      await page.close();
      await stopHost(h);
    }
    record("states", seen);
  },
};

const run = phases[phase];
if (!run) {
  console.error(`unknown phase ${phase}; one of ${Object.keys(phases).join(", ")}`);
  process.exit(2);
}
browser = await chromium.launch();
try {
  await run();
  assert.deepEqual(errors, [], "no page errors");
  record("pageErrors", errors);
  const scrubbed = JSON.stringify(facts, null, 2).replaceAll(repo, "<repo>").replaceAll(work, "<work>");
  writeFileSync(join(out, "ui", `${phase}.json`), `${scrubbed}\n`);
  console.log(`walkthrough ${phase}: ok`);
} finally {
  if (browser.isConnected()) await browser.close();
}
