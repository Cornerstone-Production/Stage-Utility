import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MODULE = path.join(HERE, "app-root.ts");
// Absolute, because each probe runs with its cwd inside a temp directory where a
// bare "tsx" specifier would not resolve.
const TSX = path.resolve(HERE, "..", "..", "node_modules", "tsx", "dist", "loader.mjs");

/**
 * Resolution depends on the importing file's own location and on the environment,
 * so each case runs in a fresh process. Importing once in-process would only ever
 * exercise a single answer.
 */
function resolveFrom(dir: string, env: Record<string, string> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  // A COPY of the module, placed at `dir`. The walk starts from the module's own
  // location, so importing the original would always answer "the repo root" no
  // matter where the caller sits. Copying it is also what bundling does: the code
  // ends up inlined at the install root rather than under main/services.
  const copy = path.join(dir, "app-root.ts");
  fs.copyFileSync(MODULE, copy);
  const probe = path.join(dir, "probe.mjs");
  fs.writeFileSync(
    probe,
    `import { APP_ROOT } from ${JSON.stringify(copy)};\nprocess.stdout.write(APP_ROOT);\n`,
  );
  return execFileSync(process.execPath, ["--import", TSX, probe], {
    encoding: "utf8",
    env: { ...process.env, STAGE_UTILITY_ROOT: "", ...env },
    cwd: dir,
  }).trim();
}

/** The same probe, but returning what the module wrote to stderr. */
function warningsFrom(dir: string, env: Record<string, string> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, "app-root.ts");
  fs.copyFileSync(MODULE, copy);
  const probe = path.join(dir, "probe-warn.mjs");
  fs.writeFileSync(probe, `import { APP_ROOT } from ${JSON.stringify(copy)};\nvoid APP_ROOT;\n`);
  const res = spawnSync(process.execPath, ["--import", TSX, probe], {
    encoding: "utf8",
    env: { ...process.env, STAGE_UTILITY_ROOT: "", ...env },
    cwd: dir,
  });
  return `${res.stderr ?? ""}${res.stdout ?? ""}`;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "app-root-"));
// macOS puts temp dirs behind a /var -> /private/var symlink. The module returns a
// resolved path, not a real path, so both sides are normalised before comparing.
const same = (a: string, b: string) => assert.equal(fs.realpathSync(a), fs.realpathSync(b));

test("an explicit override wins over anything on disk", () => {
  const dir = tmp();
  const want = fs.mkdtempSync(path.join(os.tmpdir(), "override-"));
  // The override must look like an app root to be believed — see below. This
  // used to pass with an empty directory.
  fs.writeFileSync(path.join(want, "VERSION"), "1.0.0\n");
  same(resolveFrom(dir, { STAGE_UTILITY_ROOT: want }), want);
});

// STAGE_UTILITY_ROOT becomes the script path the updater spawns and the cwd it
// spawns in. Taken on trust, a typo meant the updater ran a script from a
// directory that is not the app — and CodeQL read it, correctly, as an unchecked
// environment variable reaching a command line (js/indirect-command-line-injection
// and js/shell-command-injection-from-environment).
//
// Ignored rather than fatal: falling back finds the right answer in every case
// where the override was simply wrong, and refusing to boot over an environment
// variable would take a display wall down for a typo.

test("an override that is not a directory is ignored, not obeyed", () => {
  const dir = tmp();
  const file = path.join(tmp(), "not-a-dir");
  fs.writeFileSync(file, "");
  const out = resolveFrom(dir, { STAGE_UTILITY_ROOT: file });
  assert.notEqual(fs.realpathSync(out), fs.realpathSync(file));
  assert.ok(fs.statSync(out).isDirectory(), "the fallback must still be a directory");
});

test("an override that does not exist at all is ignored", () => {
  const dir = tmp();
  const missing = path.join(tmp(), "no", "such", "place");
  const out = resolveFrom(dir, { STAGE_UTILITY_ROOT: missing });
  assert.notEqual(fs.realpathSync(out), path.resolve(missing));
  assert.ok(fs.existsSync(out), "the fallback must be a real directory");
});

test("an override with no app marker in it is ignored", () => {
  // The case that matters most: a real, readable directory that simply is not
  // this app. Pointing the updater at it would spawn a script that is not ours.
  const dir = tmp();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "not-the-app-"));
  const out = resolveFrom(dir, { STAGE_UTILITY_ROOT: elsewhere });
  assert.notEqual(fs.realpathSync(out), fs.realpathSync(elsewhere));
});

test("and it says so, rather than falling back silently", () => {
  const dir = tmp();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "not-the-app-"));
  const err = warningsFrom(dir, { STAGE_UTILITY_ROOT: elsewhere });
  assert.match(err, /ignoring STAGE_UTILITY_ROOT/, `expected a warning, got: ${err}`);
  // The value itself must NOT be echoed: this module has no scrub() and an
  // unscrubbed environment variable in a LAN-visible log is a forged log line.
  assert.doesNotMatch(err, new RegExp(elsewhere.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a relative override is resolved to an absolute path", () => {
  const dir = tmp();
  const out = resolveFrom(dir, { STAGE_UTILITY_ROOT: "." });
  assert.ok(path.isAbsolute(out), `expected absolute, got ${out}`);
});

test("the checkout's own root is found from a nested module", () => {
  // app-root.ts lives in main/services; the repo root two levels up holds
  // package.json. This is the case the hardcoded "..", ".." used to cover.
  const found = execFileSync(
    process.execPath,
    ["--import", TSX, "-e", `import("${MODULE}").then(m=>process.stdout.write(m.APP_ROOT))`],
    { encoding: "utf8", env: { ...process.env, STAGE_UTILITY_ROOT: "" } },
  ).trim();
  assert.ok(fs.existsSync(path.join(found, "package.json")), `${found} should hold package.json`);
  same(found, path.resolve(HERE, "..", ".."));
});

test("a VERSION file marks the root, for a packaged install with no package.json", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "VERSION"), "1.9.2\n");
  const nested = path.join(root, "a", "b");
  same(resolveFrom(nested), root);
});

test("the nearest marker wins, not the highest", () => {
  const outer = tmp();
  fs.writeFileSync(path.join(outer, "VERSION"), "outer");
  const inner = path.join(outer, "app");
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, "VERSION"), "inner");
  same(resolveFrom(path.join(inner, "deep")), inner);
});

test("with no marker anywhere it falls back to the working directory", () => {
  // Under a temp dir with no package.json or VERSION above it, the walk runs out
  // and must still answer rather than throw.
  const dir = tmp();
  const out = resolveFrom(dir);
  assert.ok(path.isAbsolute(out));
  assert.ok(fs.existsSync(out), "the fallback must be a real directory");
});
