// scripts/kiosk/install-macos.sh, run for real where that is safe.
//
// The script is shell, and the things that matter in it are exactly what a text
// scan cannot prove: that a zip with the wrong checksum is refused, that a failed
// swap leaves the old app in place, that a re-run keeps the device id. So these
// tests source the script and call its own functions, with every path moved under
// a scratch directory (STAGE_INSTALL_TEST_ROOT) and the download source pointed at
// local HTTP servers standing in for the Stage Utility server and for GitHub.
//
// What is NOT run, here or anywhere in CI: the parts that need root and a logged-in
// Mac (launchctl, pmset, defaults, chown). Those are exercised by --dry-run, which
// prints them, and by a person on a Mac.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "kiosk", "install-macos.sh");

const has = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

interface Result {
  status: number | null;
  out: string;
  err: string;
}

/** Run `sh -c`, collecting both streams. Async: the fake servers live in this process. */
function sh(code: string, env: Record<string, string> = {}, args: string[] = []): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", code, "sh", ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out, err }));
  });
}

const ME = os.userInfo().username;

/**
 * Stand-ins for every command that changes a real Mac: launchctl, pmset, defaults,
 * pkill, chown, chgrp, plutil. Each appends one line to a log, "<name> <args> |
 * marker=yes|no", where `marker` says whether the migration marker existed at that
 * moment (that is how the ORDER of the migration is observed), and exits 0 unless
 * SHIM_FAIL_<name> says otherwise. `launchctl print` answers "not loaded" and
 * `pgrep` answers "none", so nothing looks running. Nothing here runs a real one.
 */
const SHIM = `#!/bin/sh
name=$(basename "$0")
here=no
if [ -n "\${SHIM_MARKER:-}" ] && [ -e "$SHIM_MARKER" ]; then here=yes; fi
line="$name"
for a in "$@"; do line="$line $a"; done
printf '%s | marker=%s\\n' "$line" "$here" >>"$SHIM_LOG"
case "$name:\${1:-}" in
  launchctl:print) exit "\${SHIM_PRINT_RC:-1}" ;;
  pgrep:*) exit 1 ;;
esac
eval "rc=\\\${SHIM_FAIL_$name:-0}"
exit "$rc"
`;
const SHIMMED = ["launchctl", "pmset", "defaults", "pgrep", "pkill", "chown", "chgrp", "plutil"];

const shimDirs: string[] = [];

function makeShims(): { dir: string; log: () => string[]; env: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "su-shims-"));
  shimDirs.push(dir);
  for (const name of SHIMMED) fs.writeFileSync(path.join(dir, name), SHIM, { mode: 0o755 });
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(log, "");
  return {
    dir,
    log: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
    env: { PATH: `${dir}:${process.env.PATH ?? ""}`, SHIM_LOG: log },
  };
}

const dryRun = (root: string, args: string[], env: Record<string, string> = {}) =>
  sh('exec sh "$@"', { STAGE_INSTALL_TEST_ROOT: root, ...env }, [SCRIPT, "--dry-run", ...args]);

