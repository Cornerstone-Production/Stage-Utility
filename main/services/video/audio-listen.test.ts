import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AudioConversion } from "../../types/video.js";
import {
  PASS_THROUGH_PROTOCOLS, RELAY_PROTOCOLS, WHY_AAC, classifyAudio, listenArgv, listenPathName, planAudio, quoteForMediaMtx, resolveAudio,
  type ListenCapability, type RelayAudio,
} from "./audio-listen.js";

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
      "'-probesize' '65536' '-analyzeduration' '500000' '-protocol_whitelist' 'rtsp,rtp,tcp' '-rtsp_transport' 'tcp' '-i' 'rtsp://127.0.0.1:8554/cam' " +
      "'-c:v' 'copy' '-c:a' 'libopus' '-b:a' '128k' '-application' 'lowdelay' '-frame_duration' '20' " +
      "'-f' 'rtsp' '-rtsp_transport' 'tcp' 'rtsp://127.0.0.1:8554/cam-listen'",
  );
  assert.deepEqual(r.status, { state: "converted", listenPath: "cam-listen" });
  assert.equal(r.why, WHY_AAC);
});

test("pass-through: ffmpeg reads the audio source address and copies everything", () => {
  const r = settle("auto", "Opus", "http://192.0.2.28/0.ts");
  assert.equal(
    r.listenCommand,
    "'/usr/bin/ffmpeg' '-hide_banner' '-nostdin' '-nostats' '-loglevel' 'warning' '-fflags' 'nobuffer' '-flags' 'low_delay' " +
      "'-probesize' '65536' '-analyzeduration' '500000' '-protocol_whitelist' 'http,https,tls,tcp' '-rw_timeout' '10000000' '-i' 'http://192.0.2.28/0.ts' " +
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

// MediaMTX splits the string with shell quoting rules, then expands $NAME in each
// word, so each of these would change what runs. One table, three entry points.
test("anything that could change what runs is refused: a word, an ffmpeg path, an id, an address", () => {
  for (const word of ["/tmp/it's/ffmpeg", "/tmp/$HOME/ffmpeg", "/tmp/a\nb/ffmpeg", "/tmp/a\u0000b"]) {
    assert.equal(quoteForMediaMtx([word]).ok, false, JSON.stringify(word));
    const r = settle("auto", AAC, undefined, { ok: true, ffmpegPath: word, rtspPort: 8554 });
    assert.equal(r.listenCommand, undefined, word);
    assert.equal(r.status.state, "unavailable", word);
  }
  // A path with spaces and backslashes is fine: single quotes keep it whole.
  assert.deepEqual(quoteForMediaMtx(["C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe", "-i", "x"]), {
    ok: true,
    command: "'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' '-i' 'x'",
  });
  for (const id of ["a'b", "a b", "../x", "A", "", "a;b"]) {
    const r = resolveAudio(planAudio({ conversion: "always", audio: AAC }, id), id, CAP);
    assert.equal(r.listenCommand, undefined, `id ${id}`);
    assert.equal(r.status.state, "unavailable", `id ${id}`);
  }
  for (const url of ["http://h/x'; touch /tmp/x; '", "http://h/$X", "http://h/a b"]) {
    const r = settle("auto", AAC, url);
    assert.equal(r.listenCommand, undefined, url);
    assert.equal(r.status.state, "unavailable", url);
  }
});

// A store restored from a backup or edited by hand is not validated when it is
// loaded, so the command builder is where an address is held to http and https.
test("an address that is not plain http or https never reaches ffmpeg, whatever the store holds", () => {
  for (const url of ["file:/etc/passwd", "tcp://0.0.0.0:9999?listen=1", "subfile:,start,0,end,0,,:/etc/passwd", "udp://@:5000", "rtsp://192.0.2.9/x", "http://u:p@192.0.2.28/0.ts"]) {
    const r = settle("auto", "Opus", url);
    assert.equal(r.listenCommand, undefined, url);
    assert.equal(r.status.state, "unavailable", url);
  }
});

test("each input may open only what it needs", () => {
  const convert = listenArgv("/usr/bin/ffmpeg", "cam", { mode: "convert", why: WHY_AAC }, 8554);
  assert.equal(convert[convert.indexOf("-protocol_whitelist") + 1], RELAY_PROTOCOLS);
  assert.ok(convert.indexOf("-protocol_whitelist") < convert.indexOf("-i"), "the whitelist must come before the input");
  const pass = settle("auto", "Opus", "http://192.0.2.28/0.ts");
  assert.ok(pass.listenCommand?.includes(`'-protocol_whitelist' '${PASS_THROUGH_PROTOCOLS}' '-rw_timeout' '10000000' '-i'`), pass.listenCommand);
  assert.equal(RELAY_PROTOCOLS, "rtsp,rtp,tcp");
  assert.equal(PASS_THROUGH_PROTOCOLS, "http,https,tls,tcp");
});

test("listenArgv has the program first and nothing in it is shell syntax", () => {
  const argv = listenArgv("/usr/bin/ffmpeg", "cam", { mode: "convert", why: WHY_AAC }, 18554);
  assert.equal(argv[0], "/usr/bin/ffmpeg");
  assert.ok(argv.includes("rtsp://127.0.0.1:18554/cam"));
  assert.ok(argv.includes("rtsp://127.0.0.1:18554/cam-listen"));
});
