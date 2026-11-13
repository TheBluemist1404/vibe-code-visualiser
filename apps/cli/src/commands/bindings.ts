// vcv binding … and vcv evidence …: source binding claims and read-only evidence queries.
import {
  BindingError,
  createEvidenceApi,
  disputeBinding,
  formatLocator,
  listBindings,
  readBinding,
  recordBinding,
  removeBinding,
  verifyBinding,
  verifyBindings,
} from "@vcv/repo";
import type { Verification } from "@vcv/repo";
import type { BindingRelation } from "@vcv/core";
import { InputError, a, b, bindingHost, host, locatorArg, need, num, rest, values } from "../args.ts";
import { printVerification } from "../print.ts";
import { USAGE } from "../usage.ts";

export function bindingCommand(): number {
  const path = need(b, "<path>");
  const id = rest[0];
  switch (a) {
    case "add": {
      const conf = values.confidence === undefined ? undefined : Number(values.confidence);
      const r = recordBinding(
        path,
        {
          ...(values.id ? { bindingId: values.id } : {}),
          modelObjectId: need(values.object, "--object"),
          relation: need(values.relation, "--relation") as BindingRelation,
          locator: locatorArg(),
          ...(values.rationale !== undefined ? { rationale: values.rationale } : {}),
          ...(conf !== undefined ? { confidence: conf } : {}),
          ...(values.revision ? { modelRevision: values.revision } : {}),
          allowUnchecked: values["allow-unchecked"],
        },
        bindingHost(),
        null,
      );
      console.log(`${r.entry.bindingId}: recorded (${r.resolution.state}: ${r.resolution.detail})`);
      console.log(`  digest: ${r.entry.digest}`);
      console.log(`  file:   ${r.entry.file} (commit it with the code; the model revision is unchanged)`);
      return 0;
    }
    case "reassert": {
      const bindingId = need(id, "<bindingId>");
      const expected = need(values.expect, "--expect");
      const old = readBinding(path, bindingId);
      if (!old?.claim)
        throw new BindingError(
          old ? "INVALID_CLAIM" : "NOT_FOUND",
          old ? `binding ${bindingId} is unreadable: ${old.problem}` : `binding ${bindingId} does not exist`,
        );
      const conf = values.confidence === undefined ? undefined : Number(values.confidence);
      const r = recordBinding(
        path,
        {
          bindingId,
          modelObjectId: old.claim.modelObjectId,
          relation: old.claim.relation,
          locator: locatorArg(),
          ...(values.rationale !== undefined ? { rationale: values.rationale } : {}),
          ...(conf !== undefined ? { confidence: conf } : {}),
          ...(values.revision ? { modelRevision: values.revision } : {}),
          allowUnchecked: values["allow-unchecked"],
        },
        bindingHost(),
        expected,
      );
      console.log(`${bindingId}: reasserted (${r.resolution.state}: ${r.resolution.detail})`);
      console.log(`  digest: ${r.entry.digest}`);
      return 0;
    }
    case "remove":
      removeBinding(path, need(id, "<bindingId>"), { ...host(), source: "human" }, need(values.expect, "--expect"));
      console.log(`${id}: removed`);
      return 0;
    case "dispute": {
      const e = disputeBinding(
        path,
        need(id, "<bindingId>"),
        need(values.reason, "--reason"),
        { ...host(), source: "human" },
        need(values.expect, "--expect"),
      );
      console.log(`${id}: disputed by ${host().principalId}`);
      console.log(`  digest: ${e.digest}`);
      return 0;
    }
    case "list": {
      const entries = listBindings(path);
      if (values.json) console.log(JSON.stringify(entries, null, 2));
      else
        for (const e of entries)
          console.log(
            `${e.bindingId}  ${e.digest}  ${e.claim ? `${e.claim.modelObjectId} ${e.claim.relation} ${formatLocator(e.claim.locator)}` : `invalid: ${e.problem}`}`,
          );
      return 0;
    }
    case "verify": {
      let vs: Verification[];
      if (id) {
        const e = readBinding(path, id);
        if (!e) throw new BindingError("NOT_FOUND", `binding ${id} does not exist`);
        vs = [verifyBinding(path, e)];
      } else vs = verifyBindings(path);
      if (values.json) console.log(JSON.stringify(vs, null, 2));
      else vs.forEach(printVerification);
      return vs.every((v) => v.state === "resolved") ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return 1;
  }
}

export function evidenceCommand(): number {
  const api = createEvidenceApi(need(a, "<path>"));
  const list = (v: string | undefined) =>
    v === undefined
      ? undefined
      : v
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
  let request: Record<string, unknown>;
  if (values.request !== undefined) {
    try {
      request = JSON.parse(values.request);
    } catch {
      throw new InputError("--request must be a JSON object");
    }
  } else {
    const opt = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    const common = { expectedRevision: values["expected-revision"], limit: num(values.limit), cursor: values.cursor };
    request =
      b === "overview"
        ? opt({ ...common, states: list(values.states) })
        : b === "object"
          ? opt({
              ...common,
              id: rest[0],
              relations: list(values.relations),
              selectorKinds: list(values["selector-kinds"]),
              states: list(values.states),
            })
          : b === "binding"
            ? opt({ expectedRevision: values["expected-revision"], bindingId: rest[0] })
            : b === "refresh"
              ? opt({ ...common, bindingIds: rest.length ? rest : undefined, since: values.since })
              : {};
  }
  const result =
    b === "overview"
      ? api.getEvidenceOverview(request as never)
      : b === "object"
        ? api.getObjectEvidence(request as never)
        : b === "binding"
          ? api.getBindingEvidence(request as never)
          : b === "refresh"
            ? api.refreshEvidence(request as never)
            : undefined;
  if (!result) {
    console.log(USAGE);
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}