let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "su-install-"));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const d of shimDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("install-macos.sh is valid shell", () => {
  it("parses under sh and bash (and dash where it exists)", () => {
    for (const shell of ["sh", "bash", "dash"]) {
      if (!has(shell)) continue;
      const r = spawnSync(shell, ["-n", SCRIPT], { encoding: "utf8" });
      assert.equal(r.status, 0, `${shell} -n: ${r.stderr}`);
    }
  });

  it("is clean under shellcheck, when shellcheck is installed", (t) => {
    if (!has("shellcheck")) {
      t.skip("shellcheck is not installed here; sh -n above is the fallback");
      return;
    }
    const r = spawnSync("shellcheck", ["-s", "sh", SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe("--dry-run", () => {
  const server = { STAGE_SERVER: "http://192.0.2.10:8788", STAGE_INSTALL_TEST_UNAME_S: "Darwin", STAGE_INSTALL_TEST_OS_VERSION: "14.5", STAGE_INSTALL_TEST_CONSOLE_USER: ME };

  it("prints the helper's steps for each architecture, and changes nothing", async () => {
    for (const arch of ["arm64", "x86_64"]) {
      const r = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_UNAME_M: arch });
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, new RegExp(`this Mac: ${arch}`));
      assert.match(r.out, new RegExp(`download http://192\\.0\\.2\\.10:8788/kiosk/StageUtilityOutput-${arch}\\.zip and its \\.sha256`));
      assert.match(r.out, /GitHub release's StageUtilityOutput/);
      assert.match(r.out, /refuse a zip whose SHA-256 differs/);
      assert.match(r.out, /com\.stageutility\.output\.plist/);
      assert.match(r.out, /pmset -a displaysleep 0 sleep 0/);
      assert.match(r.out, /screen saver idle time 0/);
      assert.match(r.out, /automatic login/);
      assert.match(r.out, /Local Network prompt/);
      assert.match(r.out, /Dry run: nothing was changed/);
    }
    assert.deepEqual(fs.readdirSync(scratch), [], "a dry run must not create a single file");
  });

  it("plans a system-wide agent, started now for the console user", async () => {
    const r = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_UNAME_M: "arm64" });
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /write .*\/Library\/LaunchAgents\/com\.stageutility\.output\.plist, root-owned, which starts the helper at every login/);
    assert.match(r.out, new RegExp(`start the helper now for ${ME}`));
    assert.doesNotMatch(r.out, /Nobody is logged in/);
  });

  it("with nobody logged in, plans the same agent and says the helper starts at the next login", async () => {
    const r = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_CONSOLE_USER: "none", STAGE_INSTALL_TEST_UNAME_M: "arm64" });
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /write .*\/Library\/LaunchAgents\/com\.stageutility\.output\.plist, root-owned/);
    assert.match(r.out, /nobody is logged in, so the helper starts at the next login/);
    assert.match(r.out, /Nobody is logged in, so the helper has not started: it starts at the next login\./);
    assert.doesNotMatch(r.out, /start the helper now/);
    assert.deepEqual(fs.readdirSync(scratch), []);
  });

  it("says it will keep an existing device id, and not make another", async () => {
    const state = path.join(scratch, "Library", "Application Support", "StageUtility");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "device-id"), "11111111-2222-3333-4444-555555555555\n");
    const r = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_UNAME_M: "arm64" });
    assert.match(r.out, /keep the device id 11111111-2222-3333-4444-555555555555/);
    assert.doesNotMatch(r.out, /create a device id/);
    assert.equal(fs.readFileSync(path.join(state, "device-id"), "utf8"), "11111111-2222-3333-4444-555555555555\n");
  });

  it("plans the migration only when the Chrome kiosk agent is there", async () => {
    const env = { ...server, STAGE_INSTALL_TEST_UNAME_M: "arm64" };
    const without = await dryRun(scratch, [], env);
    assert.doesNotMatch(without.out, /Replacing the Chrome kiosk agent/);

    const agents = path.join(scratch, "Library", "LaunchAgents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "com.stageutility.kiosk.plist"), "<plist/>");
    const withOld = await dryRun(scratch, [], env);
    assert.match(withOld.out, /Replacing the Chrome kiosk agent/);
    assert.match(withOld.out, /keep the device id, the token and the Chrome profile/);
    assert.ok(fs.existsSync(path.join(agents, "com.stageutility.kiosk.plist")), "a dry run removes nothing");
  });

  it("shows the migration marker in the plan, and writes nothing", async () => {
    const agents = path.join(scratch, "Library", "LaunchAgents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "com.stageutility.kiosk.plist"), "<plist/>");
    const r = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_UNAME_M: "arm64" });
    assert.match(r.out, /write .*migrated-from-kiosk, which tells the helper/);
    assert.match(r.out, /main display comes back as the screen the Chrome kiosk showed/);
    assert.ok(!fs.existsSync(path.join(scratch, "Library", "Application Support")), "a dry run writes no marker");
  });

  it("refuses a Mac the helper cannot run on, and points at --browser", async () => {
    const old = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_UNAME_M: "arm64", STAGE_INSTALL_TEST_OS_VERSION: "13.6.1" });
    assert.equal(old.status, 1);
    assert.match(old.err, /needs macOS 14 or later; this is macOS 13\.6\.1\. Use --browser/);

    const odd = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_UNAME_M: "ppc" });
    assert.equal(odd.status, 1);
    assert.match(odd.err, /architecture "ppc"/);

    const linux = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_UNAME_S: "Linux", STAGE_INSTALL_TEST_UNAME_M: "arm64" });
    assert.equal(linux.status, 1);
    assert.match(linux.err, /for macOS; this is Linux/);
  });

  it("stops with the way out when it has no server to download from", async () => {
    const r = await dryRun(scratch, [], { STAGE_INSTALL_TEST_UNAME_S: "Darwin", STAGE_INSTALL_TEST_OS_VERSION: "15.0", STAGE_INSTALL_TEST_UNAME_M: "arm64" });
    assert.equal(r.status, 1);
    assert.match(r.err, /no server address to download from.*STAGE_SERVER=http/);
  });

  it("keeps the Chrome kiosk path behind --browser, and it needs no helper download", async () => {
    // macOS 13 cannot run the helper, and --browser is the way it installs.
    const r = await dryRun(scratch, ["--browser"], { STAGE_INSTALL_TEST_UNAME_S: "Darwin", STAGE_INSTALL_TEST_OS_VERSION: "13.0", STAGE_INSTALL_TEST_UNAME_M: "x86_64" });
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Installing the Stage Utility kiosk agent/);
    assert.match(r.out, /write the launcher/);
    assert.doesNotMatch(r.out, /StageUtilityOutput/);
    assert.deepEqual(fs.readdirSync(scratch), []);
  });

  it("answers an unknown option with 2, and --help with the usage", async () => {
    const bad = await sh('exec sh "$@"', {}, [SCRIPT, "--bogus"]);
    assert.equal(bad.status, 2);
    assert.match(bad.err, /unknown option "--bogus"/);
    const help = await sh('exec sh "$@"', {}, [SCRIPT, "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.out, /--browser/);
    assert.match(help.out, /--dry-run/);
  });
});

