#!/usr/bin/env bash
# Source binding claims on a standalone Course Desk checkout (Issue #13, M2.4).
#
#   examples/reference-app/bindings/demo.sh <empty-dir>
#
# Materializes Course Desk, creates .vcv/ from the M2.3 agent draft with `vcv project init`,
# records claims as an agent, renames the bound method, verifies, reasserts the claim as a person,
# and shows that .vcv/HEAD and the model revision never moved. Every step uses the public CLI.
# The recorded output is docs/samples/m2.4-bindings/demo.txt.
set -euo pipefail

work=${1:?usage: demo.sh <empty-dir>}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vcv_home=$(cd "$here/../../.." && pwd)
repo="$work/course-desk"
vcv() { node --experimental-strip-types --no-warnings "$vcv_home/apps/cli/src/main.ts" "$@"; }
step() { printf '\n$ %s\n' "$*" | sed "s|$repo|<repo>|g; s|$vcv_home/||g"; }
run() { step "vcv $*"; vcv "$@" 2>&1 | sed "s|$repo|<repo>|g" || true; }
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Demo" GIT_AUTHOR_EMAIL="demo@example.invalid" GIT_COMMITTER_NAME="Demo" GIT_COMMITTER_EMAIL="demo@example.invalid"
export GIT_AUTHOR_DATE="2026-01-02T00:00:00Z" GIT_COMMITTER_DATE="2026-01-02T00:00:00Z"

svc=server/src/enrollment/enrollment.service.ts
ctl=server/src/enrollment/enrollment.controller.ts
step "examples/reference-app/materialize.sh <repo>"
bash "$vcv_home/examples/reference-app/materialize.sh" "$repo"
run project init "$repo" "$vcv_home/docs/samples/m2.3-bootstrap/agent-output/model.yaml"
head_before=$(sha256sum "$repo/.vcv/HEAD" | cut -c1-64)

echo; echo "# An agent records three claims. VCV checks that each pointer resolves, nothing more."
run binding add "$repo" --as agent:bootstrap --source agent --id impl.cap-enroll --object cap-enroll --relation implements --locator "$svc#symbol:EnrollmentService.enroll" --rationale "enroll() decides and records" --confidence 0.8
run binding add "$repo" --as agent:bootstrap --source agent --id expose.cap-enroll --object cap-enroll --relation exposes --locator "$ctl#route:POST /enrollments"
run binding add "$repo" --as agent:bootstrap --source agent --id test.rul-seat-limit --object rul-seat-limit --relation tests --locator "server/src/enrollment/enrollment.service.spec.ts#test:EnrollmentService > rejects an enrollment into a full course and notifies the student"
echo; echo "# A pointer to nothing, an unsafe path and an unsupported selector are refused, not stored."
run binding add "$repo" --source agent --object cap-enroll --relation implements --locator "$svc#symbol:EnrollmentService.reject"
run binding add "$repo" --source agent --object cap-enroll --relation implements --locator "../outside.ts"
run binding add "$repo" --source agent --object cap-enroll --relation implements --locator "README.md#symbol:Enroll"
run binding verify "$repo"

step "git add -A && git commit -m 'vcv: draft model and binding claims'"
git -C "$repo" add -A && git -C "$repo" commit -q -m "vcv: draft model and binding claims"

echo; echo "# Rename the bound method in the working tree (same Git HEAD)."
step "sed -i 's/enroll(request/enrollStudent(request/' $svc $ctl"
sed -i 's/  enroll(request: EnrollmentRequest)/  enrollStudent(request: EnrollmentRequest)/' "$repo/$svc"
sed -i 's/this.enrollment.enroll(request)/this.enrollment.enrollStudent(request)/' "$repo/$ctl"
run binding verify "$repo"

echo; echo "# A person reasserts the claim at its new locator, naming the claim they read (--expect)."
digest=$(vcv binding list "$repo" --json | node -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8")).find(e=>e.bindingId==="impl.cap-enroll");console.log(e.digest)')
run binding reassert "$repo" impl.cap-enroll --as user:reviewer --source human --expect 0000000000000000000000000000000000000000000000000000000000000000 --locator "$svc#symbol:EnrollmentService.enrollStudent"
run binding reassert "$repo" impl.cap-enroll --as user:reviewer --source human --expect "$digest" --locator "$svc#symbol:EnrollmentService.enrollStudent"
run binding verify "$repo"

step "git add -A && git commit -m 'rename enroll, reassert its binding' && git show --stat HEAD"
git -C "$repo" add -A && git -C "$repo" commit -q -m "rename enroll, reassert its binding"
git -C "$repo" show --stat --format=%s HEAD | sed '/^$/d'
run project status "$repo"
echo
if [ "$(sha256sum "$repo/.vcv/HEAD" | cut -c1-64)" = "$head_before" ]; then echo ".vcv/HEAD unchanged by every binding operation"; else echo ".vcv/HEAD CHANGED"; exit 1; fi
