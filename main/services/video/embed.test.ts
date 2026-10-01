import { strict as assert } from "node:assert";
import { test } from "node:test";
import { embedSrc, normalizeEmbedRef } from "./embed.js";

test("a channel URL becomes its UC id", () => {
  assert.deepEqual(
    normalizeEmbedRef("youtube-channel", "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"),
    { ok: true, ref: "UCabcdefghijklmnopqrstuv" },
  );
});
test("a handle is refused with where to find the id", () => {
  const r = normalizeEmbedRef("youtube-channel", "@example");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /starts with UC/);
});
test("a watch URL, a youtu.be URL and a bare id give one video id", () => {
  for (const raw of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"]) {
    assert.deepEqual(normalizeEmbedRef("youtube-video", raw), { ok: true, ref: "dQw4w9WgXcQ" });
  }
});
test("a Resi embed must be a control.resi.io player URL, pasted as the iframe or the src", () => {
  const src = "https://control.resi.io/webplayer/video.html?id=abc-123";
  assert.deepEqual(normalizeEmbedRef("resi", `<iframe src="${src}"></iframe>`), { ok: true, ref: src });
  assert.equal(normalizeEmbedRef("resi", "https://evil.example/webplayer/video.html?id=1").ok, false);
});
test("every src is muted, autoplays and has no controls", () => {
  assert.equal(
    embedSrc("youtube-channel", "UCabcdefghijklmnopqrstuv"),
    "https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv&autoplay=1&mute=1&controls=0&playsinline=1",
  );
  assert.equal(
    embedSrc("youtube-video", "dQw4w9WgXcQ"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1&controls=0&playsinline=1",
  );
  const resi = new URL(embedSrc("resi", "https://control.resi.io/webplayer/video.html?id=abc-123"));
  assert.equal(resi.searchParams.get("autoplay"), "true");
  assert.equal(resi.searchParams.get("mute"), "true");
});
test("resi embeds override existing mute and autoplay to true", () => {
  const resi = new URL(embedSrc("resi", "https://control.resi.io/webplayer/video.html?id=abc-123&mute=false&autoplay=false"));
  assert.equal(resi.searchParams.get("autoplay"), "true");
  assert.equal(resi.searchParams.get("mute"), "true");
});
test("a Resi player must be exactly control.resi.io, over https, under /webplayer/", () => {
  for (const bad of [
    "http://control.resi.io/webplayer/video.html?id=1",
    "https://evilcontrol.resi.io/webplayer/video.html?id=1",
    "https://control.resi.io.example/webplayer/video.html?id=1",
    "https://resi.io/webplayer/video.html?id=1",
    "https://control.resi.io/other/video.html?id=1",
  ]) {
    assert.equal(normalizeEmbedRef("resi", bad).ok, false, bad);
  }
  assert.equal(normalizeEmbedRef("resi", "https://control.resi.io/webplayer/video.html?id=1").ok, true);
});
