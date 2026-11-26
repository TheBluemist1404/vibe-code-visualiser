# Walkthrough: one feature change and one bug, end to end

A hands-on tour of VCV on the Course Desk reference app, about 30–40 minutes. You play three roles
and watch what VCV allows, refuses and reports at each step:

| Role | What they may do | In this tour |
|---|---|---|
| **You, the PO** | change intent in the explorer, read results | the browser |
| **The coding agent** | propose model changes, record links between model and code (`agent:coder`) | commands prefixed with `as_agent` |
| **The reviewer** | sign approvals with a private key (`user:reviewer`) | `vcv review approve ... --key` |
| **CI** | run the tests and the gate before merge | `gate <name>` |

Everything runs in a throwaway copy at `~/vcv-tour`. Nothing touches this repository or GitHub.
Every command and output below was rehearsed on 2026-11-25; your commit IDs and draft IDs will differ.

**Where to run things:** an **Ubuntu** terminal (WSL), not PowerShell. You need two terminal
windows: **A** runs the explorer, **B** runs commands. The browser is your normal Windows browser.

---

## 0. Set up (once, about 2 minutes)

In terminal **B**, save the helpers to a file, so you can load them in any terminal:

```bash
cat > ~/vcv-tour-env.sh <<'EOF'
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null
VCV_HOME=~/projects/vibe-code-visualiser
TOUR=~/vcv-tour
REPO=$TOUR/course-desk
KEY=$TOUR/keys/reviewer.pem
DOWNLOADS="/mnt/c/Users/Helios Neo 16/Downloads"
# The VCV command line
vcv() { node --experimental-strip-types --no-warnings "$VCV_HOME/apps/cli/src/main.ts" "$@"; }
# Run a command as the coding agent: the identity is fixed by the "host" (this env), not by the agent
as_agent() { VCV_HOST_PRINCIPAL=agent:coder VCV_HOST_PERMISSIONS=model:propose,binding:record "$@"; }
# What CI runs on a pull request: identity -> the app's own tests -> the VCV gate
gate() { bash "$VCV_HOME/examples/reference-app/premerge/ci.sh" "$TOUR" "$TOUR/out/$1"; }
# The agent re-confirms a link between model and code after something changed
reassert() { local l; l=$(vcv binding list "$REPO" | grep "^$1 ")
  as_agent vcv binding reassert "$REPO" "$1" --locator "$(echo "$l" | sed -E 's/^(\S+\s+){4}//')" \
    --expect "$(echo "$l" | awk '{print $2}')" --source agent --rationale "$2"; }
[ -f $TOUR/main.sha ] && MAIN=$(cat $TOUR/main.sha)
EOF
source ~/vcv-tour-env.sh
```

Build the copy of Course Desk:

```bash
rm -rf ~/vcv-tour
$VCV_HOME/examples/reference-app/premerge/setup.sh ~/vcv-tour
source ~/vcv-tour-env.sh          # picks up MAIN, the protected base
cd $REPO && git config user.name "You" && git config user.email "you@example.invalid"
```

What you get on `main` is a small React + NestJS app where students enroll in courses, plus:
- an **approved model** in `.vcv/`: 3 modules (Enrollment, Notifications, Web) with their rules;
- **3 acceptance criteria**, two of them required: *a rejected enrollment is announced*, *a
  confirmed enrollment is announced*;
- **links from each criterion to the tests** that check it;
- a **gate policy**: rule *every enrollment decision must reach the student* needs passing tests.

The last lines of the output list the criteria and their mapped tests, ending in:

```
main: 10b09d3f463b9cfe1d82bfe39a3c352203f50352
setup: ok. Keep /home/<you>/vcv-tour/keys private; it holds the reviewer's private key.
```

In terminal **A**, start the explorer and leave it running:

```bash
source ~/vcv-tour-env.sh
cd $VCV_HOME && npm run ui -- $REPO --protected-base main --base-commit $MAIN
```

Open **http://127.0.0.1:4870/**. You should see 3 modules and the header `rev-3-… approved`, `main`.
Click around: modules, their rules and criteria. Nothing you click changes the project.

---

## Act 1. The PO changes intent (model-first)

The story: you want the seat-limit rule to say plainly what happens when a course is full.

### 1.1 Start a feature branch (terminal B)

