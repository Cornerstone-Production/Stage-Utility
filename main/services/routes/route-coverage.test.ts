// Every /api path the client calls must be handled by some route module.
//
// The channel guard in renderer/lib/api-channels.test.ts catches a channel with
// no case in api.ts. This is the other half: a case that exists, builds a URL,
// and posts to a path no module serves. Two features shipped that way — the
// baptism trigger panel and baptism auto-start — and in both the operator got a
// failure toast while the code looked complete from either side alone.
//
// Matched textually rather than by running the server: the dispatcher needs a
// live socket and the whole service graph, and this only has to answer "does any
// module mention this path".

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(HERE, "..", "..");
const REPO = path.resolve(MAIN, "..");
const API_TS = path.join(REPO, "renderer", "lib", "api.ts");

/**
 * Every `/api/...` path that appears as a STRING LITERAL in the route modules or
 * remote-server.
 *
 * Quoted, deliberately. Matching raw file text let a comment satisfy the check:
 * writing this test, a comment in display-settings-routes explaining the old
 * broken path was enough to make the scan call that path served, so the guard
 * passed on the exact bug it exists for. Prose about a route is not a route.
 *
 * Stripping comments instead was the obvious alternative and worse — a
 * hand-rolled block-comment strip swallowed real code between a `/*` inside one
 * expression and a later `* /`, and quietly hid a route that genuinely exists.
 */
function serverPaths(): Set<string> {
  const files = [path.join(MAIN, "services", "remote-server.ts")];
  const dir = path.join(MAIN, "services", "routes");
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".ts") && !f.endsWith(".test.ts")) files.push(path.join(dir, f));
  }
  const out = new Set<string>();
  for (const f of files) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/["'`](\/api\/[^"'`\s)$]*)["'`]/g)) {
      out.add(m[1]!.replace(/\/$/, ""));
    }
  }
  return out;
}

/**
 * The /api paths api.ts builds, reduced to their static prefix.
 *
 * A template like `/api/views/${id}/slots` is checked as `/api/views/` — the
 * dynamic tail is matched by regex server-side, so demanding an exact string
 * would produce noise. The static-prefix check still catches a whole path no
 * module serves, which is the failure this exists for.
 */
function clientPaths(): Map<string, string> {
  const src = fs.readFileSync(API_TS, "utf8");
  const out = new Map<string, string>();
  for (const m of src.matchAll(/["'`](\/api\/[^"'`\s)]*)["'`]/g)) {
    const raw = m[1]!;
    const stop = raw.search(/[$?]/);
    const prefix = stop === -1 ? raw : raw.slice(0, stop);
    // `/api/` alone carries no information.
    if (prefix.length > "/api/".length) out.set(prefix.replace(/\/$/, ""), raw);
  }
  return out;
}

/**
 * Is this path served, directly or by a prefix handler?
 *
 * Some namespaces are dispatched with `pathname.startsWith("/api/baptism/")` and
 * a switch on the tail, so the literal full path never appears in the source.
 * Walking up the segments accepts those. It stops above `/api/<segment>`, so a
 * whole namespace the server does not know — which is what both real bugs looked
 * like — still fails.
 */
function isServed(served: Set<string>, apiPath: string): boolean {
  const parts = apiPath.split("/").filter(Boolean); // ["api", "baptism", "start"]
  for (let n = parts.length; n >= 2; n--) {
    if (served.has(`/${parts.slice(0, n).join("/")}`)) return true;
  }
  return false;
}

describe("API route coverage", () => {
  it("every /api path the client calls is served by some module", () => {
    const served = serverPaths();
    const missing = [...clientPaths()]
      .filter(([prefix]) => !isServed(served, prefix))
      .map(([prefix, raw]) => `  ${prefix}   (from ${raw})`);

    assert.equal(
      missing.length,
      0,
      `the client calls paths no route module handles:\n${missing.join("\n")}`,
    );
  });

  it("finds paths at all, so a broken scan cannot pass silently", () => {
    const paths = clientPaths();
    assert.ok(paths.size > 40, `only found ${paths.size} client paths — scan looks broken`);
    assert.ok(paths.has("/api/state"), "expected /api/state among them");
  });
});
