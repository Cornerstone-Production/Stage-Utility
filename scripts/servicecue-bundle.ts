// servicecue-bundle.ts — the public ServiceCue page, ready to upload.
//
//   npm run servicecue:bundle         fails the command when anything is wrong
//   ... servicecue-bundle.ts --soft   what `npm run build` runs: says so and carries on, and
//                                     leaves build/servicecue.failed (the commit, then why)
//   --out <dir>  --wrangler <file>    elsewhere to write, another config to read: for tests
//
// The Worker in publish/servicecue/ and the page it serves reach Cloudflare through
// `npm run servicecue:deploy`, which needs wrangler, a login and the Worker's own
// node_modules. This writes the same thing, from nothing but what `npm ci` and
// `vite build` already need, so a server can put it on Cloudflare itself:
//
//   build/servicecue/
//     worker.js      the Worker as one ES module, exporting the default handler and
//                    the PublishHub Durable Object: what `wrangler deploy` uploads
//     public/        the built page (its `_headers` is in deploy.json, not here)
//     deploy.json    what to say about them when uploading (DeployManifest below)
//
// Every value in deploy.json is read from where it lives: wrangler.jsonc (a date, flags,
// bindings, asset rules), package.json (the version), the contract (the protocol) and the
// built document (the build id). Nothing is copied by hand, and a key wrangler.jsonc gains
// that this does not know is an error, not a field that quietly goes missing.
//
// The Worker is bundled with the esbuild the root package already has, with the options
// wrangler gives its own, and scripts/servicecue-bundle-wrangler.test.ts
// holds the output to wrangler's byte for byte.
//
// `build/` is gitignored, shipped in the release archives, and rebuilt by the update.

import type { BuildOptions } from "esbuild";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage } from "../main/services/errors.js";
import { isStringList } from "../main/services/is-record.js";
import { isMain } from "./is-main.mjs";
import type { DeployBinding, DeployManifest } from "../main/types/servicecue-deploy.js";
import { PUBLISH_PROTOCOL_VERSION, VIEWER_HTML, isRecord, viewerBuildFromHtml } from "../main/types/servicecue-publish.js";
import { STATIC_HEADERS_FILE } from "../publish/servicecue/src/headers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(ROOT, "publish/servicecue");
const DEFAULT_OUT = path.join(ROOT, "build/servicecue");
const WRANGLER_CONFIG = path.join(WORKER_DIR, "wrangler.jsonc");

/** The Worker's file in the bundle, and `mainModule` in the manifest. */
const MAIN_MODULE = "worker.js";

export type { DeployBinding, DeployManifest } from "../main/types/servicecue-deploy.js";

/**
 * Every top-level key of wrangler.jsonc, sorted, by what this does with it. A key in
 * neither list throws: wrangler would act on it and the manifest would not know.
 */
export const CARRIED_KEYS = [
  "assets",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "exports",
  "keep_vars",
  "name",
  "vars",
];
/** What wrangler keeps of a Worker's bindings across a deploy (its `keepSecrets`): the publishing token. */
export const KEEP_SECRETS = ["secret_text", "secret_key"];
/** What wrangler also keeps with `keep_vars`: variables set on the Worker in the dashboard, a raised MAX_VIEWERS_PER_ADDRESS say. */
export const KEEP_VARS = ["plain_text", "json"];
export const DEPLOYED_ELSEWHERE_KEYS = [
  "$schema", // editor help
  "dependencies_instrumentation", // what wrangler tells Cloudflare about npm packages
  "main", // the entry point: bundled here
  "preview_urls", // set once, on the Worker
  "workers_dev", // set once, on the Worker
];

/** wrangler.jsonc is JSON with comments and trailing commas. TypeScript's own reader takes both. */
export async function parseWranglerConfig(text: string): Promise<Record<string, unknown>> {
  // Loaded here so a box without it fails inside the command's own handler, which is soft.
  const ts = (await import("typescript")).default;
  const { config, error } = ts.parseConfigFileTextToJson("wrangler.jsonc", text);
  if (error || typeof config !== "object" || config === null) {
    const why = error ? ts.flattenDiagnosticMessageText(error.messageText, "\n") : "it is not an object";
    throw new Error(`wrangler.jsonc could not be read: ${why}`);
  }
  return config as Record<string, unknown>;
}

function stringField(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || value === "") throw new Error(`wrangler.jsonc has no "${key}"`);
  return value;
}

