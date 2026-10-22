// The ffmpeg path names a file on one machine, so a config backup must neither
// contain it nor put one back: restored onto another server it would choose the
// program that server runs. Driven through configSnapshot.build and .apply, the
// bodies of the config export and import routes.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-ffmpeg-restore-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot } = await import("../config-snapshot.js");
const { ffmpegPathStore, loadFfmpegPath } = await import("./ffmpeg-path-store.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");

const snapshotOf = (files: Record<string, unknown>) => ({ kind: "stage-utility-config", version: 1, createdAt: "2026-10-20T00:00:00.000Z", files });

test("a backup does not carry the ffmpeg path", async () => {
  await ffmpegPathStore.save({ path: "/opt/here/ffmpeg" });
  const built = await configSnapshot.build();
  assert.equal(JSON.stringify(built).includes("/opt/here/ffmpeg"), false);
  assert.equal("video-ffmpeg.json" in built.files, false);
});

test("a restore does not set the ffmpeg path, whether it names the store or hides it in another file", async () => {
  await ffmpegPathStore.save({ path: "/opt/here/ffmpeg" });
  const applied = await configSnapshot.apply(
    snapshotOf({
      "video-ffmpeg.json": { path: "/tmp/evil/ffmpeg" },
      "video-feeds.json": { feeds: [], ports: DEFAULT_VIDEO_PORTS, ffmpegPath: "/tmp/evil/ffmpeg" },
    }),
  );
  assert.equal(applied.includes("video-ffmpeg.json"), false, "the store's file is not on the restored list");
  assert.equal(await loadFfmpegPath(), "/opt/here/ffmpeg");
});
