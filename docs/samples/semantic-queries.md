# Semantic Query API: sample results

Generated from `examples/enrollment/model.rev-1.yaml` with the CLI (`npm run vcv -- query <store> ...`). The scenario: an agent is asked to *notify students when an enrollment is rejected*.

## overview

```sh
vcv query <store> overview
```

```json
{
  "ok": true,
  "context": {
    "projectId": "prj-lms",
    "modelRevision": "rev-1",
    "snapshotStatus": "approved",
    "source": "canonical-ir",
    "coverage": "model-only",
    "implementationChecked": false
  },
  "data": {
    "project": {
      "id": "prj-lms",
      "name": "LMS",
      "schemaVersion": "0.2"
    },
    "modules": [
      {
        "id": "mod-enrollment",
        "kind": "module",
        "name": "Enrollment",
        "moduleId": "mod-enrollment",
        "parentId": "prj-lms",
        "irPath": "modules[0]",
        "purpose": "Manage enrollment reviews",
        "dependsOn": [],
        "consumes": [],
        "exposes": [
          "ctr-enrollment-events",
          "ctr-enrollment-review"
        ],
        "owned": {
          "attribute": 2,
          "behavior": 1,
          "capability": 1,
          "contract": 2,
          "data": 1,
          "event": 3,
          "rule": 2,
          "state": 3,
          "transition": 2
        }
      },
      {
        "id": "mod-notifications",
        "kind": "module",
        "name": "Notifications",
        "moduleId": "mod-notifications",
        "parentId": "prj-lms",
        "irPath": "modules[1]",
        "purpose": "Tell people about things that happened to them",
        "dependsOn": [
          "mod-enrollment"
        ],
        "consumes": [
          "ctr-enrollment-events"
        ],
        "exposes": [],
        "owned": {
          "behavior": 1,
          "capability": 1,
          "state": 2,
          "transition": 1
        }
      }
    ],
    "inventory": {
      "actor": 2,
      "attribute": 2,
      "behavior": 2,
      "capability": 2,
      "contract": 2,
      "data": 1,
      "event": 3,
      "module": 2,
      "rule": 2,
      "state": 5,
      "transition": 3
    },
    "validation": {
      "errors": 0,
      "warnings": 0
    }
  },
  "diagnostics": []
}
```

## search: find the modules

```sh
vcv query <store> search enrollment notifications --kind module
```

```json
{
  "ok": true,
  "context": {
    "projectId": "prj-lms",
    "modelRevision": "rev-1",
    "snapshotStatus": "approved",
    "source": "canonical-ir",
    "coverage": "model-only",
    "implementationChecked": false
  },
  "data": {
    "hits": [
      {
        "id": "mod-enrollment",
        "kind": "module",
        "name": "Enrollment",
        "moduleId": "mod-enrollment",
        "parentId": "prj-lms",
        "irPath": "modules[0]",
        "score": 36,
        "matchedFields": [
          "id",
          "name",
          "purpose"
        ]
      },
      {
        "id": "mod-notifications",
        "kind": "module",
        "name": "Notifications",
        "moduleId": "mod-notifications",
        "parentId": "prj-lms",
        "irPath": "modules[1]",
        "score": 30,
        "matchedFields": [
          "id",
          "name"
        ]
      }
    ],
    "total": 2,
    "truncated": false
  },
  "diagnostics": []
}
```

## search: the user's own words

```sh
vcv query <store> search notify rejected enrollment --limit 5
```

```json
{
  "ok": true,
  "context": {
    "projectId": "prj-lms",
    "modelRevision": "rev-1",
    "snapshotStatus": "approved",
    "source": "canonical-ir",
    "coverage": "model-only",
    "implementationChecked": false
  },
  "data": {
    "hits": [
      {
        "id": "cap-notify-rejection",
        "kind": "capability",
        "name": "Notify student of rejected enrollment",
        "moduleId": "mod-notifications",
        "parentId": "mod-notifications",
        "irPath": "capabilities[1]",
        "score": 46,
        "matchedFields": [
          "id",
          "name"
        ]
      },
      {
        "id": "evt-enrollment-rejected",
        "kind": "event",
        "name": "Enrollment rejected",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "events[2]",
        "score": 40,
        "matchedFields": [
          "id",
          "name"
        ]
      },
      {
        "id": "mod-enrollment",
        "kind": "module",
        "name": "Enrollment",
        "moduleId": "mod-enrollment",
        "parentId": "prj-lms",
        "irPath": "modules[0]",
        "score": 36,
        "matchedFields": [
          "id",
          "name",
          "purpose"
        ]
      },
      {
        "id": "ctr-enrollment-events",
        "kind": "contract",
        "name": "Enrollment events",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "contracts[1]",
        "score": 20,
        "matchedFields": [
          "id",
          "name"
        ]
      },
      {
        "id": "ctr-enrollment-review",
        "kind": "contract",
        "name": "Review enrollment",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "contracts[0]",
        "score": 20,
        "matchedFields": [
          "id",
          "name"
        ]
      }
    ],
    "total": 14,
    "truncated": true,
    "nextCursor": "rev-1:5"
  },
  "diagnostics": []
}
```

