// Source binding claims and deterministic locator verification (Issue #13, M2.4), on real Git
// checkouts of the Course Desk fixture with the M2.3 agent draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadModel } from "@vcv/ir";
import { FileStore, FileStoreReader, ModelEngine } from "@vcv/core";
import type { SourceLocator } from "@vcv/core";
import { createQueryApi } from "@vcv/query";
import {
  BindingError,
  RepositoryProject,
  VCV_DIR,
  defaultBindingId,
  disputeBinding,
  fileFingerprint,
  initProject,
  listBindings,
  parseLocator,
  readBinding,
  recordBinding,
  removeBinding,
  resolveLocator,
  verifyBinding,
  verifyBindings,
} from "../src/index.ts";
import type { BindingHost, RecordInput } from "../src/index.ts";
import { GIT_ENV, git, tempDir } from "@vcv/testkit";

const ROOT = join(import.meta.dirname, "../../..");
const DRAFT = join(ROOT, "docs/samples/m2.3-bootstrap/agent-output/model.yaml");
const SERVICE = "server/src/enrollment/enrollment.service.ts";
const CONTROLLER = "server/src/enrollment/enrollment.controller.ts";
const SPEC = "server/src/enrollment/enrollment.service.spec.ts";
const ENROLL: SourceLocator = { path: SERVICE, selector: { kind: "symbol", name: "EnrollmentService.enroll" } };

const agent: BindingHost = { principalId: "agent:bootstrap", permissions: ["binding:record"], source: "agent" };
const reviewer: BindingHost = {
  principalId: "user:hoang",
  permissions: ["binding:record", "binding:dispute"],
  source: "human",
};

const tmp = () => realpathSync(tempDir("vcv-bind-"));
const read = (p: string) => readFileSync(p, "utf8");
const edit = (repo: string, rel: string, from: string | RegExp, to: string) => {
  const before = read(join(repo, rel));
  const after = before.replace(from, to);
  assert.notEqual(after, before, `edit of ${rel} changed nothing`);
  writeFileSync(join(repo, rel), after);
};
const bytesOf = (repo: string) =>
  Object.fromEntries(
    ["HEAD", ...readdirSync(join(repo, VCV_DIR, "revisions")).map((f) => `revisions/${f}`)].map((f) => [
      f,
      read(join(repo, VCV_DIR, f)),
    ]),
  );
const claimFiles = (repo: string) =>
  existsSync(join(repo, VCV_DIR, "bindings")) ? readdirSync(join(repo, VCV_DIR, "bindings")).sort() : [];

/** A standalone Course Desk checkout with the M2.3 draft initialized through project init. */
function courseDesk(commitProject = false): string {
  const repo = join(tmp(), "course-desk");
  execFileSync("bash", [join(ROOT, "examples/reference-app/materialize.sh"), repo], { encoding: "utf8" });
  initProject(repo, loadModel(read(DRAFT)).model!);
  if (commitProject) {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "vcv: draft model");
  }
  return repo;
}
const enrollInput = (over: Partial<RecordInput> = {}): RecordInput => ({
  modelObjectId: "cap-enroll",
  relation: "implements",
  locator: ENROLL,
  rationale: "enroll() makes and records the decision",
  confidence: 0.8,
  ...over,
});
function refuses(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof BindingError && e.code === code, `expected ${code}`);
}

test("a claim from a capability and a rule to EnrollmentService.enroll resolves, without labelling its meaning verified", () => {
  const repo = courseDesk();
  const before = bytesOf(repo);
  const cap = recordBinding(repo, enrollInput(), agent, null);
  const rule = recordBinding(
    repo,
    { modelObjectId: "rul-seat-limit", relation: "implements", locator: ENROLL },
    agent,
    null,
  );
  assert.equal(cap.resolution.state, "resolved");
  assert.equal(cap.created, true);
  assert.notEqual(cap.entry.bindingId, rule.entry.bindingId);

  const claim = cap.entry.claim!;
  assert.equal(claim.provenance.source, "agent");
  assert.equal(claim.provenance.principalId, "agent:bootstrap");
  assert.equal(claim.modelRevision, "rev-1");
  assert.equal(claim.observed.commit, git(repo, "rev-parse", "HEAD"), "the inspected source snapshot");
  assert.equal(claim.observed.workingTree, "clean");
  assert.match(claim.observed.fingerprint.selector!, /^[0-9a-f]{64}$/);

  const v = verifyBinding(repo, readBinding(repo, cap.entry.bindingId)!);
  assert.equal(v.state, "resolved");
  assert.equal(v.meaning, "unverified");
  assert.equal(v.approved, false);
  assert.equal(v.source!.state, "unchanged");
  assert.equal(v.model!.state, "unchanged");
  assert.match(v.locator!.detail, /EnrollmentService\.enroll at line \d+/);

  // Binding writes never touch HEAD or the revisions, and the model stays an unverified draft.
  assert.deepEqual(bytesOf(repo), before);
  const overview = createQueryApi(new FileStoreReader(join(repo, VCV_DIR))).getProjectOverview();
  assert.ok(overview.ok);
  assert.equal(overview.context.snapshotStatus, "draft");
  assert.equal(overview.context.implementationChecked, false);

  // Portable: no machine path in a tracked claim; one file per claim under .vcv/bindings/.
  for (const f of claimFiles(repo))
    assert.doesNotMatch(
      read(join(repo, VCV_DIR, "bindings", f)),
      new RegExp(repo.replace(/[/\\^$.*+?()[\]{}|]/g, "\\$&")),
    );
  assert.deepEqual(claimFiles(repo), [`${cap.entry.bindingId}.json`, `${rule.entry.bindingId}.json`].sort());
});

