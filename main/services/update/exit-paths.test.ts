import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Every way this process can end, enumerated.
//
// On launchd a background job that exits has its KeepAlive respawn PARKED
// ("pended nondemand spawn = inefficient"): the box stays dark until a human
// runs `launchctl kickstart`. exitForRestart() exists to pair the exit with a
// detached kickstart so that cannot happen, and relaunch.test.ts covers the
// script it builds — thoroughly, and beside the point.
//
// Nothing covered the CALL SITES. Proven, not assumed: replacing
// system-routes.ts's `exitForRestart(1200)` with `setTimeout(() => process.exit(0), 1200)`
// — the exact pre-fix code behind a config restore that left a Homebrew box dark
// — left all 1308 tests passing. The only complaint was tsc noticing an unused
// import, which anyone making that change deletes along with the call.
//
// So this asserts the EXACT set of direct exits, not a floor. A floor with slack
// is how three config stores went missing from every backup with the suite green.
// A new exit path fails here until it is either routed through exitForRestart or
// added below with a reason.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");

/**
 * The only two places allowed to end the process directly.
 *
 * Deliberately keyed by file AND reason: a future reader deciding whether their
 * new exit belongs here has to answer "is the service manager already stopping
 * me, or am I expecting it to bring me back?"
 */
const ALLOWED_DIRECT_EXITS: Record<string, string> = {
  "main/services/update/relaunch.ts":
    "inside exitForRestart itself — the sanctioned exit, which spawns the kickstart first",
  "server.ts":
    "SIGTERM/SIGINT shutdown — the service manager is stopping us on purpose, so a kickstart would fight it",
};

/** Every shipped .ts under main/, plus server.ts. Tests excluded. */
function sourceFiles(): string[] {
  const out: string[] = [path.join(REPO, "server.ts")];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(path.join(REPO, "main"));
  return out;
}

describe("process exit paths", () => {
  it("only the two sanctioned files end the process directly", () => {
    const found = new Map<string, number>();
    for (const file of sourceFiles()) {
      // Matched on the CALL, not the identifier: prose about exiting cannot
      // satisfy this, and a comment that contains the call text only ever ADDS a
      // site — failing loudly, which is the safe direction to be wrong in.
      const hits = (fs.readFileSync(file, "utf8").match(/process\.exit\(/g) ?? []).length;
      if (hits > 0) found.set(path.relative(REPO, file), hits);
    }

    assert.deepEqual(
      [...found.keys()].sort(),
      Object.keys(ALLOWED_DIRECT_EXITS).sort(),
      "a file ends the process directly without being listed in ALLOWED_DIRECT_EXITS — " +
        "route it through exitForRestart(), or add it with the reason it is exempt",
    );
  });

  it("every restart path goes through exitForRestart", () => {
    // The three sites that expect something to bring the process back. Each must
    // call it — matched as a call, so an import alone does not satisfy this.
    const callers = [
      "main/services/routes/system-routes.ts", // operator restart + config restore
      "main/services/updater.ts", // restart after an applied update
      "server.ts", // uncaughtException
    ];
    for (const rel of callers) {
      const src = fs.readFileSync(path.join(REPO, rel), "utf8");
      assert.match(src, /exitForRestart\(/, `${rel} must restart through exitForRestart()`);
    }
  });
});
