// The public-hygiene workflow (.github/workflows/public-hygiene.yml).
//
// The script is tested over real repos in check-public-hygiene.test.ts. This pins
// the part that test cannot see: how the workflow calls it. The workflow is
// parsed, not searched, so a comment naming PRIVATE_TERMS cannot satisfy it. If
// the secret stops reaching the script, the check still goes green on every PR
// and says only "PRIVATE_TERMS not set", which is how a guard dies quietly.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(HERE, "..", ".github", "workflows", "public-hygiene.yml");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Workflow {
  on: Record<string, { paths?: string[]; "paths-ignore"?: string[] } | null>;
  permissions?: Record<string, string>;
  jobs: Record<string, { steps?: Step[] }>;
}

const doc = parse(fs.readFileSync(WORKFLOW, "utf8")) as Workflow;
const steps = doc.jobs["hygiene"]?.steps ?? [];
const check = steps.filter((s) => s.run !== undefined);

describe("public-hygiene workflow", () => {
  it("runs on every pull request, with no path filter that could skip a docs-only one", () => {
    assert.deepEqual(Object.keys(doc.on), ["pull_request"]);
    const pr = doc.on["pull_request"];
    assert.equal(pr?.paths, undefined);
    assert.equal(pr?.["paths-ignore"], undefined);
  });

  it("can only read the repository", () => {
    assert.deepEqual(doc.permissions, { contents: "read" });
  });

  it("has one run step, and it is exactly the script", () => {
    assert.equal(check.length, 1);
    assert.equal(check[0].run, "node scripts/check-public-hygiene.mjs");
    assert.ok(fs.existsSync(path.join(HERE, "check-public-hygiene.mjs")), "the script the workflow runs does not exist");
  });

  it("gives that step the secret list, and requires it only for a same-repo, non-Dependabot PR", () => {
    assert.deepEqual(check[0].env, {
      PRIVATE_TERMS: "${{ secrets.PRIVATE_TERMS }}",
      REQUIRE_TERMS:
        "${{ github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]' && '1' || '' }}",
    });
  });

  it("checks the repository out before it runs", () => {
    const at = steps.findIndex((s) => s.uses?.startsWith("actions/checkout@"));
    assert.ok(at >= 0 && at < steps.indexOf(check[0]), "no checkout before the check");
  });
});
