// deploy-bundle.ts — a build/servicecue/ folder a test can write, in the shape the real bundle has.
//
// The real one is made by scripts/servicecue-bundle.ts and a test in scripts/ deploys it; these are
// small and fixed so a test can say exactly what it expects to arrive.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DeployManifest } from "../../types/servicecue-deploy.js";

export const BUILD_A = "aaaaaaaaaaaa";
export const BUILD_B = "bbbbbbbbbbbb";

export const MANIFEST: DeployManifest = {
  name: "servicecue",
  build: BUILD_B,
  version: "1.28.0",
  mainModule: "worker.js",
  compatibilityDate: "2026-10-13",
  compatibilityFlags: [],
  protocol: 1,
  assets: { run_worker_first: ["/*", "!/assets/*.js"], html_handling: "none", not_found_handling: "none", _headers: "/*\n  X-Test: 1\n" },
  bindings: [
    { type: "assets", name: "ASSETS" },
    { type: "durable_object_namespace", name: "HUB", class_name: "PublishHub" },
    { type: "json", name: "MAX_VIEWERS", json: 500 },
  ],
  keep_bindings: ["secret_text", "secret_key"],
  exports: { PublishHub: { type: "durable-object", storage: "sqlite" } },
};

/** The page's files: three shapes of type, one in a folder, one with none. */
export const FILES: Record<string, string> = {
  "servicecue.html": "<!doctype html><title>page</title>",
  "assets/index-1a2b3c.js": "export const a = 1;\n",
  "assets/index-1a2b3c.css": "body { margin: 0 }\n",
  "favicon.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  "icon-192.png": "\u0089PNG fixture",
  "NOTICE": "no extension, so no type",
};

export interface WrittenBundle {
  dir: string;
  remove(): void;
}

/** A folder of the real shape. `manifest` overrides fields of deploy.json; `files` is the page; `worker` the module. */
export function writeBundle(opts: { manifest?: Partial<DeployManifest>; files?: Record<string, string>; worker?: string } = {}): WrittenBundle {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "servicecue-fixture-")), "servicecue");
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.writeFileSync(path.join(dir, "worker.js"), opts.worker ?? "export default { fetch() { return new Response('ok'); } };\nexport class PublishHub {}\n");
  for (const [name, text] of Object.entries(opts.files ?? FILES)) {
    const file = path.join(dir, "public", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  fs.writeFileSync(path.join(dir, "deploy.json"), JSON.stringify({ ...MANIFEST, ...opts.manifest }, null, 2));
  return { dir, remove: () => fs.rmSync(path.dirname(dir), { recursive: true, force: true }) };
}
