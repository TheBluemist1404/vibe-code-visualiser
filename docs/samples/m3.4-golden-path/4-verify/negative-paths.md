### a model:apply shortcut through the legacy propose command only records a pending change

expected: ok with /pending/, got: ok (exit 0), as expected

```
chg-neg-apply: pending (proposed by agent:proposer; record is pending)
```

###   … and .vcv/HEAD and the revisions did not move

expected: ok, got: ok (exit 0), as expected

```

```

### the proposer cannot approve a pending change (vcv approve as agent:proposer)

expected: fail with /NOT_AUTHORIZED/, got: fail (exit 1), as expected

```
chg-neg-apply: denied (proposed by agent:proposer; record is pending)
  ✗ NOT_AUTHORIZED at (root): agent:proposer may not approve changes
  note: developer approval (identity asserted by --as/--perm or VCV_HOST_*); no attestation. Use `vcv review approve` for a trusted reviewer approval.
```

### the proposer cannot pass --as/--perm under a host identity

expected: fail with /--as and --perm are not accepted/, got: fail (exit 2), as expected

```
✗ INPUT: identity and permissions are fixed by this host (VCV_HOST_PRINCIPAL / VCV_HOST_PERMISSIONS); --as and --perm are not accepted
```

### review approve refuses to run under an agent host identity

expected: fail with /refuses to run under VCV_HOST/, got: fail (exit 2), as expected

```
✗ INPUT: vcv review approve takes no --as/--perm and refuses to run under VCV_HOST_PRINCIPAL/VCV_HOST_PERMISSIONS (an agent host); the reviewer's identity comes from --key and the trust list
```

### a stale expectedRevision is rejected

expected: fail with /STALE|stale|expectedRevision/, got: fail (exit 1), as expected

```
chg-neg-stale: rejected (recorded); .vcv/HEAD stays at rev-3-a5c764161201
  digest: 5540a1d2a9d8f7fc239b4496e531d54b16a1f1bc7dca30526693f4f3069ec8b6
  ✗ STALE_REVISION at expectedRevision: expected rev-1, current is rev-3-a5c764161201
      → The model moved since you read it: re-read the current revision, re-check your operations against it, and submit a new proposal with that expectedRevision.
  Recorded as rejected (the record keeps the diagnostics). Fix the proposal and submit it under a new changeId.
```

### an operation on a missing reference is rejected

expected: fail with /rejected/, got: fail (exit 1), as expected

```
chg-neg-missing: rejected (recorded); .vcv/HEAD stays at rev-3-a5c764161201
  digest: 656cea0454d323f5214361272885f708a6b1080de8b5856303c895f29688118e
  ✗ TARGET_MISSING at operations[0]: setRuleStatement: rule "rul-does-not-exist" not found
      → The operation names an object that does not exist at the base revision; check the ID with vcv_get_context.
  Recorded as rejected (the record keeps the diagnostics). Fix the proposal and submit it under a new changeId.
```

### a change that violates an invariant (removing a module still referenced) is rejected

expected: fail with /rejected/, got: fail (exit 1), as expected

```
chg-neg-invalid: rejected (recorded); .vcv/HEAD stays at rev-3-a5c764161201
  digest: 21ed06b65c2e4ae9bdd7e7c12aca62c4f218e6314b6f1cdea7e78ae8b32e3ebb
  ✗ HAS_OWNED_OBJECTS at operations[0]: removeObject: "mod-notifications" still owns cap-list-notifications, dat-notification, rul-recipient-required; transfer or remove them first
      → Remove or move the owned objects first, in earlier operations of the same proposal.
  Recorded as rejected (the record keeps the diagnostics). Fix the proposal and submit it under a new changeId.
```

### a replayed change ID is refused

expected: fail with /DUPLICATE_CHANGE/, got: fail (exit 1), as expected

```
chg-notification-rejection-reason: rejected (not recorded); .vcv/HEAD stays at rev-3-a5c764161201
  ✗ DUPLICATE_CHANGE at changeId: change "chg-notification-rejection-reason" was already submitted
      → Change IDs are immutable and used once: choose a new changeId (the existing record is left as it was).
  Nothing was recorded.
```

### rejected and pending proposals left .vcv/HEAD and the revisions unchanged

expected: ok, got: ok (exit 0), as expected

```

```

### self-approval: the reviewer cannot approve a change they proposed

expected: fail with /SELF_APPROVAL/, got: fail (exit 1), as expected

