// `npm run servicecue:deploy` (publish/servicecue/scripts/deploy.mjs) annotates what it deploys the
// way the server does, so a server that keeps the page up to date reads a version and a build back
// from it and does not roll a hand deploy back.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { VIEWER_BUILD_META, viewerBuildFromHtml, viewerBuildTag } from "../main/types/servicecue-publish.js";
import { DEPLOY_MESSAGE_PREFIX, versionOfMessage } from "../main/services/servicecue-cloudflare.js";
// @ts-expect-error a plain .mjs with no types: it runs under node alone
import { buildIdOf, deployPlan } from "../publish/servicecue/scripts/deploy.mjs";

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

describe("buildIdOf", () => {
  test("reads a document as the app does", () => {
    const documents = [
      `<!doctype html>${viewerBuildTag("0123456789ab")}`,
      `<!-- ${viewerBuildTag("aaaaaaaaaaaa")} --><html>${viewerBuildTag("0123456789ab")}</html>`,
      `<!-- <!-- --> ${viewerBuildTag("aaaaaaaaaaaa")} -->${viewerBuildTag("0123456789ab")}`,
      "<html></html>",
      `<meta name="${VIEWER_BUILD_META}" content="short">`,
      `<meta name="${VIEWER_BUILD_META}"   content="0123456789ab"/>`,
    ];
    for (const html of documents) assert.equal(buildIdOf(html), viewerBuildFromHtml(html), html);
    assert.equal(buildIdOf(documents[0]!), "0123456789ab");
  });
});
