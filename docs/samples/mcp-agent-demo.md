# M1 manual agent demo: Claude Code + VCV MCP

Recorded 2026-11-11 with Claude Code 2.1.322 headless (`claude -p`), the server from this
branch, and the Enrollment fixture (`examples/enrollment/model.rev-1.yaml`, rev-1). Agent
output is quoted as produced; paths are shortened.

**Question:** *Which module handles rejected enrollment, and how does Notifications depend on it?*

Reproduce with `apps/mcp/demo/run-claude-demo.sh` (needs a signed-in `claude` CLI). The script
builds a throwaway repo with `.vcv-store/` (from `vcv init`), `.mcp.json` (copied from
`apps/mcp/examples/claude-code.mcp.json`), the opt-in `CLAUDE.md` template, and the two invented
source files in `apps/mcp/demo/lms-sample/`. It runs with `--strict-mcp-config` and
`--setting-sources project`, so only this repo's config and the VCV server are in play.

## Run A: no guidance file, no code (`--no-guidance --no-code`)

Discoverability check: only the MCP server's own tool descriptions and initialize instructions.

```
servers: [{"name":"vcv","status":"connected"}]
vcv tools: mcp__vcv__vcv_analyze_impact, mcp__vcv__vcv_get_context, mcp__vcv__vcv_get_project_overview, mcp__vcv__vcv_search_objects
→ ToolSearch {"query":"select:mcp__vcv__vcv_get_project_overview,mcp__vcv__vcv_search_objects,mcp__vcv__vcv_get_context"}
→ mcp__vcv__vcv_get_project_overview {}
→ mcp__vcv__vcv_search_objects {"text":"rejected enrollment"}
→ mcp__vcv__vcv_get_context {"id":"evt-enrollment-rejected","expectedRevision":"rev-1"}
→ mcp__vcv__vcv_get_context {"id":"ctr-enrollment-events","expectedRevision":"rev-1"}
→ mcp__vcv__vcv_get_context {"id":"beh-rejection-notice","expectedRevision":"rev-1"}
→ Glob {"pattern":"**/*"}
```

Answer (excerpt):

> The model answers this cleanly. The repo itself contains only the VCV store and no application
> source, so this is declared intent with nothing to verify against in code.
>
> **Enrollment handles rejection.** [...] That transition's effect emits the "Enrollment
> rejected" event [...] The "Enrollment events" contract is the only thing that publishes the
> "Enrollment rejected" event outward.
>
> **Notifications depends on it through that one contract.** [...] Notifications lists
> Enrollment in its dependsOn and consumes the "Enrollment events" contract. [...] its
> "Rejection notice" behavior [...] has a single transition to Sent, triggered by the
> "Enrollment rejected" event.
>
> The working directory holds no source files [...] so I could not check whether any
> implementation matches this.

## Run B: `CLAUDE.md` template + sample code (default)

```
→ ToolSearch {"query":"select:mcp__vcv__vcv_get_project_overview,mcp__vcv__vcv_search_objects,mcp__vcv__vcv_get_context,mcp__vcv__vcv_analyze_impact"}
→ mcp__vcv__vcv_get_project_overview {}
→ mcp__vcv__vcv_search_objects {"text":"rejected enrollment reject","expectedRevision":"rev-1"}
→ mcp__vcv__vcv_get_context {"id":"mod-notifications","depth":2,"expectedRevision":"rev-1"}
→ mcp__vcv__vcv_get_context {"id":"ctr-enrollment-events","expectedRevision":"rev-1"}
→ Bash {"command":"git ls-files | head -100"}
→ mcp__vcv__vcv_get_context {"id":"beh-rejection-notice","expectedRevision":"rev-1"}
→ mcp__vcv__vcv_get_context {"id":"beh-enrollment-approval","expectedRevision":"rev-1"}
→ mcp__vcv__vcv_get_context {"id":"evt-enrollment-rejected","expectedRevision":"rev-1"}
→ Bash {"command":"ls -la && git status --short | head -50 && git log --oneline | head -5"}
→ Glob {"pattern":"**/*"}
→ Read {"file_path":".../src/enrollment/enrollment.service.ts"}
→ Read {"file_path":".../src/notifications/rejection.listener.ts"}
→ mcp__vcv__vcv_get_context {"id":"rule-review-permission","expectedRevision":"rev-1"}
```

Relevant structured outputs the agent received (every result carried
`"context":{"projectId":"prj-lms","modelRevision":"rev-1","snapshotStatus":"approved","source":"canonical-ir","coverage":"model-only","implementationChecked":false}`):

```text
vcv_get_project_overview  modules:
  mod-enrollment     dependsOn []                 consumes []                         exposes [ctr-enrollment-events, ctr-enrollment-review]
  mod-notifications  dependsOn [mod-enrollment]   consumes [ctr-enrollment-events]    exposes []
vcv_search_objects "rejected enrollment reject"  total 13, truncated false, top hits:
  evt-enrollment-rejected 60, cap-notify-rejection 46, st-rejected 40, mod-enrollment 36, rule-no-reopen 32
vcv_get_context mod-notifications depth 2  (truncated true, edgesTotal 10), among the edges:
  ctr-enrollment-events  contractPublishes  evt-enrollment-rejected  [contract]    contracts[1].publishes[0]
  mod-notifications      consumes           ctr-enrollment-events    [contract]    modules[1].consumes[0]
  mod-notifications      dependsOn          mod-enrollment           [dependency]  modules[1].dependsOn[0]
```

Answer (excerpt; model and code reported separately, as the guidance asks):

> **Short answer:** the Enrollment module (`mod-enrollment`) owns rejection. Notifications
> (`mod-notifications`) depends on it through one published event contract. The code mostly
> matches, but the listener also reaches into Enrollment's repository, which the model does not
> declare.
>
> **What the model declares** (revision rev-1, approved, not checked against code by the tool):
> `mod-enrollment` owns the `Enrollment approval` behavior. Its `tr-reject` transition [...]
> emits `evt-enrollment-rejected`. The event is published through the contract
> `ctr-enrollment-events` [...] `mod-notifications` declares `dependsOn: mod-enrollment` and
> `consumes: ctr-enrollment-events`. [...] So the intended coupling is event-only.
>
> **What the code does** (two files, no tests, no commits yet): [...]
>
> **Differences between model and code:**
> - **Undeclared data dependency.** The listener takes an `EnrollmentRepository` and reads the
>   request's note directly from Enrollment's store. [...]
> - **Permission guard not implemented.** The model guards `tr-reject` with the Lecturer
>   permission rule. The code accepts a lecturer ID but never checks who is calling.
> - **Module boundary is a shared global.** [...]
>
> Nothing has been changed.

## Observations

- In both runs the agent found the deferred VCV tools by itself, started with the overview,
  used IDs from search results, and pinned later calls to `rev-1` via `expectedRevision`.
- It kept model intent and code evidence apart and named both divergences planted in the sample
  code (repository access from Notifications; missing permission check).
- It did not call `vcv_analyze_impact` (the question does not ask about a change), and did not
  re-query when `getContext` reported `truncated: true`.
- With no code in the repo, a repeat of run A also grepped the working directory for
  "reject", which reaches the raw `.vcv-store/revisions/*.yaml`. Agents can read the store files
  directly; the tools are the supported, bounded path, but nothing prevents the bypass.