```
reviewer: user:reviewer (key c9ecc67163802d0d, trusted per .vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e))
  trust anchor: commit 5a65d6570f9e pinned by the caller: an immutability pin, not proof of origin; that it is the protected branch is caller-asserted and unverified
  ! authorization not established by this command: the trust anchor is caller-asserted, and a shell in this checkout can supply its own. The authorization gate is `vcv integrity --base <protected base> --trust-ref <protected base> --require-attestation` run by the host (CI) on the hosting service's protected branch
chg-neg-self: denied (proposed by user:reviewer; record is pending)
  ✗ SELF_APPROVAL at (root): a proposer cannot approve their own change
```

### an unauthorized reviewer (key not in main's trust list) cannot approve

expected: fail with /UNTRUSTED_KEY/, got: fail (exit 2), as expected

```
✗ UNTRUSTED_KEY: the key 9891c0872fafc434 is not in the trust list (.vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e))
```

### the right reviewer cannot approve content other than the digest they reviewed

expected: fail with /DIGEST_MISMATCH/, got: fail (exit 1), as expected

```
reviewer: user:reviewer (key c9ecc67163802d0d, trusted per .vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e))
  trust anchor: commit 5a65d6570f9e pinned by the caller: an immutability pin, not proof of origin; that it is the protected branch is caller-asserted and unverified
  ! authorization not established by this command: the trust anchor is caller-asserted, and a shell in this checkout can supply its own. The authorization gate is `vcv integrity --base <protected base> --trust-ref <protected base> --require-attestation` run by the host (CI) on the hosting service's protected branch
chg-neg-unauth: rejected (proposed by agent:proposer; record is pending)
  ✗ DIGEST_MISMATCH at (root): the proposal's content digest is 26653972f8d43bd59598295dd556766d103bb39ddb0f7da73a1081a563de61aa, not the reviewed ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff; preview it again
```

### a hand-made revision with a hand-edited .vcv/HEAD fails the host gate

expected: fail with /FAILED/, got: fail (exit 1), as expected

```
integrity: FAILED (prj-course-desk at rev-4-handmade)
  base:  5a65d6570f9eae9deb902cd6faf1380b4df0adea 5a65d6570f9e at rev-2-a21d7aa4915e
  trust: .vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e), 1 reviewer(s); commit 5a65d6570f9e pinned by the caller: an immutability pin, not proof of origin; that it is the protected branch is caller-asserted and unverified
  authorization: caller-asserted: ok means consistent and attested under the trust anchor given here; it authorizes a change only when that anchor (and --base) is supplied by the host from the hosting service's protected branch, in a check the change under review cannot edit
  1. rev-1: initial; approval not-applicable (initial revision (created by init; provenance not provable))
  2. rev-2-a21d7aa4915e: verified by chg-baseline; approval attested (signed by user:reviewer (key c9ecc67163802d0d), trusted per .vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e))
  3. rev-3-a5c764161201 (new): verified by chg-notification-rejection-reason; approval attested (signed by user:reviewer (key c9ecc67163802d0d), trusted per .vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e))
  4. rev-4-handmade (new): no-record; approval missing (no change record)
  ✗ UNEXPLAINED_REVISION: no applied change record produced rev-4-handmade: it was written by hand, or its record was removed
  ✗ HEAD_RECORD_MISMATCH: HEAD's last commit (chg-notification-rejection-reason) is not the applied record of rev-4-handmade
  not provable here:
    - An attestation proves that the holder of a trusted reviewer key signed this exact change; it does not prove which person held the key, or that the key was not shared or stolen.
    - Trust is only as strong as its source. A trust list in the checkout under review can be changed by that same change; in CI, read it from the protected base branch (--trust-ref) and protect who may change it there. Git pins the commit the list was read from; it cannot prove that the branch is protected. An unpinned --trust-ref is a local name anyone with a shell in the checkout can create or move: rely on it only where the host provides the ref (a CI checkout), or pin it with --trust-commit.
    - The initial revision has no recorded derivation: who created it, and from what, is not provable from the repository.
    - Derivation replays the recorded typed operations; it says nothing about whether the source code implements the model (that is M4's reconciliation).
    - The local audit log (.vcv/audit.jsonl) is not shared through Git and is not evidence here.
```

### a forged applied change record fails the host gate

expected: fail with /FAILED/, got: fail (exit 1), as expected

