// redact-url.test.ts — every credential shape a relay URL can carry, stripped
// from text before it reaches a log line or an Error message. Each case is a
// shape this app itself builds (reconcile-plan.ts's pullSource, the push
// addresses) or one an operator can paste as a pull address.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { withoutCredentials } from "./redact-url.js";

const cases: { name: string; text: string; secret: string; expected: string }[] = [
  {
    name: "userinfo",
    text: "'rtsp://admin:s3cret@192.0.2.1/s' is not a valid URL",
    secret: "s3cret",
    expected: "'rtsp://192.0.2.1/s' is not a valid URL",
  },
  {
    name: "userinfo whose password holds a raw @, split from the host on the last one",
    text: "'rtsp://admin:p@ss@192.0.2.1/s' is not a valid URL",
    secret: "ss@",
    expected: "'rtsp://192.0.2.1/s' is not a valid URL",
  },
  {
    name: "userinfo whose password holds a ?",
    text: "rtsp://admin:pa?ss@192.0.2.5/s",
    secret: "pa?ss",
    expected: "rtsp://192.0.2.5/s",
  },
  {
    name: "userinfo whose password holds a ?, inside an error line",
    text: "Invalid URL: rtsp://admin:se?cret@cam/stream",
    secret: "se?cret",
    expected: "Invalid URL: rtsp://cam/stream",
  },
  {
    name: "userinfo whose password holds a hash",
    text: "'rtsp://admin:pa#ss@192.0.2.5/s' is not a valid URL",
    secret: "pa#ss",
    expected: "'rtsp://192.0.2.5/s' is not a valid URL",
  },
  {
    // Accepted over-redaction, not a requirement: with no userinfo at all, an @
    // in the query is indistinguishable from the end of a password containing a
    // ?, and a redactor must resolve that toward taking too much. This case
    // used to pin the opposite, which is what let the ? and hash passwords through.
    name: "(accepted over-redaction) the text up to an @ in the query after a bare host",
    text: "http://192.0.2.7?contact=a@b.example failed",
    secret: "contact=a",
    expected: "http://b.example failed",
  },
  {
    name: "an SRT pull's passphrase, in the shape the relay reported a malformed host",
    text: "'srt://ho%zzst:9000?passphrase=SECRETPASS123' is not a valid URL",
    secret: "SECRETPASS123",
    expected: "'srt://ho%zzst:9000?passphrase=<redacted>' is not a valid URL",
  },
  {
    name: "a passphrase after other query parameters, then more",
    text: "dial srt://192.0.2.5:9000?mode=caller&passphrase=p%40ssword1&latency=200 failed",
    secret: "p%40ssword1",
    expected: "dial srt://192.0.2.5:9000?mode=caller&passphrase=<redacted>&latency=200 failed",
  },
  {
    name: "an RTMP publish address's pass",
    text: "rtmp://192.0.2.9:1935/cam?user=video&pass=swordfishswordfish",
    secret: "swordfishswordfish",
    expected: "rtmp://192.0.2.9:1935/cam?user=video&pass=<redacted>",
  },
  {
    name: "a pwd query value",
    text: "http://192.0.2.7/stream.m3u8?pwd=hunter2hunter2",
    secret: "hunter2hunter2",
    expected: "http://192.0.2.7/stream.m3u8?pwd=<redacted>",
  },
  {
    name: "an SRT publish streamid",
    text: "srt://192.0.2.9:8890?streamid=publish:cam:video:swordfishswordfish",
    secret: "swordfishswordfish",
    expected: "srt://192.0.2.9:8890?streamid=publish:cam:video:<redacted>",
  },
  {
    name: "an SRT read streamid, percent-encoded",
    text: "srt://192.0.2.9:8890?streamid=read%3Acam%3Aviewer%3Atopsecret99",
    secret: "topsecret99",
    expected: "srt://192.0.2.9:8890?streamid=read%3Acam%3Aviewer%3A<redacted>",
  },
];

for (const c of cases) {
  test(`strips ${c.name}`, () => {
    const out = withoutCredentials(c.text);
    assert.equal(out.includes(c.secret), false, `the secret survived: ${out}`);
    assert.equal(out, c.expected);
  });
}

test("leaves a streamid with no password, and words that only end in pass, alone", () => {
  const text = "srt://h:8890?streamid=publish:cam and bypass=1 compass=north";
  assert.equal(withoutCredentials(text), text);
});
