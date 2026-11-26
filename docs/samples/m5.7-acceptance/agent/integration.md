# Integration note (agent:coder)

Inputs: the owner's handoff `ui-20261124-164442-4829-v5` (3 operations, base rev-4-d704dd46aee2) and the agent's own draft `agent-draft-notification-docs` (2 operations, same base, never submitted).
Output: one fresh proposal, `chg-full-course-notice`, 7 operations.

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