## context: inspect the rejection event

```sh
vcv query <store> context evt-enrollment-rejected --depth 2
```

```json
{
  "ok": true,
  "context": {
    "projectId": "prj-lms",
    "modelRevision": "rev-1",
    "snapshotStatus": "approved",
    "source": "canonical-ir",
    "coverage": "model-only",
    "implementationChecked": false
  },
  "data": {
    "focus": {
      "id": "evt-enrollment-rejected",
      "kind": "event",
      "name": "Enrollment rejected",
      "moduleId": "mod-enrollment",
      "parentId": "mod-enrollment",
      "irPath": "events[2]",
      "record": {
        "id": "evt-enrollment-rejected",
        "kind": "event",
        "owner": "mod-enrollment",
        "name": "Enrollment rejected"
      }
    },
    "nodes": [
      {
        "id": "mod-enrollment",
        "kind": "module",
        "name": "Enrollment",
        "moduleId": "mod-enrollment",
        "parentId": "prj-lms",
        "irPath": "modules[0]",
        "distance": 1
      },
      {
        "id": "ctr-enrollment-events",
        "kind": "contract",
        "name": "Enrollment events",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "contracts[1]",
        "distance": 1
      },
      {
        "id": "tr-reject",
        "kind": "transition",
        "name": "tr-reject",
        "moduleId": "mod-enrollment",
        "parentId": "beh-enrollment-approval",
        "irPath": "behaviors[0].transitions[1]",
        "distance": 1
      },
      {
        "id": "tr-send-notice",
        "kind": "transition",
        "name": "tr-send-notice",
        "moduleId": "mod-notifications",
        "parentId": "beh-rejection-notice",
        "irPath": "behaviors[1].transitions[0]",
        "distance": 1
      },
      {
        "id": "mod-notifications",
        "kind": "module",
        "name": "Notifications",
        "moduleId": "mod-notifications",
        "parentId": "prj-lms",
        "irPath": "modules[1]",
        "distance": 2
      },
      {
        "id": "st-pending",
        "kind": "state",
        "name": "Pending",
        "moduleId": "mod-enrollment",
        "parentId": "beh-enrollment-approval",
        "irPath": "behaviors[0].states[0]",
        "distance": 2
      },
      {
        "id": "rule-review-permission",
        "kind": "rule",
        "name": "rule-review-permission",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "rules[0]",
        "distance": 2
      },
      {
        "id": "st-rejected",
        "kind": "state",
        "name": "Rejected",
        "moduleId": "mod-enrollment",
        "parentId": "beh-enrollment-approval",
        "irPath": "behaviors[0].states[2]",
        "distance": 2
      },
      {
        "id": "evt-rejection-submitted",
        "kind": "event",
        "name": "Rejection submitted",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "events[1]",
        "distance": 2
      },
      {
        "id": "beh-enrollment-approval",
        "kind": "behavior",
        "name": "Enrollment approval",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "behaviors[0]",
        "distance": 2
      },
      {
        "id": "st-notice-waiting",
        "kind": "state",
        "name": "Waiting",
        "moduleId": "mod-notifications",
        "parentId": "beh-rejection-notice",
        "irPath": "behaviors[1].states[0]",
        "distance": 2
      },
      {
        "id": "st-notice-sent",
        "kind": "state",
        "name": "Sent",
        "moduleId": "mod-notifications",
        "parentId": "beh-rejection-notice",
        "irPath": "behaviors[1].states[1]",
        "distance": 2
      },
      {
        "id": "beh-rejection-notice",
        "kind": "behavior",
        "name": "Rejection notice",
        "moduleId": "mod-notifications",
        "parentId": "mod-notifications",
        "irPath": "behaviors[1]",
        "distance": 2
      }
    ],
    "edges": [
      {
        "from": "beh-enrollment-approval",
        "to": "tr-reject",
        "relation": "contains",
        "category": "ownership",
        "declaredAt": "behaviors[0].transitions[1]"
      },
      {
        "from": "beh-rejection-notice",
        "to": "tr-send-notice",
        "relation": "contains",
        "category": "ownership",
        "declaredAt": "behaviors[1].transitions[0]"
      },
      {
        "from": "ctr-enrollment-events",
        "to": "evt-enrollment-rejected",
        "relation": "contractPublishes",
        "category": "contract",
        "declaredAt": "contracts[1].publishes[0]"
      },
      {
        "from": "ctr-enrollment-events",
        "to": "mod-enrollment",
        "relation": "owner",
        "category": "ownership",
        "declaredAt": "contracts[1].owner"
      },
      {
        "from": "evt-enrollment-rejected",
        "to": "mod-enrollment",
        "relation": "owner",
        "category": "ownership",
        "declaredAt": "events[2].owner"
      },
      {
        "from": "mod-notifications",
        "to": "ctr-enrollment-events",
        "relation": "consumes",
        "category": "contract",
        "declaredAt": "modules[1].consumes[0]"
      },
      {
        "from": "mod-notifications",
        "to": "mod-enrollment",
        "relation": "dependsOn",
        "category": "dependency",
        "declaredAt": "modules[1].dependsOn[0]"
      },
      {
        "from": "tr-reject",
        "to": "evt-enrollment-rejected",
        "relation": "effectEvent",
        "category": "behavior",
        "declaredAt": "behaviors[0].transitions[1].effects[0].eventId"
      },
      {
        "from": "tr-reject",
        "to": "st-pending",
        "relation": "fromState",
        "category": "behavior",
        "declaredAt": "behaviors[0].transitions[1].fromStateId"
      },
      {
        "from": "tr-reject",
        "to": "rule-review-permission",
        "relation": "guardRule",
        "category": "permission",
        "declaredAt": "behaviors[0].transitions[1].guards[0].ruleId"
      },
      {
        "from": "tr-reject",
        "to": "st-rejected",
        "relation": "toState",
        "category": "behavior",
        "declaredAt": "behaviors[0].transitions[1].toStateId"
      },
      {
        "from": "tr-reject",
        "to": "evt-rejection-submitted",
        "relation": "triggerEvent",
        "category": "behavior",
        "declaredAt": "behaviors[0].transitions[1].trigger.eventId"
      },
      {
        "from": "tr-send-notice",
        "to": "st-notice-waiting",
        "relation": "fromState",
        "category": "behavior",
        "declaredAt": "behaviors[1].transitions[0].fromStateId"
      },
      {
        "from": "tr-send-notice",
        "to": "st-notice-sent",
        "relation": "toState",
        "category": "behavior",
        "declaredAt": "behaviors[1].transitions[0].toStateId"
      },
      {
        "from": "tr-send-notice",
        "to": "evt-enrollment-rejected",
        "relation": "triggerEvent",
        "category": "behavior",
        "declaredAt": "behaviors[1].transitions[0].trigger.eventId"
      }
    ],
    "truncated": true,
    "budget": {
      "depth": 2,
      "maxNodes": 25,
      "direction": "both"
    }
  },
  "diagnostics": []
}
```