// ── The real download, verify and swap ─────────────────────────────────────

/** A helper zip with just enough bundle in it for the installer's own checks. */
function makeZip(dir: string, marker: string): { file: string; bytes: Buffer } {
  const app = path.join(dir, "build", "StageUtilityOutput.app", "Contents");
  fs.mkdirSync(path.join(app, "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Info.plist"),
    `<?xml version="1.0"?><plist><dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.stageutility.output</string>\n</dict></plist>\n`,
  );
  fs.writeFileSync(path.join(app, "MacOS", "StageUtilityOutput"), `#!/bin/sh\necho ${marker}\n`, { mode: 0o755 });
  const file = path.join(dir, `${marker}.zip`);
  const r = spawnSync("zip", ["-qr", file, "StageUtilityOutput.app"], { cwd: path.join(dir, "build"), encoding: "utf8" });
  assert.equal(r.status, 0, `zip failed (is zip installed?): ${r.stderr}`);
  fs.rmSync(path.join(dir, "build"), { recursive: true, force: true });
  return { file, bytes: fs.readFileSync(file) };
}

interface Fake {
  server: http.Server;
  base: string;
  /** path -> reply. */
  routes: Map<string, { status?: number; body: Buffer | string }>;
  hits: string[];
}

async function fakeHost(): Promise<Fake> {
  const routes = new Map<string, { status?: number; body: Buffer | string }>();
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const r = routes.get(req.url ?? "");
    if (!r) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown" }));
      return;
    }
    res.writeHead(r.status ?? 200);
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, routes, hits };
}

