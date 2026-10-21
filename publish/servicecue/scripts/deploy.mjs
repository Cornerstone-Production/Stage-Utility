// deploy.mjs — `wrangler deploy`, with this install's own address.
//
// The repository is public, so no church's domain is written into wrangler.jsonc.
// An optional, gitignored `deploy.local.json` beside wrangler.jsonc names it:
//
//   { "domain": "servicecue.example.org", "workersDev": false }
//
// `domain` is attached as a Custom Domain on every deploy, so a deploy never drops it.
// `workersDev: false` turns the workers.dev address off; it stays on without the file.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const localPath = join(here, "deploy.local.json");

/** The wrangler arguments and, when workers.dev is off, the config text to deploy with. */
export function deployPlan(local, configText) {
  const args = ["deploy"];
  let config = null;
  if (local?.domain !== undefined) {
    if (typeof local.domain !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(local.domain)) {
      throw new Error(`deploy.local.json: "domain" is not a host name: ${JSON.stringify(local.domain)}`);
    }
    args.push("--domain", local.domain);
  }
  if (local?.workersDev === false) {
    const on = '"workers_dev": true';
    if (configText.split(on).length !== 2) throw new Error(`wrangler.jsonc: expected exactly one ${on}`);
    config = configText.replace(on, '"workers_dev": false');
  }
  return { args, config };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : null;
  const { args, config } = deployPlan(local, readFileSync(join(here, "wrangler.jsonc"), "utf8"));
  const generated = join(here, "wrangler.deploy.jsonc");
  const cleanUp = () => rmSync(generated, { force: true });
  if (config !== null) {
    writeFileSync(generated, config);
    args.push("--config", generated);
    // Ctrl-C reaches wrangler too. With a handler this process outlives it, so the
    // finally below still removes the generated config.
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cleanUp(); process.exit(130); });
  }
  console.log(`[servicecue-deploy] wrangler ${args.join(" ")}`);
  let r;
  try {
    r = spawnSync("npx", ["wrangler", ...args], { cwd: here, stdio: "inherit" });
  } finally {
    if (config !== null) cleanUp();
  }
  process.exit(r.status ?? 1);
}
