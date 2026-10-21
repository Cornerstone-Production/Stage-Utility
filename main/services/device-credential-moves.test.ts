// A Spectera base station's API password and a pulled camera's password go only
// to the address they were entered for.
//
// Both editors send an unchanged password back as "unchanged" (the wireless
// panel as the mask, the feed editor by leaving it out), and that kept the
// stored value whatever else the save changed. So a patch that moved the address
// handed the password to whatever answered at the new one, on the next dial.
// Driven through wirelessManager.updateConnection and videoService.updateFeed
// and importFeeds, the bodies of their routes. Connections stay disabled and no
// relay is attached, so nothing is dialled. The import's ordinary cases are
// driven through its route in video-transfer-routes.test.ts.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-device-credential-moves-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { wirelessManager } = await import("./wireless-manager.js");
const { wirelessSecretSlot } = await import("./wireless-credentials.js");
const { videoService } = await import("./video/video-service.js");
const { feedSecretSlot } = await import("./video/feed-id.js");
const { videoFeedsStore } = await import("./video/feed-store.js");
const { secretsStore } = await import("./secrets.js");
const { MASK } = await import("./mask.js");

let warned: string[] = [];
const realWarn = console.warn;
beforeEach(() => {
  warned = [];
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
});
afterEach(() => {
  console.warn = realWarn;
});

describe("a Spectera connection", () => {
  async function connection(config: Record<string, unknown>): Promise<string> {
    const list = await wirelessManager.addConnection({ name: `Base station ${Math.random()}`, providerId: "sennheiser-spectera" });
    const id = list[list.length - 1]!.id;
    await wirelessManager.updateConnection({ id, patch: { config } });
    return id;
  }
  const password = async (id: string) => (await secretsStore.getSecrets(wirelessSecretSlot(id))).password;
  /** What the panel posts when one field is committed: everything it holds,
   *  the password as the mask it was shown. */
  const commit = (id: string, config: Record<string, unknown>) =>
    wirelessManager.updateConnection({ id, patch: { config: { password: MASK, ...config } } });

  test("moved to another address loses its stored password, and the log says so", async () => {
    const id = await connection({ host: "spectera-a.example", password: "entered-for-a" });
    assert.equal(await password(id), "entered-for-a", "precondition: the password was stored");
    const list = await commit(id, { host: "attacker.example" });
    assert.equal(await password(id), undefined, "the password survived a move to another host");
    assert.equal(list.find((c) => c.id === id)?.config.password, "", "the panel should be told the field is empty now");
    assert.ok(warned.some((l) => l.startsWith("[wireless] cleared the stored password") && l.includes("attacker.example")), warned.join("\n"));
    assert.ok(!warned.join("\n").includes("entered-for-a"), "the log carried the password itself");
  });

  test("on another port, too", async () => {
    const id = await connection({ host: "spectera-a.example", password: "entered-for-a" });
    await commit(id, { host: "spectera-a.example", port: 8443 });
    assert.equal(await password(id), undefined);
  });

  test("keeps it when the port is set to the 443 it was already dialling", async () => {
    const id = await connection({ host: "spectera-a.example", password: "entered-for-a" });
    await commit(id, { host: "spectera-a.example", port: 443 });
    assert.equal(await password(id), "entered-for-a");
  });

  test("keeps a password the same patch supplies for the new address", async () => {
    const id = await connection({ host: "spectera-a.example", password: "entered-for-a" });
    await wirelessManager.updateConnection({ id, patch: { config: { host: "spectera-b.example", password: "entered-for-b" } } });
    assert.equal(await password(id), "entered-for-b");
  });

  test("keeps it across a rename", async () => {
    const id = await connection({ host: "spectera-a.example", password: "entered-for-a" });
    await wirelessManager.updateConnection({ id, patch: { name: "Renamed" } });
    assert.equal(await password(id), "entered-for-a");
  });

  test("switched to another provider at the same address loses it: the password was for the base station", async () => {
    const id = await connection({ host: "spectera-a.example", password: "entered-for-a" });
    await wirelessManager.updateConnection({ id, patch: { providerId: "shure-ulxd" } });
    assert.equal(await password(id), undefined);
    const line = warned.find((l) => l.startsWith("[wireless] cleared the stored password"));
    assert.ok(line, warned.join("\n"));
    // Same host either side, so the line has to name the provider to say what moved.
    assert.match(line, /sennheiser-spectera/);
    assert.match(line, /shure-ulxd/);
  });
});