test("routes, tests and files resolve; a locator to nothing, an ambiguous one or an unsupported one is never stored as valid", () => {
  const repo = courseDesk();
  const route = recordBinding(
    repo,
    {
      modelObjectId: "cap-enroll",
      relation: "exposes",
      locator: parseLocator(`${CONTROLLER}#route:POST /enrollments`),
    },
    agent,
    null,
  );
  assert.match(route.resolution.detail, /EnrollmentController\.enroll/);
  const prefixed = resolveLocator(
    repo,
    parseLocator("server/src/notifications/notifications.controller.ts#route:GET /notifications"),
  );
  assert.equal(prefixed.state, "resolved", "the @Controller path is part of the route");
  assert.equal(resolveLocator(repo, parseLocator(`${CONTROLLER}#route:GET /enrollments/:id`)).state, "resolved");
  assert.equal(
    resolveLocator(repo, parseLocator(`${CONTROLLER}#route:GET /api/courses`)).state,
    "missing",
    "the global prefix is not applied (documented)",
  );
  const t = recordBinding(
    repo,
    {
      modelObjectId: "rul-seat-limit",
      relation: "tests",
      locator: parseLocator(
        `${SPEC}#test:EnrollmentService > rejects an enrollment into a full course and notifies the student`,
      ),
    },
    agent,
    null,
  );
  assert.equal(t.resolution.state, "resolved");
  recordBinding(
    repo,
    {
      modelObjectId: "mod-enrollment",
      relation: "implements",
      locator: parseLocator("server/src/enrollment/enrollment.module.ts"),
    },
    agent,
    null,
  );
  const stored = claimFiles(repo);

  refuses(
    () =>
      recordBinding(
        repo,
        enrollInput({ locator: { path: SERVICE, selector: { kind: "symbol", name: "EnrollmentService.reject" } } }),
        agent,
        null,
      ),
    "LOCATOR_MISSING",
  );
  refuses(
    () =>
      recordBinding(
        repo,
        enrollInput({ locator: { path: "server/src/enrollment/waitlist.service.ts", selector: { kind: "file" } } }),
        agent,
        null,
      ),
    "LOCATOR_MISSING",
  );
  refuses(
    () =>
      recordBinding(
        repo,
        enrollInput({ locator: parseLocator(`${CONTROLLER}#route:DELETE /enrollments/:id`) }),
        agent,
        null,
      ),
    "LOCATOR_MISSING",
  );
  refuses(() => recordBinding(repo, enrollInput({ modelObjectId: "cap-withdraw" }), agent, null), "UNKNOWN_OBJECT");
  refuses(
    () => recordBinding(repo, enrollInput({ modelRevision: "rev-9-000000000000" }), agent, null),
    "UNKNOWN_REVISION",
  );
  refuses(() => recordBinding(repo, enrollInput({ relation: "verifies" as never }), agent, null), "INVALID_CLAIM");
  refuses(() => recordBinding(repo, enrollInput(), { ...agent, permissions: [] }, null), "NOT_AUTHORIZED");

  // Two declarations with the same name: none is picked; naming the declaration kind resolves it.
  writeFileSync(
    join(repo, "server/src/shared.ts"),
    "export class Seat { n = 1; }\nexport interface Seat { label: string }\nexport function pick(): void;\nexport function pick(x?: number) {}\n",
  );
  refuses(
    () => recordBinding(repo, enrollInput({ locator: parseLocator("server/src/shared.ts#symbol:Seat") }), agent, null),
    "LOCATOR_AMBIGUOUS",
  );
  assert.equal(
    resolveLocator(repo, {
      path: "server/src/shared.ts",
      selector: { kind: "symbol", name: "Seat", declaration: "class" },
    }).state,
    "resolved",
  );
  assert.equal(
    resolveLocator(repo, parseLocator("server/src/shared.ts#symbol:pick")).state,
    "resolved",
    "overloads belong to one implementation",
  );

  // Outside the subset: honest "unchecked", refused unless explicitly allowed.
  writeFileSync(
    join(repo, "server/src/dynamic.controller.ts"),
    'import { Controller, Get } from "@nestjs/common";\nconst P = "x";\n@Controller()\nexport class D { @Get(P) x() {} }\n',
  );
  refuses(
    () =>
      recordBinding(
        repo,
        enrollInput({ locator: parseLocator("server/src/dynamic.controller.ts#route:GET /x") }),
        agent,
        null,
      ),
    "LOCATOR_UNCHECKED",
  );
  refuses(
    () => recordBinding(repo, enrollInput({ locator: parseLocator("README.md#symbol:Enroll") }), agent, null),
    "LOCATOR_UNCHECKED",
  );
  assert.deepEqual(claimFiles(repo), stored, "no refused claim was written");

  const unchecked = recordBinding(
    repo,
    enrollInput({ locator: parseLocator("README.md#symbol:Enroll"), allowUnchecked: true }),
    agent,
    null,
  );
  const v = verifyBinding(repo, unchecked.entry);
  assert.equal(v.state, "unchecked");
  assert.equal(v.source!.state, "unknown");
});

