<!-- VCV agent guidance (opt-in). Copy this section into your repository's AGENTS.md
     yourself; VCV never edits instruction files for you. Works with any MCP client. -->

## Architecture model (VCV)

This repository has an approved architecture model served by the `vcv` MCP server
(read-only tools `vcv_get_project_overview`, `vcv_search_objects`, `vcv_get_context`,
`vcv_analyze_impact`). The model describes **intended** modules, capabilities, data, rules,
events, contracts and behaviors with stable IDs. It is not evidence about the code.

When a question or task touches the system's structure (which module owns something, how
modules depend on each other, what events or contracts connect them, what a change could
affect):

1. Call `vcv_get_project_overview` first and note `context.modelRevision`.
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
- Results are bounded. If `truncated` is true, page with `nextCursor` or narrow the query
  instead of assuming you saw everything.
- Use model IDs (e.g. `mod-enrollment`) when you refer to model objects.
- These tools cannot change the model. Do not edit files in the model store (`.vcv-store/`
  or wherever it lives) by hand.
