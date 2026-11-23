# ADR 0010: One writer at a time across VCV processes (M5.6a)

Status: **proposed for review** (2026-11-23). Design record for
[Issue #43](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/43). Replaces the
"single writer" assumption in [ADR 0003](0003-persistence.md), [ADR 0006](0006-mcp-adapter.md) and
[ADR 0007](0007-repository-projects.md).

## Context

The store's HEAD and fingerprint checks ([ADR 0007](0007-repository-projects.md) §2) detect that
the store moved after a change was validated. They are optimistic: two processes can both pass
the check and then both rename. Worse, a process that opens the store while another is between
"revision written" and "HEAD written" sees an unlisted revision file and recovery moves it to
`orphaned/`, after which the first writer's HEAD names a missing file. M5.4 will put a second
writer (the local UI host) next to the CLI and the agent's MCP/CLI session, so this has to be
closed before any browser-triggered write exists.

Selected coordination model (Issue #43, option A): a shared Core/store boundary with
process-safe filesystem serialization. No daemon, no server, no database, no platform `flock`.

## Decision

- **One lock per store.** `<store>/cache/writer.lock` (`.vcv/cache/writer.lock` in a checkout).
  `cache/` is already local state: ignored by `.vcv/.gitignore`, not part of
  `storeFingerprint()`, never read by recovery or the integrity check. Taking the lock changes
  neither Git status nor what a reader sees.
- **Acquisition is an exclusive hard link.** The owner record (`token`, `pid`, `thread`, `host`,
  Linux `boot` ID, `acquiredAt`, `purpose`) is written and fsynced to a temp file, which is then
  `link()`ed to `writer.lock`. `link` fails with `EEXIST` if the lock exists, atomically, on
  POSIX and on NTFS, so the lock file is never half written. A waiting writer retries with
  jittered backoff (2 ms doubling to 100 ms) for up to 30 s (`VCV_LOCK_TIMEOUT_MS`), then fails
  with `LOCKED`, naming the holder. Nothing is written in that case.
- **Release checks the token.** A writer only deletes a lock whose token is its own.
- **Stale locks are broken only when the holder provably cannot be running:** same host and
  (another boot, or a PID that no longer exists, or this same thread without the lock in its
  table). A lock from another host is never broken automatically; the `LOCKED` message says
  which file to delete if no VCV process is running. An unreadable lock file (VCV never writes
  one) is broken once it is 10 s old. Breaking runs under a short-lived `writer.lock.break`
  guard and renames the lock aside first, then discards it only if it is still the exact file
  that was judged stale, so two breakers cannot delete a fresh lock.
- **Reentrant within a thread.** A repo operation that holds the lock can open a `FileStore` and
  call the engine, which take the same lock again without waiting.
- **What runs under it.** Everything that writes or moves store files, and the read/check step
  that the write depends on:
  - `FileStore`: open-time recovery, `sync()` recovery after the store changed, `commit()`,
    `putChange()`.
  - `ModelEngine.propose()` and `approve()`: the whole snapshot → replay/pending check →
    validation → write, via the optional `ModelStore.exclusive()`. A contender that waited sees
    the winner's result in its own snapshot, so it fails with the normal deterministic codes
    (`STALE_REVISION`, `DUPLICATE_CHANGE`, `NOT_PENDING`), never `STORE_CHANGED` from a race.
  - `@vcv/repo`: `submitProposal` (the replay check, the engine call and its "HEAD did not
    move" guarantee), `reviewApprove` (engine commit and the signed attestation in one hold, so
    the attestation is signed over the record that commit produced), `reviewFinalize`,
    `addTrustedReviewer`, binding claim writes and implementation report writes.
  - Read-only paths (`FileStoreReader`, `projectStatus`, previews, the integrity check, the UI's
    read API and its drafts) take no lock and never wait.
- **The store's own rechecks stay.** After the lock is taken, `HEAD_CHANGED` / `STORE_CHANGED`,
  change identity (`previous` record) and the approval digest are still checked exactly as
  before. They are what catch writers that do not take the lock.

## Threat model: what is guaranteed

Guaranteed, for **cooperating VCV writers** (any process using `@vcv/core`'s `FileStore` or the
`@vcv/repo` write functions, on one machine, on a local filesystem with working `link`, `rename`
and `fsync`):

- Writes to one store are serialized. No accepted revision, applied record, pending record or
  attestation is lost or overwritten by a concurrent VCV writer. Revision IDs and change IDs stay
  immutable; no change is retargeted onto another base.
- Each decision (validate, approve, attest) is made on the state the previous writer left.
- An approval's attestation always carries the digest of the record it committed.
- A crashed or killed writer does not wedge the store: its lock is broken by the next writer on
  the same host, and the usual recovery (ADR 0003) then runs under the lock.

Not guaranteed:

- **External actors do not take the lock.** `git checkout`, `pull`, `merge`, an editor or a
  script can still change `.vcv/` at any time. VCV detects that (HEAD/fingerprint/record checks
  under the lock, and recovery's conflict/divergence refusals) and writes nothing, but it does not
  prevent it, and a checkout that lands inside a single `rename` is not detected.
- **Other hosts.** A store on a network share used from two machines is not supported: PID
  liveness is local, so a remote holder is never judged stale, and network filesystems may not
  honour `link`/`fsync` semantics.
- **PID reuse.** A holder that died and whose PID was reused by an unrelated live process on
  the same boot keeps its lock until a person deletes it; the `LOCKED` error says how.
- **Authority.** The lock orders writers; it does not authorize them. Approval authority still
  comes only from the reviewer's private key, the trust list read from the protected base and
  the CI integrity gate ([ADR 0008](0008-model-first-changes.md)). Nothing here gives the UI or
  an agent `model:approve` or a key.

## How M5.4 relies on this

A future UI host write (for example submitting a draft as a pending proposal) calls the same
`submitProposal` as the CLI, and so takes the same lock and gets the same deterministic result
codes. It must not add its own mutex, and it must not call `FileStore` write methods outside
`@vcv/repo`. Approval stays CLI-only (`vcv review approve`).

## Evidence

- `packages/core/test/concurrency.test.ts`: real Node processes racing `propose` (5 at once, one
  wins, the rest are `STALE_REVISION`); a writer paused between revision and HEAD while another
  opens and proposes; 6 distinct pending proposals; 4 submissions of one ID (one recorded, intact);
  approve vs approve; approve vs apply; a process exiting at each commit step and one killed with
  `SIGKILL` while holding the lock; a live holder is never stolen (`LOCKED` names it); lock rules
  (reentrancy, foreign host, unreadable lock age, token-checked release, symlinked `cache/`); a
  branch swap while the lock is held is still refused.
- `packages/repo/test/concurrency.test.ts`: `reviewApprove` from two processes with two trusted
  reviewers (one attestation, signed over the reviewed digest); approval vs submission; a
  reviewer process dying after the commit, then `reviewFinalize`; the lock never shows in
  `git status`.
- With the lock temporarily disabled, the propose vs propose, paused-writer, distinct-ID and
  approve vs apply tests fail (contenders refused with `STORE_CHANGED` or lost, an orphaned
  revision).
