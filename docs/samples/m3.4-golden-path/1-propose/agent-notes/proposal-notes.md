# Proposal notes: chg-notification-rejection-reason

## Source observed
- `server/src/enrollment/enrollment.types.ts`: `Enrollment.reason?: RejectionReason` ("COURSE_FULL" | "ALREADY_ENROLLED"), set only when rejected.
- `server/src/enrollment/enrollment.service.ts` `enroll()`: computes `reason`, saves the enrollment, then calls `notifications.notify(studentId, "enrollment-rejected", enrollment.id, <message text>)`. The reason is passed only as message text.
- `server/src/notifications/notification.types.ts`: `Notification` has `id, recipientId, kind, message, enrollmentId`, with no reason field.
- `server/src/notifications/notifications.service.ts`: `notify(recipientId, kind, enrollmentId, message)` takes no reason. `notifications.controller.ts` returns the stored objects as they are.
- `web/src/api/client.ts` mirrors `Notification` with no reason. `web/src/components/NotificationList.tsx` renders only `n.message` (plus `data-kind`).
- The model already has `att-enr-reason` on `dat-enrollment`. `dat-notification` has no reason attribute. `mod-notifications` has no dependencies.
- Evidence: 8 of 8 binding claims resolved before this proposal.

## Agent inferred
- The only data-shape change is a nullable `reason` attribute on `dat-notification`. I typed it `string`, like `att-enr-reason`, because `mod-notifications` does not depend on `mod-enrollment`, so a reference or shared type would add a dependency.
- I updated the `rul-announce-every-decision` statement. A rejection notification now carries the reason as its own field, and the rule still says one notification per decision.
- I updated the descriptions of `dat-notification` and `cap-use-ui` so the model records the reason and the page showing it.
- Left unchanged on purpose:
  - `dat-enrollment` and `rul-seat-limit`.
  - Module dependencies, events and contracts.
  - Capabilities (no new one; the existing list-notifications and enroll capabilities cover this).
  - Confirmed enrollments and their notifications.
  - The existing message texts.
- Confidence is high on the data and rule change. Describing the web behavior in `cap-use-ui`'s description is a judgment call, because there is no UI-specific model object for it.

## VCV validated
- Dry run: `proposal chg-notification-rejection-reason (not submitted: dry run)`, `base: rev-2-a21d7aa4915e; this checkout is at rev-2-a21d7aa4915e (applies)`, with no errors or warnings.
- The delta has 4 objects: `+ attribute att-ntf-reason`, `~ dat-notification`, `~ rul-announce-every-decision`, `~ cap-use-ui`.
- Impact: `CROSS-MODULE`. mod-enrollment, mod-notifications and mod-web are each marked changed. No contracts.
- Binding claims to revisit (2): `impl.rul-announce-every-decision` and `persist.dat-notification`.
- Submit: `chg-notification-rejection-reason: pending (recorded); .vcv/HEAD stays at rev-2-a21d7aa4915e`.
- Digest: `eb632d5c7f6ca1653af3eb93e5b2d86d710ad9d639d288d2b8a9f30fd41c8f68`.
- Submitting added the untracked record `.vcv/changes/chg-notification-rejection-reason.json`. I did not commit it.

## Needs a person
- Review and approve (or reject) the pending proposal and its implementation request. VCV did not compare the code with it.
- After implementation, reassert the two claims above. `impl.rul-announce-every-decision` and `test.rul-seat-limit` point at the same code, so check whether the test claim also needs a look.
- Open question: should `reason` be absent or null on confirmed notifications? I proposed "absent" (nullable optional), as `Enrollment.reason` is today.
- Open question: how the page should display the reason (raw code or a friendlier label). I left this to the implementation; the criteria only require that the reason is shown next to a rejected notification.
- I did not run any tests or change any source, tests, claims or `.vcv/` files by hand.
