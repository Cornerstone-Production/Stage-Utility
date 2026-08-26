// The kiosk installers have to be IN the release, and findable from it.
//
// Two independent bugs made the release's headline feature a 404 on every
// install that is not a git checkout, and each one alone was enough:
//
//  1. build-artifacts.sh staged build/, public/, LICENSE, VERSION and node.
//     "kiosk" appeared nowhere in it, so scripts/kiosk/ was never packaged.
//  2. the route read `new URL("../../../scripts/kiosk/" + name, import.meta.url)`
//     — correct from main/services/routes/ in a checkout, but the bundled
//     server.mjs sits at the install ROOT, where that resolves to
//     file:///scripts/kiosk/… and reads nothing.
//
// The command an operator is told to paste is printed in the app's own Advanced
// settings and in docs/kiosk-devices.md, so this failed in the one place it is
// guaranteed to be tried.
//
// Both halves are asserted, because fixing either alone still leaves a 404.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const ROUTE = readFileSync(path.join(HERE, "kiosk-device-routes.ts"), "utf8");
const BUILD = readFileSync(path.join(REPO, "scripts", "build-artifacts.sh"), "utf8");

/** The installers the route will serve, read from the route itself. */
function servedNames(): string[] {
  const m = /const KIOSK_INSTALLERS = new Set\(\[([^\]]*)\]\)/.exec(ROUTE);
  assert.ok(m, "could not find KIOSK_INSTALLERS — has it moved?");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("kiosk installers reach a real install", () => {
  it("every name the route serves exists on disk", () => {
    const names = servedNames();
    assert.ok(names.length >= 3, `only ${names.length} installers listed — scan looks broken`);
    const missing = names.filter((n) => !existsSync(path.join(REPO, "scripts", "kiosk", n)));
    assert.deepEqual(missing, [], `the route offers installers that do not exist: ${missing.join(", ")}`);
  });

  it("and every installer on disk is one the route will serve", () => {
    // The other direction: an installer added to the folder and not to the
    // allowlist is a file nobody can fetch, which reads as a broken platform.
    const onDisk = readdirSync(path.join(REPO, "scripts", "kiosk"));
    const served = new Set(servedNames());
    const orphans = onDisk.filter((f) => !served.has(f));
    assert.deepEqual(orphans, [], `not reachable over HTTP: ${orphans.join(", ")}`);
  });

  it("the release artifact stages scripts/kiosk", () => {
    // Bug 1. Matches the copy itself, not a mention: a comment naming the folder
    // must not satisfy this.
    assert.match(
      BUILD,
      /cp\s+-R\s+scripts\/kiosk\s+"\$stage\/scripts\/kiosk"/,
      "build-artifacts.sh must stage scripts/kiosk, or the installers are not in the release at all",
    );
  });

  it("the route resolves them from APP_ROOT, not from its own file position", () => {
    // Bug 2. `import.meta.url` is main/services/routes/ in a checkout and the
    // install root in the bundle, so a relative walk is right in exactly the
    // place nobody ships.
    assert.match(
      ROUTE,
      /path\.join\(APP_ROOT,\s*"scripts",\s*"kiosk",\s*name\)/,
      "the installer path must come from APP_ROOT",
    );
    assert.doesNotMatch(
      ROUTE,
      /new URL\(`\.\.\/\.\.\/\.\.\/scripts/,
      "a path relative to this module resolves to file:///scripts in the bundled server",
    );
  });
});
