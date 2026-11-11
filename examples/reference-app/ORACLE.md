# Course Desk: reviewer oracle

**Evaluation data, not agent input.** This file lists facts about `template/` that a reviewer
can check an agent-built model against (Issue #9, for the M2.3 onboarding run). It is not a
`.vcv/` model or IR, it is not copied into the materialized repository, and it must not be put
in an agent's prompt or context. Every fact names the code and the test that show it, all paths
relative to the fixture root.

## F1. Two server modules, one-way dependency

| # | Fact | Code | Test evidence |
|---|------|------|---------------|
| F1.1 | The app is composed of `EnrollmentModule` and `NotificationsModule` | `server/src/app.module.ts` `AppModule` | `test/app.e2e-spec.ts` (boots `AppModule`) |
| F1.2 | `NotificationsModule` owns `NotificationsController` and `NotificationsService` and **exports** `NotificationsService` | `server/src/notifications/notifications.module.ts` | e2e notifications routes |
| F1.3 | `EnrollmentModule` **imports** `NotificationsModule`; owns `EnrollmentController`, `EnrollmentService`, `CourseCatalog`, `EnrollmentRepository` | `server/src/enrollment/enrollment.module.ts` | `enrollment.service.spec.ts` `setup()` |
| F1.4 | `EnrollmentService` depends on `CourseCatalog`, `EnrollmentRepository` and `NotificationsService` (constructor injection) | `server/src/enrollment/enrollment.service.ts` constructor | `enrollment.service.spec.ts` |
| F1.5 | Notifications does not depend on Enrollment. It knows an enrollment only as the string `enrollmentId` | `server/src/notifications/*` (no import from `../enrollment`) | `notifications.service.spec.ts` constructs it alone |

## F2. HTTP routes (global prefix `/api`)

| # | Route | Handler | Behavior | Test evidence |
|---|-------|---------|----------|---------------|
| F2.1 | `GET /api/courses` | `EnrollmentController.courses` → `EnrollmentService.courses` | Catalog with `seatsLeft = capacity − confirmed enrollments` | e2e "lists the seeded courses" |
| F2.2 | `POST /api/enrollments` | `EnrollmentController.enroll` → `parseEnrollmentRequest`, `EnrollmentService.enroll` | `201` with the decision (confirmed or rejected); `400` bad body; `404` unknown course | e2e "confirms, then rejects…", "answers 400…" |
| F2.3 | `GET /api/enrollments/:id` | `EnrollmentController.get` | One enrollment or `404` | e2e |
| F2.4 | `GET /api/notifications?recipientId=` | `NotificationsController.list` → `NotificationsService.forRecipient` | Recipient's notifications, oldest first; `400` without `recipientId` | e2e |

## F3. Enrollment rules and the notification side effect

| # | Fact | Code | Test evidence |
|---|------|------|---------------|
| F3.1 | Enrollment statuses are only `confirmed` and `rejected`; reasons `COURSE_FULL`, `ALREADY_ENROLLED` | `server/src/enrollment/enrollment.types.ts` | spec + e2e |
| F3.2 | A request is confirmed while the course has seats; it takes a seat | `EnrollmentService.enroll` | spec "confirms an enrollment…" |
| F3.3 | A full course rejects with `COURSE_FULL` | `EnrollmentService.enroll` | spec "rejects … full course", e2e |
| F3.4 | A student already confirmed in the course is rejected with `ALREADY_ENROLLED` (checked before capacity) and no seat is taken | `EnrollmentService.enroll` | spec "rejects a repeat enrollment…" |
| F3.5 | **Every** recorded decision sends exactly one notification to the student: `enrollment-confirmed` or `enrollment-rejected` | `EnrollmentService.enroll` → `NotificationsService.notify` | spec + e2e notification assertions |
| F3.6 | An unknown course is refused with `404`: nothing is recorded and nobody is notified | `EnrollmentService.enroll` (`NotFoundException`) | spec "refuses an unknown course…" |
| F3.7 | Rejection is a recorded outcome (`201`), not an HTTP error | `EnrollmentController.enroll` `@HttpCode(201)` | e2e |
| F3.8 | Seeded catalog: `crs-algebra` Linear Algebra (2 seats), `crs-poetry` Modern Poetry (1 seat) | `server/src/enrollment/course-catalog.ts` `SEED_COURSES` | e2e "lists the seeded courses" |
| F3.9 | Storage is in memory (`EnrollmentRepository`, notification outbox array); IDs are sequential `enr-N`, `ntf-N` | `enrollment.repository.ts`, `notifications.service.ts` | spec + e2e IDs |

## F4. Web client

| # | Fact | Code | Test evidence |
|---|------|------|---------------|
| F4.1 | `App` renders `EnrollmentForm` and, after an enrollment, `NotificationList` for that student | `web/src/App.tsx` | `web/src/App.test.tsx` "shows the outcome…" |
| F4.2 | After enrolling, the UI re-reads the student's notifications and the course list (the notification is how the outcome reaches the user) | `App.enroll` | `App.test.tsx` |
| F4.3 | The client calls `GET /api/courses`, `POST /api/enrollments`, `GET /api/notifications` (never `GET /api/enrollments/:id`) | `web/src/api/client.ts` `httpApi` | `App.test.tsx` "posts enrollments as JSON…" |
| F4.4 | The client's data types duplicate the server contracts by hand (no shared package) | `web/src/api/client.ts` vs `server/src/**/*.types.ts` | n/a (structure) |
| F4.5 | In development Vite proxies `/api` to the Nest server on port 3000 | `web/vite.config.ts` | n/a (config) |

## F5. Absent on purpose (an accurate model does not claim these)

No database, authentication, roles or users beyond a free-text `studentId`; no message queue or
external notification channel (email, push); no `pending`/approval/waitlist state; no
withdrawal or cancellation; no course administration. Notifications are not read/unread.

## Planned controlled changes (for M2.4/M2.5, not applied)

Each starts from the baseline commit and changes one thing a binding should notice:

- **C1 rename/move**: move `server/src/enrollment/course-catalog.ts` to
  `server/src/catalog/course-catalog.ts` (class name unchanged).
- **C2 symbol rename**: rename `NotificationsService.notify` to `send` (call site in
  `EnrollmentService.enroll`).
- **C3 uncommitted behavior change**: in the working tree only, change `EnrollmentService.enroll`
  so a full course waitlists instead of rejecting (F3.3 no longer true; the model is now stale).
