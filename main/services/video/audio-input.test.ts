import { strict as assert } from "node:assert";
import { test } from "node:test";

import { audioFieldsOf, audioSourceUrlProblem, parseAudioFields } from "./audio-input.js";
import { parseFeedInput } from "./feed-input.js";

const KINDS = new Set(["pull", "push", "embed", "external"] as const);
const PULL = { kind: "pull", url: "rtsp://192.0.2.10/s", username: "" };

test("the defaults are left out, so a feed that never set them stores neither", () => {
  const r = parseAudioFields({ audioConversion: "auto", audioSourceUrl: "" });
  assert.deepEqual(r, { ok: true, fields: {} });
  assert.deepEqual(parseAudioFields({}), { ok: true, fields: {} });
});

test("off, always and an http or https address are kept", () => {
  assert.deepEqual(parseAudioFields({ audioConversion: "off" }), { ok: true, fields: { audioConversion: "off" } });
  assert.deepEqual(parseAudioFields({ audioConversion: "always", audioSourceUrl: " http://192.0.2.28/0.ts " }), {
    ok: true,
    fields: { audioConversion: "always", audioSourceUrl: "http://192.0.2.28/0.ts" },
  });
  assert.equal(audioSourceUrlProblem("https://encoder.example/0.ts?a=1&b=2"), null);
});

test("a wrong type or an unknown mode is refused, not ignored", () => {
  for (const bad of [true, 3, "loud", null, ["off"]]) {
    const r = parseAudioFields({ audioConversion: bad });
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(parseAudioFields({ audioSourceUrl: 5 }).ok, false);
});

test("an address that is not plain http or https is refused", () => {
  for (const url of ["rtsp://192.0.2.28/x", "ftp://h/x", "http://", "not a url", "http://u:p@192.0.2.28/0.ts", "file:///etc/passwd"]) {
    assert.notEqual(audioSourceUrlProblem(url), null, `accepted ${url}`);
  }
});

// MediaMTX splits runOnDemand with shell quoting rules, then expands $NAME in each
// word. Every one of these would change what runs if it reached the command.
test("an address with a quote, a $, a backtick, a backslash, a space or a control character is refused", () => {
  const hostile = [
    "http://h/x'; touch /tmp/pwned; echo '",
    "http://h/$HOME",
    "http://h/${MTX_PATH}",
    "http://h/`id`",
    "http://h/a\\b",
    "http://h/a b",
    'http://h/"x"',
    "http://h/x\nsecond",
    "http://h/x#frag",
    "http://h/x|y",
    "http://h/x<y>",
    "http://h/x{y}",
  ];
  for (const url of hostile) {
    assert.notEqual(audioSourceUrlProblem(url), null, `accepted ${JSON.stringify(url)}`);
    assert.equal(parseAudioFields({ audioSourceUrl: url }).ok, false, `parse accepted ${JSON.stringify(url)}`);
  }
});

test("a feed body carries the fields through parseFeedInput for pull and push, and drops them for embed and external", () => {
  const body = { audioConversion: "off", audioSourceUrl: "http://192.0.2.28/0.ts" };
  const pull = parseFeedInput({ name: "A", source: PULL, ...body }, KINDS);
  assert.ok(pull.ok && pull.audioConversion === "off" && pull.audioSourceUrl === "http://192.0.2.28/0.ts");
  const push = parseFeedInput({ name: "A", source: { kind: "push", protocol: "srt" }, ...body }, KINDS);
  assert.ok(push.ok && push.audioConversion === "off");
  const external = parseFeedInput({ name: "A", source: { kind: "external", url: "https://x.example/a.m3u8" }, ...body }, KINDS);
  assert.ok(external.ok && !("audioConversion" in external) && !("audioSourceUrl" in external));
  const embed = parseFeedInput({ name: "A", source: { kind: "embed", player: "youtube-video", ref: "dQw4w9WgXcQ" }, ...body }, KINDS);
  assert.ok(embed.ok && !("audioConversion" in embed));
});

test("a bad audio field refuses the whole feed", () => {
  const r = parseFeedInput({ name: "A", source: PULL, audioSourceUrl: "http://h/$X" }, KINDS);
  assert.equal(r.ok, false);
});

test("audioFieldsOf copies only what is set", () => {
  assert.deepEqual(audioFieldsOf({}), {});
  assert.deepEqual(audioFieldsOf({ audioConversion: undefined, audioSourceUrl: undefined }), {});
  assert.deepEqual(audioFieldsOf({ audioConversion: "always" }), { audioConversion: "always" });
});
