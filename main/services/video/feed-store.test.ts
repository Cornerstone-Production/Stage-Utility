import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-feeds-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { videoFeedsStore, loadFeedsFile } = await import("./feed-store.js");

test("a file with no ports gets every default port", async () => {
  await fs.writeFile(path.join(TMP, "video-feeds.json"), JSON.stringify({ feeds: [] }));
  await videoFeedsStore.reload();
  const file = await loadFeedsFile();
  assert.deepEqual(file.ports, { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 });
});

test("a partial ports object keeps what it has", async () => {
  await fs.writeFile(path.join(TMP, "video-feeds.json"), JSON.stringify({ feeds: [], ports: { rtmp: 1936 } }));
  await videoFeedsStore.reload();
  assert.equal((await loadFeedsFile()).ports.rtmp, 1936);
  assert.equal((await loadFeedsFile()).ports.srt, 8890);
});
