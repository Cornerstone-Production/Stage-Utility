// servicecue-deploy-try.ts — run the server's own deployer once, by hand, and say each step.
//
//   CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> \
//     npm run servicecue:deploy-try -- --script <name> [--check] [--bundle <dir>] [--version <v>]
//
// What the server does on its own when it finds the public page out of date, without the server:
// the same code (main/services/servicecue-cloudflare.ts) reads build/servicecue/ and puts it on the
// Worker named by --script, printing each request it makes. It is for trying a deploy against a
// scratch Worker before trusting the server with the real one, so:
//
//   --script <name>   the Worker to deploy to. Required. The bundle's own name (the real Worker's)
//                     is refused unless --production is also given.
//   --check           verify the token and read what is deployed, and send nothing.
//   --bundle <dir>    the folder to deploy (default: build/servicecue, made by `npm run servicecue:bundle`).
//   --version <v>     the version to record with the upload (default: package.json's).
//   --api <origin>    another API address; only a loopback one is accepted, for a fake.
//
// The account and the token come from the environment, as wrangler reads them, never from an
// argument (an argument is in the process list). Neither is printed, nor anything Cloudflare hands
// back that could stand in for one. The Worker must already exist: creating it is the manual,
// first-time step (docs/ops/servicecue-on-the-web.md).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage } from "../main/services/errors.js";
import { CLOUDFLARE_API_ORIGIN, CloudflareError, cloudflareOrigin, createCloudflare, readBundle, type DeployedPage } from "../main/services/servicecue-cloudflare.js";
import { isMain } from "./is-main.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

const when = (at: number | null): string => (at === null ? "unknown" : new Date(at).toISOString());
const said = (page: DeployedPage): string => `build ${page.build ?? "unknown"}, version ${page.version ?? "not recorded (deployed by hand)"}, live since ${when(page.at)}`;

/** The command. Answers the exit status; `say` is where each line goes. */
export async function run(args: string[], env: Record<string, string | undefined>, say: (line: string) => void): Promise<number> {
  try {
    const script = flag(args, "--script");
    if (!script) throw new Error("--script <the Worker to deploy to> is required");
    const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
    const token = env.CLOUDFLARE_API_TOKEN ?? "";
    if (!accountId || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required in the environment");
    const bundleDir = path.resolve(flag(args, "--bundle") ?? path.join(ROOT, "build/servicecue"));
    const version = flag(args, "--version") ?? (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    const check = args.includes("--check");
    const api = flag(args, "--api");
    const origin = cloudflareOrigin(api ?? CLOUDFLARE_API_ORIGIN);

    const bundle = readBundle(bundleDir);
    say(`bundle     ${path.relative(ROOT, bundleDir) || bundleDir}: build ${bundle.manifest.build}, made at version ${bundle.manifest.version}, ${bundle.files.length} files, Worker ${bundle.worker.byteLength} bytes`);
    say(`target     Worker "${script}" on account ${accountId.slice(0, 4)}…${accountId.slice(-4)} at ${origin}`);
    if (script === bundle.manifest.name && !args.includes("--production")) {
      throw new Error(`"${script}" is the real Worker's name. Deploy to a scratch Worker, or add --production to mean it`);
    }

    const client = createCloudflare({ origin, accountId, token, script });
    say("verify     the token ...");
    await client.verifyToken();
    say("verify     accepted");

    say("deployed   reading what the Worker holds ...");
    const before = await client.deployedPage();
    say(`deployed   ${said(before)}`);
    if (check) {
      say("check      nothing was sent");
      return 0;
    }

    say(`deploy     as version ${version} ...`);
    const files = await client.deploy(bundle, version, (plan) => say(`files      ${plan.uploaded} to upload, ${plan.held} already on Cloudflare`));
    say(`deploy     done: ${files.uploaded} uploaded, ${files.held} already held`);

    const after = await client.deployedPage();
    say(`deployed   now ${said(after)}`);
    if (after.build !== bundle.manifest.build) say(`WARNING    Cloudflare reports build ${after.build ?? "none"}, not ${bundle.manifest.build}: the version annotation is not read back the way the server needs`);
    if (after.version !== version) say(`WARNING    Cloudflare reports version ${after.version ?? "none"}, not ${version}: the no-downgrade rule has nothing to read`);
    return 0;
  } catch (err) {
    say(`FAILED     ${err instanceof CloudflareError ? err.describe() : errorMessage(err)}`);
    return 1;
  }
}

if (isMain(import.meta.url, process.argv[1])) {
  process.exit(await run(process.argv.slice(2), process.env, (line) => console.log(line)));
}
