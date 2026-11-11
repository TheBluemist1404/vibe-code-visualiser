# VCV maintenance report: ch-maint-01

Model `prj-course-desk` at `rev-1` [draft]; code at `a580bd7` plus uncommitted changes.

## Source observed
- Uncommitted changes add a **waitlist** (no commits since the model was drafted).
- `server/src/enrollment/enrollment.service.ts` `enroll()`: a request for a full course is saved as `waitlisted` with `waitlistPosition = waitlisted count + 1`, takes no seat, and sends an `enrollment-waitlisted` notification ("… you are number N on the waitlist."). `COURSE_FULL` is no longer produced.
- A repeat request is rejected with `ALREADY_ENROLLED` (checked first) or the new `ALREADY_WAITLISTED`; both are checked before capacity.
- `enrollment.types.ts`: `EnrollmentStatus` gains `waitlisted`; `RejectionReason` is now `ALREADY_ENROLLED | ALREADY_WAITLISTED`; `Enrollment.waitlistPosition?` added. `notification.types.ts`: `NotificationKind` gains `enrollment-waitlisted`. `enrollment.repository.ts`: `waitlistedFor()`.
- Unit spec, e2e spec, `scripts/smoke.mjs` and README all describe the same behaviour as the code. The spec test for the full course was renamed ("waitlists an enrollment into a full course in request order…"), and a new test covers `ALREADY_WAITLISTED`.
- No promotion from the waitlist exists; README says enrollments cannot be cancelled.
- I did not inspect the `web/` diff for model impact (`App.tsx`, `client.ts`, `App.test.tsx` also changed).

## Agent inferred
- `rul-seat-limit` statement was false (it says COURSE_FULL rejection). Updated, high confidence.
- `rul-announce-every-decision` said "confirmed or rejected"; now three outcomes. High confidence.
- New rule `rul-no-double-waitlist` for ALREADY_WAITLISTED. I added a separate rule rather than widen `rul-no-double-enroll`, which stays true as written. Medium-high confidence on this modelling choice.
- Descriptions of `cap-enroll`, `dat-enrollment`, `dat-notification` updated; attribute `att-enr-waitlist-position` (integer, nullable) added.
- `status` and `kind` attributes are typed `string`, so no attribute change is needed there.
- Overall confidence: high that the model is now accurate for the server; the web module is unreviewed.

## VCV validated
- `vcv propose`: `ch-maint-01: pending (proposed by agent:maintainer; record is pending)`.
- Before: 2 resolved, 5 stale, 1 missing (of 8). Stale: `impl.cap-enroll`, `impl.rul-no-double-enroll`, `impl.rul-seat-limit`, `persist.dat-enrollment`, `persist.dat-notification`. Missing: `test.rul-seat-limit` (the test title was renamed).
- After proposing, `refresh --since <token>` reported `changedSince: false` with identical counts, as expected for a pending proposal.

## Needs a person
- Review and approve or reject `ch-maint-01`.
- After approval, re-record or reassert the 5 stale claims once the code is reviewed.
- Repoint `test.rul-seat-limit` to the renamed test (`EnrollmentService > waitlists an enrollment into a full course in request order and notifies the student`); VCV does not follow renames. Consider adding a test claim for `rul-no-double-waitlist`, and an `impl` claim for it on `EnrollmentService.enroll`.
- Check whether the `web/` changes need model updates (e.g. `cap-use-ui` or `mod-web` descriptions).
- Decide whether waitlist promotion is a wanted behaviour; it is absent from code and so from the model.
- Note: `.vcv/changes/` now holds the pending record (written by VCV, not by me).
