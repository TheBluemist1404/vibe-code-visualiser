// The model-first path: vcv proposal, reviewer, review, integrity, handoff and implementation.
import {
  addTrustedReviewer,
  checkIntegrity,
  createReviewerKey,
  reviewApprove,
  buildHandoff,
  recordImplementation,
  implementationStatus,
  reviewFinalize,
  listProposals,
  previewProposal,
  submitProposal,
} from "@vcv/repo";
import {
  InputError,
  a,
  b,
  cmd,
  host,
  need,
  num,
  readProposalFile,
  refuseAssertedIdentity,
  rest,
  trustSource,
  values,
} from "../args.ts";
import { printHinted, printIntegrity, printOutcome, printPreview, printResultError, printWarnings } from "../print.ts";
import { USAGE } from "../usage.ts";

export function handoffCommand(): number {
  const r = buildHandoff(need(a, "<path>"), need(b, "<changeId>"));
  console.log(JSON.stringify(r.ok ? r.data : r, null, 2));
  return r.ok ? 0 : 1;
}

export function implementationCommand(): number {
  const path = need(b, "<path>");
  if (a === "record") {
    const r = recordImplementation(
      path,
      readProposalFile(need(values.report, "--report")),
      host(),
      values.expect ?? null,
    );
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else if (!r.ok) printResultError(r);
    else {
      const o = r.data.report.vcvObserved;
      console.log(`${r.data.file}: ${r.data.replaced ? "replaced" : "recorded"} (digest ${r.data.digest})`);
      console.log(
        `  change ${r.data.report.changeId} approved as ${r.data.report.approvedRevision}; claimed by ${r.data.report.agentClaims.claimedBy}; not reconciled`,
      );
      console.log(
        `  ${o.filesModified.length} source file(s) changed since ${o.baseCommit.slice(0, 12)}, ${o.outOfScope.length} outside the approved scope; ${o.bindings.filter((x) => x.reasserted).length}/${o.bindings.length} affected binding(s) reasserted`,
      );
      printWarnings(r.data.report.warnings);
    }
    return r.ok ? 0 : 1;
  }
  if (a === "show") {
    const r = implementationStatus(path, need(rest[0], "<changeId>"));
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else if (!r.ok) printResultError(r);
    else {
      console.log(
        `${r.data.file} (digest ${r.data.digest}): change ${r.data.report.changeId} at ${r.data.report.approvedRevision}; not reconciled`,
      );
      console.log(
        `  observed now: ${r.data.now.filesModified.length} source file(s) changed, ${r.data.now.outOfScope.length} out of scope${r.data.changedSinceReport ? "; DIFFERENT from the recorded report" : "; same as recorded"}`,
      );
      printWarnings(r.data.warningsNow);
    }
    return r.ok ? 0 : 1;
  }
  console.log(USAGE);
  return 1;
}

export function proposalCommand(): number {
  const path = need(b, "<path>");
  switch (a) {
    case "submit": {
      const r = submitProposal(path, readProposalFile(rest[0]), host());
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else if (!r.ok) printResultError(r);
      else {
        const d = r.data;
        console.log(
          `${d.changeId ?? "(no change id)"}: ${d.status}${d.recorded ? " (recorded)" : " (not recorded)"}; .vcv/HEAD stays at ${d.modelRevision.after}`,
        );
        if (d.proposalDigest) console.log(`  digest: ${d.proposalDigest}`);
        printHinted(d.diagnostics);
        console.log(`  ${d.next}`);
      }
      return r.ok && r.data.ok ? 0 : 1;
    }
    case "preview": {
      if ((rest[0] === undefined) === (values.file === undefined))
        throw new InputError("pass a change ID or --file <change.yaml>, not both");
      const req = {
        ...(values.file !== undefined ? { change: readProposalFile(values.file) } : { changeId: rest[0] }),
        ...(values.limit !== undefined ? { limit: num(values.limit) } : {}),
      };
      const r = previewProposal(path, req);
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else if (!r.ok) printResultError(r);
      else printPreview(r.data, r.context.modelRevision);
      return r.ok ? 0 : 1;
    }
    case "list": {
      const lifecycles = values.states
        ?.split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const r = listProposals(path, {
        ...(lifecycles ? { lifecycles } : {}),
        ...(values.limit !== undefined ? { limit: num(values.limit) } : {}),
      });
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else if (!r.ok) printResultError(r);
      else {
        for (const p of r.data.proposals) {
          console.log(
            `${p.changeId}  ${p.lifecycle}${p.stale ? ` (${p.stale.reason})` : ""}  by ${p.proposerId ?? "?"}  base ${p.baseRevision ?? "?"}${p.resultingRevision ? ` → ${p.resultingRevision}` : ""}  ${p.operations} op(s)${p.problem ? `  ${p.problem}` : ""}`,
          );
        }
        if (r.data.truncated) console.log(`… ${r.data.matched} in all`);
      }
      return r.ok ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return 1;
  }
}

export function reviewCommand(): number {
  if (cmd === "reviewer") {
    if (a !== "init") {
      console.log(USAGE);
      return 1;
    }
    refuseAssertedIdentity("vcv reviewer init");
    const entry = createReviewerKey(need(values.id, "--id"), need(b, "<key-file>"));
    console.log(`private key written to ${b} (mode 0600). Keep it outside the repository and any agent sandbox.`);
    console.log("trust-list entry (add it to .vcv/reviewers.json through a reviewed PR to the protected branch):");
    console.log(JSON.stringify(entry, null, 2));
    if (values.add !== undefined) console.log(`added to ${addTrustedReviewer(values.add, entry)}; commit it`);
    return 0;
  }
  if (a !== "approve" && a !== "finalize") {
    console.log(USAGE);
    return 1;
  }
  refuseAssertedIdentity(`vcv review ${a}`);
  const path = need(b, "<path>");
  const trust = trustSource(null);
  if (!trust)
    throw new InputError(
      "a trust anchor is required: --trust-commit <full commit ID of the protected base, from the hosting service> [--trust-ref origin/main], or --trust <reviewer-owned file outside the checkout> (--trust-working-tree is an unsafe development mode)",
    );
  const unsafe = trust.kind === "working-tree";
  if (unsafe)
    console.log(
      "! UNSAFE development mode: the trust list comes from the checkout under review; this is not a trusted approval and a strict integrity check rejects it",
    );
  const input = {
    changeId: need(rest[0], "<changeId>"),
    expectedDigest: need(values.digest, "--digest"),
    keyFile: need(values.key, "--key"),
    trust,
    allowUnprotectedTrust: unsafe,
  };
  const r = a === "approve" ? reviewApprove(path, input) : reviewFinalize(path, input);
  console.log(`reviewer: ${r.reviewer.id} (key ${r.reviewer.keyFingerprint}, trusted per ${r.reviewer.trustSource})`);
  console.log(`  trust anchor: ${r.reviewer.trustAnchor}`);
  console.log(`  ! authorization ${r.authorization}`);
  const code = printOutcome(r.outcome);
  if (r.attestation)
    console.log(
      `  attestation: ${r.attestation.file}${r.attestation.alreadyPresent ? " (already present; unchanged)" : " (commit it with the change record and the new revision)"}`,
    );
  return code;
}

export function integrityCommand(): number {
  const r = checkIntegrity(need(a, "<path>"), {
    trust: trustSource(null),
    ...(values.base !== undefined ? { base: values.base } : {}),
    requireAttestation: values["require-attestation"],
  });
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else printIntegrity(r);
  return r.ok ? 0 : 1;
}
