// servicecue-public-build.test.ts — the public ServiceCue viewer, as it is BUILT.
//
// Three promises about the public page cannot be kept by reading source, and each
// has been broken in a repo like this by a build nobody looked at:
//
//   - it contains the ServiceCue pages and NOT the operator app: a page that imports
//     one operator module pulls the whole shell, the settings and the device scan
//     into a bundle served to the open internet;
//   - its document is one the Worker's content security policy lets run: no inline
//     script, no font folded into the stylesheet as a data: URI, no eval;
//   - every file the build writes is a path the Worker will answer, and the Worker
//     answers no file the build did not write.
//
// So this runs the real build, in process, into a temporary folder, and asks the
// bundler's own module list and the files it actually left there (a build that is
// only asked for its in-memory output does not copy publicDir, so it cannot see a
// folder that should not be on the public host). The viewer is not drawn here: jsdom
// loads no stylesheet and measures nothing, and what the page looks like is in the
// screenshots on the PR.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { build } from "vite";

import {
  PUBLIC_STATIC_FILES,
  STATIC_ASSET_PREFIX,
  VIEWER_BUILD_META,
  VIEWER_HTML,
  isViewerBuildId,
  viewerBuildFromHtml,
  viewerBuildTag,
} from "../main/types/servicecue-publish.js";
import { viewerBuild } from "../publish/servicecue/src/build.js";
import { STATIC_HEADERS_FILE, staticHeaders } from "../publish/servicecue/src/headers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "servicecue-build-"));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

const built = await build({
  root: ROOT,
  configFile: path.join(ROOT, "vite.servicecue.config.ts"),
  logLevel: "silent",
  build: { outDir: OUT, emptyOutDir: true },
});
const chunks = (Array.isArray(built) ? built[0]! : built).output.flatMap((o) => (o.type === "chunk" ? [o] : []));

/** Every file the build left in its folder, by path from it. */
function filesUnder(dir: string, base = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(path.join(dir, entry.name), rel) : [rel];
  });
}
const emitted = new Set(filesUnder(OUT));
const read = (file: string): string => fs.readFileSync(path.join(OUT, file), "utf8");
/** Every module in the bundle that is ours, as a repo-relative path. */
const modules = [...new Set(chunks.flatMap((c) => c.moduleIds))]
  .filter((id) => id.startsWith(ROOT) && !id.includes("/node_modules/"))
  .map((id) => id.slice(ROOT.length + 1))
  .sort();
const within = (dir: string) => modules.filter((m) => m.startsWith(`${dir}/`));
const url = (p: string) => new URL(p, "https://servicecue.example.workers.dev");

