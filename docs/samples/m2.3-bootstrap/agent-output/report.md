# VCV bootstrap report: Course Desk

Draft model: `vcv-bootstrap/model.yaml` (rev-1, draft). Nothing is committed.

## Modules
| Module | Based on | Confidence |
|---|---|---|
| Enrollment | server/src/enrollment/*.ts (module, service, controller, repository, types, catalog) | High |
| Notifications | server/src/notifications/*.ts | High |
| Web | web/src/App.tsx, api/client.ts, components/ | High on content; the dependsOn edges are HTTP-level, not imports (judgement call) |

## Elements
- Capabilities: list courses, enroll, get enrollment, list notifications, use UI. Routes are from the controllers and README. High confidence.
- Data: Course, Enrollment, Notification. High confidence. Status, reason and kind are typed `string` because the schema has no enum type; their allowed values are in the descriptions.
- Rules: capacity limit, no double enrollment, every decision notified (policy), request validation, recipientId required. High confidence. Each is from enrollment.service.ts, enrollment.types.ts or notifications.controller.ts.
- Actor: Student. Medium confidence. The code has no auth or roles, only a free-form studentId.

## Open questions
- Is "Student" a real actor, given that there is no authentication? Capability initiators are inferred.
- Should Web depend on the server modules at all, given that it only calls their HTTP routes?

## Left out, deliberately
- Events, contracts and behaviors. Enrollment calls NotificationsService directly, so no published interface exists. An enrollment state machine is not modelled because enrollments are immutable once saved.
- Permission rules. There is no authorization in the code.
- The bootstrap/infra pieces: main.ts, app.setup.ts (global `api` prefix, CORS), scripts/smoke.mjs, build config.
- The test files were not read in detail (enrollment.service.spec.ts, notifications.service.spec.ts, test/app.e2e-spec.ts, web/src/App.test.tsx). The model is derived from the sources and README. I did not run the tests.
