import { parse, stringify } from "yaml";
import { checkModel } from "./validate.ts";
import type { CheckResult } from "./validate.ts";
import type { Model } from "./types.ts";

/** Parse YAML (or JSON, which is valid YAML) text and run full validation. */
export function loadModel(text: string): CheckResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { ok: false, diagnostics: [{ code: "PARSE", severity: "error", path: "", message: (e as Error).message }] };
  }
  return checkModel(raw);
}

/** Serialize a model to YAML. Output is deterministic for a given model. */
export function dumpModel(model: Model): string {
  return stringify(model, { lineWidth: 0 });
}

export function parseYaml(text: string): unknown {
  return parse(text);
}
