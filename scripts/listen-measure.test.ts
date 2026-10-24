// listen-measure.ts: the arithmetic against streams built with known delays, the
// RTSP client against a fake server, and the packet reader against a stand-in
// ffprobe. The tool run against a real relay is the drive recorded in the PR.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  matchVideo,
  parseArgs,
  parsePacketLine,
  readPackets,
  sampleWindow,
  summarize,
  timeToFirstAudio,
  wallOffset,
  type Packet,
} from "./listen-measure.js";

// ── Arguments ───────────────────────────────────────────────────────────────

test("the relay is host:port or an rtsp address, with the feed's own id, and the defaults are the documented ones", () => {
  const a = parseArgs(["127.0.0.1:8554", "ma-pgm"]);
  assert.ok(!("error" in a));
  assert.deepEqual({ host: a.host, port: a.port, feed: a.feed, minutes: a.minutes, intervalS: a.intervalS, warmupS: a.warmupS, json: a.json }, {
    host: "127.0.0.1", port: 8554, feed: "ma-pgm", minutes: 30, intervalS: 10, warmupS: 4, json: false,
  });
  const b = parseArgs(["rtsp://relay.example:9000", "cam", "--minutes", "2", "--interval", "5", "--json"]);
  assert.ok(!("error" in b));
  assert.deepEqual({ host: b.host, port: b.port, minutes: b.minutes, intervalS: b.intervalS, json: b.json }, { host: "relay.example", port: 9000, minutes: 2, intervalS: 5, json: true });
  const c = parseArgs(["relay.example", "cam"]);
  assert.ok(!("error" in c) && c.port === 8554, "no port reads as the default RTSP port");
});

test("the tool refuses what it would otherwise measure wrongly", () => {
  const err = (argv: string[]) => {
    const r = parseArgs(argv);
    return "error" in r ? r.error : "";
  };
  assert.match(err(["127.0.0.1:8554", "cam-listen"]), /not "cam-listen"/, "a -listen id would be read twice over");
  assert.match(err(["127.0.0.1:8554", "Cam Feed"]), /not a feed id/);
  assert.match(err(["127.0.0.1:8554"]), /usage/);
  assert.match(err(["127.0.0.1:8554", "cam", "--minutes"]), /needs a value/);
  assert.match(err(["127.0.0.1:8554", "cam", "--minutes", "0"]), /at least/);
  assert.match(err(["127.0.0.1:99999", "cam"]), /not a host:port/);
});

// ── One packet ──────────────────────────────────────────────────────────────

test("a packet line is read for its kind, timestamp and checksum, and anything else is not a packet", () => {
  assert.deepEqual(parsePacketLine("packet|codec_type=video|dts_time=1.240000|data_hash=CRC32:631bd235", 5), { kind: "video", ts: 1.24, wall: 5, crc: "CRC32:631bd235" });
  assert.deepEqual(
    parsePacketLine("packet|codec_type=audio|dts_time=0.171417|data_hash=CRC32:be7ace9f|side_datum/producer_reference_time:side_data_type=Producer Reference Time", 2),
    { kind: "audio", ts: 0.171417, wall: 2, crc: "CRC32:be7ace9f" },
  );
  assert.equal(parsePacketLine("packet|codec_type=video|dts_time=N/A|data_hash=CRC32:1", 1), null, "a packet before the first RTCP report has no time to measure from");
  assert.equal(parsePacketLine("packet|codec_type=data|dts_time=1.0", 1), null);
  assert.equal(parsePacketLine("[rtsp @ 0x1] method DESCRIBE failed", 1), null);
});

// ── The arithmetic, against streams with delays built in ────────────────────

/** Two paths of one feed. The source: video 25 fps and audio in 20 ms packets, each arriving `relay` after it was made. The listen
 *  path: timestamps numbered from another origin (`shift`), the video `videoAdd` later and the audio `audioAdd` later. Jitter only
 *  ever adds, as a network does, and the first packet of each kind is on time. */
function paths(opts: { seconds: number; shift: number; relay: number; videoAdd: number; audioAdd: number; audioDriftPerMin?: number; seed?: number }) {
  let seed = opts.seed ?? 7;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 16) / 1000;
  };
  const source: Packet[] = [];
  const listen: Packet[] = [];
  const first = { sv: true, sa: true, lv: true, la: true };
  const j = (key: keyof typeof first) => (first[key] ? ((first[key] = false), 0) : jitter());
  for (let n = 0; n < opts.seconds * 25; n++) {
    const ts = n / 25;
    const crc = `CRC32:${n}`;
    source.push({ kind: "video", ts, wall: ts + opts.relay + j("sv"), crc });
    listen.push({ kind: "video", ts: ts + opts.shift, wall: ts + opts.relay + opts.videoAdd + j("lv"), crc });
  }
  for (let n = 0; n < opts.seconds * 50; n++) {
    const ts = n / 50;
    const drift = ((opts.audioDriftPerMin ?? 0) * ts) / 60;
    source.push({ kind: "audio", ts, wall: ts + opts.relay + j("sa") });
    listen.push({ kind: "audio", ts: ts + opts.shift, wall: ts + opts.relay + opts.audioAdd + drift + j("la") });
  }
  return { source, listen };
}