```bash
git switch -c feature/seat-limit-wording
```

The explorer header switches to `feature/seat-limit-wording` on its own within a few seconds.

### 1.2 Draft the change in the explorer (browser)

1. Select **Enrollment**, then the rule **Course capacity** (`rul-seat-limit`).
2. **Edit Statement**, and replace the text with:
   `A course never takes more confirmed enrollments than its capacity; a request for a full course is rejected with COURSE_FULL.`
3. **Stage**. The draft panel shows the engine's check: *applies to its base revision*, the
   before and after, and *Modules touched: Enrollment*.
4. Optional: open **Implementation request** and fill in what the agent should build, e.g.
   Behavior *A full course is rejected with COURSE_FULL*, one acceptance criterion per line, and
   Scope `server/src/enrollment/**`. It travels in the handoff and the reviewer approves it with
   the model edit.
5. **Hand off to agent**, then **Download**. You get a file like `ui-20261125-160128-cc25-v1.json`.

Nothing in the project has changed yet. The draft lives only on this computer.

### 1.3 Give the file to the "agent" (terminal B)

```bash
cp "$(ls -t "$DOWNLOADS"/ui-*.json | head -1)" $TOUR/change.json
CHANGE=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).changeId' $TOUR/change.json)
vcv proposal preview $REPO --file $TOUR/change.json
```

A dry run, the same one a reviewer will see later:

```
model delta (against current rev-3-bd922e630c6e; 1 object(s)):
  ~ rule rul-seat-limit [mod-enrollment]
      statement: Confirmed enrollments for a course never exceed its capacity; ...
        → A course never takes more confirmed enrollments than its capacity; ...
impact (structural candidates only):
  modules:   mod-enrollment (changed)
  · criterion crt-rejection-notified: criterion crt-rejection-notified references rule rul-seat-limit (verifies)
binding claims to revisit (4):
  impl.rul-seat-limit: rul-seat-limit implements server/src/enrollment/enrollment.service.ts#symbol:EnrollmentService.enroll (changed)
  test.rul-seat-limit: ... (changed)
not verified by anyone yet:
  - Whether the operations express the requested behavior is the proposer's interpretation; ...
```

**Look for:** VCV shows what else the change touches (a criterion and 4 links to code and tests),
and is explicit about what it did *not* check.

### 1.4 The agent submits it

```bash
as_agent vcv proposal submit $REPO $TOUR/change.json
```

```
ui-…-v1: pending (recorded); .vcv/HEAD stays at rev-3-bd922e630c6e
  Recorded as pending; ... A separate reviewer must approve it before anything is implemented.
```

**In the browser:** the **Proposals** tab gets a badge *1 pending*. Open it: *Pending review*,
proposer `agent:coder`, *Reviewer signature: not yet*, and an **Approve in your own terminal**
box with the exact command. The browser itself cannot approve.

### 1.5 The agent tries to approve its own change

```bash
as_agent vcv review approve $REPO $CHANGE --digest x --key $KEY
as_agent vcv proposal submit $REPO $TOUR/change.json --as user:reviewer
```

```
✗ INPUT: vcv review approve takes no --as/--perm and refuses to run under VCV_HOST_PRINCIPAL/VCV_HOST_PERMISSIONS (an agent host); ...
✗ INPUT: identity and permissions are fixed by this host (VCV_HOST_PRINCIPAL / VCV_HOST_PERMISSIONS); --as and --perm are not accepted
```

**Look for:** an agent can neither approve nor pretend to be someone else.

### 1.6 The reviewer approves something they didn't review

The approval is tied to the exact content the reviewer previewed (its digest). Change one character:

```bash
DIGEST=$(vcv proposal preview $REPO $CHANGE --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.proposal.proposalDigest')
TAMPERED=$(echo $DIGEST | tr '0-9a-f' '1-9a-f0')   # every character shifted by one
vcv review approve $REPO $CHANGE --digest $TAMPERED --key $KEY --trust-commit $MAIN
```

```
  ✗ DIGEST_MISMATCH at (root): the proposal's content digest is b53f9fc5…, not the reviewed c640a0d6…; preview it again
```

### 1.7 The reviewer approves for real

```bash
vcv review approve $REPO $CHANGE --digest $DIGEST --key $KEY --trust-commit $MAIN
git add .vcv && git commit -m "vcv: approve $CHANGE"
vcv project status $REPO
```

