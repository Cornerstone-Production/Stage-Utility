// parent.mjs — stands in for the running server.
//
// Spawns the worker exactly as updater.ts does: detached, stdio ignored,
// unref'd. Then stays alive, as the server does, so the service manager has a
// live main process to tear down.

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const child = spawn(process.execPath, [path.join(here, "child.mjs")], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
child.unref();

setInterval(() => {}, 1000);