describe("fetching, verifying and swapping the app", { skip: !has("zip") && "zip is not installed" }, () => {
  let stageServer: Fake;
  let github: Fake;
  let zipA: { file: string; bytes: Buffer };
  let zipB: { file: string; bytes: Buffer };

  before(async () => {
    stageServer = await fakeHost();
    github = await fakeHost();
  });
  after(async () => {
    await new Promise((r) => stageServer.server.close(r));
    await new Promise((r) => github.server.close(r));
  });
  beforeEach(() => {
    stageServer.routes.clear();
    stageServer.hits.length = 0;
    github.routes.clear();
    github.hits.length = 0;
    zipA = makeZip(scratch, "build-a");
    zipB = makeZip(scratch, "build-b");
  });

  const publish = (host: Fake, prefix: string, zip: { bytes: Buffer }, digest = sha(zip.bytes)) => {
    host.routes.set(`${prefix}/StageUtilityOutput-arm64.zip`, { body: zip.bytes });
    host.routes.set(`${prefix}/StageUtilityOutput-arm64.zip.sha256`, { body: `${digest}  StageUtilityOutput-arm64.zip\n` });
  };

  const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    STAGE_INSTALL_SOURCED: "1",
    STAGE_INSTALL_TEST_ROOT: scratch,
    STAGE_INSTALL_TEST_UNAME_M: "arm64",
    STAGE_INSTALL_GITHUB_BASE: `${github.base}/releases`,
    STAGE_SERVER: stageServer.base,
    ...extra,
  });

  /** Source the installer and run `steps` in it, as main() would, with the exit trap armed. */
  const install = (steps: string, extra: Record<string, string> = {}) =>
    sh(`. "${SCRIPT}"; trap on_exit EXIT; WORK="$(mktemp -d)"; ${steps}`, baseEnv(extra));

  const app = () => path.join(scratch, "Applications", "StageUtilityOutput.app");
  const marker = () => fs.readFileSync(path.join(app(), "Contents", "MacOS", "StageUtilityOutput"), "utf8").trim().split(" ")[1];
  const leftovers = () => fs.readdirSync(path.join(scratch, "Applications")).filter((n) => n !== "StageUtilityOutput.app");
  const FLOW = "detect_arch; fetch_helper; stage_app; swap_app";

  it("installs from the server and verifies the published checksum", async () => {
    publish(stageServer, "/kiosk", zipA);
    const r = await install(`${FLOW}; FINISHED=1`);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /downloading StageUtilityOutput-arm64\.zip from this server/);
    assert.match(r.out, new RegExp(`verified SHA-256 ${sha(zipA.bytes)}`));
    assert.equal(marker(), "build-a");
    assert.deepEqual(github.hits, [], "the release is not touched when the server answered");
    assert.deepEqual(leftovers(), [], "no staging or old-app directories are left behind");
  });

  it("refuses a download that does not match its checksum, and installs nothing", async () => {
    publish(stageServer, "/kiosk", zipA, sha("a different file"));
    stageServer.routes.set("/api/update/status", { body: '{"tracks":["main","beta"],"version":"9.9.9"}' });
    publish(github, "/releases/v9.9.9", zipA, sha("also wrong"));
    const r = await install(FLOW);
    assert.equal(r.status, 1, r.out + r.err);
    assert.match(r.err, /did not match its published SHA-256/);
    assert.ok(!fs.existsSync(app()), "a refused download must not become the app");
    assert.deepEqual(fs.existsSync(path.join(scratch, "Applications")) ? leftovers() : [], []);
  });

  it("falls back to the GitHub release for the server's version, and verifies that too", async () => {
    stageServer.routes.set("/kiosk/StageUtilityOutput-arm64.zip.sha256", {
      status: 404,
      body: JSON.stringify({ error: "v9.9.9 of StageUtilityOutput-arm64.zip.sha256 is not in the cache and could not be fetched: no route" }),
    });
    stageServer.routes.set("/api/update/status", { body: '{"tracks":["main","beta"],"version":"9.9.9"}' });
    publish(github, "/releases/v9.9.9", zipB);
    const r = await install(`${FLOW}; FINISHED=1`);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /the checksum answered 404: v9\.9\.9 of .* is not in the cache and could not be fetched: no route/, "the server's own reason is shown");
    assert.match(r.out, /downloading StageUtilityOutput-arm64\.zip from the GitHub release v9\.9\.9/);
    assert.equal(marker(), "build-b");
    assert.ok(github.hits.some((h) => h.endsWith("/v9.9.9/StageUtilityOutput-arm64.zip")));
  });

  it("names both reasons when neither source works", async () => {
    stageServer.routes.set("/api/update/status", { body: '{"version":"9.9.9"}' });
    const r = await install(FLOW);
    assert.equal(r.status, 1);
    assert.match(r.err, /could not get the helper\. this server \(.*\): the checksum answered 404/);
    assert.match(r.err, /the GitHub release v9\.9\.9: the checksum answered 404/);
    assert.ok(!fs.existsSync(app()));
  });

  it("explains itself when the server's version cannot be read, so GitHub was not tried", async () => {
    const r = await install(FLOW);
    assert.equal(r.status, 1);
    assert.match(r.err, /version could not be read from .*\/api\/update\/status either, so the GitHub release was not tried/);
  });

  it("replaces an older copy, and keeps the old one until the new one is in place", async () => {
    publish(stageServer, "/kiosk", zipA);
    assert.equal((await install(`${FLOW}; FINISHED=1`)).status, 0);
    assert.equal(marker(), "build-a");

    publish(stageServer, "/kiosk", zipB);
    const r = await install(`${FLOW}; FINISHED=1`);
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(marker(), "build-b", "upgraded in place");
    assert.deepEqual(leftovers(), []);
  });

  it("puts the old app back when the swap fails", async () => {
    publish(stageServer, "/kiosk", zipA);
    assert.equal((await install(`${FLOW}; FINISHED=1`)).status, 0);

    publish(stageServer, "/kiosk", zipB);
    // The staged copy is taken away between the unpack and the swap, so the
    // second rename has nothing to move: the failure the rollback exists for.
    const r = await install(`detect_arch; fetch_helper; stage_app; rm -rf "$STAGING/$APP_NAME"; swap_app`);
    assert.equal(r.status, 1, r.out + r.err);
    assert.match(r.err, /could not put the new StageUtilityOutput\.app .* the previous one is kept/);
    assert.equal(marker(), "build-a", "the previous app is still the app");
    assert.deepEqual(leftovers(), []);
  });

  it("leaves the previous app in place when the new zip is not a helper", async () => {
    publish(stageServer, "/kiosk", zipA);
    assert.equal((await install(`${FLOW}; FINISHED=1`)).status, 0);

    // A zip that verifies but holds something else.
    const bogus = path.join(scratch, "bogus");
    fs.mkdirSync(bogus);
    fs.writeFileSync(path.join(bogus, "README"), "not an app");
    const z = path.join(scratch, "bogus.zip");
    assert.equal(spawnSync("zip", ["-qr", z, "README"], { cwd: bogus }).status, 0);
    publish(stageServer, "/kiosk", { bytes: fs.readFileSync(z) });
    const r = await install(FLOW);
    assert.equal(r.status, 1);
    assert.match(r.err, /does not contain StageUtilityOutput\.app/);
    assert.equal(marker(), "build-a");
    assert.deepEqual(leftovers(), []);
  });

  it("refuses an app with another bundle id", async () => {
    const evil = path.join(scratch, "evil");
    fs.mkdirSync(path.join(evil, "StageUtilityOutput.app", "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(evil, "StageUtilityOutput.app", "Contents", "Info.plist"), "<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>");
    fs.writeFileSync(path.join(evil, "StageUtilityOutput.app", "Contents", "MacOS", "StageUtilityOutput"), "#!/bin/sh\n", { mode: 0o755 });
    const z = path.join(scratch, "evil.zip");
    assert.equal(spawnSync("zip", ["-qr", z, "StageUtilityOutput.app"], { cwd: evil }).status, 0);
    publish(stageServer, "/kiosk", { bytes: fs.readFileSync(z) });
    const r = await install(FLOW);
    assert.equal(r.status, 1);
    assert.match(r.err, /is not com\.stageutility\.output/);
    assert.ok(!fs.existsSync(app()));
  });

  // The whole of install_helper, in a test root, with launchctl and the other
  // commands that change a Mac replaced by logging stand-ins (see SHIM). Nothing
  // here touches launchd, pmset, defaults or a real account.
  describe("a whole install, with the commands that change a Mac stubbed", { skip: !(has("uuidgen") && has("xxd")) && "needs uuidgen and xxd" }, () => {
    const stateDir = () => path.join(scratch, "Library", "Application Support", "StageUtility");
    const agents = () => path.join(scratch, "Library", "LaunchAgents");
    const helperPlist = () => path.join(agents(), "com.stageutility.output.plist");
    const kioskPlist = () => path.join(agents(), "com.stageutility.kiosk.plist");
    const marker = () => path.join(stateDir(), "migrated-from-kiosk");

    const seedKiosk = () => {
      fs.mkdirSync(agents(), { recursive: true });
      fs.mkdirSync(path.join(scratch, "usr", "local", "bin"), { recursive: true });
      fs.writeFileSync(kioskPlist(), "<plist/>");
      fs.writeFileSync(path.join(scratch, "usr", "local", "bin", "stage-utility-kiosk"), "#!/bin/sh\n");
    };

    let shims: ReturnType<typeof makeShims>;
    beforeEach(() => {
      shims = makeShims();
    });

    /** install_helper itself, as main() calls it, as the console user `who` ("none" for nobody). */
    const whole = (who: string, extra: Record<string, string> = {}) =>
      sh(`. "${SCRIPT}"; trap on_exit EXIT; install_helper`, baseEnv({ ...shims.env, SHIM_MARKER: marker(), STAGE_INSTALL_TEST_CONSOLE_USER: who, ...extra }));

    it("with someone logged in: a root-owned system LaunchAgent, started in their session", async () => {
      publish(stageServer, "/kiosk", zipA);
      const r = await whole(ME);
      assert.equal(r.status, 0, r.out + r.err);

      assert.ok(fs.existsSync(helperPlist()), "the agent is in /Library/LaunchAgents, not a home folder");
      assert.equal(fs.statSync(helperPlist()).mode & 0o777, 0o644);
      const plist = fs.readFileSync(helperPlist(), "utf8");
      assert.match(plist, /<key>Label<\/key><string>com\.stageutility\.output<\/string>/);
      assert.match(plist, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);

      const calls = shims.log().map((l) => l.replace(/ \| marker=.*/, ""));
      assert.ok(calls.includes(`chown root:wheel ${helperPlist()}`), calls.join("\n"));
      const uid = (await sh("id -u")).out.trim();
      assert.ok(calls.includes(`launchctl bootstrap gui/${uid} ${helperPlist()}`), calls.join("\n"));
      assert.match(r.out, new RegExp(`started for ${ME}; it also starts at every login`));
      assert.doesNotMatch(r.out, /Nobody is logged in/);
      assert.doesNotMatch(calls.join("\n"), /dscl/, "no account lookup is needed any more");
    });

    it("with nobody logged in: the same agent, no start, and text that says it starts at the next login", async () => {
      publish(stageServer, "/kiosk", zipA);
      const r = await whole("none");
      assert.equal(r.status, 0, r.out + r.err);
      assert.ok(fs.existsSync(helperPlist()), "still installed: it loads at the next GUI login of any account");
      assert.equal(fs.statSync(helperPlist()).mode & 0o777, 0o644);
      const calls = shims.log().map((l) => l.replace(/ \| marker=.*/, ""));
      assert.deepEqual(calls.filter((c) => c.startsWith("launchctl")), [], "no session to start it in");
      assert.match(r.out, /nobody is logged in at the console, so the helper was not started/);
      assert.match(r.out, /starts at the next login/);
      assert.doesNotMatch(r.out, /started for/);
      // The token is for the administrators group, since no account owns it yet.
      assert.equal(fs.statSync(path.join(stateDir(), "token")).mode & 0o777, 0o640);
      assert.ok(calls.includes(`chgrp admin ${path.join(stateDir(), "token")}`), calls.join("\n"));
      assert.match(r.out, /If the account\s+that logs in first is not one/);
    });

    it("with nobody logged in, still replaces the Chrome kiosk, and says it happens at the next login", async () => {
      seedKiosk();
      publish(stageServer, "/kiosk", zipA);
      const r = await whole("none");
      assert.equal(r.status, 0, r.out + r.err);
      assert.ok(fs.existsSync(marker()));
      assert.ok(!fs.existsSync(kioskPlist()), "the kiosk's agent is gone");
      assert.ok(fs.existsSync(helperPlist()), "and the helper's agent takes its place at the next login");
      assert.match(r.out, /Nobody is logged in, so the kiosk is replaced at the next login/);
      assert.deepEqual(shims.log().filter((l) => l.startsWith("launchctl")), []);
    });
  });
});