test("rename, body edit, unrelated edit, commit and move: reported as missing or stale, never rewritten or rebound", () => {
  const repo = courseDesk(true);
  const { entry } = recordBinding(repo, enrollInput(), agent, null);
  const claimBytes = read(join(repo, entry.file));
  const head = bytesOf(repo);
  const state = () => verifyBinding(repo, readBinding(repo, entry.bindingId)!);

  // An edit elsewhere in the same file is not advertised as drift of this claim.
  edit(repo, SERVICE, "if (!enrollment) throw", "if (enrollment === undefined) throw");
  let v = state();
  assert.equal(v.state, "resolved");
  assert.equal(v.source!.fileChanged, true);
  assert.match(v.source!.cause, /not evidence/);
  // Comments and formatting inside the method do not count either.
  edit(repo, SERVICE, "const taken = this.enrollments", "// seats already taken\n    const   taken = this.enrollments");
  assert.equal(state().state, "resolved");
  // A change of the selected code in the working tree (same Git HEAD) is detected from file contents.
  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity");
  v = state();
  assert.equal(v.state, "stale");
  assert.equal(v.source!.state, "changed");
  assert.equal(v.git.commitMoved, false);
  assert.equal(v.git.workingTree, "modified");
  git(repo, "checkout", "--", SERVICE);
  assert.equal(state().state, "resolved");

  // A new commit that does not touch the code is only context.
  writeFileSync(join(repo, "NOTES.md"), "unrelated\n");
  git(repo, "add", "NOTES.md");
  git(repo, "commit", "-q", "-m", "notes");
  v = state();
  assert.equal(v.state, "resolved");
  assert.equal(v.git.commitMoved, true);

  // Rename the method: missing. Move the file: missing. Nothing is rewritten.
  edit(repo, SERVICE, "  enroll(request: EnrollmentRequest)", "  enrollStudent(request: EnrollmentRequest)");
  assert.equal(state().state, "missing");
  git(repo, "checkout", "--", SERVICE);
  git(repo, "mv", SERVICE, "server/src/enrollment/enrollments.service.ts");
  v = state();
  assert.equal(v.state, "missing");
  assert.match(v.locator!.detail, /does not exist/);
  assert.equal(read(join(repo, entry.file)), claimBytes, "the claim is not auto-rebound");
  assert.deepEqual(bytesOf(repo), head, "the model is not rewritten");
});

test("reasserting a moved mapping keeps HEAD and the IR revision; Git commits the claim and the source edit together", () => {
  const repo = courseDesk(true);
  const { entry } = recordBinding(repo, enrollInput(), agent, null);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "vcv: bind cap-enroll");
  const head = bytesOf(repo);

  edit(repo, SERVICE, "  enroll(request: EnrollmentRequest)", "  enrollStudent(request: EnrollmentRequest)");
  edit(repo, CONTROLLER, "this.enrollment.enroll(request)", "this.enrollment.enrollStudent(request)");
  assert.equal(verifyBinding(repo, readBinding(repo, entry.bindingId)!).state, "missing");

  const read1 = readBinding(repo, entry.bindingId)!;
  const moved = recordBinding(
    repo,
    enrollInput({
      bindingId: entry.bindingId,
      locator: { path: SERVICE, selector: { kind: "symbol", name: "EnrollmentService.enrollStudent" } },
    }),
    reviewer,
    read1.digest,
  );
  assert.equal(moved.created, false);
  assert.equal(moved.entry.bindingId, entry.bindingId, "the ID survives a reassert");
  assert.equal(moved.entry.claim!.provenance.source, "human");
  assert.equal(moved.entry.claim!.observed.workingTree, "modified", "recorded against the edited working tree");
  assert.deepEqual(bytesOf(repo), head, ".vcv/HEAD and the revision are unchanged");

  // Reopen from scratch: the new claim persists and resolves.
  const project = RepositoryProject.open(repo);
  assert.equal(project.status().model!.revision, "rev-1");
  assert.equal(verifyBinding(repo, readBinding(repo, entry.bindingId)!).state, "resolved");

  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "rename enroll and reassert its binding");
  assert.deepEqual(
    git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort(),
    [CONTROLLER, SERVICE, entry.file].sort(),
  );
});

