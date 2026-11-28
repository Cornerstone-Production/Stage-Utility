// The publish target both publishers share: the saved address and token, and the token hidden.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { HIDDEN, hideSecrets, resolvePublishTarget } from "./publish-target.js";
import { PUBLISH_MIN_TOKEN_LENGTH } from "../types/servicecue-publish.js";

const GOOD = "g".repeat(PUBLISH_MIN_TOKEN_LENGTH);
const seams = (url: string | Error, token: string | Error) => ({
  loadUrl: async () => {
    if (url instanceof Error) throw url;
    return url;
  },
  loadToken: async () => {
    if (token instanceof Error) throw token;
    return token;
  },
});

describe("resolvePublishTarget", () => {
  test("an address and a good token, trimmed, is the target", async () => {
    assert.deepEqual(await resolvePublishTarget(seams("https://plots.example.com/some/path", `  ${GOOD}\n`)), {
      ok: true,
      origin: "https://plots.example.com",
      token: GOOD,
    });
  });

  test("no address is unset, and says to enter one", async () => {
    const r = await resolvePublishTarget(seams("   ", GOOD));
    assert.deepEqual(r, { ok: false, reason: "address", unset: true, message: "Enter the page address." });
  });

  test("an address that cannot be used is not unset", async () => {
    const r = await resolvePublishTarget(seams("ftp://plots.example.com", GOOD));
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.reason, "address");
    assert.equal(r.ok ? true : r.unset, false);
  });

  test("no token is unset", async () => {
    const r = await resolvePublishTarget(seams("https://plots.example.com", "  "));
    assert.deepEqual(r, { ok: false, reason: "token", unset: true, message: "No publishing token is set." });
  });

  test("a token the page would refuse names the rule, never the token", async () => {
    const short = "s".repeat(PUBLISH_MIN_TOKEN_LENGTH - 1);
    const r = await resolvePublishTarget(seams("https://plots.example.com", short));
    assert.equal(r.ok ? "" : r.reason, "token");
    assert.equal(r.ok ? true : r.unset, false);
    assert.match(r.ok ? "" : r.message, /at least/);
    assert.ok(!(r.ok ? "" : r.message).includes(short));
  });

  test("a read that throws comes back as unreadable with its cause, and never throws", async () => {
    const a = await resolvePublishTarget(seams(new Error("settings EIO"), GOOD));
    assert.deepEqual(a, { ok: false, reason: "unreadable", unset: false, message: "The publishing settings could not be read: settings EIO", cause: "settings EIO" });
    const b = await resolvePublishTarget(seams("https://plots.example.com", new Error("secrets EIO")));
    assert.deepEqual(b, { ok: false, reason: "unreadable", unset: false, message: "The publishing token could not be read: secrets EIO", cause: "secrets EIO" });
  });
});

describe("hideSecrets", () => {
  test("hides every occurrence of every secret", () => {
    assert.equal(hideSecrets("a SECRET1 b SECRET1 c SECRET2", ["SECRET1", "SECRET2"]), `a ${HIDDEN} b ${HIDDEN} c ${HIDDEN}`);
  });

  test("an empty secret hides nothing", () => {
    assert.equal(hideSecrets("abc", [""]), "abc");
  });
});
