// The code-first path: vcv reconcile, tests, criteria and gate.
import { realpathSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import {
  reconcile,
  criteriaEvidence,
  preMergeGate,
  findWorkTreeRoot,
  captureTestRun,
  testIdentity,
  JUNIT_LIMITS,
} from "@vcv/repo";
import {
  InputError,
  a,
  b,
  captureInput,
  host,
  need,
  readBounded,
  readCoverage,
  readJson,
  rest,
  trustSource,
  values,
} from "../args.ts";
import { printGate, printReconciliation, printResultError } from "../print.ts";
import { USAGE } from "../usage.ts";

export function reconcileCommand(): number {
  const r = reconcile(need(a, "<path>"), {
    base: need(values.base, "--base"),
    ...(trustSource(null) ? { trust: trustSource(null) } : {}),
    requireAttestation: values["require-attestation"],
  });
  if (values.json || !r.ok) {
    console.log(JSON.stringify(r.ok ? r.data : r, null, 2));
    return r.ok ? 0 : 1;
  }
  printReconciliation(r.data);
  return 0;
}

export function testsCommand(): number {
  const path = need(b, "<path>");
  if (a === "identity") {
    const r = testIdentity(path);
    if (values.json || !r.ok) console.log(JSON.stringify(r.ok ? r.data : r, null, 2));
    else {
      const c = r.data.candidate;
      console.log(r.data.identityDigest);
      console.log(
        `  commit ${c.commit ?? "(none)"}${c.branch ? ` (${c.branch})` : ""}; ${c.uncommitted.paths} uncommitted path(s); model ${c.modelRevision}`,
      );
    }
    return r.ok ? 0 : 1;
  }
  if (a === "capture") {
    const junit = need(values.junit, "--junit");
    const r = captureTestRun(path, readBounded(junit, JUNIT_LIMITS.bytes), captureInput(), host());
    if (!r.ok) {
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else printResultError(r);
      return 1;
    }
    const text = `${JSON.stringify(r.data, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, text, { flag: "wx" });
    if (values.json || !values.out) process.stdout.write(text);
    else {
      const s = r.data.summary;
      console.log(
        `${values.out}: run captured by ${r.data.principalId}, declared ${r.data.observedBy}-observed (digest ${r.data.digest})`,
      );
      console.log(
        "  as a file this record is a claim: read back with --run it is never host-observed; use criteria --junit in the trusted job",
      );
      console.log(
        `  ${s.tests} case(s): ${s.passed} passed, ${s.failed} failed, ${s.errors} error(s), ${s.skipped} skipped; candidate ${r.data.identityDigest.slice(0, 12)} at ${r.data.candidate.commit?.slice(0, 12) ?? "(no commit)"}`,
      );
    }
    return 0;
  }
  console.log(USAGE);
  return 1;
}

export function criteriaCommand(): number {
  const ids = [b, ...rest].filter((x): x is string => !!x);
  const path = need(a, "<path>");
  const runs: unknown[] = (values.run ?? []).map((f) => readJson(f, "test-run record"));
  // --junit: capture here, in this process, and evaluate that very record (host-observed with tests:observe).
  if (values.junit) {
    const cap = captureTestRun(path, readBounded(values.junit, JUNIT_LIMITS.bytes), captureInput(), host());
    if (!cap.ok) {
      console.log(JSON.stringify(cap, null, 2));
      return 1;
    }
    runs.unshift(cap.data);
  }
  const r = criteriaEvidence(path, {
    ...(ids.length ? { ids } : {}),
    ...(runs.length ? { runs } : {}),
    ...(values.coverage ? { coverage: readCoverage(values.coverage) } : {}),
  });
  if (values.json || !r.ok) {
    console.log(JSON.stringify(r.ok ? r.data : r, null, 2));
    return r.ok ? 0 : 1;
  }
  const d = r.data;
  const c = d.counts;
  console.log(
    `acceptance criteria at ${d.modelRevision}: ${c.criteria} (${c.required} required, ${c.optional} optional); ${c.mappings} test mapping(s)`,
  );
  if (!d.mappingsAvailable) console.log(`  ! mappings NOT ASSESSED: ${d.mappingsProblem}`);
  else
    console.log(
      `  required: ${c.requiredUnmapped} unmapped, ${c.requiredNotResolved} not fully resolved${c.requiredIncomplete ? ` (${c.requiredIncomplete} with an incomplete assessment)` : ""}; optional: ${c.optionalUnmapped} unmapped`,
    );
  for (const run of d.runs) {
    const s = run.summary;
    console.log(
      `  run ${run.index}: ${run.observedBy === "host" ? "host-observed (captured here)" : `CLAIMED (${run.admittedAs}, declares ${run.declaredObservedBy})`} ${run.runner.name} by ${run.principalId}, ${s.tests} case(s) (${s.passed} passed, ${s.failed} failed, ${s.errors} error(s), ${s.skipped} skipped); suite ${run.green ? "green" : "red"}; ${run.fresh ? "describes this candidate" : `STALE: ${run.staleBecause.join("; ")}`}`,
    );
  }
  if (d.runs.length) {
    const q = d.results.required;
    console.log(
      `  required criteria: ${q.passed} passed, ${q.failed} failed, ${q.stale} stale, ${q.missing} missing, ${q.unknown} unknown`,
    );
  }
  if (d.coverage) console.log(`  coverage: ${d.coverage.linesPct}% lines (${d.coverage.source}); ${d.coverage.note}`);
  for (const n of d.notes) console.log(`  ! ${n.code}: ${n.message}`);
  if (d.invalidClaims.total) {
    console.log(
      `  ! ${d.invalidClaims.total} claim file(s) cannot be read; any of them may map a criterion, so the assessment is INCOMPLETE:`,
    );
    for (const x of d.invalidClaims.items) console.log(`    ${x.file}: ${x.problem}`);
  }
  for (const e of d.criteria) {
    console.log(
      `  ${e.id} [${e.verification}] ${e.result !== "unverified" ? `${e.result.toUpperCase()}${e.resultObservedBy ? (e.resultObservedBy === "host" ? " (host-observed)" : " (claimed, not host-observed)") : ""}; mapping ` : ""}${e.mapping}: ${e.statement}`,
    );
    console.log(`    verifies ${e.verifies.join(", ")}`);
    for (const m of e.mappings)
      console.log(
        `    ${m.state.padEnd(13)} ${m.result ? `${m.result.status.padEnd(8)} ` : ""}${m.test ? `${m.test.path} > ${m.test.name}` : `(${m.relation} claim)`}  [${m.bindingId}]${m.alsoMapsTo.length ? `  also ${m.alsoMapsTo.join(", ")}` : ""}`,
      );
    for (const p of e.problems) console.log(`    ! ${p.code}: ${p.message}`);
    if (e.mappingsTruncated || e.problemsTruncated)
      console.log(
        `    ! cut: ${e.mappings.length}/${e.mappingsTotal} mappings, ${e.problems.length}/${e.problemsTotal} problems`,
      );
  }
  if (d.truncated || d.testsTruncated || d.invalidClaims.truncated || d.budget.shrunk)
    console.log(`  ! lists were cut (report ${d.budget.bytes}/${d.budget.limit} bytes); use --json for totals`);
  console.log(`  ${d.meaning}`);
  return 0;
}

/**
 * The pre-merge gate (M4.4). Exit 0: pass or warn. 1: block. 2: usage or setup problem (never a pass).
 * --junit reports are captured here, in this process; --run records are claims.
 */
export function gateCommand(): number {
  const path = need(a, "<path>");
  const base = need(values.base, "--base");
  if (values.policy && values["policy-at-base"]) throw new InputError("give --policy or --policy-at-base, not both");
  const root = findWorkTreeRoot(path);
  let policy: unknown;
  if (values.policy) {
    // The policy is the host's: a file inside the candidate would let the candidate choose it.
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return resolvePath(p);
      }
    };
    if (root && (real(values.policy) + pathSep).startsWith(real(root) + pathSep)) {
      throw new InputError(
        "--policy is inside the candidate checkout; pass a host-owned file, or read it from the base with --policy-at-base",
      );
    }
    policy = readJson(values.policy, "gate policy");
  }
  // --before: the identity the host read BEFORE the tests ran. Without it the report is a claim.
  const junit = values.junit
    ? [
        {
          report: readBounded(values.junit, JUNIT_LIMITS.bytes),
          root: values.root ?? "",
          runner: captureInput().runner,
          invocation: captureInput().invocation,
          ...(values.before ? { before: values.before } : {}),
        },
      ]
    : [];
  if (values.before && !values.junit)
    throw new InputError(
      "--before goes with --junit: it is the identity the host read before running the tests that wrote that report",
    );
  const r = preMergeGate(
    path,
    {
      base,
      ...(junit.length ? { junit } : {}),
      ...(values.run?.length ? { runs: values.run.map((f) => readJson(f, "test-run record")) } : {}),
      ...(values.coverage ? { coverage: readCoverage(values.coverage) } : {}),
      ...(values.observations ? { observations: readJson(values.observations, "observations file") } : {}),
      ...(policy !== undefined ? { policy } : {}),
      ...(values["policy-at-base"] ? { policyAtBase: values["policy-at-base"] } : {}),
    },
    host(),
  );
  if (!r.ok) {
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else printResultError(r);
    return 2;
  }
  if (values.json) console.log(JSON.stringify(r.data, null, 2));
  else printGate(r.data);
  return r.data.decision === "block" ? 1 : 0;
}