/** The manifest, from the config and the three other places its values live. */
export function deployManifest(input: {
  wrangler: Record<string, unknown>;
  version: string;
  build: string;
  /** The text of the page's headers file. */
  headers: string;
}): DeployManifest {
  const { wrangler } = input;
  const known = new Set([...CARRIED_KEYS, ...DEPLOYED_ELSEWHERE_KEYS]);
  const unknown = Object.keys(wrangler).filter((k) => !known.has(k)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `wrangler.jsonc has ${unknown.map((k) => `"${k}"`).join(", ")}, which deploy.json does not carry: add it to scripts/servicecue-bundle.ts (CARRIED_KEYS, and the manifest) or say why it is not (DEPLOYED_ELSEWHERE_KEYS)`,
    );
  }

  const { assets, durable_objects: durable } = wrangler;
  if (!isRecord(assets) || typeof assets.binding !== "string") throw new Error('wrangler.jsonc has no "assets" with a "binding"');
  const { directory: _directory, binding, ...assetConfig } = assets;

  const keepVars = wrangler.keep_vars ?? false;
  if (typeof keepVars !== "boolean") throw new Error('wrangler.jsonc "keep_vars" is not true or false');

  const flags = wrangler.compatibility_flags ?? [];
  if (!isStringList(flags)) throw new Error('wrangler.jsonc "compatibility_flags" is not a list of names');

  const objects = isRecord(durable) && Array.isArray(durable.bindings) ? durable.bindings : [];
  const bindings: DeployBinding[] = [{ type: "assets", name: binding }];
  for (const b of objects) {
    if (!isRecord(b) || typeof b.name !== "string" || typeof b.class_name !== "string") throw new Error('wrangler.jsonc "durable_objects.bindings" has an entry with no name and class_name');
    if (b.script_name !== undefined) throw new Error(`wrangler.jsonc binds ${b.name} to another Worker's class (script_name), which this Worker upload does not carry`);
    bindings.push({ type: "durable_object_namespace", name: b.name, class_name: b.class_name });
  }

  // `vars`: a string is plain text and anything else is JSON, as wrangler uploads them. The
  // limits in the operator docs (MAX_VIEWERS and the others) are set here.
  const vars = wrangler.vars ?? {};
  if (!isRecord(vars)) throw new Error('wrangler.jsonc "vars" is not an object');
  for (const [name, value] of Object.entries(vars).sort(([a], [b]) => a.localeCompare(b))) {
    bindings.push(typeof value === "string" ? { type: "plain_text", name, text: value } : { type: "json", name, json: value });
  }

  return {
    name: stringField(wrangler, "name"),
    build: input.build,
    version: input.version,
    mainModule: MAIN_MODULE,
    compatibilityDate: stringField(wrangler, "compatibility_date"),
    compatibilityFlags: flags as string[],
    protocol: PUBLISH_PROTOCOL_VERSION,
    assets: { ...assetConfig, [STATIC_HEADERS_FILE]: input.headers },
    bindings,
    // In wrangler's order: the variables, then the secrets.
    keep_bindings: keepVars ? [...KEEP_VARS, ...KEEP_SECRETS] : [...KEEP_SECRETS],
    exports: isRecord(wrangler.exports) ? wrangler.exports : {},
  };
}

/**
 * wrangler's own bundling of a Worker, which `wrangler deploy --dry-run` shows. Only the
 * options that change the output are named; the test that compares it to wrangler's keeps
 * this honest on the day wrangler changes one.
 */
export const WORKER_BUNDLE_OPTIONS = {
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["browser", "module", "main"],
  keepNames: true,
  external: ["cloudflare:*", "node:*"],
} satisfies BuildOptions;

export interface BundleResult {
  outDir: string;
  manifest: DeployManifest;
  /** esbuild's account of what went into the Worker, for the test that compares it to wrangler's. */
  workerInputs: string[];
  workerExports: string[];
}

