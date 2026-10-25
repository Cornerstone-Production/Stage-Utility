// PATCH /api/video/ffmpeg chooses a program the server will run, so it must
// sit behind the same write gate as every other video settings write
// (RemoteServer.handle: the host-name check and the cross-origin refusal), and
// must refuse a path that is not an ffmpeg. Run through the real handler on a
// real socket, the way remote-server-cors.test.ts does.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { serveOnSocket, type SocketServer } from "../fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-ffmpeg-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("../remote-server.js");
const { loadFfmpegPath } = await import("../video/ffmpeg-path-store.js");

const FOREIGN = "http://attacker.example";
const JSON_HEADERS = { "Content-Type": "application/json" };
let server: SocketServer;

before(async () => {
  server = await serveOnSocket(new RemoteServer().handle);
});
after(async () => {
  await server.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

const patch = (body: unknown, headers: Record<string, string> = {}) =>
  server.send("PATCH", "/api/video/ffmpeg", { headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });

test("a cross-origin PATCH is refused and saves nothing, like the other video settings", async () => {
  const gated = await server.send("PATCH", "/api/video/ports", { headers: { ...JSON_HEADERS, Origin: FOREIGN }, body: "{}" });
  assert.equal(gated.status, 403, "the reference route is gated");
  const r = await patch({ path: "/opt/x/ffmpeg" }, { Origin: FOREIGN });
  assert.equal(r.status, 403);
  assert.equal((await loadFfmpegPath()), "");
});

test("a path that is not an ffmpeg is a 400 with the reason, and saves nothing", async () => {
  for (const bad of ["/bin/sh", "/tmp/x/ffmpeg-evil"]) {
    const r = await patch({ path: bad });
    assert.equal(r.status, 400, bad);
    assert.match(r.body, /must name an ffmpeg executable/);
  }
  assert.equal((await loadFfmpegPath()), "");
});

test("a same-origin PATCH naming an ffmpeg is saved, whether or not it exists yet", async () => {
  const r = await patch({ path: "/opt/x/ffmpeg" }, { Origin: `http://${server.host}` });
  assert.equal(r.status, 200, r.body);
  assert.equal((await loadFfmpegPath()), "/opt/x/ffmpeg");
  assert.match(r.body, /not found at the path set in Advanced/);
  await patch({ path: "" });
});

// The server log has the full paths; the API names none. (docs/integrations/video-feeds.md:
// folders are named relative to the data folder, and a busy port's holder by
// program name only.) Each answer below is read for ANY absolute path, not only
// this machine's temp directory.
const ABSOLUTE_PATH = /(^|[\s"'(:,[])(\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:\\/;

const SKIP_NO_SH = process.platform === "win32" ? "needs a POSIX shell" : false;

async function fakeFfmpeg(name: string, opts: { encoders?: string; mode?: number; dirMode?: number; exitCode?: number } = {}): Promise<string> {
  const dir = path.join(TMP, name);
  await fs.mkdir(dir, { recursive: true });
  const exe = path.join(dir, "ffmpeg");
  const script = opts.exitCode
    ? `#!/bin/sh\nexit ${opts.exitCode}\n`
    : `#!/bin/sh\ncase "$*" in\n*-version*) echo "ffmpeg version 7.7-fake";;\n*-decoders*) echo " A....D aac AAC";;\n*-encoders*) echo "${opts.encoders ?? " A....D libopus Opus"}";;\n*-protocols*) printf 'Input:\\n  http\\nOutput:\\n  file\\n';;\n*-muxers*) echo " E rtsp RTSP";;\nesac\n`;
  await fs.writeFile(exe, script);
  await fs.chmod(exe, opts.mode ?? 0o755);
  await fs.chmod(dir, opts.dirMode ?? 0o755);
  return exe;
}

test("no answer names a folder, whichever way the check ends", { skip: SKIP_NO_SH }, async () => {
  const realPath = process.env.PATH;
  const cases: [string, () => Promise<string>, string, RegExp][] = [
    ["found on PATH", async () => path.dirname(await fakeFfmpeg("leak-ok")), "", /"version":"7\.7-fake","source":"automatic"/],
    ["found at the configured path", async () => "", await fakeFfmpeg("leak-configured"), /"source":"configured"/],
    ["configured but missing", async () => "", path.join(TMP, "leak-missing", "ffmpeg"), /was not found at the path set in Advanced/],
    ["configured, in a folder anyone can write to", async () => "", await fakeFfmpeg("leak-open", { dirMode: 0o777 }), /in a folder anyone can write to/],
    ["without libopus", async () => path.dirname(await fakeFfmpeg("leak-noopus", { encoders: " A....D aac AAC" })), "", /cannot encode Opus/],
    ["exits with an error", async () => path.dirname(await fakeFfmpeg("leak-exit", { exitCode: 3 })), "", /it exited with an error/],
    ["configured, file writable by others", async () => "", await fakeFfmpeg("leak-wide", { mode: 0o777 }), /writable by group or other users/],
  ];
  try {
    await patch({ path: "/reset-start/ffmpeg" }); // not inside the reuse window of an earlier save
    let n = 0;
    for (const [label, pathEnv, configured, expected] of cases) {
      process.env.PATH = (await pathEnv()) || path.join(TMP, "no-such-dir");
      const patch1 = await patch({ path: configured }, { Origin: `http://${server.host}` });
      assert.equal(patch1.status, 200, `${label}: ${patch1.body}`);
      assert.match(patch1.body, expected, `${label}: the check did not end the way this case needs`);
      const get = await server.send("GET", "/api/video/ffmpeg");
      assert.equal(get.status, 200, label);
      for (const [where, body] of [["PATCH", patch1.body], ["GET", get.body]] as const) {
        // The operator's own configured value is theirs to see again.
        const without = configured === "" ? body : body.split(JSON.stringify(configured).slice(1, -1)).join("");
        assert.doesNotMatch(without, ABSOLUTE_PATH, `${label} (${where}) names a folder: ${body}`);
        assert.equal(without.includes(TMP), false, `${label} (${where}) names the temp folder`);
        assert.equal(without.includes("resolvedPath"), false);
      }
      // A different path each time, so the next case is a real check, not the reuse window.
      await patch({ path: `/reset-${n++}/ffmpeg` });
    }
  } finally {
    process.env.PATH = realPath;
    await patch({ path: "" });
  }
});
