import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseFeedInput, externalProtocol } from "./feed-input.js";

const PR1 = new Set(["embed", "external"] as const);
const ALL = new Set(["pull", "push", "embed", "external"] as const);

test("a name is required and trimmed", () => {
  assert.equal(parseFeedInput({ name: "  ", source: { kind: "external", url: "http://x/a.m3u8" } }, PR1).ok, false);
});
test("a kind this build does not offer is refused", () => {
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://10.0.0.1/s", username: "" } }, PR1);
  assert.equal(r.ok, false);
});
test("external needs http(s)", () => {
  assert.equal(parseFeedInput({ name: "X", source: { kind: "external", url: "file:///etc/passwd" } }, PR1).ok, false);
  assert.equal(parseFeedInput({ name: "X", source: { kind: "external", url: "https://cdn/x/index.m3u8" } }, PR1).ok, true);
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