```
reviewer: user:reviewer (key …, trusted per .vcv/reviewers.json at main (10b09d3f463b))
ui-…-v1: applied → rev-4-8d58e5033ece (proposed by agent:coder, approved by user:reviewer; record is applied)
  attestation: .vcv/approvals/ui-…-v1.json
model:   prj-course-desk at rev-4-8d58e5033ece [approved], 4 revision(s)
```

**In the browser:** the proposal flips to *Applied to model* with *Reviewer signature: yes*, and
the header shows `rev-4-…`. The rule's new statement is now the agreed intent.

### 1.8 Check the history the way CI would

```bash
vcv integrity $REPO --trust-commit $MAIN --require-attestation | head -8
```

```
integrity: ok (prj-course-desk at rev-4-8d58e5033ece)
  2. rev-2-…: verified by chg-baseline; approval attested (signed by user:reviewer …)
  3. rev-3-…: verified by chg-enrollment-criteria; approval attested (…)
  4. rev-4-…: verified by ui-…-v1; approval attested (…)
```

Every model version traces back to a signed approval.

### 1.9 Before merging: is the code still in line?

```bash
gate 1-wording
```

```
gate exit 0: vcv gate: WARN: passed with 2 warnings: 2/2 required criteria passed, host-observed
```

See why it warns:

```bash
cat $TOUR/out/1-wording/gate.txt
```

```
  ✓ crt-confirmation-notified [required] passed (host)
  ✓ crt-rejection-notified [required] passed (host)
  warn  CLAIM_STALE: claim impl.rul-seat-limit (... EnrollmentService.enroll) is stale (model: rul-seat-limit changed ...)
```

**Look for:** the rule changed, so VCV can no longer assume the code that implemented the *old*
wording still matches. Someone has to look. The agent checks the code and re-confirms both links:

```bash
reassert impl.rul-seat-limit "enroll() still rejects a full course with COURSE_FULL"
reassert test.rul-seat-limit "the spec still asserts COURSE_FULL for a full course"
git add -A && git commit -m "Reassert the seat-limit claims"
gate 2-wording-reasserted
```

```
gate exit 0: vcv gate: PASS: passed: 2/2 required criteria passed, host-observed
```

Act 1 is done: an intent change went PO → agent → reviewer → CI, and each step left a record.

---

## Act 2. Someone breaks the product (code-first)

The story: a developer "tidies" the notification code and swaps two branches by mistake. No model
change, no proposal. Just code.

### 2.1 Make the bug (terminal B)

```bash
git switch main && git switch -c fix/notifications
sed -i 's/^    if (reason) {/    if (!reason) {/' server/src/enrollment/enrollment.service.ts
git diff
git commit -qam "Tidy enrollment notifications"
```

A one-character change: now rejected students are told they're enrolled, and the other way round.

### 2.2 What ordinary CI would tell you

```bash
gate 3-broken
grep -E "×|Tests " $TOUR/out/3-broken/tests.txt
```

```
     × confirms an enrollment while seats are left and notifies the student
     × rejects an enrollment into a full course and notifies the student
     × confirms, then rejects when full; each student is notified of their outcome
      Tests  3 failed | 5 passed (8)
```

That's what a plain test run says: *3 failed*.

### 2.3 What VCV tells you

```bash
cat $TOUR/out/3-broken/gate.txt
```

```
vcv gate: BLOCK: blocked: 5 blocking reasons (...)
  candidate … (fix/notifications) against base …; code-first change (1 file(s), 0 new model revision(s), lineage unchanged)
  ✗ crt-confirmation-notified [required] failed  verifies rul-announce-every-decision, cap-enroll
  ✗ crt-rejection-notified [required] failed  verifies rul-announce-every-decision, rul-seat-limit, cap-enroll
  ✓ crt-repeat-rejected [optional] passed (host)
  BLOCK TEST_FAILED crt-confirmation-notified: ... "EnrollmentService > confirms an enrollment while seats are left and notifies the student" ... failed
  BLOCK EVIDENCE_REQUIRED: rul-announce-every-decision is touched by this change and the policy requires a host-observed pass ...
        every enrollment decision must reach the student
  warn  CLAIM_STALE: claim impl.rul-announce-every-decision (... EnrollmentService.enroll) is stale (code: ... differs from the recorded fingerprint)
```