describe("the device identity survives a re-run", () => {
  const state = () => path.join(scratch, "Library", "Application Support", "StageUtility");
  const run = () =>
    sh(`. "${SCRIPT}"; DRY=0; CONSOLE_USER=""; write_state`, {
      STAGE_INSTALL_SOURCED: "1",
      STAGE_INSTALL_TEST_ROOT: scratch,
    });

  it("keeps an existing id and token byte for byte", async () => {
    fs.mkdirSync(state(), { recursive: true });
    fs.writeFileSync(path.join(state(), "device-id"), "aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb\n");
    fs.writeFileSync(path.join(state(), "token"), "0123456789abcdef");
    const r = await run();
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.readFileSync(path.join(state(), "device-id"), "utf8"), "aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb\n");
    assert.equal(fs.readFileSync(path.join(state(), "token"), "utf8"), "0123456789abcdef");
    assert.match(r.out, /device id: aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb/);
  });

  it("makes one on a first run and keeps that one on the second", { skip: !(has("uuidgen") && has("xxd")) && "needs uuidgen and xxd" }, async () => {
    assert.equal((await run()).status, 0);
    const first = fs.readFileSync(path.join(state(), "device-id"), "utf8");
    assert.match(first, /^[0-9a-f-]{36}\n$/);
    assert.equal((await run()).status, 0);
    assert.equal(fs.readFileSync(path.join(state(), "device-id"), "utf8"), first);
  });
});

