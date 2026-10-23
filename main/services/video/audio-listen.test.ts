import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AudioConversion } from "../../types/video.js";
import { classifyAudio, listenArgv, listenPathName, planAudio, quoteForMediaMtx, resolveAudio, type ListenCapability, type RelayAudio } from "./audio-listen.js";

const CAP: ListenCapability = { ok: true, ffmpegPath: "/usr/bin/ffmpeg", rtspPort: 8554 };
const NO_FFMPEG: ListenCapability = { ok: false, reason: "ffmpeg is not installed on this server" };
const AAC = "MPEG-4 Audio";

function settle(conversion: AudioConversion, audio: RelayAudio, sourceUrl?: string, capability: ListenCapability = CAP) {
  return resolveAudio(planAudio({ conversion, audio, sourceUrl }, "cam"), "cam", capability);
}

// The exact commands. MediaMTX runs these, so every flag is part of the contract.
test("converting: ffmpeg reads the relay's copy, copies the video and re-encodes the audio to Opus", () => {
  const r = settle("auto", AAC);
  assert.equal(
    r.listenCommand,
    "'/usr/bin/ffmpeg' '-hide_banner' '-nostdin' '-nostats' '-loglevel' 'warning' '-fflags' 'nobuffer' '-flags' 'low_delay' " +
      "'-probesize' '65536' '-analyzeduration' '500000' '-rtsp_transport' 'tcp' '-i' 'rtsp://127.0.0.1:8554/cam' " +
      "'-c:v' 'copy' '-c:a' 'libopus' '-b:a' '128k' '-application' 'lowdelay' '-frame_duration' '20' " +
      "'-f' 'rtsp' '-rtsp_transport' 'tcp' 'rtsp://127.0.0.1:8554/cam-listen'",
  );
  assert.deepEqual(r.status, { state: "converted", listenPath: "cam-listen" });
  assert.equal(r.why, "AAC");
});

test("pass-through: ffmpeg reads the audio source address and copies everything", () => {
  const r = settle("auto", "Opus", "http://192.0.2.28/0.ts");
  assert.equal(
    r.listenCommand,
    "'/usr/bin/ffmpeg' '-hide_banner' '-nostdin' '-nostats' '-loglevel' 'warning' '-fflags' 'nobuffer' '-flags' 'low_delay' " +
      "'-probesize' '65536' '-analyzeduration' '500000' '-rw_timeout' '10000000' '-i' 'http://192.0.2.28/0.ts' " +
      "'-c' 'copy' '-f' 'rtsp' '-rtsp_transport' 'tcp' 'rtsp://127.0.0.1:8554/cam-listen'",
  );
  assert.deepEqual(r.status, { state: "pass-through", listenPath: "cam-listen" });
});

// One row per mode. `-` is "no -listen path".
test("which feeds get a -listen path: every mode against every audio", () => {
  const rows: [AudioConversion, RelayAudio, string, string][] = [
    // conversion, audio, status.state, converter
    ["auto", AAC, "converted", "convert"],
    ["auto", "Opus", "direct", "-"],
    ["auto", "G711", "direct", "-"],
    ["auto", "G722", "direct", "-"],
    ["auto", "MPEG-1/2 Audio", "unavailable", "-"],
    ["auto", null, "none", "-"],
    ["auto", undefined, "unknown", "convert"],
    ["off", AAC, "unavailable", "-"],
    ["off", "Opus", "direct", "-"],
    ["off", null, "none", "-"],
    ["off", undefined, "unknown", "-"],
    ["always", AAC, "converted", "convert"],
    ["always", "Opus", "converted", "convert"],
    ["always", "MPEG-1/2 Audio", "converted", "convert"],
    ["always", null, "none", "-"],
    ["always", undefined, "unknown", "convert"],
  ];
  const got = rows.map(([c, a]) => {
    const r = settle(c, a);
    return [c, a, r.status.state, r.listenCommand === undefined ? "-" : "convert"];
  });
  assert.deepEqual(got, rows);
});

