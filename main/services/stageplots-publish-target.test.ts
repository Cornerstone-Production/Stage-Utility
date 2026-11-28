// What the stage plots publisher is told when it has no page to publish to, with the app's real
// stores behind it: the saved address and token. Its own file, since the stores read their files once.
//
// A token that is saved but unusable (too short, with a space in it) used to read the same as no
// page at all, "Set up the public link first", so the card sent the operator to set up what they
// had already set up. Each reason now says what it is.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import type { PublishOrigin } from "./servicecue-publish-rules.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-publish-target-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { NO_PAGE, publishTarget } = await import("./stageplots-publish-instance.js");
const { savePublishToken, servicecuePublishStore } = await import("./servicecue-publish-store.js");
const { PUBLISH_MIN_TOKEN_LENGTH } = await import("../types/servicecue-publish.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const ORIGIN = "https://plots.example.com" as PublishOrigin;

test("no address saved reads as the page not being set up", async () => {
  await servicecuePublishStore.save({ enabled: false, url: "" });
  assert.deepEqual(await publishTarget(), { ok: false, message: NO_PAGE });
});

test("an address with no token reads as the page not being set up", async () => {
  await servicecuePublishStore.save({ enabled: false, url: ORIGIN });
  assert.deepEqual(await publishTarget(), { ok: false, message: NO_PAGE });
});

test("a saved token that is too short says the token is the problem, not that nothing is set up", async () => {
  await servicecuePublishStore.save({ enabled: false, url: ORIGIN });
  await savePublishToken(ORIGIN, "x".repeat(PUBLISH_MIN_TOKEN_LENGTH - 1));
  const target = await publishTarget();
  assert.equal(target.ok, false);
  if (target.ok) return;
  assert.notEqual(target.message, NO_PAGE);
  assert.match(target.message, /publishing token has to be at least/);
  assert.doesNotMatch(target.message, /x{4}/, "the token itself is never in the message");
});

test("a saved token with a space in it says so", async () => {
  await servicecuePublishStore.save({ enabled: false, url: ORIGIN });
  await savePublishToken(ORIGIN, `${"y".repeat(PUBLISH_MIN_TOKEN_LENGTH)} z`);
  const target = await publishTarget();
  assert.equal(target.ok, false);
  if (target.ok) return;
  assert.match(target.message, /letters, digits and punctuation/);
});

test("a hand-edited address that is not a web address says so", async () => {
  await servicecuePublishStore.save({ enabled: false, url: "ftp://plots.example.com" });
  const target = await publishTarget();
  assert.equal(target.ok, false);
  if (target.ok) return;
  assert.notEqual(target.message, NO_PAGE);
  assert.match(target.message, /https:\/\//);
});

test("an address and a good token is the target", async () => {
  await servicecuePublishStore.save({ enabled: false, url: ORIGIN });
  const token = "t".repeat(PUBLISH_MIN_TOKEN_LENGTH);
  await savePublishToken(ORIGIN, `  ${token}  `);
  assert.deepEqual(await publishTarget(), { ok: true, origin: ORIGIN, token });
});