test("cross-branch collision: an update or create based on another branch's claim aborts before touching it or HEAD", () => {
  const repo = courseDesk(true);
  const id = "implements.cap-enroll.main";
  // main: the claim points at the service method.
  recordBinding(repo, enrollInput({ bindingId: id }), agent, null);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "bind on main");
  // other: the same ID with different content.
  git(repo, "checkout", "-q", "-b", "other", "HEAD~1");
  recordBinding(
    repo,
    enrollInput({ bindingId: id, locator: parseLocator(`${CONTROLLER}#symbol:EnrollmentController.enroll`) }),
    agent,
    null,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "bind on other");
  const otherClaim = read(join(repo, VCV_DIR, "bindings", `${id}.json`));
  // empty: no claim at all.
  git(repo, "checkout", "-q", "-b", "empty", "other~1");

  // Replace path: read on main, switch to other, try the update.
  git(repo, "checkout", "-q", "main");
  const seenOnMain = readBinding(repo, id)!;
  git(repo, "checkout", "-q", "other");
  const head = bytesOf(repo);
  refuses(
    () =>
      recordBinding(
        repo,
        enrollInput({ bindingId: id, locator: parseLocator(`${SERVICE}#symbol:EnrollmentService.get`) }),
        agent,
        seenOnMain.digest,
      ),
    "BINDING_CHANGED",
  );
  refuses(() => removeBinding(repo, id, agent, seenOnMain.digest), "BINDING_CHANGED");
  refuses(() => disputeBinding(repo, id, "wrong", reviewer, seenOnMain.digest), "BINDING_CHANGED");
  assert.equal(read(join(repo, VCV_DIR, "bindings", `${id}.json`)), otherClaim, "other's claim is intact");
  assert.deepEqual(bytesOf(repo), head);

  // Create path: absence observed on "empty", then the checkout brings a same-ID claim.
  git(repo, "checkout", "-q", "empty");
  assert.equal(readBinding(repo, id), null);
  git(repo, "checkout", "-q", "other");
  refuses(() => recordBinding(repo, enrollInput({ bindingId: id }), agent, null), "BINDING_EXISTS");
  assert.equal(read(join(repo, VCV_DIR, "bindings", `${id}.json`)), otherClaim);

  // A checkout landing between validation and the write: refused at the re-check, nothing written.
  git(repo, "checkout", "-q", "main");
  const mainClaim = readBinding(repo, id)!;
  refuses(
    () =>
      recordBinding(repo, enrollInput({ bindingId: id, rationale: "again" }), agent, mainClaim.digest, {
        beforeWrite: () => git(repo, "checkout", "-q", "other"),
      }),
    "STATE_CHANGED",
  );
  assert.equal(read(join(repo, VCV_DIR, "bindings", `${id}.json`)), otherClaim);
  git(repo, "checkout", "-q", "empty");
  refuses(
    () =>
      recordBinding(repo, enrollInput({ bindingId: id }), agent, null, {
        beforeWrite: () => git(repo, "checkout", "-q", "other"),
      }),
    "STATE_CHANGED",
  );
  assert.equal(read(join(repo, VCV_DIR, "bindings", `${id}.json`)), otherClaim);
  assert.deepEqual(bytesOf(repo), head);
  assert.equal(git(repo, "status", "--porcelain"), "", "no stray files");

  // The model store moving during a binding write is refused too.
  git(repo, "checkout", "-q", "main");
  const fresh = readBinding(repo, id)!;
  const engine = new ModelEngine(new FileStore(join(repo, VCV_DIR)));
  refuses(
    () =>
      recordBinding(repo, enrollInput({ bindingId: id, rationale: "again" }), agent, fresh.digest, {
        beforeWrite: () => {
          const o = engine.propose(
            {
              changeId: "ch-rename",
              projectId: "prj-course-desk",
              expectedRevision: "rev-1",
              operations: [{ type: "renameObject", objectId: "cap-enroll", name: "Enroll" }],
            },
            { principalId: "u", permissions: ["model:propose", "model:apply"] },
          );
          assert.equal(o.status, "applied", JSON.stringify(o.diagnostics));
        },
      }),
    "STATE_CHANGED",
  );
  assert.equal(readBinding(repo, id)!.digest, fresh.digest);
});