/** Build the page and the Worker into `outDir`, and write deploy.json beside them. */
export async function bundleServiceCue(outDir: string = DEFAULT_OUT, quiet = false, wranglerConfig: string = WRANGLER_CONFIG): Promise<BundleResult> {
  // The cheap failures first: a config this cannot describe should not cost a page build.
  const version = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: unknown }).version;
  if (typeof version !== "string" || version === "") throw new Error("package.json has no version");
  const wrangler = await parseWranglerConfig(fs.readFileSync(wranglerConfig, "utf8"));
  deployManifest({ wrangler, version, build: "unknown", headers: "" });

  // Whatever an earlier run left is not this build's: a half-written folder must not look finished.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Loaded here, inside the command's handler: a box that cannot load them has no bundle,
  // which is the soft failure, and not a crash before the handler is reached.
  const { build: viteBuild } = await import("vite");
  const { build: esbuild } = await import("esbuild");

  const publicDir = path.join(outDir, "public");
  await viteBuild({
    root: ROOT,
    configFile: path.join(ROOT, "vite.servicecue.config.ts"),
    logLevel: quiet ? "silent" : "warn",
    build: { outDir: publicDir, emptyOutDir: true },
  });

  const documentPath = path.join(publicDir, VIEWER_HTML.slice(1));
  const build = viewerBuildFromHtml(fs.readFileSync(documentPath, "utf8"));
  if (build === null) throw new Error(`${VIEWER_HTML.slice(1)} carries no build id: the page build did not stamp it`);

  const bundled = await esbuild({
    ...WORKER_BUNDLE_OPTIONS,
    absWorkingDir: WORKER_DIR,
    entryPoints: ["src/worker.ts"],
    outfile: path.join(outDir, MAIN_MODULE),
    metafile: true,
    logLevel: quiet ? "silent" : "warning",
  });
  const output = Object.values(bundled.metafile.outputs)[0];
  if (!output) throw new Error("esbuild wrote no Worker");
  const workerExports = [...output.exports].sort();
  for (const needed of ["PublishHub", "default"]) {
    if (!workerExports.includes(needed)) throw new Error(`the bundled Worker does not export ${needed}: it exports ${workerExports.join(", ") || "nothing"}`);
  }

  // `_headers` is config and not an asset: its text goes in the manifest and the file out of the folder.
  const headersPath = path.join(publicDir, STATIC_HEADERS_FILE);
  const headers = fs.readFileSync(headersPath, "utf8");
  fs.rmSync(headersPath);

  const manifest = deployManifest({ wrangler, version, build, headers });
  fs.writeFileSync(path.join(outDir, "deploy.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { outDir, manifest, workerInputs: Object.keys(bundled.metafile.inputs).sort(), workerExports };
}

// ── As a command ──────────────────────────────────────────────────────────────

/** The commit this checkout is on, or "unknown" where there is no git to ask. */
function currentCommit(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

/**
 * What a soft failure leaves beside the folder: the commit it failed on, then why, so the update
 * scripts can tell a bundle that is missing because it failed here from one that was never made.
 * `<folder>.failed`, i.e. build/servicecue.failed.
 */
export function failureMarker(outDir: string): string {
  return `${outDir}.failed`;
}

if (isMain(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const soft = args.includes("--soft");
  // Flags and not environment variables: this command deletes its output folder, and nothing in
  // an environment may point that at another. The tests pass these.
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      console.error(`[servicecue-bundle] ${name} needs a value`);
      process.exit(2);
    }
    return value;
  };
  const out = path.resolve(flag("--out") ?? DEFAULT_OUT);
  const wrangler = flag("--wrangler");
  try {
    const { manifest } = await bundleServiceCue(out, false, wrangler ? path.resolve(wrangler) : undefined);
    // The bundle is whole again: nothing is missing for an update to wait on.
    fs.rmSync(failureMarker(out), { force: true });
    console.log(`[servicecue-bundle] ${path.relative(ROOT, out) || "."}: build ${manifest.build}, version ${manifest.version}`);
  } catch (err) {
    const message = errorMessage(err);
    // Cleaning up can fail too, and that is part of the same report: it must not turn a soft
    // failure into a crash, nor go unsaid.
    const also: string[] = [];
    try {
      // Not a partial folder: a deployer reading one would upload half a page.
      fs.rmSync(out, { recursive: true, force: true });
    } catch (cleanup) {
      also.push(`could not remove ${out}: ${errorMessage(cleanup)}`);
    }
    if (!soft) {
      console.error(`[servicecue-bundle] FAILED: ${message}${also.length ? ` (also ${also.join("; ")})` : ""}`);
      process.exit(1);
    }
    try {
      fs.writeFileSync(failureMarker(out), `${currentCommit()}\n${message.replace(/\s+/g, " ")}\n`);
    } catch (marker) {
      also.push(`could not write ${failureMarker(out)}: ${errorMessage(marker)}`);
    }
    // The page's bundle is one feature's: an update that cannot make it must still update
    // the app. The line is the evidence, and this server will have no bundle to deploy.
    console.error(`[servicecue-bundle] FAILED, so this server cannot update the public ServiceCue page from this build (the app is unaffected): ${message}${also.length ? ` (also ${also.join("; ")})` : ""}`);
  }
}