**Look for:** the difference between the two outputs. VCV says *which product promises* broke
("a confirmed enrollment is announced", "a rejected enrollment is announced"), which business
rule they protect, and that your policy makes this a blocker. That's the part a PO can read.

### 2.4 See it in the explorer

The Before merging page needs the test results handed to it at startup. Record them:

```bash
vcv tests capture $REPO --junit $TOUR/out/3-broken/junit.xml --runner vitest --invocation "npx vitest run" \
  --root server --out $TOUR/out/3-broken/run.json \
  --before "$(node -pe 'JSON.parse(require("fs").readFileSync(0)).identityDigest' < $TOUR/out/3-broken/identity.json)"
```

In terminal **A**, stop the explorer (Ctrl+C) and restart it with the results and the policy:

```bash
npm run ui -- $REPO --protected-base main --base-commit $MAIN \
  --run $TOUR/out/3-broken/run.json --policy $REPO/.github/vcv-policy.json
```

Open **Before merging**: *Gate decision: Blocked*, the same `TEST_FAILED` and
`EVIDENCE_REQUIRED` reasons, and the criteria table with two required criteria *failed*. The page
labels the run as *records handed to this host are claims*: only CI's own run is real evidence.

### 2.5 Fix it

```bash
sed -i 's/^    if (!reason) {/    if (reason) {/' server/src/enrollment/enrollment.service.ts
git commit -qam "Restore enrollment notifications"
gate 4-fixed
```

```
gate exit 0: vcv gate: PASS: passed: 2/2 required criteria passed, host-observed
```

(The explorer still shows the old run, now for an older commit. Results are tied to the exact
code they were run on.)

If you capture this passing run too and restart the explorer with it, Before merging says
**Blocked: not proven yet** (nothing is failing), with `RESULT_CLAIMED`: *passed only in runs that were not captured here*. A
results file handed to the explorer is a claim, and the policy accepts only results the gate
captured itself. A claimed *failure* still blocks; a claimed *pass* never counts. Only the gate's
own run (`gate 4-fixed`, or CI) can show PASS.

---

## Act 3. Someone tries to cheat (2 minutes)

The story: instead of proposing a change, someone edits the approved model file directly to make
the rule say rejected students get no notification.

```bash
git switch main && git switch -c cheat/edit-model
sed -i 's/receives exactly one enrollment-rejected notification/receives no notification/' .vcv/revisions/rev-3-*.yaml
git commit -qam "Quietly edit the approved model"
vcv project status $REPO
vcv gate $REPO --base $MAIN --policy-at-base .github/vcv-policy.json | head -1
```

```
project: invalid (…/course-desk/.vcv)
  ✗ INVALID_STORE: revisions/rev-3-bd922e630c6e.yaml does not match its ID: its content digest does not verify ... (edited after commit, ...)
vcv gate: BLOCK: blocked: the candidate's model cannot be loaded (PROJECT_NOT_READY)
```

**In the browser:** the explorer reports the project as invalid instead of showing a quietly
changed model. Approved intent can only change through a signed proposal.

---

## What you just saw, in one table

| Step | Who | Result |
|---|---|---|
| Draft a rule change | PO, in the browser | a local draft, checked by the engine; project untouched |
| Submit | agent | *pending*; the model doesn't move |
| Agent approves / impersonates | agent | refused |
| Approve a different digest | reviewer | refused (`DIGEST_MISMATCH`) |
| Approve | reviewer, with their key | new model version `rev-4`, signed |
| Gate after intent change | CI | warns: code links went stale, someone must re-check |
| Bug in code, no model change | CI | **blocked**, naming the broken product promises |
| Edit the approved model by hand | anyone | **blocked**: the model no longer verifies |

What this tour does *not* show: live agents doing the work themselves (here you typed their
commands), and GitHub enforcing the gate on a real pull request. See
[golden-path.md](golden-path.md) and [samples/m4.5-golden-path](samples/m4.5-golden-path/README.md).

## Reset or clean up

```bash
pkill -f apps/ui/src/main.ts; rm -rf ~/vcv-tour ~/.local/state/vcv/ui ~/vcv-tour-env.sh
```

To run the tour again, start at step 0.
