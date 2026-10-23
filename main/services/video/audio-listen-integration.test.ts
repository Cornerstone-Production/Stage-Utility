// The real thing: the pinned MediaMTX, the system ffmpeg, an AAC test source,
// and the commands this app generates. A feed's `-listen` path must hand a
// reader H.264 plus Opus, from one ffmpeg that starts on the first reader and
// ends after the last, whatever the path to ffmpeg looks like.
//
// Skipped, with the reason printed, only when a binary is not available: no
// ffmpeg that passes ffmpeg-system.ts's checks (or no ffprobe beside it), or the
// pinned MediaMTX cannot be downloaded. Everything runs on 127.0.0.1 and on
// ports the OS hands out; no encoder, no LAN.

import { strict as assert } from "node:assert";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-listen-int-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { ensureBinary } = await import("./acquire.js");
const { findFfmpeg } = await import("./ffmpeg-system.js");
const { MediaMtxRelay } = await import("./mediamtx-relay.js");
const { relayConfig } = await import("./mediamtx-config.js");
const { relayUsers } = await import("./reconcile-plan.js");
const { planAudio, resolveAudio } = await import("./audio-listen.js");
type RelayFeed = import("./relay.js").RelayFeed;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, ms: number, fn: () => Promise<T | undefined | false>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`gave up after ${ms} ms waiting for ${what}`);
    await sleep(150);
  }
}

const ffmpeg = await findFfmpeg();
const ffprobe = ffmpeg.ok ? path.join(path.dirname(ffmpeg.resolvedPath), "ffprobe") : "";
const hasProbe = ffprobe !== "" && (await fs.access(ffprobe).then(() => true, () => false));
const binary = ffmpeg.ok && hasProbe ? await ensureBinary() : null;
const skip =
  !ffmpeg.ok ? `no usable ffmpeg here: ${ffmpeg.reason}`
  : !hasProbe ? "no ffprobe beside ffmpeg"
  : binary && !binary.ok ? `the pinned MediaMTX is not available: ${binary.reason}`
  : false;
if (skip) console.log(`[integration skipped] ${skip}`);

const children: ChildProcess[] = [];
function start(cmd: string, args: string[]): ChildProcess {
  const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  c.stdout?.resume();
  c.stderr?.resume();
  children.push(c);
  return c;
}
function stopAll(): void {
  for (const c of children.splice(0)) c.kill("SIGKILL");
}

/** What ffprobe sees reading `url` over TCP: its streams and the seconds until the first packet. */
async function probe(url: string): Promise<{ streams: { codec_name: string; codec_type: string; channels?: number }[]; seconds: number }> {
  const t0 = performance.now();
  const { stdout } = await execFileP(
    ffprobe,
    ["-v", "error", "-rtsp_transport", "tcp", "-probesize", "65536", "-analyzeduration", "500000", "-read_intervals", "%+#1",
      "-show_entries", "stream=codec_name,codec_type,channels:packet=codec_type", "-of", "json", url],
    { timeout: 30_000 },
  );
  const seconds = (performance.now() - t0) / 1000;
  return { streams: (JSON.parse(stdout) as { streams: never[] }).streams, seconds };
}

/** ffmpeg processes publishing a -listen path of this relay. */
async function converters(rtspPort: number): Promise<number> {
  const { stdout } = await execFileP("ps", ["-axo", "command="]);
  return stdout.split("\n").filter((l) => l.includes(`rtsp://127.0.0.1:${rtspPort}/cam-listen`) && l.includes("-f rtsp") && !l.includes("ffprobe")).length;
}