## impact: what might a change to that event affect

```sh
vcv query <store> impact evt-enrollment-rejected
```

```json
{
  "ok": true,
  "context": {
    "projectId": "prj-lms",
    "modelRevision": "rev-1",
    "snapshotStatus": "approved",
    "source": "canonical-ir",
    "coverage": "model-only",
    "implementationChecked": false
  },
  "data": {
    "seeds": [
      {
        "id": "evt-enrollment-rejected",
        "kind": "event",
        "name": "Enrollment rejected",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "events[2]"
      }
    ],
    "candidates": [
      {
        "id": "mod-enrollment",
        "kind": "module",
        "name": "Enrollment",
        "moduleId": "mod-enrollment",
        "parentId": "prj-lms",
        "irPath": "modules[0]",
        "distance": 1,
        "via": "container",
        "dependencyPath": [
          {
            "from": "evt-enrollment-rejected",
            "relation": "owner",
            "to": "mod-enrollment"
          }
        ],
        "reason": "module mod-enrollment owns event evt-enrollment-rejected"
      },
      {
        "id": "ctr-enrollment-events",
        "kind": "contract",
        "name": "Enrollment events",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "contracts[1]",
        "distance": 1,
        "via": "dependent",
        "dependencyPath": [
          {
            "from": "evt-enrollment-rejected",
            "relation": "contractPublishes",
            "to": "ctr-enrollment-events"
          }
        ],
        "reason": "contract ctr-enrollment-events references event evt-enrollment-rejected (contract publishes this event)"
      },
      {
        "id": "tr-reject",
        "kind": "transition",
        "name": "tr-reject",
        "moduleId": "mod-enrollment",
        "parentId": "beh-enrollment-approval",
        "irPath": "behaviors[0].transitions[1]",
        "distance": 1,
        "via": "dependent",
        "dependencyPath": [
          {
            "from": "evt-enrollment-rejected",
            "relation": "effectEvent",
            "to": "tr-reject"
          }
        ],
        "reason": "transition tr-reject references event evt-enrollment-rejected (transition emits this event)"
      },
      {
        "id": "tr-send-notice",
        "kind": "transition",
        "name": "tr-send-notice",
        "moduleId": "mod-notifications",
        "parentId": "beh-rejection-notice",
        "irPath": "behaviors[1].transitions[0]",
        "distance": 1,
        "via": "dependent",
        "dependencyPath": [
          {
            "from": "evt-enrollment-rejected",
            "relation": "triggerEvent",
            "to": "tr-send-notice"
          }
        ],
        "reason": "transition tr-send-notice references event evt-enrollment-rejected (transition is triggered by this event)"
      },
      {
        "id": "mod-notifications",
        "kind": "module",
        "name": "Notifications",
        "moduleId": "mod-notifications",
        "parentId": "prj-lms",
        "irPath": "modules[1]",
        "distance": 2,
        "via": "dependent",
        "dependencyPath": [
          {
            "from": "evt-enrollment-rejected",
            "relation": "contractPublishes",
            "to": "ctr-enrollment-events"
          },
          {
            "from": "ctr-enrollment-events",
            "relation": "consumes",
            "to": "mod-notifications"
          }
        ],
        "reason": "module mod-notifications references contract ctr-enrollment-events (consumes this contract); contract ctr-enrollment-events references event evt-enrollment-rejected (contract publishes this event)"
      },
      {
        "id": "beh-enrollment-approval",
        "kind": "behavior",
        "name": "Enrollment approval",
        "moduleId": "mod-enrollment",
        "parentId": "mod-enrollment",
        "irPath": "behaviors[0]",
        "distance": 2,
        "via": "container",
        "dependencyPath": [
          {
            "from": "evt-enrollment-rejected",
            "relation": "effectEvent",
            "to": "tr-reject"
          },
          {
            "from": "tr-reject",
            "relation": "contains",
            "to": "beh-enrollment-approval"
          }
        ],
        "reason": "behavior beh-enrollment-approval contains transition tr-reject; transition tr-reject references event evt-enrollment-rejected (transition emits this event)"
      },
      {
        "id": "beh-rejection-notice",
        "kind": "behavior",
        "name": "Rejection notice",
        "moduleId": "mod-notifications",
        "parentId": "mod-notifications",
        "irPath": "behaviors[1]",
        "distance": 2,
        "via": "container",
        "dependencyPath": [
          {
            "from": "evt-enrollment-rejected",
            "relation": "triggerEvent",
            "to": "tr-send-notice"
          },
          {
            "from": "tr-send-notice",
            "relation": "contains",
            "to": "beh-rejection-notice"
          }
        ],
        "reason": "behavior beh-rejection-notice contains transition tr-send-notice; transition tr-send-notice references event evt-enrollment-rejected (transition is triggered by this event)"
      }
    ],
    "truncated": false,
    "budget": {
      "maxDepth": 3,
      "maxResults": 50
    },
    "impactClass": "structural-candidate",
    "note": "Candidates follow declared model references only. Nothing here was checked against source code, tests or runtime behaviour."
  },
  "diagnostics": []
}
```