test("paths outside the checkout are refused, including through symlinks; case is not folded", () => {
  const repo = courseDesk();
  const outside = tmp();
  writeFileSync(join(outside, "secret.ts"), "export const secret = 1;\n");
  symlinkSync(outside, join(repo, "server/linked"));
  for (const path of [
    "../course-desk/README.md",
    "/etc/hosts",
    "server\\src\\main.ts",
    "./README.md",
    "server//src/main.ts",
    ".vcv/HEAD",
    ".git/config",
    "server/node_modules/x.ts",
    "server/linked/secret.ts",
  ]) {
    refuses(
      () => recordBinding(repo, enrollInput({ locator: { path, selector: { kind: "file" } } }), agent, null),
      "UNSAFE_PATH",
    );
  }
  refuses(
    () =>
      recordBinding(
        repo,
        enrollInput({ locator: { path: "server/src/Enrollment/enrollment.service.ts", selector: { kind: "file" } } }),
        agent,
        null,
      ),
    "LOCATOR_MISSING",
  );
  mkdirSync(join(repo, "server/alias"));
  symlinkSync(join(repo, "server/src/enrollment"), join(repo, "server/alias/enrollment"));
  assert.equal(
    resolveLocator(repo, { path: "server/alias/enrollment/enrollment.service.ts", selector: { kind: "file" } }).state,
    "resolved",
    "a symlink that stays inside is fine",
  );
  assert.deepEqual(claimFiles(repo), []);

  // A bindings/ directory that is a symlink out of the checkout is never written through.
  symlinkSync(outside, join(repo, VCV_DIR, "bindings"));
  refuses(() => recordBinding(repo, enrollInput(), agent, null), "UNSAFE_PATH");
  assert.deepEqual(readdirSync(outside), ["secret.ts"]);
});

test("model and claims stay readable after reopening, moving the checkout and cloning it elsewhere", () => {
  const repo = courseDesk(true);
  const a = recordBinding(repo, enrollInput(), agent, null);
  const b = recordBinding(
    repo,
    {
      modelObjectId: "cap-enroll",
      relation: "exposes",
      locator: parseLocator(`${CONTROLLER}#route:POST /enrollments`),
    },
    agent,
    null,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "bindings");

  const moved = join(tmp(), "moved");
  renameSync(repo, moved);
  const clone = join(tmp(), "clone");
  execFileSync("git", ["clone", "-q", moved, clone], { env: GIT_ENV });
  for (const where of [moved, clone]) {
    assert.equal(RepositoryProject.open(where).status().state, "ready");
    const vs = verifyBindings(where);
    assert.equal(vs.length, 2);
    assert.deepEqual(
      vs.map((v) => [v.bindingId, v.state]).sort(),
      [
        [a.entry.bindingId, "resolved"],
        [b.entry.bindingId, "resolved"],
      ].sort(),
    );
    const overview = createQueryApi(new FileStoreReader(join(where, VCV_DIR))).getProjectOverview();
    assert.ok(overview.ok);
    assert.equal(overview.context.implementationChecked, false);
  }
  // Deterministic: the same claim made independently in two checkouts at the same commit has the
  // same ID and the same bytes, so Git sees no conflict between them.
  const [x, y] = [courseDesk(), courseDesk()];
  const [cx, cy] = [recordBinding(x, enrollInput(), agent, null), recordBinding(y, enrollInput(), agent, null)];
  assert.equal(cx.entry.bindingId, cy.entry.bindingId);
  assert.equal(read(join(x, cx.entry.file)), read(join(y, cy.entry.file)));
  // Key order in the caller's input does not change the bytes either.
  const z = courseDesk();
  const shuffled = {
    selector: { name: "EnrollmentService.enroll", kind: "symbol" },
    path: SERVICE,
  } as unknown as SourceLocator;
  const cz = recordBinding(
    z,
    {
      confidence: 0.8,
      rationale: "enroll() makes and records the decision",
      locator: shuffled,
      relation: "implements",
      modelObjectId: "cap-enroll",
    },
    agent,
    null,
  );
  assert.equal(read(join(z, cz.entry.file)), read(join(x, cx.entry.file)));
});

test("model freshness is separate from source freshness, and a dispute is shown verbatim, never derived", () => {
  const repo = courseDesk(true);
  const onEnroll = recordBinding(repo, enrollInput(), agent, null);
  const onRule = recordBinding(
    repo,
    { modelObjectId: "rul-seat-limit", relation: "implements", locator: ENROLL },
    agent,
    null,
  );
  const engine = new ModelEngine(new FileStore(join(repo, VCV_DIR)));
  const o = engine.propose(
    {
      changeId: "ch-rename-enroll",
      projectId: "prj-course-desk",
      expectedRevision: "rev-1",
      operations: [{ type: "renameObject", objectId: "cap-enroll", name: "Enroll a student" }],
    },
    { principalId: "user:hoang", permissions: ["model:propose", "model:apply"] },
  );
  assert.equal(o.status, "applied", JSON.stringify(o.diagnostics));

  const v1 = verifyBinding(repo, readBinding(repo, onEnroll.entry.bindingId)!);
  assert.equal(v1.state, "stale");
  assert.equal(v1.model!.state, "changed");
  assert.equal(v1.source!.state, "unchanged", "the code did not change");
  const v2 = verifyBinding(repo, readBinding(repo, onRule.entry.bindingId)!);
  assert.equal(v2.state, "resolved", "an unrelated object change does not make this claim stale");
  assert.equal(v2.model!.state, "unchanged");

  refuses(() => disputeBinding(repo, onRule.entry.bindingId, "no", agent, onRule.entry.digest), "NOT_AUTHORIZED");
  const d = disputeBinding(
    repo,
    onRule.entry.bindingId,
    "seat limit is checked in enroll(), but this is the whole method",
    reviewer,
    onRule.entry.digest,
  );
  const v3 = verifyBinding(repo, readBinding(repo, onRule.entry.bindingId)!);
  assert.deepEqual(v3.disputed, {
    by: "user:hoang",
    reason: "seat limit is checked in enroll(), but this is the whole method",
  });
  assert.equal(v3.state, "resolved", "a dispute is a recorded fact, not a verification result");
  removeBinding(repo, onRule.entry.bindingId, reviewer, d.digest);
  assert.equal(readBinding(repo, onRule.entry.bindingId), null);
});

