# Trusted approval and the integrity check (M3.2)

The second step of the model-first path in
[Issue #17](https://github.com/TheBluemist1404/vibe-code-visualiser/issues/17). After an agent
submits a proposal ([proposals.md](proposals.md)), a **separate human reviewer** approves the
exact content they previewed, VCV persists the next canonical `.vcv/` revision, and anyone (CI
in particular) can check, read-only, that every revision in the checkout is explained by an
approved change.

Design notes: [ADR 0008](adr/0008-model-first-changes.md#m32-decisions).

## Threat model

The agent that proposes a change usually runs a shell in the same checkout as the reviewer's
tools. So the reviewer's identity must not come from anything that agent can set:

| Claimed by                                   | Spoofable by a shell agent? | Used by `vcv review approve`? |
| -------------------------------------------- | --------------------------- | ----------------------------- |
| `--as` / `--perm` flags                       | yes                         | no, refused                   |
| `VCV_HOST_PRINCIPAL` / `VCV_HOST_PERMISSIONS` | yes                         | no, refused                   |
| a principal ID written in a change record    | yes (edit the file)         | no, only reported             |
| `.vcv/reviewers.json` in the working tree, a file inside the checkout, or `HEAD` / the checked-out branch / a commit only it contains | yes (commit it on the feature branch) | refused (`UNPROTECTED_TRUST`); only `--trust-working-tree`, an explicit unsafe development mode |
| any other local ref name: a tag, a second branch, even `origin/main` (`git tag`, `git branch`, `git update-ref`) | yes | refused for approval (`UNPROTECTED_TRUST`); accepted by `vcv integrity` where the host provides the ref (CI) |
| `.vcv/reviewers.json` at a commit the reviewer pins by full ID, copied from the hosting service's protected branch (`--trust-commit <sha>`) | no: a commit ID cannot be forged, and a ref that does not resolve to it is refused (`TRUST_PIN_MISMATCH`) | yes |
| a reviewer-owned trust file outside the checkout (`--trust <file>`) | only if the agent can write there | yes |
| an Ed25519 private key kept outside the checkout and any agent sandbox | no, unless it is leaked | yes, this is the identity |

### Where authorization is actually established

Two things together are the boundary: **a private key the agent cannot read**, and **the host
gate**: `vcv integrity` run by the hosting service's CI, reading the base and its trust list
from the protected branch, in a required check the change under review cannot edit. A change
is authorized when it passes that gate, and not before.

`vcv review approve` cannot be that boundary on its own. It runs in a shell the coding agent
may share, and anything it is told about where the trust list came from is the caller's word:
a pinned commit ID is an **immutability pin, not proof of origin** (an agent can commit its own
key, tag the commit and pass that tag with that SHA), and a file outside the checkout is only as
safe as its write permissions. So VCV labels every local anchor **caller-asserted** and says, on
every approval, that it is evidence for the gate, not authorization. What it still enforces
locally:

- the candidate is refused outright: `HEAD`, `@`, the checked-out branch under any spelling, a
  commit only it contains, any trust file inside the checkout (resolved, parent symlinks
  followed), the working tree (except in explicit unsafe development mode);
- a bare local ref name (tag, branch, `origin/main`) is refused, because anyone with a shell can
  create or move one; the reviewer must pin the commit (`--trust-commit <full ID>`, copied from
  the hosting service, with the ref, if given, resolving to exactly it) or use their own file
  (`--trust <file>`);
- the approver identity comes only from the key, the content only from the reviewed digest.

An agent that signs with its own key under its own anchor gets a locally applied, signed,
caller-asserted approval, and then fails the host gate: its key is not in the protected base's
trust list (`untrusted-key`), and an integrity check whose trust anchor is not the base under
check (or an ancestor of it) reports `TRUST_NOT_FROM_BASE`.

What VCV cannot prove, and says so in every integrity report (`limits`):

- which person held a key, or that a key was not shared or stolen;
- where a trust anchor came from: every anchor given on the command line is caller-asserted;
  the trust list is only as strong as the branch protection and the CI setup that supply it;
- who created the initial revision (`vcv project init` has no recorded derivation);
- that the source code implements the model (that is M4's reconciliation);
- anything from `.vcv/audit.jsonl`, which is local and not shared through Git.

## Setting up a reviewer

```sh
vcv reviewer init ~/.config/vcv/hoang.pem --id user:hoang [--add <checkout>]
```

This writes a new Ed25519 private key (mode 0600, never overwrites an existing file) and prints
the trust-list entry. `--add` appends it to `<checkout>/.vcv/reviewers.json`; commit that
through a reviewed PR to the protected branch. The format is:

```json
{
  "format": 1,
  "reviewers": [
    { "id": "user:hoang", "publicKey": "ed25519:<base64 SPKI DER>", "permissions": ["model:approve"] }
  ]
}
```

A key may appear only once. The reviewer's principal ID is the `id` of the entry whose
public key matches the private key, so "who approved" comes from the trust list, not from the
reviewer's shell.

## Approving: `vcv review approve`

```sh
vcv proposal preview <checkout> chg-cancel-enrollment     # shows proposalDigest
vcv review approve <checkout> chg-cancel-enrollment \
    --digest <proposalDigest> --key ~/.config/vcv/hoang.pem \
    (--trust-commit <sha from the hosting service> [--trust-ref origin/main]
     | --trust <reviewer-owned file outside the checkout> | --trust-working-tree)
```

- A trust anchor is required; there is no default. Anything but a pinned commit or an
  external file is refused before anything is applied (`UNPROTECTED_TRUST`), including a tag,
  a second branch or a locally moved `origin/main`. `--trust-working-tree` is an explicit
  **unsafe development mode**: the change is applied and signed, the command says it is not a
  trusted approval, and a strict integrity check rejects it.
- It refuses to run under `VCV_HOST_PRINCIPAL` / `VCV_HOST_PERMISSIONS` or with `--as` /
  `--perm` (exit 2): those mark an agent host.
- `--digest` binds the decision to the content the reviewer saw. If the proposal differs (the
  agent re-submitted under the same ID, or the file was edited), the engine refuses with
  `DIGEST_MISMATCH`, leaves the record pending, and audits the attempt.
- The key must be in the trust list (`UNTRUSTED_KEY` otherwise). The usual engine rules still
  apply: `SELF_APPROVAL` (a trusted key whose ID is the proposer's), `NOT_PENDING` (replay),
  `STALE_REVISION`, `UNKNOWN_CHANGE`.
- Before anything is committed it checks that the attestation can be written:
  `.vcv/approvals/` must be a plain, writable directory (or absent), and no attestation for this
  change may exist yet (`UNSAFE_PATH`, `ATTESTATION_EXISTS`; nothing is approved).
- On success the change is applied as the next revision (`.vcv/HEAD` moves) and VCV writes a
  signed attestation to `.vcv/approvals/<changeId>.json`, created exclusively (an existing file
  is never replaced). Commit it with the change record and the new revision, alongside the code
  in the same PR.

### If the attestation write fails: `vcv review finalize`

The model commit and the attestation are two writes. If the second fails after the first (disk
full, a crash, a directory changed in between), the command fails with
`ATTESTATION_NOT_WRITTEN` and prints the recovery command. The change is now applied, so
`approve` cannot be repeated (`NOT_PENDING`), and a strict integrity check fails until the
attestation exists. To finish it:

```sh
vcv review finalize <checkout> <changeId> --digest <proposalDigest> --key <key-file> --trust-commit <sha>
```

It signs and writes only the attestation (the model and the record are untouched), and only
when: the change is applied and its revision is in the current history; the key is trusted by
an anchor outside the candidate branch; the key's principal is the approver the record names
(`NOT_APPROVER` otherwise) and not the proposer; and the digest matches (`DIGEST_MISMATCH`).
It is idempotent: the same reviewer's valid attestation is reported as already present, and a
different existing file is never overwritten (`ATTESTATION_EXISTS`). It never applies a
pending change (`NOT_APPLIED`). Signing with `finalize` means the approver vouches for that
applied content, so preview it first.

The attestation signs `"vcv-approval-v1\0" + canonicalJson(body)`, where the body holds the
change ID, project ID, proposal digest, proposer, approver, base and resulting revision, the
public key and its fingerprint, and the time. It is checked against the change record field by
field, so editing either one breaks it.

The older `vcv approve` still works for local development. It prints a note and writes no
attestation, so its revisions show as `missing` provenance in the integrity check.

**Change approval is not snapshot approval.** Approving a change moves the model to a new
revision; it does not mark a draft model as approved. That is the separate `approveDraft`
operation, itself a change that goes through the same proposal and review.

## Checking: `vcv integrity`

```sh
vcv integrity <checkout> [--base <ref>] [--trust-ref <ref> [--trust-commit <sha>] | --trust <file> | --trust-working-tree] \
    [--require-attestation] [--json]
```

Read-only; it writes nothing, not even an audit line. Exit 0 when there are no errors, 1
otherwise. For each revision in `.vcv/HEAD`'s history it reports:

- **derivation**: `initial` (rev-1), or `verified` when replaying the applied change record's
  typed operations on the parent revision produces exactly this revision. Otherwise
  `no-record`, `ambiguous`, `base-mismatch`, `invalid-change`, `failed` or `mismatch`, each an
  error: a hand-made or edited revision is caught here.
- **approval**: `attested` (a valid signature by a key the trust list lists for that approver),
  `missing` (no attestation: direct apply or `vcv approve`), `untrusted-key`,
  `trust-unavailable` (no trust source given), `invalid` (present but does not verify or does
  not match the record) or `not-applicable` (rev-1).
- **introduced**: whether the revision is new relative to `--base`.

With `--base`, the base's model history must be a prefix of the checkout's
(`BASE_HISTORY_REWRITTEN`, `BASE_REVISION_CHANGED` otherwise), so a PR cannot quietly replace
history that main already has. The base's evidence must survive too: every attestation the
base has, and every change record the base already settled (applied or rejected), must be
byte-identical here (`BASE_EVIDENCE_REMOVED`, `BASE_EVIDENCE_CHANGED`, always errors), so a
branch cannot quietly delete the proof of an earlier approval. Pending base records may still
be decided on the branch, and legacy unattested base revisions are not required to gain a
signature. An `invalid` attestation is always an error. A revision
introduced without a valid attestation is a warning by default and an error with
`--require-attestation`. Other checks: `HEAD_WITHOUT_LAST_COMMIT`, `HEAD_RECORD_MISMATCH`,
`ORPHAN_APPLIED_RECORD`, `STRAY_ATTESTATION`, `TRUST_NOT_FROM_BASE` when `--base` is given and
the trust anchor is neither that base nor an ancestor of it (an error with
`--require-attestation`), and `TRUST_FROM_CHECKOUT` when the trust list
comes from the candidate (working tree, a file inside the checkout, `HEAD` or the checked-out
branch): a warning by default, an error with `--require-attestation`, so a strict check never
passes on self-controlled trust. Every report carries `authorization`: `ok` means consistent and
attested under the anchor given; it authorizes only when the host supplied that anchor.

### In CI: the authorization gate

Read the base and the trust list from the protected branch, never from the PR's own tree, and
make sure the check itself is one the PR cannot change:

```yaml
# .github/workflows/vcv.yml (excerpt)
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }          # the base ref must be present
- run: npm ci && npm run vcv -- integrity . --base origin/main --trust-ref origin/main --require-attestation
```

- Make it a **required status check** on `main`, and protect `main` so that changes to
  `.vcv/reviewers.json` and to the workflow file need a human code-owner review (for example
  CODEOWNERS on `.vcv/reviewers.json` and `.github/workflows/`). A `pull_request` workflow runs
  the PR's own copy of the workflow file, so without that protection a PR could edit the gate.
- If you run it from `pull_request_target` instead, check out and run VCV from the base, and
  treat the PR head only as data to read; never install or run the PR's code there.

A PR that adds the agent's own key to `reviewers.json` and signs with it locally then fails
here: the key is `untrusted-key` under the protected base's list.

## What this does not do

No MCP approval tool (approval is a human step outside the agent host), no key revocation list
or expiry (remove the entry from the trust list on the protected branch), no implementation
handoff (M3.3), no reconciliation of code and model (M4).