```
integrity: FAILED (prj-course-desk at rev-3-a5c764161201)
  base:  5a65d6570f9eae9deb902cd6faf1380b4df0adea 5a65d6570f9e at rev-2-a21d7aa4915e
  trust: .vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e), 1 reviewer(s); commit 5a65d6570f9e pinned by the caller: an immutability pin, not proof of origin; that it is the protected branch is caller-asserted and unverified
  authorization: caller-asserted: ok means consistent and attested under the trust anchor given here; it authorizes a change only when that anchor (and --base) is supplied by the host from the hosting service's protected branch, in a check the change under review cannot edit
  1. rev-1: initial; approval not-applicable (initial revision (created by init; provenance not provable))
  2. rev-2-a21d7aa4915e: verified by chg-baseline; approval attested (signed by user:reviewer (key c9ecc67163802d0d), trusted per .vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e))
  3. rev-3-a5c764161201 (new): verified by chg-notification-rejection-reason; approval invalid (attestation does not match the record (approverId))
  ✗ APPROVAL_INVALID: rev-3-a5c764161201 (change chg-notification-rejection-reason): approval invalid: attestation does not match the record (approverId)
  ✗ HEAD_RECORD_MISMATCH: HEAD's last commit (chg-notification-rejection-reason) is not the applied record of rev-3-a5c764161201
  not provable here:
    - An attestation proves that the holder of a trusted reviewer key signed this exact change; it does not prove which person held the key, or that the key was not shared or stolen.
    - Trust is only as strong as its source. A trust list in the checkout under review can be changed by that same change; in CI, read it from the protected base branch (--trust-ref) and protect who may change it there. Git pins the commit the list was read from; it cannot prove that the branch is protected. An unpinned --trust-ref is a local name anyone with a shell in the checkout can create or move: rely on it only where the host provides the ref (a CI checkout), or pin it with --trust-commit.
    - The initial revision has no recorded derivation: who created it, and from what, is not provable from the repository.
    - Derivation replays the recorded typed operations; it says nothing about whether the source code implements the model (that is M4's reconciliation).
    - The local audit log (.vcv/audit.jsonl) is not shared through Git and is not evidence here.
```

### a hand-edited approved revision fails the host gate

expected: fail with /does not match its ID/, got: fail (exit 1), as expected

```
integrity: FAILED
  trust: none
  authorization: caller-asserted: ok means consistent and attested under the trust anchor given here; it authorizes a change only when that anchor (and --base) is supplied by the host from the hosting service's protected branch, in a check the change under review cannot edit
  ✗ STORE_NOT_READY: the VCV project is invalid: revisions/rev-3-a5c764161201.yaml does not match its ID: its content digest does not verify as revision 3 after rev-2-a21d7aa4915e (edited after commit, or listed out of place in HEAD)
  not provable here:
    - An attestation proves that the holder of a trusted reviewer key signed this exact change; it does not prove which person held the key, or that the key was not shared or stolen.
    - Trust is only as strong as its source. A trust list in the checkout under review can be changed by that same change; in CI, read it from the protected base branch (--trust-ref) and protect who may change it there. Git pins the commit the list was read from; it cannot prove that the branch is protected. An unpinned --trust-ref is a local name anyone with a shell in the checkout can create or move: rely on it only where the host provides the ref (a CI checkout), or pin it with --trust-commit.
    - The initial revision has no recorded derivation: who created it, and from what, is not provable from the repository.
    - Derivation replays the recorded typed operations; it says nothing about whether the source code implements the model (that is M4's reconciliation).
    - The local audit log (.vcv/audit.jsonl) is not shared through Git and is not evidence here.
```

### an applied change without its attestation fails the host gate

expected: fail with /FAILED/, got: fail (exit 1), as expected