test("unreadable claim files are listed as invalid, and the model is still served", () => {
  const repo = courseDesk();
  const { entry } = recordBinding(repo, enrollInput(), agent, null);
  const p = join(repo, entry.file);
  const good = read(p);
  writeFileSync(join(repo, VCV_DIR, "bindings", "misnamed.json"), good); // holds another ID's claim
  writeFileSync(p, `<<<<<<< HEAD\n${good}=======\n{}\n>>>>>>> other\n`);
  const entries = listBindings(repo);
  assert.deepEqual(
    entries.map((e) => [e.bindingId, e.claim === null]),
    [
      [entry.bindingId, true],
      ["misnamed", true],
    ],
  );
  assert.match(entries[0]!.problem!, /conflict markers/);
  assert.match(entries[1]!.problem!, /named misnamed\.json but holds claim/);
  assert.equal(verifyBinding(repo, entries[0]!).state, "invalid");
  assert.equal(
    RepositoryProject.open(repo).status().state,
    "ready",
    "a broken claim does not stop the model from being served",
  );
});

test("resolver: fingerprints ignore comments, formatting and line endings, and see decorators", () => {
  const dir = tmp();
  const write = (text: string) => writeFileSync(join(dir, "c.controller.ts"), text);
  const fp = (name = "C.m") =>
    resolveLocator(dir, { path: "c.controller.ts", selector: { kind: "symbol", name } }).selectorFingerprint;
  write(
    'import { Controller, Get } from "@nestjs/common";\n@Controller("c")\nexport class C {\n  /** doc */\n  @Get(":id") m(id: string) { return id; }\n}\n',
  );
  const base = fp();
  write(
    'import { Controller, Get } from "@nestjs/common";\r\n@Controller("c")\r\nexport class C {\r\n  // other comment\r\n  @Get(":id")\r\n  m( id : string ) {\r\n    return id;\r\n  }\r\n}\r\n',
  );
  assert.equal(fp(), base);
  assert.equal(resolveLocator(dir, parseLocator("c.controller.ts#route:GET /c/:id")).state, "resolved");
  write(
    'import { Controller, Get } from "@nestjs/common";\n@Controller("c")\nexport class C {\n  @Get(":key") m(id: string) { return id; }\n}\n',
  );
  assert.notEqual(fp(), base, "a decorator change is a code change");
  write(
    'import { Controller, Get as Fetch } from "@nestjs/common";\n@Controller("c")\nexport class C {\n  @Fetch(":id") m(id: string) { return id; }\n}\n',
  );
  assert.equal(
    resolveLocator(dir, parseLocator("c.controller.ts#route:GET /c/:id")).state,
    "unchecked",
    "aliased decorators are not guessed",
  );
  assert.equal(fileFingerprint(Buffer.from("a\r\nb\n")), fileFingerprint(Buffer.from("a\nb\n")));
  // Tests: describe nesting, .each is not static.
  writeFileSync(
    join(dir, "x.spec.ts"),
    'describe("A", () => { describe("B", () => { it("c", () => {}); }); it.each([1])("d %s", () => {}); });\n',
  );
  assert.equal(resolveLocator(dir, parseLocator("x.spec.ts#test:A > B > c")).state, "resolved");
  assert.equal(resolveLocator(dir, parseLocator("x.spec.ts#test:A > d 1")).state, "unchecked");
  assert.equal(resolveLocator(dir, parseLocator("x.spec.ts#test:A > B")).matches[0]!.declaration, "suite");
  assert.equal(defaultBindingId("Cap Enroll!", "implements", ENROLL).startsWith("implements.cap-enroll."), true);
});

