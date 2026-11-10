// Forwards to build-inputs.ts, exit status included. It stays: an update script is loaded before the pull,
// so an install on an older release runs one that calls this path.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("./build-inputs.ts", import.meta.url));
const run = spawnSync(process.execPath, ["--no-warnings", target, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