test("an audio source address is a pass-through unless the conversion is Off, which never runs ffmpeg", () => {
  const url = "http://192.0.2.28/0.ts";
  for (const c of ["auto", "always"] as const) {
    for (const a of [AAC, "Opus", null, undefined] as RelayAudio[]) {
      const r = settle(c, a, url);
      assert.equal(r.status.state, "pass-through", `${c}/${String(a)}`);
      assert.ok(r.listenCommand?.includes(`'${url}'`));
    }
  }
  const off = settle("off", AAC, url);
  assert.equal(off.listenCommand, undefined);
  assert.equal(off.status.state, "unavailable");
  assert.equal(settle("off", "Opus", url).status.state, "direct");
});

test("a direct feed is read on its own path and a converted one on its -listen sibling", () => {
  assert.deepEqual(settle("auto", "Opus").status, { state: "direct", listenPath: "cam" });
  assert.deepEqual(settle("auto", AAC).status, { state: "converted", listenPath: "cam-listen" });
  assert.equal(listenPathName("ma-pgm"), "ma-pgm-listen");
});

test("with no usable ffmpeg no -listen path is written and a feed that needs one says why", () => {
  for (const c of ["auto", "always"] as const) {
    const r = settle(c, AAC, undefined, NO_FFMPEG);
    assert.equal(r.listenCommand, undefined);
    assert.deepEqual(r.status, { state: "unavailable", reason: "ffmpeg is not installed on this server" });
  }
  const pass = settle("auto", "Opus", "http://192.0.2.28/0.ts", NO_FFMPEG);
  assert.equal(pass.listenCommand, undefined);
  assert.equal(pass.status.state, "unavailable");
  // A feed nobody has seen yet is not known to need ffmpeg, so it is not reported as broken.
  assert.deepEqual(settle("auto", undefined, undefined, NO_FFMPEG).status, { state: "unknown" });
  // A feed that needs no conversion does not care.
  assert.deepEqual(settle("auto", "Opus", undefined, NO_FFMPEG).status, { state: "direct", listenPath: "cam" });
});

test("classifying codec names as MediaMTX spells them", () => {
  assert.equal(classifyAudio("MPEG-4 Audio"), "aac");
  assert.equal(classifyAudio("Opus"), "direct");
  assert.equal(classifyAudio("G711"), "direct");
  assert.equal(classifyAudio("MPEG-1/2 Audio"), "other");
  assert.equal(classifyAudio("AC-3"), "other");
});

// MediaMTX splits the string with shell quoting rules then expands $NAME in each word.
test("a word that a quote or $ could change is refused, never escaped", () => {
  for (const word of ["/tmp/it's/ffmpeg", "/tmp/$HOME/ffmpeg", "/tmp/a\nb/ffmpeg", "/tmp/a\u0000b"]) {
    assert.equal(quoteForMediaMtx([word]).ok, false, JSON.stringify(word));
  }
  const odd = quoteForMediaMtx(["C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe", "-i", "x"]);
  assert.deepEqual(odd, { ok: true, command: "'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' '-i' 'x'" });
});

test("an ffmpeg path MediaMTX could not pass on makes the feed unavailable, with no -listen path", () => {
  const r = settle("auto", AAC, undefined, { ok: true, ffmpegPath: "/opt/$HOME/ffmpeg", rtspPort: 8554 });
  assert.equal(r.listenCommand, undefined);
  assert.equal(r.status.state, "unavailable");
});

test("a feed id that is not a safe relay path never reaches a command", () => {
  for (const id of ["a'b", "a b", "../x", "A", "", "a;b"]) {
    const r = resolveAudio(planAudio({ conversion: "always", audio: AAC }, id), id, CAP);
    assert.equal(r.listenCommand, undefined, id);
    assert.equal(r.status.state, "unavailable", id);
  }
});

test("an audio source address with shell syntax never reaches a command", () => {
  for (const url of ["http://h/x'; touch /tmp/x; '", "http://h/$X", "http://h/a b"]) {
    const r = settle("auto", AAC, url);
    assert.equal(r.listenCommand, undefined, url);
    assert.equal(r.status.state, "unavailable", url);
  }
});

test("listenArgv has the program first and nothing in it is shell syntax", () => {
  const argv = listenArgv("/usr/bin/ffmpeg", "cam", { mode: "convert", why: "AAC" }, 18554);
  assert.equal(argv[0], "/usr/bin/ffmpeg");
  assert.ok(argv.includes("rtsp://127.0.0.1:18554/cam"));
  assert.ok(argv.includes("rtsp://127.0.0.1:18554/cam-listen"));
});
