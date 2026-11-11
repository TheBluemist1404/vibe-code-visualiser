# Course Desk

Students enroll in courses; every enrollment decision is announced to the student as a
notification.

- `server/`: NestJS API with in-memory storage.
- `web/`: React (Vite) single page.

Requires Node 22.22.2 or later (a jsdom requirement of the web tests). There are no external services, databases or accounts.

## Commands

```sh
npm ci              # install both workspaces from package-lock.json
npm run typecheck
npm test            # server unit + HTTP tests, web component tests (Vitest)
npm run build       # server → server/dist, web → web/dist
npm start           # API on http://localhost:3000/api (PORT to change)
npm run dev:web     # UI on http://localhost:5173, proxies /api to port 3000
npm run smoke       # after build: starts the API on a free port and walks the main flow
```

## HTTP API

All routes are under `/api`. Data is kept in memory and resets on restart; IDs are
sequential (`enr-1`, `ntf-1`, …).

| Route | Result |
|-------|--------|
| `GET /courses` | The course catalog with remaining seats |
| `POST /enrollments` `{ "studentId", "courseId" }` | `201` with the recorded enrollment: `confirmed`, or `rejected` with a reason. `400` for a malformed body, `404` for an unknown course |
| `GET /enrollments/:id` | One enrollment, `404` if unknown |
| `GET /notifications?recipientId=…` | Notifications for one recipient, oldest first; `400` without `recipientId` |

## Expected behavior

Two courses are seeded: Linear Algebra (2 seats) and Modern Poetry (1 seat).

1. `stu-ada` enrolls in Modern Poetry: `confirmed`; Modern Poetry has 0 seats left.
2. `stu-bob` enrolls in Modern Poetry: `rejected` with reason `COURSE_FULL`.
3. `stu-ada` has one notification (`enrollment-confirmed`), `stu-bob` one
   (`enrollment-rejected`).
4. Enrolling again in a course you already hold is `rejected` with `ALREADY_ENROLLED` and does
   not take a seat.

In the UI, choose a student ID and a course and press **Enroll**: the page shows the outcome,
the student's notifications and the updated seat counts.
