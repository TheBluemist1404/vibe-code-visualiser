# ADR 0001: Build the IR and engine first, with Enrollment as the only domain

Status: accepted for the first spike (2026-11-10)

We build `packages/ir` (types, schema, validation, projections) and `packages/core`
(operations, engine, stores) before any canvas, MCP server or repository indexer. The only
domain is the invented LMS Enrollment fixture from the IR v0.2 spec, plus a tiny
Notifications module so contract rules between modules are exercised.

Why: the product bet depends on a model that stays consistent while several interfaces
change it. That is testable without UI, and UI built first would hide gaps in the model.

Consequence: no repository binding beyond the `Binding` record and staleness check; code
divergence detection waits for Slice 3.
