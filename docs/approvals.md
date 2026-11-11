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
| `.vcv/reviewers.json` in the working tree     | yes                         | only with `--trust-working-tree`, flagged as unprotected |
| `.vcv/reviewers.json` at a protected Git ref  | only by a reviewed push     | yes (default `HEAD`; use the base branch in CI) |
| an Ed25519 private key kept outside the checkout and any agent sandbox | no, unless it is leaked | yes, this is the identity |

The boundary is therefore **a private key the agent cannot read**, matched against a **trust
list read from a ref the agent cannot push to**. Everything else is reported, never trusted.

What VCV cannot prove, and says so in every integrity report (`limits`):

- which person held a key, or that a key was not shared or stolen;
- that the trust list itself is right: it is only as strong as the branch protection on the ref
  it is read from;
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
    [--trust-ref <ref> (default HEAD) | --trust <file> | --trust-working-tree] [--json]
```

- It refuses to run under `VCV_HOST_PRINCIPAL` / `VCV_HOST_PERMISSIONS` or with `--as` /
  `--perm` (exit 2): those mark an agent host.
- `--digest` binds the decision to the content the reviewer saw. If the proposal differs (the
  agent re-submitted under the same ID, or the file was edited), the engine refuses with
  `DIGEST_MISMATCH`, leaves the record pending, and audits the attempt.
- The key must be in the trust list (`UNTRUSTED_KEY` otherwise). The usual engine rules still
  apply: `SELF_APPROVAL` (a trusted key whose ID is the proposer's), `NOT_PENDING` (replay),
  `STALE_REVISION`, `UNKNOWN_CHANGE`.
- On success the change is applied as the next revision (`.vcv/HEAD` moves) and VCV writes a
  signed attestation to `.vcv/approvals/<changeId>.json`. Commit it with the change record and
  the new revision, alongside the code in the same PR.

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
vcv integrity <checkout> [--base <ref>] [--trust-ref <ref> | --trust <file> | --trust-working-tree] \
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
history that main already has. An `invalid` attestation is always an error. A revision
introduced without a valid attestation is a warning by default and an error with
`--require-attestation`. Other checks: `HEAD_WITHOUT_LAST_COMMIT`, `HEAD_RECORD_MISMATCH`,
`ORPHAN_APPLIED_RECORD`, `STRAY_ATTESTATION`, and `TRUST_FROM_CHECKOUT` when the trust list
comes from the working tree.

### In CI

Read the base and the trust list from the protected branch, never from the PR's own tree:

```yaml
# .github/workflows/vcv.yml (excerpt)
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }          # the base ref must be present
- run: npm ci && npm run vcv -- integrity . --base origin/main --trust-ref origin/main --require-attestation
```

Protect `main` so that changes to `.vcv/reviewers.json` need a human review. A PR that adds the
agent's own key to `reviewers.json` can then sign locally (with `--trust-working-tree`), but CI
reports that key as `untrusted-key` and fails.

## What this does not do

No MCP approval tool (approval is a human step outside the agent host), no key revocation list
or expiry (remove the entry from the trust list on the protected branch), no implementation
handoff (M3.3), no reconciliation of code and model (M4).
