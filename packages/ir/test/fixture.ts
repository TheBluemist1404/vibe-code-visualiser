import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../src/index.ts";
import type { Model } from "../src/index.ts";

export const FIXTURE_DIR = join(import.meta.dirname, "../../../examples/enrollment");
export const fixtureText = () => readFileSync(join(FIXTURE_DIR, "model.rev-1.yaml"), "utf8");
export const fixtureRaw = () => parseYaml(fixtureText()) as Model;

/** A fresh copy of the valid fixture with one deliberate edit applied. */
export function broken(edit: (m: Model) => void): Model {
  const m = fixtureRaw();
  edit(m);
  return m;
}

export const approval = (m: Model) => m.behaviors.find((b) => b.id === "beh-enrollment-approval")!;
export const notifications = (m: Model) => m.modules.find((x) => x.id === "mod-notifications")!;
