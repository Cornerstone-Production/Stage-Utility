#!/usr/bin/env node
// run.mjs — make the documentation screenshots.
//
//   npm run docs:screenshots                 every image
//   npm run docs:screenshots -- --only home-dashboard,screens-overview
//   npm run docs:screenshots -- --serve      seed a server and leave it running to look at
//
// See scripts/docs-screenshots/README.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApi } from "./lib/api.mjs";
import { DEFAULT_PORT, REPO_ROOT, assertScratchDir, killByPort, startServer } from "./lib/server.mjs";
import { seedHistoryFiles } from "./seed/history.mjs";
import { seedApp } from "./seed/app.mjs";
import { capture } from "./capture/index.mjs";

function parseArgs(argv) {
  const out = { only: null, port: DEFAULT_PORT, serve: false, data: null, out: path.join(REPO_ROOT, "docs/images") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") out.only = argv[++i].split(",").filter(Boolean);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--serve") out.serve = true;
    else if (a === "--data") out.data = argv[++i];
    else if (a === "--out") out.out = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(path.join(REPO_ROOT, "build/renderer/app.html"))) {
  throw new Error("the app is not built: run `npm run build` first, so the screenshots show this checkout and not an old build");
}
const scratch = args.data ? path.resolve(args.data) : fs.mkdtempSync(path.join(os.tmpdir(), "stage-docs-shots-"));
const dataDir = path.join(scratch, "data");
assertScratchDir(dataDir);
const stateFile = path.join(scratch, "state.json");
const now = new Date();
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ live: false }));

console.log(`scratch data dir: ${dataDir}`);
seedHistoryFiles(dataDir, now);

const server = await startServer({ dataDir, port: args.port, now, stateFile, logFile: path.join(scratch, "server.log") });
const stop = async () => server.stop();
process.on("SIGINT", async () => {
  await stop();
  process.exit(130);
});

try {
  const api = makeApi(server.base);
  const world = await seedApp(api, { now, dataDir });
  if (args.serve) {
    console.log(`serving ${server.base} (data ${dataDir}); stop with: kill $(lsof -tiTCP:${args.port} -sTCP:LISTEN)`);
    await new Promise(() => {});
  }
  await capture({ base: server.base, api, world, only: args.only, outDir: args.out, setLive: (live) => fs.writeFileSync(stateFile, JSON.stringify({ live })) });
} finally {
  if (!args.serve) {
    await stop();
    killByPort(args.port);
  }
}