test("the added audio delay, the video's own, and the offset inside -listen come out of known streams", () => {
  const { source, listen } = paths({ seconds: 30, shift: -7.5, relay: 0.1, videoAdd: 0.04, audioAdd: 0.09 });
  const s = sampleWindow(source, listen, 4, 14);
  assert.ok(s);
  assert.ok(Math.abs(s.audioDelayMs - 90) < 1, `audio delay ${s.audioDelayMs}`);
  assert.ok(Math.abs(s.videoDelayMs - 40) < 1, `video delay ${s.videoDelayMs}`);
  assert.ok(Math.abs(s.videoCheckMs - 40) < 1, `video by the minimum filter ${s.videoCheckMs}`);
  assert.ok(Math.abs(s.avOffsetMs - 50) < 1, `A/V offset ${s.avOffsetMs}: audio 90 ms late against video 40 ms late is 50`);
});

test("the origin shift between the paths does not leak into the delay: any shift, same answer", () => {
  for (const shift of [-7.5, 0, 123.456]) {
    const { source, listen } = paths({ seconds: 20, shift, relay: 0.05, videoAdd: 0, audioAdd: 0.06 });
    const s = sampleWindow(source, listen, 4, 14);
    assert.ok(s && Math.abs(s.audioDelayMs - 60) < 1, `shift ${shift}: ${s?.audioDelayMs}`);
  }
});

test("a stream's offset is its fastest packet in the window, so jitter does not move it", () => {
  const packets: Packet[] = [
    { kind: "audio", ts: 0, wall: 0.2 },
    { kind: "audio", ts: 1, wall: 1.05 },
    { kind: "audio", ts: 2, wall: 2.4 },
    { kind: "video", ts: 1, wall: 9 },
  ];
  assert.ok(Math.abs(wallOffset(packets, "audio", 0, 10)! - 0.05) < 1e-9);
  assert.ok(Math.abs(wallOffset(packets, "audio", 1.5, 10)! - 0.4) < 1e-9, "only packets that arrived in the window count");
  assert.equal(wallOffset(packets, "audio", 5, 6), null);
});

test("frames are matched by checksum, and a checksum seen twice on a path matches nothing", () => {
  const source: Packet[] = [];
  const listen: Packet[] = [];
  for (let n = 0; n < 30; n++) {
    source.push({ kind: "video", ts: n, wall: n + 1, crc: `c${n}` });
    listen.push({ kind: "video", ts: n + 100, wall: n + 1.5, crc: `c${n}` });
  }
  // A frame repeated on the source (a black frame, say) would pair with whichever came first.
  source.push({ kind: "video", ts: 40, wall: 41, crc: "c5" });
  source.push({ kind: "audio", ts: 0, wall: 0, crc: "c1" });
  const m = matchVideo(source, listen);
  assert.ok(m);
  assert.equal(m.pairs, 29, "the repeated checksum was paired");
  assert.equal(m.shift, 100);
  assert.equal(m.videoDelay, 0.5);
  assert.equal(matchVideo(source.slice(0, 5), listen), null, "fewer than ten pairs is no basis for a shift");
});

test("a window with no audio, or with frames that do not match, gives no figure rather than a wrong one", () => {
  const { source, listen } = paths({ seconds: 20, shift: 1, relay: 0.1, videoAdd: 0.04, audioAdd: 0.09 });
  assert.equal(sampleWindow(source, listen.filter((p) => p.kind === "video"), 4, 14), null);
  assert.equal(sampleWindow(source, listen.map((p) => (p.crc ? { ...p, crc: `${p.crc}x` } : p)), 4, 14), null);
});

test("drift is the slope of the figure over the run, in ms per minute, with its min and max", () => {
  const { source, listen } = paths({ seconds: 600, shift: -3, relay: 0.1, videoAdd: 0.04, audioAdd: 0.06, audioDriftPerMin: 0.002 });
  const points = [];
  for (let from = 4; from + 10 <= 600; from += 10) {
    const s = sampleWindow(source, listen, from, from + 10);
    assert.ok(s);
    points.push({ at: s.at, value: s.audioDelayMs });
  }
  const series = summarize(points);
  assert.ok(series);
  assert.ok(Math.abs(series.slopePerMin - 2) < 0.1, `slope ${series.slopePerMin}`);
  assert.ok(series.max > series.min + 15, "min and max did not span the 10 minutes of drift");
  assert.equal(summarize([]), null);
  assert.deepEqual(summarize([{ at: 10, value: 5 }]), { n: 1, min: 5, max: 5, mean: 5, slopePerMin: 0 });
});

// ── The RTSP client ─────────────────────────────────────────────────────────

