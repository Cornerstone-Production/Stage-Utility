// `npm run servicecue:deploy` (publish/servicecue/scripts/deploy.ts) annotates what it deploys the
// way the server does, so a server that keeps the page up to date reads a version and a build back
// from it and does not roll a hand deploy back.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEPLOY_MESSAGE_PREFIX, versionOfMessage } from "../main/services/servicecue-cloudflare.js";
import { deployPlan } from "../publish/servicecue/scripts/deploy.ts";

const CONFIG = '{ "workers_dev": true }';
const RELEASE = { version: "1.28.0-beta.2", build: "0123456789ab" };

describe("deployPlan", () => {
  test("passes the version's message and the build id as wrangler's --message and --tag", () => {
    const { args } = deployPlan(null, CONFIG, RELEASE);
    assert.deepEqual(args, ["deploy", "--message", "Stage Utility 1.28.0-beta.2", "--tag", "0123456789ab"]);
  });

  test("the message is the one the server writes and reads back", () => {
    const message = deployPlan(null, CONFIG, RELEASE).args[2] as string;
    assert.ok(message.startsWith(DEPLOY_MESSAGE_PREFIX));
    assert.equal(versionOfMessage(message), RELEASE.version);
  });

  test("refuses to deploy without a version and a build id to say", () => {
    assert.throws(() => deployPlan(null, CONFIG, undefined), /annotated with the app's version and the built page's build id/);
    assert.throws(() => deployPlan(null, CONFIG, { version: "1.0.0", build: "not-a-build" }), /build id/);
    assert.throws(() => deployPlan(null, CONFIG, { version: "", build: "0123456789ab" }), /version/);
  });
});

describe("deploy.ts run as a script", () => {
  const SCRIPT = fileURLToPath(new URL("../publish/servicecue/scripts/deploy.ts", import.meta.url));
  const BUILT = fileURLToPath(new URL("../publish/servicecue/public/servicecue.html", import.meta.url));

  // Through a symlink argv[1] is not the module's own path. A hand-rolled comparison then skipped
  // the deploy and exited 0: nothing deployed, nothing said. With no built page the real script
  // stops at the missing page, which is how this test tells it ran. A built page means
  // it would call wrangler, so the test does not run it then.
  test("runs when invoked through a symlink", { skip: fs.existsSync(BUILT) && "a built page exists: running would call wrangler" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-link-"));
    try {
      const link = path.join(dir, "deploy-link.ts");
      fs.symlinkSync(SCRIPT, link);
      const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
      assert.notEqual(r.status, 0, "a symlinked invocation exited 0 without deploying");
      assert.match(r.stderr, /servicecue\.html/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
