// The custom tab and home-screen icon, from the request that sets it to the bytes a
// phone is served and the backup that carries it.
//
// Everything here is the real thing: the real branding route, the real controller
// and settings store over a temp data directory, the real icon route, the real
// config snapshot. Nothing stands in for the code path being checked, because the
// failure this feature can have is a path that is each-half-correct and wrong
// end to end (a stored icon the route never reads; a backup that lists the
// settings and not the files they point at).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "app-icon-routes-"));
process.env.STAGE_UTILITY_DATA = DATA;

const { brandingRoutes } = await import("./branding-routes.js");
const { appIconRoutes } = await import("./app-icon-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");
const { configSnapshot } = await import("../config-snapshot.js");
const { iconInput, pngDataUrl } = await import("../app-icon-fixture.js");
const { ICON_ROUTES } = await import("../install-metadata.js");
const { initLogCapture, getLogLines, setLogSink } = await import("../log-buffer.js");
// The buffer only records while something is listening to it.
setLogSink(() => {});
initLogCapture();

const branding = () => getLogLines().map((l) => l.msg).filter((m) => m.startsWith("[branding]"));

const PATHS = Object.keys(ICON_ROUTES);
const REF = /^\/branding-images\/[0-9a-f]{16}\.png$/;

function post(body: unknown) {
  return callRoute(brandingRoutes, "/api/branding", { method: "POST", body });
}

async function settings(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(DATA, "settings.json"), "utf8")) as Record<string, unknown>;
}

/** The bytes a path answers with, or null when the route leaves it to the static handler. */
async function served(p: string) {
  const r = await callRoute(appIconRoutes, p);
  return r.responded ? r : null;
}

describe("with no custom icon", () => {
  test("every icon path is left to the built-in files", async () => {
    for (const p of PATHS) assert.equal(await served(p), null, `${p} was answered with no icon set`);
  });

  test("the manifest names the app and the three icons", async () => {
    const r = await served("/manifest.webmanifest");
    assert.ok(r);
    assert.equal(r.status, 200);
    assert.equal(r.headers["Content-Type"], "application/manifest+json");
    assert.equal(r.headers["Cache-Control"], "no-cache");
    const m = r.json as { name: string; short_name: string; icons: { src: string }[] };
    assert.equal(m.name, "Stage Utility");
    assert.equal(m.short_name, "Stage Utility");
    assert.deepEqual(m.icons.map((i) => i.src), ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"]);
  });

  test("state carries no icon and the default background", () => {
    const s = stageController.getState();
    assert.equal(s.appIcon192, null);
    assert.equal(s.appIconMaskable, null);
    assert.equal(s.appIconBackground, "#000000");
  });
});

describe("POST /api/branding with an icon", () => {
  test("a refused icon is a 400 naming the field, and changes nothing", async () => {
    const r = await post({ icon: { ...iconInput(), apple: pngDataUrl(192) } });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /body\.icon\.apple must be 180 x 180/);
    assert.equal(stageController.getState().appIcon192, null);
    assert.equal(await served("/apple-touch-icon.png"), null);
  });

  test("a good one is stored as files, and the state carries references, never bytes", async () => {
    const r = await post({ icon: iconInput({ background: "#2e6691" }) });
    assert.equal(r.status, 200, r.body.slice(0, 200));
    assert.deepEqual(
      branding().filter((m) => m.includes("icon set")),
      ["[branding] custom tab and home-screen icon set, background #2e6691"],
    );
    const s = stageController.getState();
    assert.match(s.appIcon192 as string, REF);
    assert.match(s.appIconMaskable as string, REF);
    assert.equal(s.appIconBackground, "#2e6691");

    const onDisk = await settings();
    for (const key of ["appIcon", "appIconOriginal", "appIconApple", "appIcon192", "appIcon512", "appIconMaskable"]) {
      assert.match(onDisk[key] as string, REF, `${key} is not a stored reference`);
    }
    assert.equal(onDisk.appIconBackground, "#2e6691");
    assert.deepEqual(onDisk.appIconCrop, { scale: 1, x: 0, y: 0 });
  });

  test("the editor's source for the icon is its original and crop", async () => {
    const src = await stageController.getBrandingSource("icon");
    assert.match(src.original as string, REF);
    assert.match(src.art as string, REF, "the art is what a new background is redrawn from");
    assert.deepEqual(src.crop, { scale: 1, x: 0, y: 0 });
    const viaRoute = await callRoute(brandingRoutes, "/api/branding/source?target=icon");
    assert.deepEqual(viaRoute.json, src);
  });
});

