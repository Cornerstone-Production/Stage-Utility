import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Before any store is constructed: feed-transfer.ts imports the settings
// store, which must read this directory and never the default data folder.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-feed-transfer-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { planImport, assertVideoBundle } = await import("./feed-transfer.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");
type VideoFeed = import("../../types/video.js").VideoFeed;
type VideoFeedsBundle = import("../../types/video.js").VideoFeedsBundle;

const KINDS = new Set(["pull", "push", "embed", "external"] as const);

function bundleOf(feeds: Record<string, unknown>[]): VideoFeedsBundle {
  return { kind: "stage-utility-video-feeds", version: 1, appVersion: "", createdAt: "", source: { server: "" }, feeds } as unknown as VideoFeedsBundle;
}

const HERE_RTSP: VideoFeed = { id: "cam", name: "Cam", source: { kind: "pull", url: "rtsp://192.0.2.10/s", username: "" } };

test("a replaced pull feed that becomes SRT with no password in the file is refused when the kept password breaks the passphrase rule", async () => {
  const file = bundleOf([{ id: "cam", name: "Cam", source: { kind: "pull", url: "srt://192.0.2.10:9000", username: "" } }]);
  const [plan] = await planImport(file, [HERE_RTSP], async () => "short", KINDS);
  assert.equal(plan.preview.status, "invalid");
  assert.equal(plan.parsed, undefined, "an invalid plan must carry nothing to write");
  assert.match(plan.preview.error ?? "", /10 to 80 characters/);
  assert.match(plan.preview.error ?? "", /password saved for this feed would be used/);

  const nonAscii = await planImport(file, [HERE_RTSP], async () => "pässphrase-long-enough", KINDS);
  assert.equal(nonAscii[0].preview.status, "invalid");
  assert.match(nonAscii[0].preview.error ?? "", /plain letters, digits/);
});

test("a kept password that is a valid passphrase, or none at all, lets the SRT replace through", async () => {
  const file = bundleOf([{ id: "cam", name: "Cam", source: { kind: "pull", url: "srt://192.0.2.10:9000", username: "" } }]);
  const valid = await planImport(file, [HERE_RTSP], async () => "correct-horse-battery", KINDS);
  assert.equal(valid[0].preview.status, "differs");
  const none = await planImport(file, [HERE_RTSP], async () => undefined, KINDS);
  assert.equal(none[0].preview.status, "differs");
});

test("a password the file carries replaces the kept one, so the kept one is not checked", async () => {
  const file = bundleOf([
    { id: "cam", name: "Cam", source: { kind: "pull", url: "srt://192.0.2.10:9000", username: "" }, password: "correct-horse-battery" },
  ]);
  const [plan] = await planImport(file, [HERE_RTSP], async () => "short", KINDS);
  assert.equal(plan.preview.status, "differs");
});

test("a feed that is not a pull feed here keeps no password, so there is nothing to check", async () => {
  const file = bundleOf([{ id: "cam", name: "Cam", source: { kind: "pull", url: "srt://192.0.2.10:9000", username: "" } }]);
  const external: VideoFeed = { id: "cam", name: "Cam", source: { kind: "external", url: "https://cdn.example/x.m3u8" } };
  const [plan] = await planImport(file, [external], async () => "short", KINDS);
  assert.equal(plan.preview.status, "differs");
});

test("a file with a feed id ending in -listen is refused: that path belongs to another feed's audio", () => {
  const entry = { id: "cam-listen", name: "Cam", source: { kind: "push", protocol: "rtmp" } };
  assert.throws(() => assertVideoBundle({ kind: "stage-utility-video-feeds", version: 1, feeds: [entry] }, DEFAULT_VIDEO_PORTS), /id this server cannot use/);
  assert.doesNotThrow(() => assertVideoBundle({ kind: "stage-utility-video-feeds", version: 1, feeds: [{ ...entry, id: "cam" }] }, DEFAULT_VIDEO_PORTS));
});

test("an export from before the RTSP port existed keeps this server's RTSP port rather than resetting it", () => {
  const { rtsp: _gone, ...six } = DEFAULT_VIDEO_PORTS;
  const here = { ...DEFAULT_VIDEO_PORTS, rtsp: 28554 };
  const bundle = assertVideoBundle({ kind: "stage-utility-video-feeds", version: 1, feeds: [], ports: six }, here);
  assert.equal(bundle.ports?.rtsp, 28554);
  // Taken from the file's own port when it has one.
  assert.equal(assertVideoBundle({ kind: "stage-utility-video-feeds", version: 1, feeds: [], ports: { ...six, rtsp: 9554 } }, here).ports?.rtsp, 9554);
});