const SDP = ["v=0", "m=video 0 RTP/AVP 96", "a=control:trackID=0", "m=audio 0 RTP/AVP 97", "a=rtpmap:97 opus/48000/2", "a=control:trackID=1", ""].join("\r\n");
const rtp = (channel: number) => Buffer.concat([Buffer.from([0x24, channel, 0, 16]), Buffer.alloc(16, 0x80)]);

/** A one-connection RTSP server: answers as scripted, records what was asked. */
async function fakeRelay(opts: { describe?: (url: string) => { status: number; sdp?: string }; afterPlay: (socket: net.Socket) => void }) {
  const requests: string[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("latin1");
      for (let end = buf.indexOf("\r\n\r\n"); end >= 0; end = buf.indexOf("\r\n\r\n")) {
        const req = buf.slice(0, end);
        buf = buf.slice(end + 4);
        const [line] = req.split("\r\n");
        requests.push(line!);
        const cseq = /CSeq: (\d+)/.exec(req)![1];
        const method = line!.split(" ")[0];
        if (method === "DESCRIBE") {
          const d = opts.describe?.(line!.split(" ")[1]!) ?? { status: 200, sdp: SDP };
          const body = d.sdp ?? "";
          socket.write(`RTSP/1.0 ${d.status} X\r\nCSeq: ${cseq}\r\nContent-Base: rtsp://127.0.0.1/cam/\r\nContent-Type: application/sdp\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
        } else if (method === "SETUP") {
          socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: abc123;timeout=60\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`);
        } else if (method === "PLAY") {
          socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: abc123\r\n\r\n`);
          opts.afterPlay(socket);
        }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("the RTSP client times DESCRIBE through the first RTP packet on the audio channel, sets up only the audio track, and ignores RTCP", async () => {
  const relay = await fakeRelay({
    afterPlay: (s) => {
      // RTCP on channel 1 at once; the first RTP on channel 0 only after 300 ms.
      s.write(rtp(1));
      setTimeout(() => s.write(rtp(0)), 300);
    },
  });
  try {
    const r = await timeToFirstAudio("127.0.0.1", relay.port, "cam");
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.totalMs >= 290, `${r.totalMs} ms: an RTCP packet was counted as audio`);
    assert.ok(r.answeredMs < r.totalMs);
    assert.ok(relay.requests.some((q) => q.startsWith("SETUP rtsp://127.0.0.1/cam/trackID=1 ")), `SETUP asked for ${relay.requests.join(" | ")}`);
    assert.equal(relay.requests.filter((q) => q.startsWith("SETUP")).length, 1, "the video track was set up too");
  } finally {
    await relay.close();
  }
});

test("the RTSP client says why when there is no audio to time", async () => {
  const noAudio = await fakeRelay({ describe: () => ({ status: 200, sdp: "v=0\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n" }), afterPlay: () => {} });
  const missing = await fakeRelay({ describe: () => ({ status: 404 }), afterPlay: () => {} });
  const locked = await fakeRelay({ describe: () => ({ status: 401 }), afterPlay: () => {} });
  try {
    assert.deepEqual(await timeToFirstAudio("127.0.0.1", noAudio.port, "cam"), { ok: false, reason: "the stream has no audio track" });
    assert.deepEqual(await timeToFirstAudio("127.0.0.1", missing.port, "cam"), { ok: false, reason: "DESCRIBE answered 404" });
    const l = await timeToFirstAudio("127.0.0.1", locked.port, "cam");
    assert.ok(!l.ok && /credentials/.test(l.reason));
    const silent = await fakeRelay({ afterPlay: () => {} });
    const t = await timeToFirstAudio("127.0.0.1", silent.port, "cam", 400);
    assert.ok(!t.ok && /no audio packet within/.test(t.reason));
    await silent.close();
  } finally {
    await Promise.all([noAudio.close(), missing.close(), locked.close()]);
  }
});

// ── Reading packets off ffprobe ─────────────────────────────────────────────

test("each packet is stamped when its line arrives, a line split across writes is whole, and the reader ends with ffprobe", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "listen-measure-"));
  const fake = path.join(dir, "ffprobe");
  await fs.writeFile(
    fake,
    ["#!/bin/sh", "printf 'packet|codec_type=audio|dts_time=0.1|data_hash=CRC32:a\\n'", "sleep 0.4", "printf 'packet|codec_type=vid'", "sleep 0.1", "printf 'eo|dts_time=0.2|data_hash=CRC32:b\\n'", "echo 'oops' >&2"].join("\n"),
    { mode: 0o755 },
  );
  try {
    const start = performance.now();
    const reader = readPackets(fake, "rtsp://127.0.0.1:1/x", start);
    await new Promise<void>((r) => reader.proc.on("close", () => r()));
    assert.deepEqual(reader.packets.map((p) => [p.kind, p.ts, p.crc]), [["audio", 0.1, "CRC32:a"], ["video", 0.2, "CRC32:b"]]);
    assert.ok(reader.packets[1]!.wall - reader.packets[0]!.wall >= 0.4, "both lines were stamped at the same instant");
    assert.equal(reader.lastError(), "oops");
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
