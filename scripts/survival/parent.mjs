// parent.mjs — stands in for the running server.
//
// Spawns the worker exactly as updater.ts does: detached, stdio ignored,
// unref'd. Then stays alive, as the server does, so the service manager has a
// live main process to tear down.

import { spawn } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.SURVIVAL_LOG;

// The parent records itself too. Without this an empty log is ambiguous - it
// could mean the child was killed, or that the parent never got as far as
// spawning it, and those need completely different fixes. A run that fails
// should say which.
function note(line) {
  if (!out) return;
  try {
    fs.appendFileSync(out, `${line}\n`);
  } catch (err) {
    // Nowhere to report to but stderr, which the service manager captures.
    console.error(`parent could not write to SURVIVAL_LOG=${out}: ${err.message}`);
  }
}

note(`PARENT-START pid=${process.pid} uid=${process.getuid?.() ?? "?"} node=${process.execPath}`);

try {
  const child = spawn(process.execPath, [path.join(here, "child.mjs")], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  note(`PARENT-SPAWNED child=${child.pid}`);
} catch (err) {
  note(`PARENT-SPAWN-FAILED ${err.message}`);
}

setInterval(() => {}, 1000);
