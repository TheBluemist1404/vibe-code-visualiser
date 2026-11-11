A user of this application asked for the following change:

> $REQUEST

This repository has a VCV architecture model (`.vcv/`) that is the agreed, approved description of the system. Changes are made **model first**: before anyone writes code, you propose the architectural change for a separate person to review. You do not implement anything now.

Follow the VCV guide at `$VCV_GUIDE` (proposals, change operations, the implementation request). The `vcv` command is on your PATH. It acts as you: an agent that may propose model changes but not apply or approve them.

1. Read the current model (`vcv project status .`, `vcv query .vcv overview`, `vcv query .vcv context <id>`) and the source evidence (`vcv evidence . overview`), then inspect the code and tests that the request touches yourself.
2. Decide what the request means for the model: which modules, data, rules or capabilities change. Model only what the request asks for, and say what you leave unchanged on purpose.
3. Write one typed change file at `$NOTES/change.yaml` with `expectedRevision` set to the current revision, a `rationale`, the smallest set of operations, and an `implementation` request (behavior, acceptance criteria, suggested tests, and the code `scope` as repository-relative paths or globs) for the reviewer to approve together with the model change.
4. Dry-run it with `vcv proposal preview . --file $NOTES/change.yaml`, read the delta, the cross-module impact and the diagnostics, and fix the file until it is valid. Then submit it: `vcv proposal submit . $NOTES/change.yaml`.
5. Write `$NOTES/proposal-notes.md`: what you observed in the code (with paths), what you inferred, what VCV validated (quote its output), and what is left for the reviewer.

Do not change source code, tests, binding claims or anything under `.vcv/`, and do not commit. Stop once your proposal is pending, or explain why you could not make one.
