// deploy.mjs — `wrangler deploy`, with this install's own address.
//
// The repository is public, so no church's domain is written into wrangler.jsonc.
// An optional, gitignored `deploy.local.json` beside wrangler.jsonc names it:
//
//   { "domain": "servicecue.example.org", "workersDev": false }
//
// `domain` is attached as a Custom Domain on every deploy, so a deploy never drops it.
// `workersDev: false` turns the workers.dev address off; it stays on without the file.
//
// Every deploy is annotated as the server's own are (main/services/servicecue-cloudflare.ts): the
// version's message is "Stage Utility <package.json version>" and its tag is the build id stamped in
// the built page. A server that keeps the page up to date reads them back, so a deploy made here is
// neither mistaken for an old page and rolled back, nor for one nothing is known about.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const localPath = join(here, "deploy.local.json");

/**
 * The build id a built page's document carries, or null: viewerBuildFromHtml in
 * main/types/servicecue-publish.ts, which this cannot import (it is TypeScript). A test holds the two
 * to the same answer.
 */
export function buildIdOf(html) {
  let bare = html;
  for (let before = ""; before !== bare; ) {
    before = bare;
    bare = bare.replace(/<!--[\s\S]*?-->/g, "");
  }
  const m = /<meta\s+name="servicecue-build"\s+content="([^"]*)"\s*\/?>/.exec(bare);
  return m !== null && /^[0-9a-f]{12}$/.test(m[1]) ? m[1] : null;
}

/** The wrangler arguments and, when workers.dev is off, the config text to deploy with. `release` is `{ version, build }`. */
export function deployPlan(local, configText, release) {
  if (!release || typeof release.version !== "string" || !/^[0-9a-f]{12}$/.test(release.build ?? "")) {
    throw new Error("a deploy is annotated with the app's version and the built page's build id, and one of them is missing");
  }
  const args = ["deploy", "--message", `Stage Utility ${release.version}`, "--tag", release.build];
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
  const build = buildIdOf(readFileSync(join(here, "public", "servicecue.html"), "utf8"));
  if (build === null) throw new Error("public/servicecue.html carries no build id: run `npm run servicecue:build` first");
  const { version } = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
  const { args, config } = deployPlan(local, readFileSync(join(here, "wrangler.jsonc"), "utf8"), { version, build });
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