describe("a pulled feed", () => {
  let n = 0;
  async function feed(url: string, password = "entered-for-a-camera"): Promise<string> {
    const made = await videoService.addFeed({ name: `Cam ${++n}`, source: { kind: "pull", url, username: "" }, password });
    assert.ok(made.ok, JSON.stringify(made));
    return (made as { feed: { id: string } }).feed.id;
  }
  const password = async (id: string) => (await secretsStore.getSecrets(feedSecretSlot(id))).password;
  const move = (id: string, url: string, extra: Record<string, unknown> = {}) =>
    videoService.updateFeed(id, { source: { kind: "pull", url, username: "" }, ...extra });
  const bundleMoving = (id: string, url: string) => ({
    kind: "stage-utility-video-feeds",
    version: 1,
    feeds: [{ id, name: `Cam ${n}`, source: { kind: "pull", url, username: "" } }],
  });
  async function importReviewed(bundle: ReturnType<typeof bundleMoving>, id: string) {
    const reviewed = await videoService.previewImport(bundle);
    assert.ok(reviewed.ok, JSON.stringify(reviewed));
    const here = reviewed.preview.feeds.find((f) => f.id === id)?.here;
    assert.ok(here);
    return videoService.importFeeds({ bundle, choices: { [id]: "replace" }, expect: { [id]: here } });
  }

  type Update = typeof videoFeedsStore.update;
  /** Runs `act` with the feeds file's writes going through `write`, and puts the
   *  real one back. */
  async function withFeedsWrite(write: (real: Update) => Update, act: () => Promise<unknown>): Promise<unknown> {
    const real = videoFeedsStore.update.bind(videoFeedsStore) as Update;
    videoFeedsStore.update = write(real);
    try {
      return await act();
    } finally {
      videoFeedsStore.update = real;
    }
  }

  test("pointed at another camera loses its stored password, and the log says so", async () => {
    const id = await feed("rtsp://cam-a.example/stream");
    const r = await move(id, "rtsp://attacker.example/stream");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(await password(id), undefined, "the password survived a move to another camera");
    assert.equal((r as { feed: { hasPassword?: boolean } }).feed.hasPassword, false, "the editor should be told none is saved now");
    assert.ok(warned.some((l) => l.startsWith("[video]") && l.includes("cleared the stored password") && l.includes("attacker.example")), warned.join("\n"));
  });

  test("keeps it for a new path, port or protocol on the same camera", async () => {
    // One camera serves RTSP, SRT and HLS on ports of its own. The password
    // follows the camera, and SRT holds it to the passphrase rule.
    const id = await feed("rtsp://cam-a.example/stream", "a-long-enough-passphrase");
    assert.ok((await move(id, "rtsp://cam-a.example/other")).ok);
    assert.ok((await move(id, "rtsp://cam-a.example:8554/other")).ok);
    assert.ok((await move(id, "srt://cam-a.example:9000")).ok);
    assert.equal(await password(id), "a-long-enough-passphrase");
    assert.deepEqual(warned.filter((l) => l.includes("cleared the stored password")), []);
  });

  test("loses it when the camera's address goes from rtsps to plain rtsp: it would travel in the clear", async () => {
    const id = await feed("rtsps://cam-a.example/stream");
    assert.ok((await move(id, "rtsp://cam-a.example/stream")).ok);
    assert.equal(await password(id), undefined);
  });

  test("keeps it when the same camera goes from rtsp to rtsps: securing a camera is not a move", async () => {
    const id = await feed("rtsp://cam-a.example/stream");
    assert.ok((await move(id, "rtsps://cam-a.example/stream")).ok);
    assert.ok((await move(id, "https://cam-a.example/hls/index.m3u8")).ok);
    assert.equal(await password(id), "entered-for-a-camera");
  });

  test("keeps a password the same edit supplies for the new camera", async () => {
    const id = await feed("rtsp://cam-a.example/stream");
    assert.ok((await move(id, "rtsp://cam-b.example/stream", { password: "entered-for-b" })).ok);
    assert.equal(await password(id), "entered-for-b");
  });

  test("moved to an SRT address elsewhere is not checked against the password it no longer keeps", async () => {
    // The stored RTSP password is too short for an SRT passphrase. Kept, it
    // would be refused as one ("the password saved for this feed would be
    // used"); dropped, there is nothing to check.
    const id = await feed("rtsp://cam-a.example/stream", "short");
    const r = await move(id, "srt://encoder-b.example:9000");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(await password(id), undefined);
  });

  test("a new feed does not inherit a password an earlier feed of the same name left in its slot", async () => {
    // The slot a removed "Porch cam" would have used, its clear never having run.
    await secretsStore.setSecrets(feedSecretSlot("porch-cam"), { password: "another-cameras-password" });
    const made = await videoService.addFeed({ name: "Porch cam", source: { kind: "pull", url: "rtsp://cam-z.example/s", username: "" } });
    assert.ok(made.ok, JSON.stringify(made));
    assert.equal((made as { feed: { id: string } }).feed.id, "porch-cam", "precondition: the new feed took the old slot's id");
    assert.equal(await password("porch-cam"), undefined, "the new feed would dial its camera with another camera's password");
    assert.ok(warned.some((l) => l.startsWith("[video] Porch cam: cleared a password left behind")), warned.join("\n"));
  });

  test("replaced by an import with an address on another camera loses it, and the log says so", async () => {
    const id = await feed("rtsp://cam-a.example/stream");
    const result = await importReviewed(bundleMoving(id, "rtsp://attacker.example/stream"), id);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.report.passwordsCleared, [`Cam ${n}`]);
    assert.equal(await password(id), undefined, "an import moved the feed and kept the old camera's password");
    assert.ok(warned.some((l) => l.startsWith(`[video] Cam ${n}: cleared the stored password`) && l.includes("attacker.example")), warned.join("\n"));
  });

  // The order matters, not only the outcome: written the other way round, the
  // new address and the old password are on disk together for a moment, and a
  // reconcile already running (or the next boot after a crash) dials the new
  // address with it.
  test("the new address is never written while the old camera's password is still stored, by an edit or an import", async () => {
    for (const via of ["edit", "import"] as const) {
      const id = await feed("rtsp://cam-a.example/stream");
      const seenAtWrite: (string | undefined)[] = [];
      await withFeedsWrite(
        (real) => (async (mutate) => {
          seenAtWrite.push(await password(id));
          return real(mutate);
        }) as Update,
        () => (via === "edit" ? move(id, "rtsp://attacker.example/stream") : importReviewed(bundleMoving(id, "rtsp://attacker.example/stream"), id)),
      );
      assert.deepEqual(seenAtWrite, [undefined], `${via}: the feeds file was written while the old password was stored`);
    }
  });

  test("a feeds write that fails leaves the feed at its old address with its password, by an edit or an import", async () => {
    for (const via of ["edit", "import"] as const) {
      const id = await feed("rtsp://cam-a.example/stream");
      const failing = (() => () => Promise.reject(new Error("disk full"))) as unknown as (real: Update) => Update;
      await assert.rejects(
        withFeedsWrite(failing, () => (via === "edit" ? move(id, "rtsp://attacker.example/stream") : importReviewed(bundleMoving(id, "rtsp://attacker.example/stream"), id))),
        /disk full/,
      );
      assert.equal(await password(id), "entered-for-a-camera", `${via}: a failed write cost the feed its password`);
    }
  });
});
