# Reviewer decision (simulated reviewer)

**Who.** `user:reviewer`, simulated: the reviewer's key is a file on the same machine as the agents (outside the checkout and denied to their tools), and the decision was made by the operator of this run (a Claude Code session that did not take part in either agent session). This demonstrates the review protocol and its checks, not a production trust boundary (docs/approvals.md).

**What was reviewed.** `preview-reviewed.txt`, proposal digest `eb632d5c7f6ca1653af3eb93e5b2d86d710ad9d639d288d2b8a9f30fd41c8f68`, against `request.md`.

**Assessment.**

- The operations match the request: a nullable `reason` attribute on `dat-notification` (owned by Notifications), the rule `rul-announce-every-decision` (Enrollment) now says a rejection notification carries the reason, and `cap-use-ui` (Web) says the page shows it. The impact is cross-module (Enrollment, Notifications, Web), as expected for this request.
- Keeping `reason` a plain string in Notifications, so that `mod-notifications` gains no dependency on Enrollment, is the right call: the code's Notifications module does not import Enrollment today.
- The implementation request is specific and testable. Its criteria cover both rejection reasons, unchanged confirmed notifications, the HTTP response, the page, and the absence of a new module dependency.
- Reservation: the scope lists `web/src/components/NotificationList.tsx` but not `web/src/App.tsx`. If the page change needs `App.tsx`, the implementation report must show it as out of scope. That is acceptable, because it is reported rather than hidden.
- No diagnostics; the proposal applies to the current revision.

**Decision.** Approve exactly this digest.
