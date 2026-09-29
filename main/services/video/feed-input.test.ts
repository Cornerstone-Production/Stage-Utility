import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseFeedInput, externalProtocol } from "./feed-input.js";

/** The kinds this build offers. */
const OFFERED = new Set(["embed", "external"] as const);
const ALL = new Set(["pull", "push", "embed", "external"] as const);

test("a name is required and trimmed", () => {
  assert.equal(parseFeedInput({ name: "  ", source: { kind: "external", url: "http://x/a.m3u8" } }, OFFERED).ok, false);
});
test("a kind this build does not offer is refused", () => {
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://10.0.0.1/s", username: "" } }, OFFERED);
  assert.equal(r.ok, false);
});
test("external needs http(s)", () => {
  assert.equal(parseFeedInput({ name: "X", source: { kind: "external", url: "file:///etc/passwd" } }, OFFERED).ok, false);
  assert.equal(parseFeedInput({ name: "X", source: { kind: "external", url: "https://cdn/x/index.m3u8" } }, OFFERED).ok, true);
});
test("pull allows rtsp, rtsps, srt, http(s) and refuses userinfo in the address", () => {
  for (const url of ["rtsp://10.0.0.1:8554/s", "rtsps://h/s", "srt://10.0.0.1:9000", "http://h/x.m3u8"]) {
    assert.equal(parseFeedInput({ name: "P", source: { kind: "pull", url, username: "" } }, ALL).ok, true, url);
  }
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://u:p@10.0.0.1/s", username: "" } }, ALL);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /own fields/);
  assert.equal(parseFeedInput({ name: "P", source: { kind: "pull", url: "udp://h:1", username: "" } }, ALL).ok, false);
});
test("push needs a known protocol", () => {
  assert.equal(parseFeedInput({ name: "P", source: { kind: "push", protocol: "rtsp" } }, ALL).ok, false);
  assert.equal(parseFeedInput({ name: "P", source: { kind: "push", protocol: "whip" } }, ALL).ok, true);
});
test("a pull password is returned separately, never inside the source", () => {
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://h/s", username: "admin" }, password: "pw" }, ALL);
  assert.ok(r.ok);
  assert.equal((r as { password?: string }).password, "pw");
  assert.equal(JSON.stringify((r as { source: unknown }).source).includes("pw"), false);
});
test("pull username defaults to empty when omitted", () => {
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://h/s" } }, ALL);
  assert.ok(r.ok);
  assert.equal((r as { source: { username: string } }).source.username, "");
});
test("non-string password is refused", () => {
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://h/s", username: "" }, password: 123 }, ALL);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /must be text/);
});
test("external protocol follows the path", () => {
  assert.equal(externalProtocol("https://h/live/index.m3u8?t=1"), "hls");
  assert.equal(externalProtocol("http://h/cam/whep"), "whep");
});
test("external refuses a username or password in the address, like pull", () => {
  for (const url of ["https://user:pw@cdn.example/live/index.m3u8", "http://user@h/cam/whep"]) {
    const r = parseFeedInput({ name: "X", source: { kind: "external", url } }, OFFERED);
    assert.equal(r.ok, false, url);
    assert.match((r as { error: string }).error, /username and password out of the address/, url);
  }
});
test("a name may be 60 characters after trimming, not 61", () => {
  const src = { kind: "external", url: "http://h/cam/whep" };
  assert.equal(parseFeedInput({ name: ` ${"a".repeat(60)} `, source: src }, OFFERED).ok, true);
  const r = parseFeedInput({ name: "a".repeat(61), source: src }, OFFERED);
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, "Name must be 1–60 characters.");
});

// SRT authenticates a pull by passphrase alone, and MediaMTX refuses a
// passphrase outside 10 to 80 bytes on every dial, for ever ("config:
// Passphrase must be between 10 and 80 bytes long", from the real v1.21.1
// binary). A passphrase is plain printable ASCII, so its characters are its
// bytes. Each rule is refused at the door, with its own reason.
test("an SRT pull refuses a username, saying SRT uses only a passphrase", () => {
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "srt://10.0.0.1:9000", username: "admin" }, password: "a-long-passphrase" }, ALL);
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, "SRT uses a passphrase only, no username: leave Username empty.");
});

const srtPull = (password: string) =>
  parseFeedInput({ name: "P", source: { kind: "pull", url: "srt://10.0.0.1:9000", username: "" }, password }, ALL);

test("an SRT passphrase must be 10 to 80 characters, and an empty one still clears it", () => {
  for (const bad of ["a".repeat(9), "a".repeat(81)]) {
    const r = srtPull(bad);
    assert.equal(r.ok, false, `${bad.length} characters`);
    assert.equal((r as { error: string }).error, "An SRT passphrase must be 10 to 80 characters long.");
  }
  // Space and tilde are the two ends of printable ASCII.
  for (const good of ["a".repeat(10), "a".repeat(80), " ~".repeat(5), ""]) {
    assert.equal(srtPull(good).ok, true, `${JSON.stringify(good)}, ${good.length} characters`);
  }
});

test("an SRT passphrase that is not plain ASCII is refused with its own reason, whatever its length", () => {
  // 41 characters, 82 bytes: the length rule in characters holds, so only
  // the ASCII rule can refuse it.
  for (const bad of ["é".repeat(41), "passphrase\u00a0nbsp", "tab\tpassphrase"]) {
    const r = srtPull(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal((r as { error: string }).error, "An SRT passphrase can use only plain letters, digits, spaces and punctuation.");
  }
});

test("the SRT rules are SRT's alone: an RTSP pull keeps its username and any password", () => {
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://10.0.0.1/s", username: "admin" }, password: "pw" }, ALL);
  assert.equal(r.ok, true);
});