/** wrangler.jsonc's `assets.run_worker_first`. The file is JSON with whole-line comments. */
function runWorkerFirst(): string[] {
  const text = fs.readFileSync(path.join(ROOT, "publish/servicecue/wrangler.jsonc"), "utf8");
  const json = JSON.parse(text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n")) as { assets: { run_worker_first: string[] } };
  return json.assets.run_worker_first;
}

describe("what the build writes", () => {
  test("is the page, its headers file, the files the Worker names beside it, and hashed files under assets/", () => {
    const files = [...emitted].filter((f) => !f.startsWith("assets/")).sort();
    assert.deepEqual(files, [VIEWER_HTML.slice(1), STATIC_HEADERS_FILE, ...PUBLIC_STATIC_FILES.map((f) => f.slice(1))].sort());
    for (const file of emitted) assert.ok(file === "servicecue.html" || !file.endsWith(".html"), `a second document: ${file}`);
  });

  test("has every file the asset service answers by itself named in wrangler.jsonc, and names no other", () => {
    // A file the build writes that the config does not name goes to the Worker, which answers
    // none: a page with no script or no font. A name the build does not write is a hole.
    const extensions = [...new Set([...emitted].filter((f) => f.startsWith("assets/")).map((f) => path.extname(f)))].sort();
    const direct = [...PUBLIC_STATIC_FILES, ...extensions.map((e) => `${STATIC_ASSET_PREFIX}*${e}`)].map((p) => `!${p}`).sort();
    assert.deepEqual(runWorkerFirst(), ["/*", ...direct]);
  });

  test("tells the asset service what to say about them: the Worker's own text, byte for byte", () => {
    assert.equal(read(STATIC_HEADERS_FILE), staticHeaders());
  });

  test("leaves out whatever else sits in public/, which is not the public page's to serve", () => {
    assert.equal(emitted.has("control.html"), false);
  });

  test("leaves out the operator app's shared worker, which api.ts names and the page never starts", () => {
    // The module graph cannot say: a worker is its own entry, and is emitted beside the
    // chunks. So this reads what was written.
    assert.deepEqual([...emitted].filter((f) => f.includes("sse-shared-worker")), []);
  });
});

describe("what is in the bundle", () => {
  test("none of the operator app: its shell, its router, its live wiring, its update notices", () => {
    for (const operator of [
      "renderer/app/shell.tsx",
      "renderer/app/router.tsx",
      "renderer/app/destinations.tsx",
      "renderer/app/update-notices.tsx",
      "renderer/app/live-wiring.ts",
      "renderer/app/rail.tsx",
      "renderer/main/stage-view.tsx",
      "renderer/main/layout-renderer.tsx",
      "renderer/settings/sections/servicecue-section.tsx",
      "renderer/lib/sse-shared-worker.ts",
    ]) {
      assert.equal(modules.includes(operator), false, `${operator} is in the public bundle`);
    }
  });

  test("of renderer/app, only the two shared ServiceCue routes", () => {
    assert.deepEqual(within("renderer/app"), ["renderer/app/servicecue-routes.tsx"]);
  });

  test("of renderer/settings, only the plan switcher the ServiceCue page is built on", () => {
    assert.deepEqual(within("renderer/settings"), [
      "renderer/settings/sections/editing-target.ts",
      "renderer/settings/sections/plan-switcher-step.ts",
      "renderer/settings/sections/plan-switcher.tsx",
      "renderer/settings/sections/slots-target-pill.tsx",
    ]);
  });

  test("of renderer/public, the viewer's own three", () => {
    assert.deepEqual(within("renderer/public"), [
      "renderer/public/public-router.tsx",
      "renderer/public/servicecue-public.tsx",
      "renderer/public/stale-notice.tsx",
    ]);
  });

  test("of main, only what the renderer already shares with it", () => {
    assert.deepEqual(within("main"), [
      "main/services/clamp.ts",
      "main/services/errors.ts",
      // renderer/lib/api.ts gives Update the page now its timeout from here: two
      // numbers, and types the build erases.
      "main/types/servicecue-deploy.ts",
      "main/types/servicecue-publish.ts",
      "main/types/text-size.ts",
    ]);
  });

  test("the pages and the transport are in it", () => {
    for (const needed of [
      "renderer/main/servicecue-plan-view.tsx",
      "renderer/main/servicecue-index-view.tsx",
      "renderer/main/rundown-table.tsx",
      "renderer/lib/live-refresh.ts",
      "renderer/lib/public-live.ts",
      "renderer/lib/public-mode.ts",
    ]) {
      assert.ok(modules.includes(needed), `${needed} is not in the public bundle`);
    }
  });
});

describe("the document", () => {
  const html = read("servicecue.html");
  const doc = new JSDOM(html).window.document;

  test("is marked as the public page, which is what makes the shared code behave as it", () => {
    assert.equal(doc.documentElement.hasAttribute("data-servicecue-public"), true);
  });

  test("has no inline script and no inline handler: the policy allows neither", () => {
    assert.deepEqual([...doc.querySelectorAll("script:not([src])")].map((s) => s.textContent), []);
    const handlers = [...doc.querySelectorAll("*")].flatMap((el) => el.getAttributeNames().filter((n) => n.startsWith("on")).map((n) => `${el.tagName} ${n}`));
    assert.deepEqual(handlers, []);
    assert.deepEqual([...doc.querySelectorAll("script")].map((s) => s.getAttribute("type")), ["module"]);
  });

  test("loads only files the build wrote, from its own origin", () => {
    const refs = [...doc.querySelectorAll("script[src], link[href]")].map((el) => el.getAttribute("src") ?? el.getAttribute("href")!);
    assert.ok(refs.length >= 5, `too few references to be reading the document: ${refs.join(", ")}`);
    for (const ref of refs) {
      assert.match(ref, /^\/[^/]/, `${ref} is not an address on this origin`);
      assert.ok(emitted.has(ref.slice(1)), `${ref} is not a file the build wrote`);
    }
  });

  test("refers to its script and its style by names that carry their content hash, so it is a different document whenever either is", () => {
    for (const ref of [...doc.querySelectorAll('script[src^="/assets/"], link[rel="stylesheet"]')].map((el) => el.getAttribute("src") ?? el.getAttribute("href")!)) {
      assert.match(ref, /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.(js|css)$/, ref);
    }
    assert.ok(doc.querySelector('script[src^="/assets/"]') && doc.querySelector('link[rel="stylesheet"]'), "the document does not load a script and a style");
  });

  test("is stamped with the build's id, in its head: the hash of the document as it was before the stamp", () => {
    const tag = doc.head.querySelector(`meta[name="${VIEWER_BUILD_META}"]`);
    assert.ok(tag, "the document carries no build id, so a page left open across a deploy can never tell it is old");
    const stamped = tag.getAttribute("content");
    assert.ok(isViewerBuildId(stamped), `${stamped} is not a build id`);
    assert.equal(doc.querySelectorAll(`meta[name="${VIEWER_BUILD_META}"]`).length, 1);
    const before = html.replace(viewerBuildTag(stamped), "");
    assert.ok(!before.includes(VIEWER_BUILD_META), "the stamp is not the one tag the document was given");
    assert.equal(stamped, createHash("sha256").update(before).digest("hex").slice(0, 12), "the id is not the hash of the document it stamps");
  });

  test("gives the Worker and the page one id: what the Worker reads out of this document is what the page reads", async () => {
    const stamped = doc.querySelector(`meta[name="${VIEWER_BUILD_META}"]`)?.getAttribute("content");
    assert.equal(viewerBuildFromHtml(html), stamped);
    const assets = async () => new Response(html);
    assert.equal(await viewerBuild(assets, url("/servicecue")), stamped);
  });

  test("keeps itself out of search engines and says what it is", () => {
    assert.equal(doc.querySelector('meta[name="robots"]')?.getAttribute("content"), "noindex");
    assert.equal(doc.title, "ServiceCue");
  });
});

describe("what the policy would refuse at run time", () => {
  const css = [...emitted].filter((f) => f.endsWith(".css")).map(read).join("\n");
  const js = chunks.map((c) => c.code).join("\n");

  test("no font is folded into the stylesheet, where data: is not allowed", () => {
    const fonts = [...css.matchAll(/@font-face\s*{[^}]*}/g)].map((m) => m[0]);
    assert.ok(fonts.length >= 6, `${fonts.length} @font-face rules: the stylesheet was not read`);
    for (const face of fonts) assert.doesNotMatch(face, /url\(\s*["']?data:/, face.slice(0, 120));
  });

  test("every url() in the stylesheet is a file the build wrote", () => {
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!).filter((u) => !u.startsWith("data:"));
    assert.ok(urls.length > 0);
    for (const u of urls) assert.ok(emitted.has(u.replace(/^\//, "")), `${u} is not a file the build wrote`);
  });

  test("nothing evaluates a string as code, which no policy that allows no 'unsafe-eval' lets run", () => {
    assert.doesNotMatch(js, /\beval\s*\(/);
    assert.doesNotMatch(js, /\bnew Function\s*\(/);
  });
});

describe("the manifest", () => {
  const manifest = JSON.parse(read("manifest.webmanifest")) as { start_url: string; name: string; icons: { src: string }[] };

  test("opens the launcher and names only icons that were built", () => {
    assert.equal(manifest.start_url, "/servicecue");
    assert.equal(manifest.name, "ServiceCue");
    assert.ok(manifest.icons.length >= 3);
    for (const icon of manifest.icons) assert.ok(emitted.has(icon.src.slice(1)), `${icon.src} was not built`);
  });
});
