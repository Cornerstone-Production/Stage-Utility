import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error: a plain .mjs script with no type declarations
import { deployPlan } from "../scripts/deploy.mjs";

const CONFIG = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");

describe("deployPlan", () => {
  test("with no local file it is a plain deploy on workers.dev", () => {
    assert.deepEqual(deployPlan(null, CONFIG), { args: ["deploy"], config: null });
  });

  test("a local domain is attached on every deploy, so a deploy never drops it", () => {
    assert.deepEqual(deployPlan({ domain: "servicecue.example.org" }, CONFIG).args, ["deploy", "--domain", "servicecue.example.org"]);
  });

  test("workersDev false deploys a copy of the config with workers.dev off, and nothing else changed", () => {
    const { config } = deployPlan({ workersDev: false }, CONFIG);
    assert.equal(config, CONFIG.replace('"workers_dev": true', '"workers_dev": false'));
    assert.match(CONFIG, /"workers_dev": true/, "the committed config keeps workers.dev on for a fresh install");
  });

  test("a domain that is not a host name is refused before wrangler runs", () => {
    for (const bad of ["", "servicecue", "https://servicecue.example.org", "a.example.org/x", 7]) {
      assert.throws(() => deployPlan({ domain: bad }, CONFIG), /not a host name/, String(bad));
    }
  });
});