test("the planned controlled changes C1–C3: move, symbol rename and an uncommitted behaviour change are each noticed", () => {
  const repo = courseDesk(true);
  const catalog = recordBinding(
    repo,
    {
      modelObjectId: "dat-course",
      relation: "persists",
      locator: parseLocator("server/src/enrollment/course-catalog.ts#symbol:CourseCatalog"),
    },
    agent,
    null,
  );
  const notify = recordBinding(
    repo,
    {
      modelObjectId: "rul-announce-every-decision",
      relation: "implements",
      locator: parseLocator("server/src/notifications/notifications.service.ts#symbol:NotificationsService.notify"),
    },
    agent,
    null,
  );
  const enroll = recordBinding(repo, enrollInput(), agent, null);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "claims");
  const base = git(repo, "rev-parse", "HEAD");
  const states = () => Object.fromEntries(verifyBindings(repo).map((v) => [v.bindingId, v.state]));

  // C1: move the catalog file (class name unchanged). Reported missing; nothing follows the move.
  mkdirSync(join(repo, "server/src/catalog"));
  git(repo, "mv", "server/src/enrollment/course-catalog.ts", "server/src/catalog/course-catalog.ts");
  assert.deepEqual(states(), {
    [catalog.entry.bindingId]: "missing",
    [notify.entry.bindingId]: "resolved",
    [enroll.entry.bindingId]: "resolved",
  });
  git(repo, "reset", "-q", "--hard", base);

  // C2: rename NotificationsService.notify to send, with its call site in enroll().
  edit(repo, "server/src/notifications/notifications.service.ts", "  notify(recipientId", "  send(recipientId");
  writeFileSync(
    join(repo, SERVICE),
    read(join(repo, SERVICE)).replaceAll("this.notifications.notify(", "this.notifications.send("),
  );
  assert.deepEqual(states(), {
    [catalog.entry.bindingId]: "resolved",
    [notify.entry.bindingId]: "missing",
    [enroll.entry.bindingId]: "stale",
  });
  git(repo, "reset", "-q", "--hard", base);

  // C3: in the working tree only, a full course waitlists. The code changed; whether the model's
  // rule still holds is for the agent or a person to decide, and VCV does not say it does not.
  edit(
    repo,
    SERVICE,
    'status: reason ? "rejected" : "confirmed",',
    'status: reason === "COURSE_FULL" ? "waitlisted" : reason ? "rejected" : "confirmed",',
  );
  const v = verifyBinding(repo, readBinding(repo, enroll.entry.bindingId)!);
  assert.equal(v.state, "stale");
  assert.equal(v.source!.state, "changed");
  assert.equal(v.git.workingTree, "modified");
  assert.equal(git(repo, "rev-parse", "HEAD"), base, "same Git HEAD: detected from file contents");
  assert.equal(v.model!.state, "unchanged");
  assert.equal(v.meaning, "unverified");
  assert.equal(states()[catalog.entry.bindingId], "resolved");
});

