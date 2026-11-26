// The coding agent's implementation of the approved chg-full-course-notice (M5.7, Issue #46).
// Recorded work of the agent, replayed in its own clone: exact, single-match edits of real Course
// Desk source, tests, README and smoke script. CRLF files keep CRLF.
//
//   node implement.mjs <checkout>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: implement.mjs <checkout>");
function edit(file, before, after) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const crlf = text.includes("\r\n");
  const [a, b] = crlf ? [before.replace(/\n/g, "\r\n"), after.replace(/\n/g, "\r\n")] : [before, after];
  if (text.split(a).length !== 2) throw new Error(`implement: not exactly one match in ${file}:\n${before}`);
  writeFileSync(
    path,
    text.replace(a, () => b),
  );
}

const svc = "server/src/enrollment/enrollment.service.ts";
edit(
  svc,
  ` * Enrollment rules. Each decision is recorded; only a confirmed one is announced to the student:
 * a confirmed enrollment takes a seat; a full course or a repeat request is rejected.`,
  ` * Enrollment rules. Each decision is recorded. A confirmed enrollment takes a seat and is announced;
 * a full course is rejected and announced; a repeat request is rejected without a notification.`,
);
edit(
  svc,
  `    // Only confirmations are announced; the response already tells the student about a rejection.
    if (!reason) {
      this.notifications.notify(enrollment.studentId, "enrollment-confirmed", enrollment.id, \`You are enrolled in \${course.title}.\`);
    }`,
  `    // A confirmation and a full course are announced. A repeat request is not: the student already holds the seat.
    if (!reason) {
      this.notifications.notify(enrollment.studentId, "enrollment-confirmed", enrollment.id, \`You are enrolled in \${course.title}.\`);
    } else if (reason === "COURSE_FULL") {
      this.notifications.notify(enrollment.studentId, "enrollment-rejected", enrollment.id, \`\${course.title} is full; your enrollment was not accepted.\`);
    }`,
);

const spec = "server/src/enrollment/enrollment.service.spec.ts";
edit(
  spec,
  `  it("rejects an enrollment into a full course without notifying the student", async () => {
    const { enrollment, notifications } = await setup();
    enrollment.enroll({ studentId: "stu-ada", courseId: "crs-poetry" });
    const e = enrollment.enroll({ studentId: "stu-bob", courseId: "crs-poetry" });
    expect(e).toMatchObject({ status: "rejected", reason: "COURSE_FULL" });
    expect(notifications.forRecipient("stu-bob")).toEqual([]);
  });`,
  `  it("rejects an enrollment into a full course and notifies the student", async () => {
    const { enrollment, notifications } = await setup();
    enrollment.enroll({ studentId: "stu-ada", courseId: "crs-poetry" });
    const e = enrollment.enroll({ studentId: "stu-bob", courseId: "crs-poetry" });
    expect(e).toMatchObject({ id: "enr-2", status: "rejected", reason: "COURSE_FULL" });
    expect(notifications.forRecipient("stu-bob")).toEqual([
      { id: "ntf-2", recipientId: "stu-bob", kind: "enrollment-rejected", enrollmentId: "enr-2", message: "Modern Poetry is full; your enrollment was not accepted." },
    ]);
  });`,
);
edit(
  spec,
  `  it("rejects a repeat enrollment without taking a second seat", async () => {
    const { enrollment } = await setup();
    enrollment.enroll({ studentId: "stu-ada", courseId: "crs-algebra" });
    expect(enrollment.enroll({ studentId: "stu-ada", courseId: "crs-algebra" })).toMatchObject({ status: "rejected", reason: "ALREADY_ENROLLED" });
    expect(enrollment.courses().find((c) => c.id === "crs-algebra")?.seatsLeft).toBe(1);
  });`,
  `  it("rejects a repeat enrollment without taking a second seat or notifying the student", async () => {
    const { enrollment, notifications } = await setup();
    enrollment.enroll({ studentId: "stu-ada", courseId: "crs-algebra" });
    expect(enrollment.enroll({ studentId: "stu-ada", courseId: "crs-algebra" })).toMatchObject({ status: "rejected", reason: "ALREADY_ENROLLED" });
    expect(enrollment.courses().find((c) => c.id === "crs-algebra")?.seatsLeft).toBe(1);
    expect(notifications.forRecipient("stu-ada").map((n) => n.kind)).toEqual(["enrollment-confirmed"]);
  });`,
);

const e2e = "server/test/app.e2e-spec.ts";
edit(
  e2e,
  `  it("confirms, then rejects when full; only the confirmed student is notified", async () => {`,
  `  it("confirms, then rejects when full; each student is notified of their outcome", async () => {`,
);
edit(
  e2e,
  `    expect(bob.body).toEqual([]);`,
  `    expect(bob.body).toEqual([
      { id: "ntf-2", recipientId: "stu-bob", kind: "enrollment-rejected", enrollmentId: "enr-2", message: "Modern Poetry is full; your enrollment was not accepted." },
    ]);`,
);

edit(
  "README.md",
  `Students enroll in courses; every enrollment decision is recorded, and a confirmed one is
announced to the student as a notification.`,
  `Students enroll in courses; every enrollment decision is recorded. A confirmation, or a rejection
because the course is full, is announced to the student as a notification.`,
);
edit(
  "README.md",
  `3. \`stu-ada\` has one notification (\`enrollment-confirmed\`); \`stu-bob\` has none, since the
   enrollment response already says the request was rejected.
4. Enrolling again in a course you already hold is \`rejected\` with \`ALREADY_ENROLLED\` and does
   not take a seat.`,
  `3. \`stu-ada\` has one notification (\`enrollment-confirmed\`); \`stu-bob\` has one
   (\`enrollment-rejected\`: Modern Poetry is full).
4. Enrolling again in a course you already hold is \`rejected\` with \`ALREADY_ENROLLED\`, does
   not take a seat and sends no notification.`,
);
edit(
  "scripts/smoke.mjs",
  `  assert.deepEqual(results[4].body, []); // a rejection is not announced`,
  `  assert.deepEqual(results[4].body.map((n) => n.kind), ["enrollment-rejected"]); // a full course is announced`,
);
console.log("implement: 5 files edited");
