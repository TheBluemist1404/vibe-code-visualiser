// The coding agent's integration of the owner's handoff with its own working draft (M5.7, Issue
// #46). Recorded work of the agent, replayed: VCV merges nothing; this file is the agent's merge.
//
//   node integrate.mjs <handoff change.json> <own-draft.json> <proposal.json> <integration.md>
//
// Decisions (each one is the agent's, written down in <integration.md>):
//  1. The owner's operations are taken verbatim and first, in the owner's order.
//  2. Labels that would contradict them are corrected (the lesson of M4.5's withdrawn proposal):
//     the criterion's name still says a rejection is not announced, and the project description
//     says only a confirmation is.
//  3. From its own draft, the agent keeps the repeat-request criterion (now load-bearing: the
//     new rule says a repeat request is not notified) and rewrites the Notification description
//     for the new behaviour instead of its rev-4 wording.
//  4. One fresh change ID; the owner's exported ID (ui-<draft>-v<n>) is not reused, because the
//     submitted content is not the exported content.
import { readFileSync, writeFileSync } from "node:fs";

const [handoffFile, ownFile, proposalFile, notesFile] = process.argv.slice(2);
const handoff = JSON.parse(readFileSync(handoffFile, "utf8"));
const own = JSON.parse(readFileSync(ownFile, "utf8"));

// The agent reviews what it was handed before using it.
const expected = [
  "setRuleStatement:rul-announce-every-decision",
  "renameObject:rul-announce-every-decision",
  "reviseCriterion:crt-rejection-notified",
];
const got = handoff.operations.map((o) => `${o.type}:${o.ruleId ?? o.objectId ?? o.criterionId}`);
if (JSON.stringify(got) !== JSON.stringify(expected)) {
  console.error(
    `integrate: the handoff is not the one this recorded integration was written for:\n  ${got.join("\n  ")}`,
  );
  process.exit(3);
}
if (handoff.expectedRevision !== own.expectedRevision) {
  console.error("integrate: the handoff and the agent's draft are on different bases; re-plan instead of merging");
  process.exit(3);
}

const ownRepeat = own.operations.find((o) => o.type === "reviseCriterion" && o.criterionId === "crt-repeat-rejected");
const proposal = {
  changeId: "chg-full-course-notice",
  projectId: handoff.projectId,
  expectedRevision: handoff.expectedRevision,
  rationale: `${handoff.rationale} Integrated by agent:coder from the owner's UI handoff and its own draft; labels aligned so no name or description still says a full-course rejection is not announced.`,
  operations: [
    ...handoff.operations,
    { type: "renameObject", objectId: "crt-rejection-notified", name: "A full-course rejection is announced" },
    ownRepeat,
    {
      type: "setDescription",
      objectId: "dat-notification",
      description:
        "notification.types.ts, in-memory outbox; ids ntf-N. kind is enrollment-confirmed (a confirmed enrollment) or enrollment-rejected (a rejection because the course is full). enrollmentId points at an Enrollment in another module, so it is typed id rather than reference.",
    },
    {
      type: "setDescription",
      objectId: "prj-course-desk",
      description:
        "Draft bootstrapped from the repository at commit adb423c; not reviewed. Students enroll in courses; every enrollment decision is recorded, and a confirmation or a rejection because the course is full is announced as a notification. NestJS API (server/, in-memory storage) plus a React page (web/). Based on README.md and the sources.",
    },
  ],
  // What the agent will be asked to build once a reviewer approves; covered by the digest.
  implementation: {
    behavior:
      "enroll() keeps recording every decision. A confirmed enrollment still sends one enrollment-confirmed notification. A rejection because the course is full now also sends exactly one enrollment-rejected notification to that student, with the message '<course> is full; your enrollment was not accepted.'. A repeat request (ALREADY_ENROLLED) sends none. The HTTP API and the web page are unchanged; the page already lists whatever notifications the API returns.",
    acceptanceCriteria: [
      "A COURSE_FULL rejection produces exactly one enrollment-rejected notification for that enrollment",
      "A confirmed enrollment still produces exactly one enrollment-confirmed notification",
      "An ALREADY_ENROLLED rejection produces no notification and takes no seat",
      "GET /api/notifications returns the rejected student's enrollment-rejected entry",
    ],
    suggestedTests: [
      "server/src/enrollment/enrollment.service.spec.ts: full-course and repeat-request cases",
      "server/test/app.e2e-spec.ts: the confirm-then-full flow over HTTP",
    ],
    scope: ["server/src/enrollment/**", "server/test/**", "README.md", "scripts/smoke.mjs"],
  },
};
writeFileSync(proposalFile, `${JSON.stringify(proposal, null, 2)}\n`);
writeFileSync(
  notesFile,
  `# Integration note (agent:coder)

Inputs: the owner's handoff \`${handoff.changeId}\` (${handoff.operations.length} operations, base ${handoff.expectedRevision}) and the agent's own draft \`${own.changeId}\` (${own.operations.length} operations, same base, never submitted).
Output: one fresh proposal, \`${proposal.changeId}\`, ${proposal.operations.length} operations.

| From | Operation | Decision |
| ---- | --------- | -------- |
| owner | setRuleStatement rul-announce-every-decision | kept verbatim |
| owner | renameObject rul-announce-every-decision | kept verbatim |
| owner | reviseCriterion crt-rejection-notified | kept verbatim |
| agent | renameObject crt-rejection-notified | added: its name still said "is not announced" |
| agent draft | reviseCriterion crt-repeat-rejected | kept: the new rule makes "no notification for a repeat" checkable |
| agent draft | setDescription dat-notification | rewritten: its rev-4 wording ("declared, not sent") is false after this change |
| agent | setDescription prj-course-desk | added: it said only a confirmation is announced |

Code, tests, README and the smoke script change in the implementation step, after approval. Nothing here is approved.
`,
);
console.log(`integrate: ${proposal.changeId} with ${proposal.operations.length} operations`);