describe("the migration marker", () => {
  const state = () => path.join(scratch, "Library", "Application Support", "StageUtility");
  const marker = () => path.join(state(), "migrated-from-kiosk");
  const migrate = () =>
    sh(`. "${SCRIPT}"; DRY=0; CONSOLE_UID=""; migrate_kiosk`, { STAGE_INSTALL_SOURCED: "1", STAGE_INSTALL_TEST_ROOT: scratch });

  it("is written, 0644, when the Chrome kiosk agent is removed, and the identity files stay", async () => {
    const agents = path.join(scratch, "Library", "LaunchAgents");
    const bin = path.join(scratch, "usr", "local", "bin");
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(state(), { recursive: true });
    fs.writeFileSync(path.join(agents, "com.stageutility.kiosk.plist"), "<plist/>");
    fs.writeFileSync(path.join(bin, "stage-utility-kiosk"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(state(), "device-id"), "keep-me\n");
    fs.writeFileSync(path.join(state(), "token"), "keep-me-too");

    const r = await migrate();
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.existsSync(marker()), "the marker is how the helper learns this Mac was a kiosk");
    assert.equal(fs.statSync(marker()).mode & 0o777, 0o644);
    assert.match(fs.readFileSync(marker(), "utf8"), /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!fs.existsSync(path.join(agents, "com.stageutility.kiosk.plist")));
    assert.ok(!fs.existsSync(path.join(bin, "stage-utility-kiosk")));
    assert.equal(fs.readFileSync(path.join(state(), "device-id"), "utf8"), "keep-me\n");
    assert.equal(fs.readFileSync(path.join(state(), "token"), "utf8"), "keep-me-too");
  });

  it("is not written on a fresh install, nor on a re-run after the agent is gone", async () => {
    const r = await migrate();
    assert.equal(r.status, 0, r.err);
    assert.ok(!fs.existsSync(marker()), "a Mac that was never a kiosk must not be told it was");
    assert.ok(!fs.existsSync(state()), "and nothing else is made either");
  });

  it("leaves an existing marker alone when run again", async () => {
    fs.mkdirSync(state(), { recursive: true });
    fs.writeFileSync(marker(), "earlier\n");
    assert.equal((await migrate()).status, 0);
    assert.equal(fs.readFileSync(marker(), "utf8"), "earlier\n");
  });
});