test("the scripted Course Desk demonstration runs through the public CLI and leaves .vcv/HEAD unchanged", () => {
  const out = execFileSync("bash", [join(ROOT, "examples/reference-app/bindings/demo.sh"), tmp()], {
    encoding: "utf8",
  });
  assert.match(out, /impl\.cap-enroll: recorded \(resolved/);
  assert.match(out, /✗ LOCATOR_MISSING/);
  assert.match(out, /✗ UNSAFE_PATH/);
  assert.match(out, /✗ LOCATOR_UNCHECKED/);
  assert.match(out, /impl\.cap-enroll: missing/);
  assert.match(out, /✗ BINDING_CHANGED/);
  assert.match(out, /impl\.cap-enroll: reasserted \(resolved/);
  assert.match(out, /model: {3}prj-course-desk at rev-1 \[draft\], 1 revision/);
  assert.match(out, /\.vcv\/HEAD unchanged by every binding operation/);
  assert.doesNotMatch(out, /\/tmp\/|\/home\//, "no machine paths in the recorded sample");
});

test("verify passes only on complete evidence: unknown model or source evidence is indeterminate, and the CLI exits non-zero", () => {
  const repo = courseDesk();
  const { entry } = recordBinding(repo, enrollInput(), agent, null);
  const file = join(repo, entry.file);
  const original = read(file);
  const cli = () =>
    execFileSync(
      "node",
      ["--experimental-strip-types", "--no-warnings", join(ROOT, "apps/cli/src/main.ts"), "binding", "verify", repo],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  const verifyExit = () => {
    try {
      cli();
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };
  assert.equal(verifyBinding(repo, readBinding(repo, entry.bindingId)!).state, "resolved");
  assert.equal(verifyExit(), 0);

  // 1. The project is not ready (HEAD unreadable): the model axis is unknown.
  const headPath = join(repo, VCV_DIR, "HEAD");
  const head = read(headPath);
  writeFileSync(headPath, "{ not json");
  let v = verifyBinding(repo, readBinding(repo, entry.bindingId)!);
  assert.equal(v.locator!.state, "resolved");
  assert.equal(v.model!.state, "unknown");
  assert.equal(v.state, "indeterminate");
  assert.equal(verifyExit(), 1);
  writeFileSync(headPath, head);

  // 2. The claim's revision is not in this checkout's history (e.g. made on another branch).
  writeFileSync(file, original.replace('"modelRevision": "rev-1"', '"modelRevision": "rev-2-0123456789ab"'));
  v = verifyBinding(repo, readBinding(repo, entry.bindingId)!);
  assert.equal(v.model!.state, "unknown");
  assert.equal(v.source!.state, "unchanged");
  assert.equal(v.state, "indeterminate");
  assert.equal(verifyExit(), 1);

  // 3. A fingerprint scheme this VCV does not know: the source axis is unknown.
  writeFileSync(file, original.replace('"algorithm": "vcv-fp-1"', '"algorithm": "vcv-fp-99"'));
  v = verifyBinding(repo, readBinding(repo, entry.bindingId)!);
  assert.equal(v.source!.state, "unknown");
  assert.equal(v.model!.state, "unchanged");
  assert.equal(v.state, "indeterminate");
  assert.equal(verifyExit(), 1);

  // Known change still wins over unknown evidence.
  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity");
  writeFileSync(file, original.replace('"modelRevision": "rev-1"', '"modelRevision": "rev-2-0123456789ab"'));
  assert.equal(verifyBinding(repo, readBinding(repo, entry.bindingId)!).state, "stale");
});

test("claim reads respect the checkout boundary: symlinked directories and entries are not followed, odd entries are invalid, not crashes", () => {
  const repo = courseDesk();
  const { entry } = recordBinding(repo, enrollInput(), agent, null);
  const dir = join(repo, VCV_DIR, "bindings");
  const outside = tmp();
  const secret = join(outside, "secret.json");
  writeFileSync(secret, read(join(repo, entry.file)).replace(entry.bindingId, "stolen"));

  // A claim entry that is a symlink out of the checkout: listed as invalid, never read.
  symlinkSync(secret, join(dir, "stolen.json"));
  // A directory and a FIFO under claim names, and an oversized file.
  mkdirSync(join(dir, "folder.json"));
  execFileSync("mkfifo", [join(dir, "pipe.json")]);
  writeFileSync(join(dir, "huge.json"), " ".repeat(64 * 1024 + 1));
  const entries = Object.fromEntries(listBindings(repo).map((e) => [e.bindingId, e]));
  assert.deepEqual(Object.keys(entries).sort(), [entry.bindingId, "folder", "huge", "pipe", "stolen"].sort());
  assert.ok(entries[entry.bindingId]!.claim);
  assert.match(entries.stolen!.problem!, /is a symlink, which is never followed; it was not read/);
  assert.equal(entries.stolen!.digest, "unsafe:symlink");
  assert.match(entries.folder!.problem!, /is a directory/);
  assert.match(entries.pipe!.problem!, /is not a regular file/);
  assert.match(entries.huge!.problem!, /larger than 65536 bytes/);
  for (const id of ["stolen", "folder", "pipe", "huge"])
    assert.equal(verifyBinding(repo, entries[id]!).state, "invalid");
  assert.equal(readBinding(repo, "stolen")!.claim, null);

  // Writes: a symlinked entry is replaced or removed as a link; the target is untouched.
  refuses(() => recordBinding(repo, enrollInput({ bindingId: "folder" }), agent, "unsafe:directory"), "UNSAFE_PATH");
  refuses(() => removeBinding(repo, "pipe", agent, "unsafe:special"), "UNSAFE_PATH");
  removeBinding(repo, "stolen", agent, "unsafe:symlink");
  assert.ok(existsSync(secret), "removing the link does not remove its target");
  assert.equal(readBinding(repo, "stolen"), null);

  // A symlinked bindings/ directory: every read and write refuses before reading anything.
  const real = join(tmp(), "bindings");
  renameSync(dir, real);
  symlinkSync(outside, dir);
  refuses(() => listBindings(repo), "UNSAFE_PATH");
  refuses(() => readBinding(repo, "secret"), "UNSAFE_PATH");
  refuses(() => verifyBindings(repo), "UNSAFE_PATH");
  refuses(() => recordBinding(repo, enrollInput({ bindingId: "secret" }), agent, null), "UNSAFE_PATH");
  assert.deepEqual(readdirSync(outside), ["secret.json"]);
  assert.equal(RepositoryProject.open(repo).status().state, "ready", "the model is still served");
});

test("large files: selectors are unchecked without parsing, and whole-file fingerprints stream with CRLF split across chunks", () => {
  const dir = tmp();
  const big = `export const a = 1;\n${"// padding\r\n".repeat(100_000)}`;
  writeFileSync(join(dir, "big.ts"), big);
  const r = resolveLocator(dir, parseLocator("big.ts#symbol:a"));
  assert.equal(r.state, "unchecked");
  assert.match(r.detail, /larger than 1000000 bytes/);
  assert.equal(r.fileFingerprint, fileFingerprint(Buffer.from(big)));
  // A CR as the last byte of the first 1 MiB chunk, its LF as the first byte of the next.
  const split = Buffer.concat([
    Buffer.alloc((1 << 20) - 1, 0x61),
    Buffer.from("\r\n\r"),
    Buffer.alloc(10, 0x62),
    Buffer.from("\r"),
  ]);
  writeFileSync(join(dir, "split.bin"), split);
  assert.equal(
    resolveLocator(dir, { path: "split.bin", selector: { kind: "file" } }).fileFingerprint,
    fileFingerprint(split),
  );
});