describe("with a custom icon set", () => {
  test("each path answers with the custom bytes, as a PNG that revalidates", async () => {
    const onDisk = await settings();
    const fields = {
      "/apple-touch-icon.png": "appIconApple",
      "/icon-192.png": "appIcon192",
      "/icon-512.png": "appIcon512",
      "/icon-maskable-512.png": "appIconMaskable",
    } as const;
    for (const p of PATHS) {
      const r = await served(p);
      assert.ok(r, `${p} fell through to the built-in icon`);
      assert.equal(r.status, 200);
      assert.equal(r.headers["Content-Type"], "image/png");
      assert.equal(r.headers["Cache-Control"], "no-cache", `${p} must revalidate: a new icon has to reach the next install`);
      const file = await fsp.readFile(path.join(DATA, String(onDisk[fields[p as keyof typeof fields]])));
      assert.equal(r.body, file.toString(), `${p} did not answer with its own stored file`);
    }
  });

  test("the tab's own URL, with its ?v= query, is answered like the bare path", async () => {
    // The tab loads /icon-192.png?v=<hash>; the dispatcher hands a route only the
    // pathname, and callRoute splits the URL the same way.
    const bare = await served("/icon-192.png");
    const tab = await callRoute(appIconRoutes, "/icon-192.png?v=0123456789abcdef");
    assert.ok(bare && tab.responded, "the tab's URL fell through to the built-in icon");
    assert.equal(tab.body, bare.body);
  });

  test("the four paths are four different images", async () => {
    const bodies = new Set<string>();
    for (const p of PATHS) bodies.add((await served(p))!.body);
    // apple and 192 share a colour but not a size; 512 and maskable differ by seed.
    assert.equal(bodies.size, 4);
  });

  test("the manifest is unchanged by the icon, because the paths are the same", async () => {
    const m = (await served("/manifest.webmanifest"))!.json as { icons: { src: string }[] };
    assert.deepEqual(m.icons.map((i) => i.src), ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"]);
  });

  test("the manifest follows the app name", async () => {
    await post({ name: "Chapel AV" });
    const m = (await served("/manifest.webmanifest"))!.json as { name: string; short_name: string };
    assert.equal(m.name, "Chapel AV");
    assert.equal(m.short_name, "Chapel AV");
  });

  test("a backup carries the settings keys and every file they point at", async () => {
    const snap = await configSnapshot.build();
    const bundled = (snap.files["settings.json"] ?? {}) as Record<string, unknown>;
    const refs = ["appIcon", "appIconOriginal", "appIconApple", "appIcon192", "appIcon512", "appIconMaskable"].map(
      (k) => bundled[k] as string,
    );
    for (const ref of refs) {
      assert.match(ref, REF);
      assert.ok(snap.images?.[ref.replace(/^\//, "")], `the backup does not hold ${ref}`);
    }
    assert.equal(bundled.appIconBackground, "#2e6691");
  });

  test("a stored reference whose file is gone falls back to the built-in icon, and the log says so once", async () => {
    const onDisk = await settings();
    await fsp.rm(path.join(DATA, (onDisk.appIcon192 as string).replace(/^\//, "")));
    const before = branding().length;
    assert.equal(await served("/icon-192.png"), null, "the built-in icon should answer");
    assert.equal(await served("/icon-192.png"), null);
    assert.equal(await served("/icon-192.png"), null);
    const added = branding().slice(before);
    assert.equal(added.length, 1, `expected one line for three requests, got ${JSON.stringify(added)}`);
    assert.match(added[0]!, /a custom icon is set but its file could not be read; serving the built-in icon for \/icon-192\.png \/branding-images\//);
  });
});

describe("saving an adjusted image sends back the reference the editor was given", () => {
  // GET /api/branding/source returns `/branding-images/<hash>`, never the base64, and
  // the editor posts that same value back as the original with the new crop. The
  // route used to refuse anything that was not a data URL, so every Adjust failed.
  test("each of the four originals accepts a stored reference, and keeps it", async () => {
    await post({ logo: pngDataUrl(64, 5), logoOriginal: pngDataUrl(64, 6), emptyLogo: pngDataUrl(64, 7), emptyLogoOriginal: pngDataUrl(64, 8), avatar: pngDataUrl(64, 9), avatarOriginal: pngDataUrl(64, 10) });
    const kept = await settings();
    for (const [key, field] of [["logoOriginal", "appLogoOriginal"], ["emptyLogoOriginal", "emptySlotLogoOriginal"], ["avatarOriginal", "defaultAvatarOriginal"]] as const) {
      const ref = kept[field] as string;
      assert.match(ref, REF);
      const r = await post({ [key]: ref, [key.replace("Original", "Crop")]: { scale: 2, x: -3, y: -4 } });
      assert.equal(r.status, 200, `${key}: ${r.body.slice(0, 160)}`);
      assert.equal((await settings())[field], ref, `${key} changed`);
    }
    const iconOriginal = (await settings()).appLogoOriginal as string;
    const r = await post({ icon: iconInput({ original: iconOriginal }) });
    assert.equal(r.status, 200, r.body.slice(0, 160));
    assert.equal((await settings()).appIconOriginal, iconOriginal);
  });

  test("a reference to a file that is not stored, or that is not one of ours, is a 400", async () => {
    for (const ref of ["/branding-images/0000000000000000.png", "/branding-images/../settings.json", "/branding-images/abc.png", "/layout-images/0123456789abcdef.png", "https://example.com/x.png"]) {
      const r = await post({ logoOriginal: ref });
      assert.equal(r.status, 400, ref);
      const icon = await post({ icon: iconInput({ original: ref }) });
      assert.equal(icon.status, 400, `icon.original ${ref}`);
    }
  });

  test("only an original may be a reference: the image itself must still be a data URL", async () => {
    const ref = (await settings()).appLogoOriginal as string;
    const r = await post({ logo: ref });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /body\.logo must be an image data URL or null/);
  });
});

describe("removing the icon", () => {
  test("everything goes back to the built-in files and the state forgets it", async () => {
    const r = await post({ icon: null });
    assert.equal(r.status, 200);
    assert.equal(branding().filter((m) => m.includes("icon removed")).length, 1, "removal is logged once");
    for (const p of PATHS) assert.equal(await served(p), null, `${p} still answered after removal`);
    const s = stageController.getState();
    assert.equal(s.appIcon192, null);
    assert.equal(s.appIconMaskable, null);
    assert.equal(s.appIconBackground, "#000000");
    const onDisk = await settings();
    for (const key of ["appIcon", "appIconOriginal", "appIconCrop", "appIconApple", "appIcon192", "appIcon512", "appIconMaskable"]) {
      assert.equal(onDisk[key], null, `${key} survived removal`);
    }
    assert.equal(onDisk.appIconBackground, "#000000");
    assert.deepEqual(await stageController.getBrandingSource("icon"), { original: null, crop: null, art: null });
  });
});
