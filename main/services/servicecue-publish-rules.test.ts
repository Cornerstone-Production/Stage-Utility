// What an operator may type into the Public link card: the address, and the token.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PUBLISH_MIN_TOKEN_LENGTH } from "../types/servicecue-publish.js";
import { checkPublishToken, parsePublishUrl, PUBLISH_ALLOW_LOCAL_ENV } from "./servicecue-publish-rules.js";

describe("parsePublishUrl", () => {
  it("keeps only the origin of an https address, a bare host taken as https, and the link volunteers are given as the page", () => {
    const cases: [string, string][] = [
      ["https://servicecue.example.workers.dev", "https://servicecue.example.workers.dev"],
      ["servicecue.example.workers.dev", "https://servicecue.example.workers.dev"],
      ["https://servicecue.example.workers.dev/servicecue?x=1#y", "https://servicecue.example.workers.dev"],
      ["  https://servicecue.example.workers.dev/  ", "https://servicecue.example.workers.dev"],
    ];
    for (const [typed, origin] of cases) assert.deepEqual(parsePublishUrl(typed), { ok: true, origin }, typed);
  });

  it("takes plain http for localhost and 127.0.0.1 only when local addresses are allowed, and only those", () => {
    assert.deepEqual(parsePublishUrl("http://localhost:8787", true), { ok: true, origin: "http://localhost:8787" });
    assert.deepEqual(parsePublishUrl("http://127.0.0.1:8787/", true), { ok: true, origin: "http://127.0.0.1:8787" });
    for (const refused of ["http://servicecue.example.workers.dev", "http://192.0.2.10:8787", "http://localhost.example.com", "http://127.0.0.1.example.com", "http://[::1]:8787"]) {
      const r = parsePublishUrl(refused, true);
      assert.ok(!r.ok && /https:\/\//.test(r.message), `${refused} is not this machine and must not be dialled over plain http`);
    }
  });

  it("refuses this machine's own addresses unless the development switch is set, so the address cannot probe its ports", (t) => {
    const before = process.env[PUBLISH_ALLOW_LOCAL_ENV];
    t.after(() => {
      if (before === undefined) delete process.env[PUBLISH_ALLOW_LOCAL_ENV];
      else process.env[PUBLISH_ALLOW_LOCAL_ENV] = before;
    });
    delete process.env[PUBLISH_ALLOW_LOCAL_ENV];
    for (const local of ["http://localhost:8787", "http://127.0.0.1:8787", "http://127.0.0.1"]) {
      const r = parsePublishUrl(local);
      assert.ok(!r.ok && r.message === "The page address has to start with https://.", local);
    }
    // https to the same host is an ordinary address, and the switch must be exactly "1".
    assert.equal(parsePublishUrl("https://localhost:8787").ok, true);
    process.env[PUBLISH_ALLOW_LOCAL_ENV] = "true";
    assert.equal(parsePublishUrl("http://localhost:8787").ok, false);
    process.env[PUBLISH_ALLOW_LOCAL_ENV] = "1";
    assert.deepEqual(parsePublishUrl("http://localhost:8787"), { ok: true, origin: "http://localhost:8787" });
  });

  it("refuses other schemes, credentials in the address, and nothing", () => {
    for (const refused of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com", "", "   ", 42, null]) {
      assert.equal(parsePublishUrl(refused).ok, false, String(refused));
    }
  });
});

describe("checkPublishToken", () => {
  it("takes printable ASCII with no space, of at least 32 characters", () => {
    for (const token of ["x".repeat(PUBLISH_MIN_TOKEN_LENGTH), "Ab1-_.~!#$%&'()*+,/:;<=>?@[]^`{|}" + "z".repeat(20), "!".repeat(64)]) {
      assert.equal(checkPublishToken(token), null, token);
    }
  });

  it("says plainly why not, and names no character of what was typed", () => {
    const cases: [string, RegExp][] = [
      ["x".repeat(PUBLISH_MIN_TOKEN_LENGTH - 1), /at least 32 characters/],
      ["", /letters, digits and punctuation/],
      ["a".repeat(20) + " " + "b".repeat(20), /no spaces/],
      ["a".repeat(40) + "\n", /no spaces/],
      ["a".repeat(20) + "—" + "b".repeat(20), /letters, digits and punctuation/],
      ["a".repeat(20) + "é" + "b".repeat(20), /letters, digits and punctuation/],
    ];
    for (const [token, message] of cases) {
      const why = checkPublishToken(token);
      assert.match(why ?? "", message, JSON.stringify(token));
      assert.doesNotMatch(why ?? "", /index|position|—|char at/i, "the message leaks a character or its place");
    }
  });
});