/** A relay with one push feed "cam" fed by a real AAC + H.264 test source. */
async function withRelay(
  run: (ctx: { rtsp: number; relay: InstanceType<typeof MediaMtxRelay>; reconcile: (feed: Partial<RelayFeed>) => Promise<void> }) => Promise<void>,
  ffmpegPath: string,
  settings: { audioSourceUrl?: string },
): Promise<void> {
  assert.ok(binary?.ok);
  const [api, rtsp, rtmp, hls, whep, udp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort(), freePort()]);
  const ports = { api, rtsp, rtmp, hls, webrtcHttp: whep, webrtcUdp: udp, srt: await freePort() };
  const password = "integrationpass".padEnd(19, "1");
  const apiPass = "apipass".padEnd(20, "x");
  const feeds0: RelayFeed[] = [{ id: "cam", kind: "push", password }];
  const configPath = path.join(TMP, `mediamtx-${api}.yml`);
  await fs.writeFile(configPath, JSON.stringify(relayConfig({ ports, lanIp: "127.0.0.1", users: relayUsers(feeds0, apiPass), rtsp: true })));
  start(binary.path, [configPath]);
  const relay = new MediaMtxRelay(api, apiPass);
  await until("the relay's API", 15_000, async () => (await relay.status(), true));
  try {
    const reconcile = async (feed: Partial<RelayFeed>) => relay.reconcile([{ id: "cam", kind: "push", password, ...feed } as RelayFeed]);
    await reconcile({});
    start(ffmpeg.ok ? ffmpeg.resolvedPath : "", [
      "-hide_banner", "-loglevel", "error", "-re",
      "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0", "-g", "50", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ac", "2", "-b:a", "128k", "-f", "rtsp", "-rtsp_transport", "tcp", `rtsp://video:${password}@127.0.0.1:${rtsp}/cam`,
    ]);
    // What the app does on learning the codec: read it from the relay's own track list.
    const audio = await until("the source's audio track", 20_000, async () => (await relay.status()).find((p) => p.name === "cam" && p.ready)?.audio);
    assert.equal(audio, "MPEG-4 Audio", "the relay did not report the test source's AAC");
    const resolved = resolveAudio(
      planAudio({ conversion: "auto", audio, sourceUrl: settings.audioSourceUrl }, "cam"),
      "cam",
      { ok: true, ffmpegPath, rtspPort: rtsp },
    );
    assert.ok(resolved.listenCommand, JSON.stringify(resolved));
    await reconcile({ listenCommand: resolved.listenCommand });
    await run({ rtsp, relay, reconcile });
  } finally {
    stopAll();
  }
}

test("AAC in, Opus out: one ffmpeg per feed shared by two readers, started by the first and ended after the last, through a path with a space in it", { skip, timeout: 120_000 }, async () => {
  assert.ok(ffmpeg.ok);
  // MediaMTX splits the command with shell quoting; a path with a space is the case that proves the quoting.
  const dir = path.join(TMP, "dir with space");
  await fs.mkdir(dir);
  const wrapper = path.join(dir, "ffmpeg");
  await fs.writeFile(wrapper, `#!/bin/sh\nexec '${ffmpeg.resolvedPath}' "$@"\n`, { mode: 0o755 });
  await withRelay(async ({ rtsp }) => {
    assert.equal(await converters(rtsp), 0, "a converter ran with nobody listening");
    const url = `rtsp://127.0.0.1:${rtsp}/cam-listen`;
    const first = await probe(url);
    console.log(`[integration] -listen first packet after ${first.seconds.toFixed(2)} s (cold start)`);
    assert.deepEqual(first.streams.map((s) => s.codec_name).sort(), ["h264", "opus"]);
    assert.equal(first.streams.find((s) => s.codec_type === "audio")?.channels, 2);

    // Two readers at once share the one process.
    const holder = start(ffprobe, ["-v", "error", "-rtsp_transport", "tcp", "-show_entries", "stream=codec_name", "-read_intervals", "%+20", "-show_entries", "packet=pts", url]);
    await sleep(500);
    const second = await probe(url);
    assert.deepEqual(second.streams.map((s) => s.codec_name).sort(), ["h264", "opus"]);
    assert.equal(await converters(rtsp), 1, "two readers must share exactly one ffmpeg");
    holder.kill("SIGKILL");

    // Ended after the last reader (10 s grace).
    await until("the converter to stop after the last reader left", 25_000, async () => (await converters(rtsp)) === 0);
  }, wrapper, {});
});

test("an audio source address is passed through with -c copy: H.264 and Opus out of an HTTP MPEG-TS stream", { skip, timeout: 120_000 }, async () => {
  assert.ok(ffmpeg.ok);
  const httpPort = await freePort();
  const url = `http://127.0.0.1:${httpPort}/0.ts`;
  // A stand-in for an encoder's HTTP output: MPEG-TS with H.264 and Opus 48 kHz stereo.
  start(ffmpeg.resolvedPath, [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0", "-g", "25", "-pix_fmt", "yuv420p",
    "-c:a", "libopus", "-ac", "2", "-f", "mpegts", "-listen", "1", url,
  ]);
  await sleep(500);
  await withRelay(async ({ rtsp }) => {
    const r = await probe(`rtsp://127.0.0.1:${rtsp}/cam-listen`);
    console.log(`[integration] pass-through first packet after ${r.seconds.toFixed(2)} s (cold start)`);
    assert.deepEqual(r.streams.map((s) => s.codec_name).sort(), ["h264", "opus"]);
  }, ffmpeg.resolvedPath, { audioSourceUrl: url });
});
