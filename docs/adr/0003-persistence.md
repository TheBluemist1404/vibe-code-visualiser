# ADR 0003: Persist revisions as YAML files suitable for Git

Status: accepted for the first spike (2026-11-10)

`FileStore` writes one immutable `revisions/<rev>.yaml` per model revision, one
`changes/<changeId>.json` per ChangeRecord, and a `HEAD` file naming the current revision.
Files are written atomically (temp file plus rename) and `HEAD` moves last.

A model revision is not a Git commit. Committing the store folder to Git is a separate,
optional step. Layout and other presentation state live in a separate `LayoutStore` and
never create model revisions. Revisit when collaboration or concurrent writers are needed
(event log or a transactional store; spec open question 9).