```
integrity: FAILED (prj-course-desk at rev-3-a5c764161201)
  base:  5a65d6570f9eae9deb902cd6faf1380b4df0adea 5a65d6570f9e at rev-2-a21d7aa4915e
  trust: .vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e), 1 reviewer(s); commit 5a65d6570f9e pinned by the caller: an immutability pin, not proof of origin; that it is the protected branch is caller-asserted and unverified
  authorization: caller-asserted: ok means consistent and attested under the trust anchor given here; it authorizes a change only when that anchor (and --base) is supplied by the host from the hosting service's protected branch, in a check the change under review cannot edit
  1. rev-1: initial; approval not-applicable (initial revision (created by init; provenance not provable))
  2. rev-2-a21d7aa4915e: verified by chg-baseline; approval attested (signed by user:reviewer (key c9ecc67163802d0d), trusted per .vcv/reviewers.json at 5a65d6570f9eae9deb902cd6faf1380b4df0adea (5a65d6570f9e))
  3. rev-3-a5c764161201 (new): verified by chg-notification-rejection-reason; approval missing (record names user:reviewer, but there is no attestation: provenance unknown)
  ✗ APPROVAL_NOT_ATTESTED: rev-3-a5c764161201 (change chg-notification-rejection-reason): approval missing: record names user:reviewer, but there is no attestation: provenance unknown
  not provable here:
    - An attestation proves that the holder of a trusted reviewer key signed this exact change; it does not prove which person held the key, or that the key was not shared or stolen.
    - Trust is only as strong as its source. A trust list in the checkout under review can be changed by that same change; in CI, read it from the protected base branch (--trust-ref) and protect who may change it there. Git pins the commit the list was read from; it cannot prove that the branch is protected. An unpinned --trust-ref is a local name anyone with a shell in the checkout can create or move: rely on it only where the host provides the ref (a CI checkout), or pin it with --trust-commit.
    - The initial revision has no recorded derivation: who created it, and from what, is not provable from the repository.
    - Derivation replays the recorded typed operations; it says nothing about whether the source code implements the model (that is M4's reconciliation).
    - The local audit log (.vcv/audit.jsonl) is not shared through Git and is not evidence here.
```

### a reported test failure is recorded as a warning, not a pass

expected: ok with /TEST_FAILED/, got: ok (exit 0), as expected

```
.vcv/implementations/chg-notification-rejection-reason.json: replaced (digest 77cdc0346fc8b61dc35655a6df7148eb58212d8c9193bc561d45d66b9d60f50d)
  change chg-notification-rejection-reason approved as rev-3-a5c764161201; claimed by agent:implementer; not reconciled
  10 source file(s) changed since b0eff0016fd6, 1 outside the approved scope; 2/2 affected binding(s) reasserted
  ! OUT_OF_SCOPE: README.md changed outside the approved scope
  ! TEST_FAILED: npm test: failed (agent's report)
  ! CRITERION_UNKNOWN: A COURSE_FULL rejection produces a notification with reason COURSE_FULL, and the message text is unchanged: unknown (agent's report)
  ! CLAIMS_UNVERIFIED: tests, outcomes and acceptance are the agent's claims: VCV ran nothing and verified none of them
```

###   … an edit outside the approved scope is a warning

expected: ok with /OUT_OF_SCOPE: README.md/, got: ok (exit 0), as expected

```
.vcv/implementations/chg-notification-rejection-reason.json (digest 77cdc0346fc8b61dc35655a6df7148eb58212d8c9193bc561d45d66b9d60f50d): change chg-notification-rejection-reason at rev-3-a5c764161201; not reconciled
  observed now: 10 source file(s) changed, 1 out of scope; same as recorded
  ! OUT_OF_SCOPE: README.md changed outside the approved scope
  ! TEST_FAILED: npm test: failed (agent's report)
  ! CRITERION_UNKNOWN: A COURSE_FULL rejection produces a notification with reason COURSE_FULL, and the message text is unchanged: unknown (agent's report)
  ! CLAIMS_UNVERIFIED: tests, outcomes and acceptance are the agent's claims: VCV ran nothing and verified none of them
```

###   … and a criterion the agent could not confirm is a warning

expected: ok with /CRITERION_UNKNOWN/, got: ok (exit 0), as expected

```
.vcv/implementations/chg-notification-rejection-reason.json (digest 77cdc0346fc8b61dc35655a6df7148eb58212d8c9193bc561d45d66b9d60f50d): change chg-notification-rejection-reason at rev-3-a5c764161201; not reconciled
  observed now: 10 source file(s) changed, 1 out of scope; same as recorded
  ! OUT_OF_SCOPE: README.md changed outside the approved scope
  ! TEST_FAILED: npm test: failed (agent's report)
  ! CRITERION_UNKNOWN: A COURSE_FULL rejection produces a notification with reason COURSE_FULL, and the message text is unchanged: unknown (agent's report)
  ! CLAIMS_UNVERIFIED: tests, outcomes and acceptance are the agent's claims: VCV ran nothing and verified none of them
```

### a second report without --expect is refused

expected: fail with /REPORT_EXISTS/, got: fail (exit 1), as expected

```
✗ REPORT_EXISTS: .vcv/implementations/chg-notification-rejection-reason.json exists (digest 77cdc0346fc8b61dc35655a6df7148eb58212d8c9193bc561d45d66b9d60f50d); pass --expect <digest> to replace it
```

