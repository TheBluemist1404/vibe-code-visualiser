<!-- VCV agent guidance (opt-in). Copy this section into your repository's AGENTS.md
     yourself; VCV never edits instruction files for you. Works with any MCP client. -->

## Architecture model (VCV)

This repository has a versioned architecture model (draft or approved) served by the `vcv`
MCP server
(read-only tools `vcv_get_project_overview`, `vcv_search_objects`, `vcv_get_context`,
`vcv_analyze_impact`). The model describes **intended** modules, capabilities, data, rules,
events, contracts and behaviors with stable IDs. It is not evidence about the code.

When a question or task touches the system's structure (which module owns something, how
modules depend on each other, what events or contracts connect them, what a change could
affect):

1. Call `vcv_get_project_overview` first and note `context.modelRevision` and
   `context.snapshotStatus`. `approved` is agreed intent; `draft` is work in progress that may
   contain unresolved references (shown as `{ "unresolved": "..." }` and in `diagnostics`).
2. Use `vcv_search_objects` to find the relevant objects by words; use their IDs from then on.
3. Use `vcv_get_context` on those IDs to read declared relationships (edges carry `relation`,
   `category` and the IR field that declares them).
4. When considering a change, call `vcv_analyze_impact` on the IDs you would change. Its
   candidates are structural hints, not a test plan.
5. Pass the `modelRevision` from step 1 as `expectedRevision` on later calls. On
   `REVISION_MISMATCH`, start again from step 1.
6. Then verify in the code: read the source and tests that implement those modules. Report
   what the model declares and what the code does **separately**, and call out any difference.

Rules:

- Every VCV result has `implementationChecked: false`. Never say the code does something
  because the model says so, and never treat a successful query as a check of the repository.
- If `snapshotStatus` is `draft`, say so in your answer and do not present it as approved
  intent. Read `diagnostics` (and the overview's `validation` counts) for unresolved or
  invalid parts.
- Results are bounded. If `truncated` is true, page with `nextCursor` or narrow the query
  instead of assuming you saw everything.
- Use model IDs (e.g. `mod-enrollment`) when you refer to model objects.
- These tools cannot change the model. Do not edit files in the model store (`.vcv-store/`
  or wherever it lives) by hand.

### Source evidence (when the server runs with `--repo`)

Binding claims say that some code implements, exposes, persists or tests a model object. Read
them with `vcv_get_evidence_overview`, `vcv_get_object_evidence`,
`vcv_get_binding_evidence` and `vcv_refresh_evidence`.

- A claim is someone's interpretation (see `claim.provenance`), not a fact. `resolved` only
  means the pointer resolves and neither the code nor the model object changed since the claim;
  it does not mean the code is correct. Every claim has `approval.approved: false`.
- `stale` means the selected code or the model object changed (read `freshness.*.cause`),
  `missing` that the pointer no longer resolves (VCV never follows renames), `unchecked` that it
  is outside the supported TypeScript subset, `indeterminate` that some evidence is unknown
  (never a pass), `invalid` that the claim file is unreadable.
- Evidence is recomputed on each call against the working tree; nothing watches the repository.
  Inspect the code yourself before concluding anything, and propose model changes through VCV's
  change operations (`vcv proposal submit`, proposal-only) for a person to approve. Never edit
  `.vcv/` by hand.
- Before submitting, dry-run your change with `vcv_preview_proposal` (`{ change }`): it shows
  the model delta, cross-module impact, the binding claims you will have to revisit and the
  engine's diagnostics with hints. A pending proposal is not approved and not implemented.
  Put what should be implemented (behavior, acceptance criteria, tests, scope) in the
  proposal's `implementation` field, so the reviewer approves it too.
- Implement only after a person approved the change, and when asked to: start from
  `vcv handoff <path> <changeId>`, stay in its scope, reassert the binding claims it marks, and
  record what really happened with `vcv implementation record` (docs/implementation.md). Your
  report is a claim; VCV does not verify it, and a model change needs a new proposal.
- Routes are controller-relative (no global prefix); only syntax is read.
