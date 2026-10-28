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

import { testSigningKey } from "../main/services/fixtures/test-signing-key.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "kiosk", "install-macos.sh");

const has = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
/** The release signing key these tests sign with, made for this run; and another
 *  one, for a signature that is well formed and not the release's. */
const KEY = testSigningKey();
const OTHER_KEY = testSigningKey(3072 + 64);

interface Result {
  status: number | null;
  out: string;
  err: string;
}

/** Run `sh -c`, collecting both streams. Async: the fake servers live in this process. */
function sh(code: string, env: Record<string, string> = {}, args: string[] = []): Promise<Result> {
  return new Promise((resolve, reject) => {
    // STAGE_INSTALL_TEST_HW_ARM64 empty means "sysctl has no hw.optional.arm64", so a
    // test that names an architecture through uname gets exactly that one, on an
    // Apple silicon machine too. Tests of the sysctl itself set it.
    const child = spawn("sh", ["-c", code, "sh", ...args], { env: { PATH: process.env.PATH ?? "", STAGE_INSTALL_TEST_HW_ARM64: "", ...env } });
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
  launchctl:print)
    case "\${2:-}" in system/*) exit "\${SHIM_PRINT_SYSTEM_RC:-1}" ;; esac
    # SHIM_PID_FILE models launchd: the helper runs while the file holds its pid.
    if [ -n "\${SHIM_PID_FILE:-}" ]; then
      if [ -s "$SHIM_PID_FILE" ]; then printf '\\tpid = %s\\n' "$(cat "$SHIM_PID_FILE")"; else printf '\\tstate = not running\\n'; fi
      exit 0
    fi
    if [ -n "\${SHIM_PRINT_OUT:-}" ]; then printf '%s\\n' "$SHIM_PRINT_OUT"; fi
    exit "\${SHIM_PRINT_RC:-1}" ;;
  launchctl:bootout)
    case "\${2:-}" in gui/*) if [ -n "\${SHIM_PID_FILE:-}" ]; then rm -f "$SHIM_PID_FILE"; fi ;; esac ;;
  launchctl:bootstrap)
    case "\${2:-}" in gui/*)
      if [ -n "\${SHIM_PID_FILE:-}" ]; then
        n=$(( $(cat "$SHIM_PID_FILE.starts" 2>/dev/null || echo 0) + 1 ))
        echo "$n" >"$SHIM_PID_FILE.starts"
        if [ "$n" -gt "\${SHIM_BOOTSTRAP_LIMIT:-99}" ]; then exit 1; fi
        echo 4242 >"$SHIM_PID_FILE"
      fi ;;
    esac
    # Starting the helper: what it would write, once, as the copy just started.
    case "\${2:-}" in gui/*)
      if [ -n "\${SHIM_STARTS_WRITE:-}" ] && [ ! -e "$SHIM_STARTS_WRITE.done" ]; then
        mkdir -p "$(dirname "$SHIM_STARTS_WRITE")"
        printf '%s' "$SHIM_STARTS_BODY" >"$SHIM_STARTS_WRITE"
        : >"$SHIM_STARTS_WRITE.done"
      fi ;;
    esac ;;
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

// The digest extraction exists twice, once per installer: install.sh is bash and reads
// the JSON from a here-string, this one is POSIX sh and reads a file. Each is run from
// its own source over the same fixtures, so a fix made to one and not the other fails here.
describe("the digest extraction in install.sh and in install-macos.sh", () => {
  const INSTALL_SH = path.join(HERE, "..", "install.sh");
  /** A top-level shell function's text, found by name. */
  const functionText = (file: string, name: string): string => {
    const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m").exec(fs.readFileSync(file, "utf8"));
    assert.ok(m, `${name} is not defined at the top level of ${file}`);
    return m[0];
  };
  const NAME = "StageUtilityOutput-arm64.zip";
  const good = sha("the arm64 zip");
  const other = sha("another asset");
  /** `[label, release JSON, the digest both must print, or "" for none]`. */
  const record = (assets: object[]) =>
    JSON.stringify({ tag_name: "v9.9.9", name: "v9.9.9", uploader: { login: "bot" }, assets }, null, 2);
  const fixtures: [string, string, string][] = [
    ["the zip's own digest", record([{ name: NAME, digest: `sha256:${good}` }]), good],
    ["the zip after other assets", record([{ name: "stage-utility-9.9.9-linux-x64.tar.gz", digest: `sha256:${other}` }, { name: NAME, digest: `sha256:${good}` }]), good],
    ["a name that only begins with the zip's, first", record([{ name: `${NAME}.sha256`, digest: `sha256:${other}` }, { name: NAME, digest: `sha256:${good}` }]), good],
    ["only another architecture's asset", record([{ name: "StageUtilityOutput-x86_64.zip", digest: `sha256:${other}` }]), ""],
    ["the zip with no digest key, another's after it", record([{ name: NAME }, { name: "StageUtilityOutput-x86_64.zip", digest: `sha256:${other}` }]), ""],
    ["the zip with a null digest, another's after it", record([{ name: NAME, digest: null }, { name: "StageUtilityOutput-x86_64.zip", digest: `sha256:${other}` }]), ""],
    ["a digest of 63 digits", record([{ name: NAME, digest: `sha256:${good.slice(1)}` }]), ""],
    ["a digest of 65 digits", record([{ name: NAME, digest: `sha256:${good}0` }]), ""],
    ["a record on one line, not pretty-printed", JSON.stringify({ assets: [{ name: NAME, digest: `sha256:${good}` }] }), ""],
  ];

  const viaInstallSh = (json: string) =>
    spawnSync("bash", ["-c", `${functionText(INSTALL_SH, "release_digest")}\nrelease_digest "$NAME" "$JSON"`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", NAME, JSON: json } });
  const viaInstallMacos = (json: string) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "su-digest-")), "release.json");
    try {
      fs.writeFileSync(file, json);
      return spawnSync("sh", ["-c", `${functionText(SCRIPT, "digest_from_release")}\nZIP_NAME="$NAME"; digest_from_release "$FILE"`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", NAME, FILE: file } });
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  };

  for (const [label, json, want] of fixtures) {
    it(`both read ${want ? "the digest" : "no digest"} from ${label}`, () => {
      const a = viaInstallSh(json);
      const b = viaInstallMacos(json);
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);
      assert.equal(a.stdout.trim(), want, "install.sh");
      assert.equal(b.stdout.trim(), want, "install-macos.sh");
    });
  }
});

describe("--dry-run", () => {
  const server = { STAGE_SERVER: "http://192.0.2.10:8788", STAGE_INSTALL_TEST_UNAME_S: "Darwin", STAGE_INSTALL_TEST_OS_VERSION: "14.5", STAGE_INSTALL_TEST_CONSOLE_USER: ME };

  it("prints the helper's steps for each architecture, and changes nothing", async () => {
    for (const arch of ["arm64", "x86_64"]) {
      const r = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_UNAME_M: arch });
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, new RegExp(`this Mac: ${arch}`));
      assert.match(r.out, new RegExp(`download http://192\\.0\\.2\\.10:8788/kiosk/StageUtilityOutput-${arch}\\.zip, its \\.sha256 and its \\.sig`));
      assert.match(r.out, /download http:\/\/192\.0\.2\.10:8788\/kiosk\/release-signing\.pub\.pem, the key every download is verified against/);
      assert.match(r.out, /or whose signature is missing or does not verify/);
      assert.match(r.out, /GitHub release's StageUtilityOutput/);
      assert.match(r.out, /refuse a zip whose SHA-256 differs/);
      assert.match(r.out, /com\.stageutility\.output\.plist/);
      assert.match(r.out, /pmset -a displaysleep 0 sleep 0/);
      assert.match(r.out, /screen saver idle time 0/);
      assert.match(r.out, /automatic login/);
      assert.match(r.out, /Local Network prompt/);
      assert.match(r.out, /com\.stageutility\.output-updater\.plist, a LaunchDaemon that runs it with --check-update every five minutes/);
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

  it("picks arm64 on Apple silicon, native or under Rosetta, and x86_64 on an Intel Mac", async () => {
    // [what uname -m says, what sysctl hw.optional.arm64 prints, the architecture chosen]
    const cases: [string, string, string, string][] = [
      ["Apple silicon, native", "arm64", "1", "arm64"],
      ["Apple silicon, a shell under Rosetta (uname lies)", "x86_64", "1", "arm64"],
      ["Intel (the sysctl key does not exist)", "x86_64", "", "x86_64"],
      ["Intel (the key answers 0)", "x86_64", "0", "x86_64"],
      ["Apple silicon where the sysctl is missing, native uname", "arm64", "", "arm64"],
    ];
    for (const [label, uname, hw, want] of cases) {
      const r = await dryRun(scratch, [], { ...server, STAGE_INSTALL_TEST_UNAME_M: uname, STAGE_INSTALL_TEST_HW_ARM64: hw });
      assert.equal(r.status, 0, `${label}: ${r.err}`);
      assert.match(r.out, new RegExp(`this Mac: ${want}\\n`), label);
      assert.match(r.out, new RegExp(`StageUtilityOutput-${want}\\.zip and its`), label);
    }
  });

  it("asks the real sysctl when the test hook is not set", async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "su-sysctl-"));
    shimDirs.push(bin);
    const env = (script: string) => ({ ...server, STAGE_INSTALL_TEST_UNAME_M: "x86_64", STAGE_INSTALL_TEST_HW_ARM64: undefined as unknown as string, PATH: `${bin}:${process.env.PATH ?? ""}`, SYSCTL_SCRIPT: script });
    fs.writeFileSync(path.join(bin, "sysctl"), '#!/bin/sh\n[ "$1 $2" = "-n hw.optional.arm64" ] || exit 2\neval "$SYSCTL_SCRIPT"\n', { mode: 0o755 });
    const rosetta = await dryRun(scratch, [], env("echo 1"));
    assert.match(rosetta.out, /this Mac: arm64\n/, rosetta.err);
    const intel = await dryRun(scratch, [], env("echo \"sysctl: unknown oid 'hw.optional.arm64'\" >&2; exit 1"));
    assert.match(intel.out, /this Mac: x86_64\n/, intel.err);
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
    assert.match(r.err, /no server address to download from.*for this download only: sudo STAGE_DOWNLOAD_FROM=http/);
    assert.match(r.err, /STAGE_SERVER=http:\/\/<server> also works, but it pins this Mac to that server for good/);
  });

  it("downloads from STAGE_DOWNLOAD_FROM without pinning the Mac to it", async () => {
    const env = { STAGE_INSTALL_TEST_UNAME_S: "Darwin", STAGE_INSTALL_TEST_OS_VERSION: "14.5", STAGE_INSTALL_TEST_CONSOLE_USER: ME, STAGE_INSTALL_TEST_UNAME_M: "arm64" };
    const only = await dryRun(scratch, [], { ...env, STAGE_DOWNLOAD_FROM: "http://192.0.2.20:8788" });
    assert.equal(only.status, 0, only.err);
    assert.match(only.out, /download http:\/\/192\.0\.2\.20:8788\/kiosk\/StageUtilityOutput-arm64\.zip/);
    assert.doesNotMatch(only.out, /to .*\/server\b/, "STAGE_DOWNLOAD_FROM writes no server file");
    // STAGE_SERVER is the separate choice: it is written, and is the download source unless overridden.
    const both = await dryRun(scratch, [], { ...env, STAGE_DOWNLOAD_FROM: "http://192.0.2.20:8788", STAGE_SERVER: "http://192.0.2.10:8788" });
    assert.match(both.out, /download http:\/\/192\.0\.2\.20:8788\//);
    assert.match(both.out, /write http:\/\/192\.0\.2\.10:8788 to .*\/server/);
  });

  it("writes no server file for STAGE_DOWNLOAD_FROM, for real", { skip: !(has("uuidgen") && has("xxd")) && "needs uuidgen and xxd" }, async () => {
    const r = await sh(`. "${SCRIPT}"; DRY=0; CONSOLE_USER=""; write_state; printf 'origin=%s\\n' "$(server_origin)"`, {
      STAGE_INSTALL_SOURCED: "1",
      STAGE_INSTALL_TEST_ROOT: scratch,
      STAGE_DOWNLOAD_FROM: "http://192.0.2.20:8788",
      ...makeShims().env,
    });
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /origin=http:\/\/192\.0\.2\.20:8788\n/);
    assert.ok(!fs.existsSync(path.join(scratch, "Library", "Application Support", "StageUtility", "server")), "nothing pins the Mac");
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
function makeZip(dir: string, marker: string, version = "1.26.0", extra: (contents: string) => void = () => {}): { file: string; bytes: Buffer } {
  const app = path.join(dir, "build", "StageUtilityOutput.app", "Contents");
  fs.mkdirSync(path.join(app, "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Info.plist"),
    `<?xml version="1.0"?><plist><dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.stageutility.output</string>\n  <key>CFBundleShortVersionString</key><string>${version}</string>\n</dict></plist>\n`,
  );
  fs.writeFileSync(path.join(app, "MacOS", "StageUtilityOutput"), `#!/bin/sh\necho ${marker}\n`, { mode: 0o755 });
  extra(app);
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
    const r = routes.get(req.url ?? "") ?? routes.get((req.url ?? "").split("?")[0]);
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
    // Every install asks its server for the key first.
    stageServer.routes.set("/kiosk/release-signing.pub.pem", { body: KEY.publicPem });
    zipA = makeZip(scratch, "build-a");
    zipB = makeZip(scratch, "build-b");
  });

  /** The server's zip, its checksum and its release signature, and the key it hands an install. */
  const publish = (host: Fake, prefix: string, zip: { bytes: Buffer }, digest = sha(zip.bytes), sig = KEY.sign(zip.bytes)) => {
    host.routes.set(`${prefix}/StageUtilityOutput-arm64.zip`, { body: zip.bytes });
    host.routes.set(`${prefix}/StageUtilityOutput-arm64.zip.sha256`, { body: `${digest}  StageUtilityOutput-arm64.zip\n` });
    host.routes.set(`${prefix}/StageUtilityOutput-arm64.zip.sig`, { body: sig });
  };

  /** The GitHub release for `version`: the zip on the download host, and the release's JSON
   *  on the API host with each asset's digest. There is no .sha256 asset on a release.
   *  `assets` replaces the JSON's asset list, to publish a release with no digest or none. */
  const publishRelease = (version: string, zip: { bytes: Buffer }, digest = sha(zip.bytes), assets?: object[], sig = KEY.sign(zip.bytes)) => {
    github.routes.set(`/releases/v${version}/StageUtilityOutput-arm64.zip`, { body: zip.bytes });
    github.routes.set(`/releases/v${version}/StageUtilityOutput-arm64.zip.sig`, { body: sig });
    github.routes.set(`/api/releases/tags/v${version}`, {
      body: JSON.stringify({
        tag_name: `v${version}`,
        assets: assets ?? [
          { name: "StageUtilityOutput-arm64.zip", digest: `sha256:${digest}` },
          { name: "StageUtilityOutput-x86_64.zip", digest: `sha256:${sha("the other architecture")}` },
        ],
      }, null, 2),
    });
  };

  const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    STAGE_INSTALL_SOURCED: "1",
    STAGE_INSTALL_TEST_ROOT: scratch,
    STAGE_INSTALL_TEST_UNAME_M: "arm64",
    STAGE_INSTALL_GITHUB_BASE: `${github.base}/releases`,
    STAGE_INSTALL_GITHUB_API: `${github.base}/api/releases/tags`,
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
    publishRelease("9.9.9", zipA, sha("also wrong"));
    const r = await install(FLOW);
    assert.equal(r.status, 1, r.out + r.err);
    assert.match(r.err, /did not match the release's SHA-256/);
    assert.ok(!fs.existsSync(app()), "a refused download must not become the app");
    assert.deepEqual(fs.existsSync(path.join(scratch, "Applications")) ? leftovers() : [], []);
  });

  it("refuses a checksum file that is not exactly one SHA-256 digest, before it asks for the zip", async () => {
    const good = sha(zipA.bytes);
    for (const [label, body] of [
      ["empty", ""],
      ["63 digits", `${good.slice(1)}  x.zip\n`],
      ["65 digits", `${good}0  x.zip\n`],
      ["a non-hex digit", `${good.slice(0, 63)}g  x.zip\n`],
      ["an HTML error page", "<html>502 Bad Gateway</html>"],
    ] as const) {
      stageServer.hits.length = 0;
      publish(stageServer, "/kiosk", zipA);
      stageServer.routes.set("/kiosk/StageUtilityOutput-arm64.zip.sha256", { body });
      const r = await install(FLOW);
      assert.equal(r.status, 1, label);
      assert.match(r.err, /the checksum is not a SHA-256 digest/, label);
      assert.ok(!stageServer.hits.includes("/kiosk/StageUtilityOutput-arm64.zip"), `${label}: the zip must not be downloaded`);
      assert.ok(!fs.existsSync(app()), label);
    }
  });

  it("falls back to the GitHub release for the server's version, and verifies that too", async () => {
    stageServer.routes.set("/kiosk/StageUtilityOutput-arm64.zip.sha256", {
      status: 404,
      body: JSON.stringify({ error: "v9.9.9 of StageUtilityOutput-arm64.zip.sha256 is not in the cache and could not be fetched: no route" }),
    });
    stageServer.routes.set("/api/update/status", { body: '{"tracks":["main","beta"],"version":"9.9.9"}' });
    publishRelease("9.9.9", zipB);
    const r = await install(`${FLOW}; FINISHED=1`);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /the checksum answered 404: v9\.9\.9 of .* is not in the cache and could not be fetched: no route/, "the server's own reason is shown");
    assert.match(r.out, /downloading StageUtilityOutput-arm64\.zip from the GitHub release v9\.9\.9/);
    assert.match(r.out, new RegExp(`verified SHA-256 ${sha(zipB.bytes)}`), "the digest is the one the release's JSON lists for this architecture");
    assert.equal(marker(), "build-b");
    assert.ok(github.hits.some((h) => h.endsWith("/v9.9.9/StageUtilityOutput-arm64.zip")));
    assert.ok(github.hits.includes("/api/releases/tags/v9.9.9"), "the digest is read from the releases API");
    assert.ok(!github.hits.some((h) => h.endsWith(".sha256")), "a release has no .sha256 asset to ask for");
  });

  describe("the GitHub release's digest", () => {
    /** The server cannot help, so the GitHub release is what the install rests on. */
    const viaGithub = () => stageServer.routes.set("/api/update/status", { body: '{"version":"9.9.9"}' });
    const ARM = "StageUtilityOutput-arm64.zip";
    const X86 = "StageUtilityOutput-x86_64.zip";
    const noSha = /the GitHub release v9\.9\.9: the release record lists no SHA-256 for StageUtilityOutput-arm64\.zip \(the release may predate GitHub's asset digests, which began in 2025, or the record is not in the form this installer reads\)/;

    // Each of these leaves the installer with no digest it may trust for the arm64 zip.
    // The first two are the ones a loose extraction gets wrong: it takes the NEXT asset's.
    const cases: [string, (good: string) => object[]][] = [
      ["lists the zip with no digest key, and another asset's digest after it", (good) => [{ name: ARM }, { name: X86, digest: `sha256:${good}` }]],
      ["lists the zip with a null digest, and another asset's digest after it", (good) => [{ name: ARM, digest: null }, { name: X86, digest: `sha256:${good}` }]],
      ["lists only another architecture's asset", (good) => [{ name: X86, digest: `sha256:${good}` }]],
      ["lists the zip with a digest of 63 hex digits", (good) => [{ name: ARM, digest: `sha256:${good.slice(1)}` }]],
      ["lists the zip with another algorithm's digest", (good) => [{ name: ARM, digest: `sha1:${good}` }]],
    ];
    for (const [label, assets] of cases) {
      it(`is refused, with the reason, when the release ${label}`, async () => {
        viaGithub();
        publishRelease("9.9.9", zipB, undefined, assets(sha(zipB.bytes)));
        const r = await install(FLOW);
        assert.equal(r.status, 1, r.out + r.err);
        assert.match(r.err, noSha);
        assert.ok(!github.hits.some((h) => h.endsWith(".zip")), "an unverifiable zip must not even be downloaded");
        assert.ok(!fs.existsSync(app()));
      });
    }

    it("is the zip's own, though an asset whose name only begins with the zip's comes first", async () => {
      viaGithub();
      publishRelease("9.9.9", zipB, undefined, [
        { name: `${ARM}.sha256`, digest: `sha256:${sha("a checksum file's hash")}` },
        { name: ARM, digest: `sha256:${sha(zipB.bytes)}` },
      ]);
      const r = await install(`${FLOW}; FINISHED=1`);
      assert.equal(r.status, 0, r.out + r.err);
      assert.match(r.out, new RegExp(`verified SHA-256 ${sha(zipB.bytes)}`));
      assert.equal(marker(), "build-b");
    });

    it("is refused when the zip does not match it, and installs nothing", async () => {
      viaGithub();
      publishRelease("9.9.9", zipB, sha("not this zip"));
      const r = await install(FLOW);
      assert.equal(r.status, 1, r.out + r.err);
      assert.match(r.err, /the GitHub release v9\.9\.9: the download did not match the release's SHA-256/);
      assert.ok(!fs.existsSync(app()));
    });

    for (const status of [403, 429]) {
      it(`says GitHub may have rate-limited this network when the release record answers ${status}`, async () => {
        viaGithub();
        github.routes.set("/api/releases/tags/v9.9.9", { status, body: '{"message":"API rate limit exceeded"}' });
        const r = await install(FLOW);
        assert.equal(r.status, 1, r.out + r.err);
        assert.match(r.err, new RegExp(`the GitHub release v9\\.9\\.9: the release record answered ${status}.* \\(GitHub may have rate-limited this network: 60 requests an hour without a token\\)`));
        assert.ok(!fs.existsSync(app()));
      });
    }

    it("says nothing about a rate limit for a 404", async () => {
      viaGithub();
      const r = await install(FLOW);
      assert.equal(r.status, 1, r.out + r.err);
      assert.match(r.err, /the release record answered 404/);
      assert.doesNotMatch(r.err, /rate-limited/);
    });
  });

  describe("how long a zip download may take", () => {
    /** A `curl` that records its arguments, one call a line, and then runs the real one. */
    const spyOnCurl = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "su-curl-"));
      shimDirs.push(dir);
      const real = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
      const log = path.join(dir, "curl.log");
      fs.writeFileSync(log, "");
      fs.writeFileSync(path.join(dir, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
      return { env: { PATH: `${dir}:${process.env.PATH ?? ""}` }, zipCalls: () => fs.readFileSync(log, "utf8").split("\n").filter((l) => /\.zip(\s|$)/.test(l)) };
    };

    it("the server's zip has a ceiling of 2 h 10 m and no idle limit, since a cold server sends nothing while it fetches", async () => {
      publish(stageServer, "/kiosk", zipA);
      const spy = spyOnCurl();
      const r = await install(`${FLOW}; FINISHED=1`, spy.env);
      assert.equal(r.status, 0, r.out + r.err);
      const calls = spy.zipCalls();
      assert.equal(calls.length, 1, calls.join("\n"));
      assert.match(calls[0], /--max-time 7800 /);
      assert.doesNotMatch(calls[0], /--speed-/, "an idle limit would cut off a server still fetching the zip from GitHub");
    });

    it("the GitHub zip gives up after a minute under 1 KB/s, with the same ceiling", async () => {
      stageServer.routes.set("/api/update/status", { body: '{"version":"9.9.9"}' });
      publishRelease("9.9.9", zipB);
      const spy = spyOnCurl();
      const r = await install(`${FLOW}; FINISHED=1`, spy.env);
      assert.equal(r.status, 0, r.out + r.err);
      const calls = spy.zipCalls().filter((c) => c.includes(github.base));
      assert.equal(calls.length, 1, spy.zipCalls().join("\n"));
      assert.match(calls[0], /--max-time 7800 --speed-time 60 --speed-limit 1024 /);
    });
  });

  describe("the release's signature", () => {
    const viaGithub = () => stageServer.routes.set("/api/update/status", { body: '{"version":"9.9.9"}' });

    it("is verified with the server's key, and said to be valid", async () => {
      publish(stageServer, "/kiosk", zipA);
      const r = await install(`${FLOW}; FINISHED=1`);
      assert.equal(r.status, 0, r.out + r.err);
      assert.match(r.out, new RegExp(`signature valid: StageUtilityOutput-arm64\\.zip\\.sig, against the release signing key from ${stageServer.base.replace(/\./g, "\\.")}`));
      assert.ok(stageServer.hits.includes("/kiosk/release-signing.pub.pem"));
      assert.ok(stageServer.hits.includes("/kiosk/StageUtilityOutput-arm64.zip.sig"));
    });

    it("is refused when missing, from the server and from GitHub, and nothing is installed", async () => {
      publish(stageServer, "/kiosk", zipA);
      stageServer.routes.delete("/kiosk/StageUtilityOutput-arm64.zip.sig");
      viaGithub();
      publishRelease("9.9.9", zipA);
      github.routes.delete("/releases/v9.9.9/StageUtilityOutput-arm64.zip.sig");
      const r = await install(FLOW);
      assert.equal(r.status, 1, r.out + r.err);
      assert.match(r.err, /this server \(.*\): signature missing: StageUtilityOutput-arm64\.zip\.sig answered 404: unknown, and nothing is installed unsigned/);
      assert.match(r.err, /the GitHub release v9\.9\.9: signature missing: StageUtilityOutput-arm64\.zip\.sig answered 404: unknown, and nothing is installed unsigned/);
      assert.ok(!fs.existsSync(app()));
      assert.deepEqual(fs.existsSync(path.join(scratch, "Applications")) ? leftovers() : [], []);
    });

    for (const [label, bad] of [
      ["made by another key", () => OTHER_KEY.sign(zipA.bytes)],
      ["of other bytes", () => KEY.sign(Buffer.from("another zip"))],
      ["that is not a signature at all", () => Buffer.from("<html>502 Bad Gateway</html>")],
    ] as const) {
      it(`is refused when it is one ${label}, though the zip matches its SHA-256`, async () => {
        publish(stageServer, "/kiosk", zipA, undefined, bad());
        const r = await install(FLOW);
        assert.equal(r.status, 1, r.out + r.err);
        assert.match(r.out, new RegExp(`verified SHA-256 ${sha(zipA.bytes)}`), "the checksum alone passed");
        assert.match(r.err, /this server \(.*\): signature invalid: StageUtilityOutput-arm64\.zip\.sig does not verify against the release signing key from /);
        assert.ok(!fs.existsSync(app()));
      });
    }

    it("from GitHub is verified too, when the server's is not good", async () => {
      publish(stageServer, "/kiosk", zipA, undefined, OTHER_KEY.sign(zipA.bytes));
      viaGithub();
      publishRelease("9.9.9", zipB);
      const r = await install(`${FLOW}; FINISHED=1`);
      assert.equal(r.status, 0, r.out + r.err);
      assert.match(r.out, /this server \(.*\): signature invalid/);
      assert.match(r.out, /signature valid: StageUtilityOutput-arm64\.zip\.sig/);
      assert.ok(github.hits.includes("/releases/v9.9.9/StageUtilityOutput-arm64.zip.sig"));
      assert.equal(marker(), "build-b");
    });

    it("from GitHub is refused when it does not verify", async () => {
      stageServer.routes.set("/kiosk/StageUtilityOutput-arm64.zip.sha256", { status: 404, body: '{"error":"not cached"}' });
      viaGithub();
      publishRelease("9.9.9", zipB, undefined, undefined, OTHER_KEY.sign(zipB.bytes));
      const r = await install(FLOW);
      assert.equal(r.status, 1, r.out + r.err);
      assert.match(r.err, /the GitHub release v9\.9\.9: signature invalid: StageUtilityOutput-arm64\.zip\.sig does not verify/);
      assert.ok(!fs.existsSync(app()));
    });

    for (const [label, route, why] of [
      ["the server has no usable key", { status: 500, body: '{"error":"this build has no usable release signing key"}' }, /could not get the release signing key: .*\/kiosk\/release-signing\.pub\.pem answered 500: this build has no usable release signing key\. Every download is checked against it, so nothing was installed\./],
      ["what the server sends is not a key", { body: "PLACEHOLDER" }, /the release signing key from .* is not a 3072-bit RSA public key \/usr\/bin\/openssl can read, so nothing was installed\./],
      ["what the server sends is a 2048-bit key", { body: testSigningKey(2048).publicPem }, /is not a 3072-bit RSA public key/],
      ["what the server sends is an Ed25519 key", { body: crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString() }, /is not a 3072-bit RSA public key/],
    ] as const) {
      it(`stops before downloading anything when ${label}`, async () => {
        publish(stageServer, "/kiosk", zipA);
        stageServer.routes.set("/kiosk/release-signing.pub.pem", route);
        const r = await install(FLOW);
        assert.equal(r.status, 1, r.out + r.err);
        assert.match(r.err, why);
        assert.ok(!stageServer.hits.some((h) => h.includes(".zip")), "nothing is downloaded without a key to check it");
        assert.ok(!fs.existsSync(app()));
      });
    }
  });

  it("names both reasons when neither source works", async () => {
    stageServer.routes.set("/api/update/status", { body: '{"version":"9.9.9"}' });
    const r = await install(FLOW);
    assert.equal(r.status, 1);
    assert.match(r.err, /could not get the helper\. this server \(.*\): the checksum answered 404/);
    assert.match(r.err, /the GitHub release v9\.9\.9: the release record answered 404/);
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

  it("refuses an app whose executable is not executable", async () => {
    const dir = path.join(scratch, "noexec");
    const contents = path.join(dir, "StageUtilityOutput.app", "Contents");
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(contents, "Info.plist"), "<plist><dict>\n<key>CFBundleIdentifier</key>\n<string>com.stageutility.output</string>\n</dict></plist>");
    fs.writeFileSync(path.join(contents, "MacOS", "StageUtilityOutput"), "#!/bin/sh\n", { mode: 0o644 });
    const z = path.join(scratch, "noexec.zip");
    assert.equal(spawnSync("zip", ["-qr", z, "StageUtilityOutput.app"], { cwd: dir }).status, 0);
    publish(stageServer, "/kiosk", { bytes: fs.readFileSync(z) });
    const r = await install(FLOW);
    assert.equal(r.status, 1, r.out + r.err);
    assert.match(r.err, /holds no runnable StageUtilityOutput/);
    assert.ok(!fs.existsSync(app()), "a helper that cannot run must not replace anything");
  });

  it("downloads from the address the server stamped into the script, when nothing else names one", async () => {
    // The server replaces the FETCHED_FROM="" line with its own address. A stamped
    // copy is made the same way here and the real fetch is run from it.
    publish(stageServer, "/kiosk", zipA);
    const stamped = path.join(scratch, "install-macos.stamped.sh");
    const src = fs.readFileSync(SCRIPT, "utf8");
    assert.ok(src.split("\n").includes('FETCHED_FROM=""'));
    fs.writeFileSync(stamped, src.replace('\nFETCHED_FROM=""\n', `\nFETCHED_FROM="${stageServer.base}"\n`));
    const r = await sh(`. "${stamped}"; trap on_exit EXIT; WORK="$(mktemp -d)"; ${FLOW}; FINISHED=1`, { ...baseEnv(), STAGE_SERVER: "" });
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(r.out.includes(`from this server (${stageServer.base})`), r.out);
    assert.equal(marker(), "build-a");
    // and an unstamped copy, with no server file either, has nowhere to go
    const bare = await sh(`. "${SCRIPT}"; trap on_exit EXIT; WORK="$(mktemp -d)"; ${FLOW}`, { ...baseEnv(), STAGE_SERVER: "" });
    assert.equal(bare.status, 1);
    assert.match(bare.err, /no server address to download from/);
  });

  it("clears a set-user-id or set-group-id bit in what it unpacked, since root unpacks it", async () => {
    // Straight on a folder: ditto keeps the bit only when root runs it, so through a
    // zip a test here would never see one to clear.
    const dir = path.join(scratch, "unpacked", "StageUtilityOutput.app", "Contents", "MacOS");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "suid"), "#!/bin/sh\n");
    fs.chmodSync(path.join(dir, "suid"), 0o4755);
    fs.writeFileSync(path.join(dir, "sgid"), "#!/bin/sh\n");
    fs.chmodSync(path.join(dir, "sgid"), 0o2755);
    assert.equal(fs.statSync(path.join(dir, "suid")).mode & 0o4000, 0o4000, "this filesystem keeps the bit, so the check below means something");
    const r = await sh(`. "${SCRIPT}"; clear_setid "$1"`, { STAGE_INSTALL_SOURCED: "1" }, [path.join(scratch, "unpacked")]);
    assert.equal(r.status, 0, r.out + r.err);
    for (const f of ["suid", "sgid"]) {
      const mode = fs.statSync(path.join(dir, f)).mode;
      assert.equal(mode & 0o6000, 0, `${f}: mode ${mode.toString(8)}`);
      assert.equal(mode & 0o777, 0o755, `${f}: the rest of its mode is kept`);
    }
  });

  it("clears that bit in every app it stages", async () => {
    // Through stage_app itself, with the unpack replaced by a copy of a prepared
    // tree, since ditto would not keep the bit for a test to find.
    const tree = path.join(scratch, "prepared");
    fs.mkdirSync(path.join(tree, "StageUtilityOutput.app", "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(tree, "StageUtilityOutput.app", "Contents", "Info.plist"), "<plist><dict>\n<key>CFBundleIdentifier</key>\n<string>com.stageutility.output</string>\n</dict></plist>");
    fs.writeFileSync(path.join(tree, "StageUtilityOutput.app", "Contents", "MacOS", "StageUtilityOutput"), "#!/bin/sh\n", { mode: 0o4755 });
    fs.chmodSync(path.join(tree, "StageUtilityOutput.app", "Contents", "MacOS", "StageUtilityOutput"), 0o4755);
    publish(stageServer, "/kiosk", zipA);
    const r = await install(`detect_arch; fetch_helper; unpack_zip() { cp -Rp "${tree}/." "$2/"; }; stage_app; find "$STAGING" -perm -4000 | wc -l | tr -d ' '`);
    assert.equal(r.out.trim().split("\n").at(-1), "0", r.out + r.err);
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

    const marker2 = () => fs.readFileSync(path.join(app(), "Contents", "MacOS", "StageUtilityOutput"), "utf8").trim().split(" ")[1];

    let shims: ReturnType<typeof makeShims>;
    beforeEach(() => {
      shims = makeShims();
    });

    /** install_helper itself, as main() calls it, as the console user `who` ("none" for nobody). */
    const whole = (who: string, extra: Record<string, string> = {}, before = "") =>
      sh(`. "${SCRIPT}"; trap on_exit EXIT; ${before || ":"}; install_helper`, baseEnv({ ...shims.env, SHIM_MARKER: marker(), STAGE_INSTALL_TEST_CONSOLE_USER: who, ...extra }));

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

    describe("a failure after the swap leaves the Mac exactly as it was", () => {
      const noCalls = (l: string[]) => l.map((c) => c.replace(/ \| marker=.*/, ""));

      it("an upgrade that fails in the agent step brings back the old app, its agent file and the running helper", async () => {
        publish(stageServer, "/kiosk", zipA);
        assert.equal((await whole(ME)).status, 0);
        const plistBefore = fs.readFileSync(helperPlist(), "utf8");
        fs.appendFileSync(helperPlist(), "<!-- the previous agent file -->\n");
        const edited = fs.readFileSync(helperPlist(), "utf8");
        assert.notEqual(edited, plistBefore);
        const uid = (await sh("id -u")).out.trim();

        publish(stageServer, "/kiosk", zipB);
        const before = shims.log().length;
        // launchctl print answering 0 means the helper is running, so it is stopped first.
        const r = await whole(ME, { SHIM_PRINT_RC: "0", SHIM_FAIL_plutil: "1" });
        assert.equal(r.status, 1, r.out + r.err);
        assert.match(r.err, /is not a valid property list/);

        assert.equal(marker2(), "build-a", "the previous app is the app again");
        assert.deepEqual(leftovers(), [], "no .StageUtilityOutput.app.old.* or .new.* is left in /Applications");
        assert.equal(fs.readFileSync(helperPlist(), "utf8"), edited, "the previous agent file is back, byte for byte");
        const calls = noCalls(shims.log().slice(before)).filter((c) => c.startsWith("launchctl") && !c.startsWith("launchctl print"));
        assert.deepEqual(calls, [`launchctl bootout gui/${uid}/com.stageutility.output`, `launchctl bootstrap gui/${uid} ${helperPlist()}`], "the helper was stopped, then started again from the restored file");
        assert.match(r.out, /restored the previous StageUtilityOutput\.app/);
      });

      it("on a Mac with no helper yet, a failure after the swap removes the new app and the agent file", async () => {
        publish(stageServer, "/kiosk", zipA);
        // An exit nobody wrapped: write_helper_plist returning 1 is a bare `set -e` exit.
        const r = await whole(ME, {}, "write_helper_plist() { return 1; }");
        assert.equal(r.status, 1, r.out + r.err);
        assert.ok(!fs.existsSync(app()), "the helper that was just swapped in is gone");
        assert.deepEqual(leftovers(), []);
        assert.ok(!fs.existsSync(helperPlist()));
        assert.match(r.out, /removed the StageUtilityOutput\.app that was just installed/);
        assert.deepEqual(noCalls(shims.log()).filter((c) => c.startsWith("launchctl bootstrap")), [], "nothing was started");
      });

      it("a successful upgrade removes the old copy", async () => {
        publish(stageServer, "/kiosk", zipA);
        assert.equal((await whole(ME)).status, 0);
        publish(stageServer, "/kiosk", zipB);
        const r = await whole(ME);
        assert.equal(r.status, 0, r.out + r.err);
        assert.equal(marker2(), "build-b");
        assert.deepEqual(leftovers(), []);
      });
    });

    describe("the updater it installs after the helper", () => {
      const updaterDir = () => path.join(scratch, "Library", "Application Support", "StageUtilityUpdater");
      const daemon = () => path.join(scratch, "Library", "LaunchDaemons", "com.stageutility.output-updater.plist");

      it("copies this installer into a root-owned folder, remembers the server, and starts a daemon that runs it every five minutes", async () => {
        publish(stageServer, "/kiosk", zipA);
        const script = fs.readFileSync(SCRIPT);
        stageServer.routes.set("/kiosk/install-macos.sh", { body: script });
        const r = await whole(ME);
        assert.equal(r.status, 0, r.out + r.err);
        assert.ok(fs.readFileSync(path.join(updaterDir(), "install-macos.sh")).equals(script), "the copy is the installer, byte for byte");
        assert.equal(fs.statSync(path.join(updaterDir(), "install-macos.sh")).mode & 0o777, 0o755);
        assert.equal(fs.readFileSync(path.join(updaterDir(), "server"), "utf8"), `${stageServer.base}\n`);
        // The key the install verified the app with, which every update is checked against.
        assert.equal(fs.readFileSync(path.join(updaterDir(), "release-signing.pub.pem"), "utf8"), KEY.publicPem);
        assert.equal(fs.statSync(path.join(updaterDir(), "release-signing.pub.pem")).mode & 0o777, 0o644);
        const plist = fs.readFileSync(daemon(), "utf8");
        assert.match(plist, /<key>Label<\/key><string>com\.stageutility\.output-updater<\/string>/);
        assert.match(plist, /<string>\/bin\/sh<\/string><string>\/Library\/Application Support\/StageUtilityUpdater\/install-macos\.sh<\/string><string>--check-update<\/string>/);
        assert.match(plist, /<key>StartInterval<\/key><integer>300<\/integer>/);
        assert.match(plist, /<key>StandardErrorPath<\/key><string>\/Library\/Logs\/StageUtility\/helper-update\.log<\/string>/);
        const calls = shims.log().map((l) => l.replace(/ \| marker=.*/, ""));
        assert.ok(calls.includes(`chown root:wheel ${updaterDir()}`), calls.join("\n"));
        assert.ok(calls.includes(`chown root:wheel ${daemon()}`), calls.join("\n"));
        assert.ok(calls.includes(`launchctl bootstrap system ${daemon()}`), calls.join("\n"));
        // Root's own copies: the state folder is the console user's to rewrite.
        assert.equal(fs.readFileSync(path.join(updaterDir(), "device-id"), "utf8"), fs.readFileSync(path.join(stateDir(), "device-id"), "utf8"));
        assert.match(r.out, /every five minutes whether to update, and never/);
      });

      it("says plainly when it cannot, and leaves the helper installed", async () => {
        publish(stageServer, "/kiosk", zipA);
        // No /kiosk/install-macos.sh on this server: there is nothing to copy.
        const r = await whole(ME);
        assert.equal(r.status, 0, r.out + r.err);
        assert.ok(fs.existsSync(app()));
        assert.match(r.err, /automatic updates are NOT installed: could not put a copy of this installer/);
        assert.ok(!fs.existsSync(daemon()));
        assert.ok(!shims.log().some((l) => l.startsWith("launchctl bootstrap system")));
      });

      it("refuses a copy that is not this installer", async () => {
        publish(stageServer, "/kiosk", zipA);
        stageServer.routes.set("/kiosk/install-macos.sh", { body: "#!/bin/sh\necho something else\n" });
        const r = await whole(ME);
        assert.equal(r.status, 0, r.out + r.err);
        assert.match(r.err, /automatic updates are NOT installed/);
        assert.ok(!fs.existsSync(path.join(updaterDir(), "install-macos.sh")));
        assert.ok(!fs.existsSync(path.join(updaterDir(), "install-macos.sh.new")));
      });
    });

    it("--browser on a Mac that has the helper tells how to remove all of it: the agent, its plist and the app", async () => {
      fs.mkdirSync(app(), { recursive: true });
      const r = await sh(`. "${SCRIPT}"; trap on_exit EXIT; install_browser`, baseEnv({ ...shims.env, SHIM_MARKER: marker(), STAGE_INSTALL_TEST_CONSOLE_USER: ME }));
      assert.equal(r.status, 0, r.out + r.err);
      assert.match(r.out, /the Stage Utility Output helper is still installed/);
      const lines = r.out.split("\n").map((l) => l.trim());
      assert.ok(lines.includes("launchctl bootout gui/<uid>/com.stageutility.output"), r.out);
      assert.ok(lines.includes(`rm -f "${helperPlist()}"`), `the system-wide agent file is removed, or the helper starts at the next login anyway: ${r.out}`);
      assert.ok(lines.includes(`rm -rf "${app()}"`), r.out);
    });

    describe("moving off the Chrome kiosk", () => {
      const strip = (l: string[]) => l.map((c) => c.replace(/ \| marker=.*/, ""));

      it("writes the marker before the helper is stopped, installed or started, and removes the kiosk's agent only after", async () => {
        seedKiosk();
        publish(stageServer, "/kiosk", zipA);
        const uid = (await sh("id -u")).out.trim();
        // print answering 0: the helper and the kiosk both look loaded, so both are bootout'd.
        const r = await whole(ME, { SHIM_PRINT_RC: "0" });
        assert.equal(r.status, 0, r.out + r.err);

        // The helper's and the kiosk's; the updater, installed last, is tested on its own.
        const changes = shims.log().filter((l) => /^(launchctl (bootout|bootstrap)|chown root:wheel)/.test(l) && !/StageUtilityUpdater|output-updater|LaunchDaemons/.test(l));
        // Every launchd change to the helper happened with the marker already on disk.
        for (const line of changes) assert.match(line, /\| marker=yes$/, `the marker must exist before: ${line}`);
        assert.deepEqual(
          strip(changes),
          [
            `launchctl bootout gui/${uid}/com.stageutility.output`,
            `chown root:wheel ${helperPlist()}`,
            `launchctl bootstrap gui/${uid} ${helperPlist()}`,
            `launchctl bootout gui/${uid}/com.stageutility.kiosk`,
          ],
          "the helper is stopped, its agent file made root's, the helper started, and only then the kiosk stopped",
        );
        assert.ok(fs.existsSync(marker()));
        assert.ok(!fs.existsSync(kioskPlist()));
      });

      it("does not touch anything when the marker cannot be written", async () => {
        publish(stageServer, "/kiosk", zipA);
        assert.equal((await whole(ME)).status, 0);
        const plistBefore = fs.readFileSync(helperPlist(), "utf8");
        const sinceFirst = shims.log().length;

        seedKiosk();
        fs.mkdirSync(marker(), { recursive: true }); // a directory where the file goes: the write fails
        publish(stageServer, "/kiosk", zipB);
        const r = await whole(ME, { SHIM_PRINT_RC: "0" });
        assert.equal(r.status, 1, r.out + r.err);
        assert.match(r.err, /could not write .*migrated-from-kiosk; nothing else was changed, and the Chrome kiosk is as it was\. The device id and token already written are kept\./);

        assert.equal(marker2(), "build-a", "the installed app is untouched");
        assert.ok(fs.existsSync(path.join(stateDir(), "device-id")) && fs.existsSync(path.join(stateDir(), "token")), "the identity files are kept, which is what the message says");
        assert.deepEqual(leftovers(), []);
        assert.equal(fs.readFileSync(helperPlist(), "utf8"), plistBefore);
        assert.ok(fs.existsSync(kioskPlist()), "the Chrome kiosk is still there");
        const changes = strip(shims.log().slice(sinceFirst)).filter((c) => /^(launchctl (bootout|bootstrap)|chown root)/.test(c));
        assert.deepEqual(changes, [], "no agent was stopped, started or rewritten");
      });

      it("takes the marker back, and keeps the kiosk, when the install fails after writing it", async () => {
        seedKiosk();
        publish(stageServer, "/kiosk", zipA);
        const r = await whole(ME, {}, "write_helper_plist() { return 1; }");
        assert.equal(r.status, 1, r.out + r.err);
        assert.ok(!fs.existsSync(marker()), "a marker for a migration that did not happen would be a lie");
        assert.ok(fs.existsSync(kioskPlist()));
        assert.ok(fs.existsSync(path.join(scratch, "usr", "local", "bin", "stage-utility-kiosk")));
        assert.ok(!fs.existsSync(app()));
      });

      it("keeps an earlier marker as it was", async () => {
        seedKiosk();
        fs.mkdirSync(stateDir(), { recursive: true });
        fs.writeFileSync(marker(), "earlier\n");
        publish(stageServer, "/kiosk", zipA);
        const r = await whole(ME);
        assert.equal(r.status, 0, r.out + r.err);
        assert.equal(fs.readFileSync(marker(), "utf8"), "earlier\n");
      });

      it("puts the kiosk's files back, and starts it again, if removing them fails", { skip: process.getuid?.() === 0 && "root ignores a read-only directory" }, async () => {
        publish(stageServer, "/kiosk", zipA);
        assert.equal((await whole(ME)).status, 0);
        seedKiosk();
        publish(stageServer, "/kiosk", zipB);
        const uid = (await sh("id -u")).out.trim();
        // The agents directory is read-only, so the kiosk's agent file cannot be removed.
        // The helper's plist already exists and can still be rewritten in place.
        const since = shims.log().length;
        fs.chmodSync(agents(), 0o555);
        try {
          const r = await whole(ME, { SHIM_PRINT_RC: "0" });
          assert.equal(r.status, 1, r.out + r.err);
          assert.match(r.err, /could not remove/);
          assert.equal(marker2(), "build-a", "the helper is rolled back too");
        } finally {
          fs.chmodSync(agents(), 0o755);
        }
        assert.ok(fs.existsSync(kioskPlist()));
        assert.ok(fs.existsSync(path.join(scratch, "usr", "local", "bin", "stage-utility-kiosk")));
        const calls = strip(shims.log().slice(since));
        assert.ok(calls.lastIndexOf(`launchctl bootstrap gui/${uid} ${kioskPlist()}`) > calls.indexOf(`launchctl bootout gui/${uid}/com.stageutility.kiosk`), calls.join("\n"));
      });
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

// ── --check-update: the updater the install leaves behind ─────────────────
// The real function, against a fake server, with launchctl stubbed. launchctl's
// stand-in answers `print` with SHIM_PRINT_OUT (a pid, or nothing for a helper that
// is not running) and, on the first `bootstrap` into a GUI session, writes what a
// starting helper would write to its status file: that is the new helper starting.
describe("--check-update", { skip: !(has("zip") && has("unzip") && has("uuidgen") && has("xxd")) && "needs zip, unzip, uuidgen and xxd" }, () => {
  let server: Fake;
  let shims: ReturnType<typeof makeShims>;
  let old: { file: string; bytes: Buffer };
  let next: { file: string; bytes: Buffer };
  const MACHINE = "5f1c09ab-7e22-4c1d-9b04-e6c1aa000001";
  const home = () => path.join(scratch, "Users", ME);
  const statusFile = () => path.join(home(), "Library", "Application Support", "StageUtilityOutput", "helper-status.json");
  const app = () => path.join(scratch, "Applications", "StageUtilityOutput.app");
  const which = () => fs.readFileSync(path.join(app(), "Contents", "MacOS", "StageUtilityOutput"), "utf8").trim().split(" ")[1];
  const updaterStatus = () => fs.readFileSync(path.join(scratch, "Library", "Application Support", "StageUtilityUpdater", "status"), "utf8");
  const leftovers = () => fs.readdirSync(path.join(scratch, "Applications")).filter((n) => n !== "StageUtilityOutput.app");
  const checks = () => server.hits.filter((h) => h.startsWith("/api/machine-updates/check?")).map((h) => new URL(h, "http://x").searchParams);
  const answer = (o: Record<string, unknown>) => server.routes.set("/api/machine-updates/check", { body: JSON.stringify({ version: "1.27.0", update: false, reason: "Helper 1.26.0, the same as this server", ...o }) });
  const started = (o: Record<string, unknown> = {}) => JSON.stringify({ chromium: "started", localNetworkRefused: false, pid: 4242, version: "1.27.0", ...o });
  let uid = "";

  before(async () => {
    server = await fakeHost();
    uid = (await sh("id -u")).out.trim();
  });
  after(async () => {
    await new Promise((r) => server.server.close(r));
  });
  beforeEach(() => {
    server.routes.clear();
    server.hits.length = 0;
    shims = makeShims();
    old = makeZip(scratch, "build-old", "1.26.0");
    next = makeZip(scratch, "build-new", "1.27.0");
    // An installed helper on 1.26.0, a device id, and the server it came from.
    const state = path.join(scratch, "Library", "Application Support", "StageUtility");
    fs.mkdirSync(state, { recursive: true });
    // The state folder is the console user's: what is in it there is theirs to
    // write, so the updater sends the id copied into its own folder at install.
    fs.writeFileSync(path.join(state, "device-id"), "planted-by-the-user\n");
    fs.mkdirSync(path.join(scratch, "Applications"), { recursive: true });
    // unzip, not ditto: this suite runs on Linux in CI, which has no ditto.
    const unpacked = spawnSync("unzip", ["-q", old.file, "-d", path.join(scratch, "Applications")], { encoding: "utf8" });
    assert.equal(unpacked.status, 0, unpacked.stderr);
    const updater = path.join(scratch, "Library", "Application Support", "StageUtilityUpdater");
    fs.mkdirSync(updater, { recursive: true });
    fs.writeFileSync(path.join(updater, "server"), `${server.base}\n`);
    fs.writeFileSync(path.join(updater, "device-id"), `${MACHINE}\n`);
    fs.mkdirSync(path.join(scratch, "Library", "LaunchAgents"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "Library", "LaunchAgents", "com.stageutility.output.plist"), "<plist/>");
    server.routes.set("/kiosk/StageUtilityOutput-arm64.zip", { body: next.bytes });
    server.routes.set("/kiosk/StageUtilityOutput-arm64.zip.sha256", { body: `${sha(next.bytes)}  StageUtilityOutput-arm64.zip\n` });
    server.routes.set("/kiosk/StageUtilityOutput-arm64.zip.sig", { body: KEY.sign(next.bytes) });
    // The key the install left for the updater.
    fs.writeFileSync(path.join(updater, "release-signing.pub.pem"), KEY.publicPem);
  });

  const run = (extra: Record<string, string> = {}) =>
    sh(`. "${SCRIPT}"; MODE=check; trap on_exit EXIT; check_update; FINISHED=1`, {
      ...shims.env,
      STAGE_INSTALL_SOURCED: "1",
      STAGE_INSTALL_TEST_ROOT: scratch,
      STAGE_INSTALL_TEST_UNAME_M: "arm64",
      STAGE_INSTALL_TEST_CONSOLE_USER: ME,
      STAGE_INSTALL_TEST_HOME: home(),
      STAGE_INSTALL_TEST_START_TIMEOUT: "4",
      // No test reaches GitHub: a fallback to the release goes nowhere.
      STAGE_INSTALL_GITHUB_BASE: "http://127.0.0.1:9",
      STAGE_INSTALL_GITHUB_API: "http://127.0.0.1:9",
      SHIM_PRINT_RC: "0",
      SHIM_PRINT_OUT: "\tpid = 4242",
      SHIM_STARTS_WRITE: statusFile(),
      SHIM_STARTS_BODY: started(),
      ...extra,
    });
  const launchctl = () => shims.log().map((l) => l.replace(/ \| marker=.*/, "")).filter((c) => c.startsWith("launchctl") && !c.startsWith("launchctl print"));

  it("asks the server, says who it is, and does nothing when told to wait", async () => {
    answer({ update: false, reason: "Helper 1.26.0. Updates to 1.27.0 when the service is no longer live" });
    const r = await run();
    assert.equal(r.status, 0, r.out + r.err);
    const [q] = checks();
    assert.equal(q.get("machine"), MACHINE);
    assert.equal(q.get("platform"), "macos");
    assert.equal(q.get("have"), "1.26.0");
    assert.equal(q.get("state"), "idle");
    assert.ok(!server.hits.some((h) => h.includes(".zip")), "nothing downloaded");
    assert.equal(which(), "build-old");
    assert.deepEqual(launchctl(), []);
    assert.match(r.out, /\[helper-update\] .*: Helper 1\.26\.0\. Updates to 1\.27\.0 when the service is no longer live/);
    // The same answer again is not said again.
    const again = await run();
    assert.doesNotMatch(again.out, /when the service is no longer live/);
  });

  it("reads the server's whole sentence, commas and all", async () => {
    answer({ update: false, reason: "Helper 1.27.0, the same as this server" });
    const r = await run();
    assert.match(r.out, /: Helper 1\.27\.0, the same as this server$/m);
    assert.match(updaterStatus(), /^answer=Helper 1\.27\.0, the same as this server$/m);
  });

  it("updates: downloads, verifies, swaps, restarts the helper, and keeps the new one once it says it started", async () => {
    answer({ update: true, reason: "Helper 1.26.0. Updating to 1.27.0" });
    const r = await run();
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(which(), "build-new");
    assert.deepEqual(leftovers(), [], "the previous app is gone once the new one started");
    assert.deepEqual(launchctl(), [`launchctl bootout gui/${uid}/com.stageutility.output`, `launchctl bootstrap gui/${uid} ${path.join(scratch, "Library", "LaunchAgents", "com.stageutility.output.plist")}`]);
    assert.match(updaterStatus(), /^state=updated$/m);
    assert.match(updaterStatus(), /^target=1\.27\.0$/m);
    assert.match(r.out, /updated the helper from 1\.26\.0 to 1\.27\.0; it is running/);
    // And says so at the next check.
    answer({ update: false });
    await run();
    assert.equal(checks().at(-1)?.get("state"), "updated");
    assert.equal(checks().at(-1)?.get("have"), "1.27.0");
  });

  describe("the release's signature", () => {
    const keyFile = () => path.join(scratch, "Library", "Application Support", "StageUtilityUpdater", "release-signing.pub.pem");

    it("is checked against the key installed on this Mac, never one the server offers", async () => {
      answer({ update: true });
      // A server, or whatever answers in its place, with a key and a signature of its own.
      server.routes.set("/kiosk/release-signing.pub.pem", { body: OTHER_KEY.publicPem });
      server.routes.set("/kiosk/StageUtilityOutput-arm64.zip.sig", { body: OTHER_KEY.sign(next.bytes) });
      const r = await run();
      assert.equal(r.status, 1, r.out + r.err);
      assert.equal(which(), "build-old");
      assert.deepEqual(launchctl(), [], "the helper was never stopped");
      assert.ok(!server.hits.includes("/kiosk/release-signing.pub.pem"), "the updater never asks for a key");
      assert.match(r.err, /\[helper-update\] install-macos\.sh: could not get the helper\. this server \(.*\): signature invalid: StageUtilityOutput-arm64\.zip\.sig does not verify against the release signing key installed on this Mac/);
      assert.match(updaterStatus(), /^state=retrying$/m);
      assert.match(updaterStatus(), /^detail=could not get the helper\. this server \(.*\): signature invalid/m);
      // The next check reports it, so Screens shows it.
      answer({ update: false });
      await run();
      assert.match(checks().at(-1)?.get("detail") ?? "", /signature invalid/);
      assert.equal(checks().at(-1)?.get("state"), "retrying");
    });

    it("says it is valid when it is", async () => {
      answer({ update: true });
      const r = await run();
      assert.equal(r.status, 0, r.out + r.err);
      assert.match(r.out, /\[helper-update\]\s+signature valid: StageUtilityOutput-arm64\.zip\.sig, against the release signing key installed on this Mac/);
      assert.equal(which(), "build-new");
    });

    it("refuses an update with no signature, and says it is missing", async () => {
      answer({ update: true });
      server.routes.delete("/kiosk/StageUtilityOutput-arm64.zip.sig");
      const r = await run();
      assert.equal(r.status, 1, r.out + r.err);
      assert.equal(which(), "build-old");
      assert.match(updaterStatus(), /^detail=could not get the helper\. this server \(.*\): signature missing: StageUtilityOutput-arm64\.zip\.sig answered 404/m);
    });

    for (const [label, plant] of [
      ["there is no key installed", () => fs.rmSync(keyFile())],
      ["the installed key is not a key", () => fs.writeFileSync(keyFile(), "not a key\n")],
      ["the installed key is 2048-bit", () => fs.writeFileSync(keyFile(), testSigningKey(2048).publicPem)],
      ["the installed key is a link", () => {
        const real = path.join(scratch, "elsewhere.pem");
        fs.writeFileSync(real, KEY.publicPem);
        fs.rmSync(keyFile());
        fs.symlinkSync(real, keyFile());
      }],
    ] as const) {
      it(`holds the update, downloading nothing, when ${label}`, async () => {
        answer({ update: true });
        plant();
        const r = await run();
        assert.equal(r.status, 1, r.out + r.err);
        assert.equal(which(), "build-old");
        assert.ok(!server.hits.some((h) => h.includes(".zip") || h.includes("release-signing")), "nothing downloaded, no key asked for");
        assert.match(updaterStatus(), /^state=failed$/m);
        assert.match(updaterStatus(), /^detail=signature not checked: no readable release signing key is installed, so no update can be verified; run the installer by hand \(looked for .*/m);
      });
    }
  });

  it("puts the previous helper back, and starts it, when the new one says Chromium did not start", async () => {
    answer({ update: true });
    const r = await run({ SHIM_STARTS_BODY: started({ chromium: "failed", chromiumProblem: "the browser host could not be opened, so nothing renders" }) });
    assert.equal(r.status, 1, r.out + r.err);
    assert.equal(which(), "build-old");
    assert.deepEqual(leftovers(), []);
    const plist = path.join(scratch, "Library", "LaunchAgents", "com.stageutility.output.plist");
    assert.deepEqual(launchctl(), [
      `launchctl bootout gui/${uid}/com.stageutility.output`,
      `launchctl bootstrap gui/${uid} ${plist}`,
      `launchctl bootout gui/${uid}/com.stageutility.output`,
      `launchctl bootstrap gui/${uid} ${plist}`,
    ]);
    assert.match(updaterStatus(), /^state=failed$/m);
    assert.match(updaterStatus(), /^target=1\.27\.0$/m);
    assert.match(updaterStatus(), /^detail=Chromium did not start: the browser host could not be opened, so nothing renders$/m);
    assert.match(r.out, /the update to 1\.27\.0 failed: Chromium did not start: the browser host could not be opened, so nothing renders\. Put 1\.26\.0 back\./);
    // The next check tells the server, which then holds the version back.
    answer({ update: false });
    await run();
    const q = checks().at(-1)!;
    assert.deepEqual([q.get("state"), q.get("target"), q.get("have")], ["failed", "1.27.0", "1.26.0"]);
  });

  it("puts the previous helper back when the new one never says it started", async () => {
    answer({ update: true });
    const r = await run({ SHIM_STARTS_WRITE: "" });
    assert.equal(r.status, 1, r.out + r.err);
    assert.equal(which(), "build-old");
    assert.match(updaterStatus(), /^detail=the new helper did not say it started within 4 s$/m);
  });

  it("does not read the stopped helper's status file as the new one's", async () => {
    answer({ update: true });
    fs.mkdirSync(path.dirname(statusFile()), { recursive: true });
    // The old copy's file, with launchd's pid: it must not count.
    fs.writeFileSync(statusFile(), started());
    const r = await run({ SHIM_STARTS_WRITE: "" });
    assert.equal(r.status, 1, r.out + r.err);
    assert.equal(which(), "build-old");
  });

  it("refuses a zip of another version before touching the running helper", async () => {
    answer({ update: true, version: "1.28.0" });
    const r = await run();
    assert.equal(r.status, 1, r.out + r.err);
    assert.equal(which(), "build-old");
    assert.deepEqual(launchctl(), [], "the helper was never stopped");
    assert.match(updaterStatus(), /^detail=the server sent version 1\.27\.0, not 1\.28\.0$/m);
  });

  it("waits for a login when nobody is logged in", async () => {
    answer({ update: true });
    const r = await run({ STAGE_INSTALL_TEST_CONSOLE_USER: "none" });
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(which(), "build-old");
    assert.ok(!server.hits.some((h) => h.includes(".zip")));
    assert.match(updaterStatus(), /^state=no-session$/m);
    assert.match(r.out, /nobody is logged in to start and check it/);
  });

  it("does not start a helper someone quit at the Mac", async () => {
    answer({ update: true });
    const r = await run({ SHIM_PRINT_OUT: "\tstate = not running" });
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(which(), "build-old");
    assert.deepEqual(launchctl(), []);
    assert.match(updaterStatus(), /^state=not-running$/m);
  });

  it("says when macOS refuses the updated helper the network, which the helper itself cannot", async () => {
    answer({ update: true });
    assert.equal((await run()).status, 0);
    fs.writeFileSync(statusFile(), started({ localNetworkRefused: true }));
    answer({ update: false });
    const r = await run();
    assert.match(r.out, /macOS refuses the helper Local Network access since the update to 1\.27\.0/);
    assert.equal(checks().at(-1)?.get("state"), "local-network");
  });

  describe("only what root owns decides", () => {
    const state = () => path.join(scratch, "Library", "Application Support", "StageUtility");

    it("asks the server it was installed with, never the state folder's server file or the helper's word", async () => {
      // Both of these the logged-in user can write.
      fs.writeFileSync(path.join(state(), "server"), "http://127.0.0.1:9\n");
      fs.mkdirSync(path.dirname(statusFile()), { recursive: true });
      fs.writeFileSync(statusFile(), started({ server: "http://127.0.0.1:9", version: "1.26.0" }));
      answer({});
      const r = await run();
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(checks().length, 1, "the installed-with server was asked");
      assert.equal(checks()[0].get("machine"), MACHINE, "with root's copy of the id, not the state folder's");
    });

    it("without root's own copy of the server, asks nobody: the state folder's file is not a fallback", async () => {
      fs.rmSync(path.join(scratch, "Library", "Application Support", "StageUtilityUpdater", "server"));
      // A valid server the logged-in user could write, and which is listening.
      fs.writeFileSync(path.join(state(), "server"), `${server.base}\n`);
      answer({ update: true });
      const r = await run();
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(checks().length, 0, "no request went to the planted server");
      assert.ok(!server.hits.some((h) => h.includes(".zip")));
      assert.match(updaterStatus(), /^answer=unreachable$/m);
      assert.match(r.out, /no server answered the update check \(none is recorded/);
    });

    it("sends nothing it would read through a link the user left, nor anything at all without its own id", async () => {
      fs.rmSync(path.join(scratch, "Library", "Application Support", "StageUtilityUpdater", "device-id"));
      fs.writeFileSync(path.join(scratch, "secret"), "ROOT-ONLY\n");
      fs.rmSync(path.join(state(), "device-id"));
      fs.symlinkSync(path.join(scratch, "secret"), path.join(state(), "device-id"));
      answer({});
      const r = await run();
      assert.notEqual(r.status, 0);
      assert.equal(checks().length, 0);
      assert.match(r.err, /no usable device id/);
    });

    it("never an address that is not a server root", async () => {
      fs.writeFileSync(path.join(scratch, "Library", "Application Support", "StageUtilityUpdater", "server"), "file:///etc\n");
      const r = await run();
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(checks().length, 0);
      assert.match(r.out, /no server answered the update check \(none is recorded/);
    });

    it("does not read the helper's status through a link", async () => {
      answer({ update: true });
      fs.mkdirSync(path.dirname(statusFile()), { recursive: true });
      fs.writeFileSync(path.join(scratch, "elsewhere.json"), started());
      fs.symlinkSync(path.join(scratch, "elsewhere.json"), statusFile());
      const r = await run({ SHIM_STARTS_WRITE: "" });
      assert.equal(r.status, 1, r.out + r.err);
      assert.equal(which(), "build-old", "a linked file saying the new one started is not believed");
    });
  });

  it("does not believe a status file the logged-in user does not own", async () => {
    answer({ update: true });
    // The console user is "nobody", and the file saying the new helper started is
    // this test's, so it is not that user's own.
    const r = await run({ STAGE_INSTALL_TEST_CONSOLE_USER: "nobody" });
    assert.equal(r.status, 1, r.out + r.err);
    assert.equal(which(), "build-old");
  });

  describe("an update that was cut off", () => {
    const apps = () => path.join(scratch, "Applications");
    const aside = (name: string, mtime: number) => {
      const dir = path.join(apps(), name);
      fs.cpSync(app(), dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "Contents", "MacOS", "StageUtilityOutput"), `#!/bin/sh\n# ${name}\n`);
      fs.utimesSync(dir, mtime, mtime);
    };

    it("puts the newest previous copy back when the app is missing, and sweeps the rest", async () => {
      answer({});
      aside(".StageUtilityOutput.app.old.111", 1_000_000);
      aside(".StageUtilityOutput.app.old.222", 2_000_000);
      fs.rmSync(app(), { recursive: true });
      fs.mkdirSync(path.join(apps(), ".StageUtilityOutput.app.new.333"));
      const r = await run();
      assert.equal(r.status, 0, r.out + r.err);
      assert.match(fs.readFileSync(path.join(app(), "Contents", "MacOS", "StageUtilityOutput"), "utf8"), /old\.222/, "the newest copy");
      assert.deepEqual(leftovers(), []);
      assert.match(r.out, /left .*StageUtilityOutput\.app missing; put back the previous copy from .*old\.222/);
      assert.equal(checks().length, 1, "and the check went on as for an installed Mac");
    });

    it("deletes leftovers beside an app that is there, and says so", async () => {
      answer({});
      aside(".StageUtilityOutput.app.old.111", 1_000_000);
      fs.mkdirSync(path.join(apps(), ".StageUtilityOutput.app.new.333"));
      const r = await run();
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(which(), "build-old", "the installed app is untouched");
      assert.deepEqual(leftovers(), []);
      assert.match(r.out, /removed .*StageUtilityOutput\.app\.old\.111, left by an update that did not finish/);
      assert.match(r.out, /removed .*StageUtilityOutput\.app\.new\.333, left by an update that did not finish/);
    });

    it("still does not put back an app removed by hand, when nothing was left aside", async () => {
      fs.rmSync(app(), { recursive: true });
      const r = await run();
      assert.equal(r.status, 0, r.out + r.err);
      assert.ok(!fs.existsSync(app()));
      assert.match(updaterStatus(), /^answer=not-installed$/m);
    });
  });

  describe("take_lock", () => {
    const lock = () => path.join(scratch, "Library", "Application Support", "StageUtilityUpdater", "lock");
    const stale = async () => (await sh("sh -c 'echo $$'")).out.trim();
    // A shell that finds the dead holder, and in the moment between looking and
    // taking over has another process do the same and start a live lock.
    const raced = async (livePid: string, deadPid: string) => {
      fs.mkdirSync(lock());
      fs.writeFileSync(path.join(lock(), "pid"), `${deadPid}\n`);
      return sh(
        `. "${SCRIPT}"
         UPDATE_LOCK="${lock()}"; LOCKED=0
         swapped=0
         kill() {
           if [ "$swapped" = 0 ] && [ "$2" = "${deadPid}" ]; then
             swapped=1
             rm -rf "$UPDATE_LOCK"; mkdir "$UPDATE_LOCK"; printf '%s\\n' "${livePid}" >"$UPDATE_LOCK/pid"
           fi
           command kill "$@"
         }
         if take_lock 0; then echo TOOK; else echo REFUSED; fi
         cat "$UPDATE_LOCK/pid"`,
        { STAGE_INSTALL_SOURCED: "1", STAGE_INSTALL_TEST_ROOT: scratch },
      );
    };

    it("takes over a lock whose holder is gone, leaving nothing renamed beside it", async () => {
      fs.mkdirSync(lock());
      fs.writeFileSync(path.join(lock(), "pid"), `${await stale()}\n`);
      const r = await sh(`. "${SCRIPT}"; UPDATE_LOCK="${lock()}"; LOCKED=0; take_lock 0 && echo TOOK; cat "$UPDATE_LOCK/pid"`, {
        STAGE_INSTALL_SOURCED: "1",
        STAGE_INSTALL_TEST_ROOT: scratch,
      });
      assert.match(r.out, /^TOOK$/m, r.out + r.err);
      assert.deepEqual(fs.readdirSync(path.dirname(lock())).filter((n) => n.startsWith("lock.")), []);
    });

    it("does not delete a live process's lock that was started while it was taking over a stale one", async () => {
      const live = spawn("sleep", ["30"]);
      try {
        const r = await raced(String(live.pid), await stale());
        assert.match(r.out, /^REFUSED$/m, "the second contender must not also hold the lock: " + r.out + r.err);
        assert.equal(fs.readFileSync(path.join(lock(), "pid"), "utf8").trim(), String(live.pid), "the live holder's lock is intact");
      } finally {
        live.kill();
      }
    });
  });

  it("is skipped while an install or another check holds the lock", async () => {
    const lock = path.join(scratch, "Library", "Application Support", "StageUtilityUpdater", "lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
    answer({ update: true });
    const r = await run();
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(checks().length, 0);
    assert.ok(fs.existsSync(lock), "and the holder's lock is left alone");
  });

  it("takes over a lock left by a process that is gone", async () => {
    const lock = path.join(scratch, "Library", "Application Support", "StageUtilityUpdater", "lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), "999999\n");
    answer({});
    const r = await run();
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(checks().length, 1);
    assert.ok(!fs.existsSync(lock), "released when the check ends");
  });

  describe("what counts as the new helper starting", () => {
    it("not a status from another pid", async () => {
      answer({ update: true });
      const r = await run({ SHIM_STARTS_BODY: started({ pid: 999 }) });
      assert.equal(r.status, 1, r.out + r.err);
      assert.equal(which(), "build-old");
    });

    it("not a status from another version", async () => {
      answer({ update: true });
      const r = await run({ SHIM_STARTS_BODY: started({ version: "1.26.0" }) });
      assert.equal(r.status, 1, r.out + r.err);
      assert.equal(which(), "build-old");
    });
  });

  it("does not start an update with no agent file to start the new helper", async () => {
    answer({ update: true });
    fs.rmSync(path.join(scratch, "Library", "LaunchAgents", "com.stageutility.output.plist"));
    const r = await run();
    assert.equal(r.status, 1, r.out + r.err);
    assert.equal(which(), "build-old");
    assert.ok(!server.hits.some((h) => h.includes(".zip")), "nothing downloaded");
    assert.match(updaterStatus(), /^state=failed$/m);
  });

  it("tries a download that failed again later, not at the next check, and does not hold the version", async () => {
    answer({ update: true });
    server.routes.delete("/kiosk/StageUtilityOutput-arm64.zip");
    server.routes.delete("/kiosk/StageUtilityOutput-arm64.zip.sha256");
    const r = await run({ STAGE_INSTALL_GITHUB_BASE: "http://127.0.0.1:9" });
    assert.equal(r.status, 1, r.out + r.err);
    assert.equal(which(), "build-old");
    assert.match(updaterStatus(), /^state=retrying$/m);
    assert.match(updaterStatus(), /^fails=1$/m);
    const retry = Number(/^retry_after=(\d+)$/m.exec(updaterStatus())?.[1]);
    assert.ok(retry > Date.now() / 1000 + 1700 && retry < Date.now() / 1000 + 1900, `half an hour on: ${retry}`);
    assert.match(r.out, /did not finish: .*Trying again in 30 minutes/);
    // The next check says so, and downloads nothing before then.
    server.hits.length = 0;
    await run({ STAGE_INSTALL_GITHUB_BASE: "http://127.0.0.1:9" });
    assert.equal(checks().at(-1)?.get("state"), "retrying");
    assert.ok(!server.hits.some((h) => h.includes(".zip")), "nothing downloaded inside the back-off");
  });

  it("says when the helper it put back could not be started again", async () => {
    answer({ update: true });
    const pidFile = path.join(scratch, "launchd-pid");
    fs.writeFileSync(pidFile, "4242");
    const r = await run({
      SHIM_PID_FILE: pidFile,
      // The new helper starts and says Chromium failed; the old one will not start.
      SHIM_BOOTSTRAP_LIMIT: "1",
      SHIM_STARTS_BODY: started({ chromium: "failed", chromiumProblem: "no host" }),
      SHIM_PRINT_RC: "",
      SHIM_PRINT_OUT: "",
      STAGE_INSTALL_TEST_RESTART_WAIT: "2",
    });
    assert.equal(r.status, 1, r.out + r.err);
    assert.equal(which(), "build-old");
    assert.match(updaterStatus(), /^detail=Chromium did not start: no host; the previous helper could not be started again$/m);
    assert.ok(shims.log().some((l) => l.startsWith("launchctl kickstart")), "it tried to start it again itself");
  });

  it("stops calling itself updated a day after", async () => {
    const dir = path.join(scratch, "Library", "Application Support", "StageUtilityUpdater");
    fs.writeFileSync(path.join(dir, "status"), `state=updated\ntarget=1.26.0\ndetail=\nanswer=x\nat=${Math.floor(Date.now() / 1000) - 90_000}\nretry_after=\nfails=0\n`);
    answer({});
    await run();
    assert.equal(checks()[0].get("state"), "idle");
  });

  it("leaves a Mac whose app was removed by hand alone", async () => {
    fs.rmSync(app(), { recursive: true, force: true });
    answer({ update: true });
    const r = await run();
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(!fs.existsSync(app()));
    assert.equal(checks().length, 0);
  });
});

describe("the device identity survives a re-run", () => {
  const state = () => path.join(scratch, "Library", "Application Support", "StageUtility");
  const run = (extra: Record<string, string> = {}) =>
    sh(`. "${SCRIPT}"; DRY=0; CONSOLE_USER=""; write_state`, {
      STAGE_INSTALL_SOURCED: "1",
      STAGE_INSTALL_TEST_ROOT: scratch,
      ...makeShims().env,
      ...extra,
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

// The state directory belongs to the console user, who can leave a symbolic link in
// it. Root writes four files there (the marker, server, device-id, token); none may
// be written through a link, and none may be chmod-ed through one.
describe("root does not write through a link left in the state directory", () => {
  const state = () => path.join(scratch, "Library", "Application Support", "StageUtility");
  const victim = () => path.join(scratch, "victim");
  const plant = (name: string) => {
    fs.mkdirSync(state(), { recursive: true });
    fs.writeFileSync(victim(), "precious\n", { mode: 0o600 });
    fs.symlinkSync(victim(), path.join(state(), name));
  };
  const untouched = () => {
    assert.equal(fs.readFileSync(victim(), "utf8"), "precious\n", "what the link pointed at was written");
    assert.equal(fs.statSync(victim()).mode & 0o777, 0o600, "what the link pointed at was chmod-ed");
  };
  const stateEnv = () => ({ STAGE_INSTALL_SOURCED: "1", STAGE_INSTALL_TEST_ROOT: scratch });
  const writeState = (extra: Record<string, string> = {}) =>
    sh(`. "${SCRIPT}"; DRY=0; CONSOLE_USER=""; write_state`, { ...stateEnv(), ...makeShims().env, ...extra });

  it("the marker: replaced by a file of its own, the link's target untouched", async () => {
    fs.mkdirSync(path.join(scratch, "usr", "local", "bin"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "usr", "local", "bin", "stage-utility-kiosk"), "#!/bin/sh\n");
    plant("migrated-from-kiosk");
    const r = await sh(`. "${SCRIPT}"; DRY=0; write_kiosk_marker`, stateEnv());
    assert.equal(r.status, 0, r.err);
    untouched();
    const m = fs.lstatSync(path.join(state(), "migrated-from-kiosk"));
    assert.ok(m.isFile() && !m.isSymbolicLink(), "the marker is a real file now");
    assert.match(fs.readFileSync(path.join(state(), "migrated-from-kiosk"), "utf8"), /^\d{4}-/);
  });

  it("the server file: replaced by a file of its own, the link's target untouched", { skip: !(has("uuidgen") && has("xxd")) && "needs uuidgen and xxd" }, async () => {
    plant("server");
    const r = await writeState({ STAGE_SERVER: "http://192.0.2.10:8788" });
    assert.equal(r.status, 0, r.out + r.err);
    untouched();
    const f = path.join(state(), "server");
    // One open, refusing a link, so the check and the read are of the same file.
    const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      assert.ok(fs.fstatSync(fd).isFile());
      assert.equal(fs.readFileSync(fd, "utf8"), "http://192.0.2.10:8788");
    } finally {
      fs.closeSync(fd);
    }
  });

  it("device-id and token: refused, and neither written nor chmod-ed through", { skip: !(has("uuidgen") && has("xxd")) && "needs uuidgen and xxd" }, async () => {
    for (const name of ["device-id", "token"]) {
      fs.rmSync(state(), { recursive: true, force: true });
      plant(name);
      const r = await writeState();
      assert.equal(r.status, 1, `${name}: ${r.out}${r.err}`);
      assert.match(r.err, new RegExp(`${name} is a symbolic link`));
      untouched();
    }
  });
});

describe("the migration marker", () => {
  const state = () => path.join(scratch, "Library", "Application Support", "StageUtility");
  const marker = () => path.join(state(), "migrated-from-kiosk");
  const migrate = () =>
    sh(`. "${SCRIPT}"; DRY=0; CONSOLE_UID=""; WORK="$(mktemp -d)"; write_kiosk_marker; retire_kiosk; rm -rf "$WORK"`, { STAGE_INSTALL_SOURCED: "1", STAGE_INSTALL_TEST_ROOT: scratch });

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

  it("leaves an existing marker alone when run again, even with the kiosk's agent back", async () => {
    fs.mkdirSync(path.join(scratch, "usr", "local", "bin"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "usr", "local", "bin", "stage-utility-kiosk"), "#!/bin/sh\n");
    fs.mkdirSync(state(), { recursive: true });
    fs.writeFileSync(marker(), "earlier\n");
    assert.equal((await migrate()).status, 0);
    assert.equal(fs.readFileSync(marker(), "utf8"), "earlier\n");
  });

  it("leaves an existing marker alone when run again", async () => {
    fs.mkdirSync(state(), { recursive: true });
    fs.writeFileSync(marker(), "earlier\n");
    assert.equal((await migrate()).status, 0);
    assert.equal(fs.readFileSync(marker(), "utf8"), "earlier\n");
  });
});

// Names the installer and the helper must agree on. The installer writes the
// LaunchAgent and the migration marker; the helper looks for both by name, and
// launchd runs the app by the bundle id build-app.sh gave it. A name that differs
// in one of them is a helper that never starts at login, or a Mac that was a kiosk
// and comes up dark, with nothing failing anywhere. The shell side is the script's
// own variables, read by sourcing it (which defines them and runs nothing); the
// Swift side is read from the line that declares each value, so a comment that
// quotes one satisfies nothing.
describe("the names the installer and the helper share", () => {
  const SOURCES = path.join(HERE, "..", "helper", "macos", "Sources");
  const swift = (file: string) => fs.readFileSync(path.join(SOURCES, file), "utf8");
  /** The one string assigned or passed on a line that is code, not a `//` or `#` comment. */
  const declared = (source: string, pattern: string): string => {
    const found = [...source.matchAll(new RegExp(`^(?![ \\t]*(?://|#))[^\\n]*${pattern}`, "gm"))];
    assert.equal(found.length, 1, `exactly one line declaring ${pattern}, found ${found.length}`);
    return found[0][1];
  };

  it("are the same in install-macos.sh, build-app.sh and the Swift", async () => {
    const r = await sh(
      `. "${SCRIPT}"; printf 'label=%s\\nplist=%s\\nstate=%s\\nmarker=%s\\n' "$HELPER_LABEL" "$HELPER_PLIST" "$STATE_DIR" "$MARKER"`,
      { STAGE_INSTALL_SOURCED: "1", STAGE_INSTALL_TEST_ROOT: scratch },
    );
    assert.equal(r.status, 0, r.err);
    const shell: Record<string, string> = {};
    for (const line of r.out.split("\n").filter(Boolean)) {
      const eq = line.indexOf("=");
      shell[line.slice(0, eq)] = line.slice(eq + 1).replace(scratch, "");
    }

    const paths = swift("StageUtilityOutputCore/Paths.swift");
    const agentName = declared(paths, 'public static let launchAgentName = "([^"]+)"');
    const agentDir = declared(paths, 'launchAgent: URL = URL\\(fileURLWithPath: "([^"]+)"\\)');
    const systemDir = declared(paths, 'systemDir: URL\\(fileURLWithPath: "([^"]+)"');
    const marker = declared(swift("StageUtilityOutputCore/OutputState.swift"), 'public static let markerFileName = "([^"]+)"');
    const subsystem = declared(swift("StageUtilityOutput/Log.swift"), 'Logger\\(subsystem: "([^"]+)"');
    const bundleId = declared(fs.readFileSync(path.join(HERE, "..", "helper", "macos", "build-app.sh"), "utf8"), "BUNDLE_ID=(\\S+)");

    assert.equal(agentName, path.basename(shell.plist), "the LaunchAgent's file name");
    assert.equal(agentDir, path.dirname(shell.plist), "the LaunchAgent's folder");
    assert.equal(systemDir, shell.state, "the folder holding device-id, token and the marker");
    assert.equal(marker, path.basename(shell.marker), "the migration marker's name");
    assert.equal(path.dirname(shell.marker), shell.state, "the marker lives beside device-id");
    assert.equal(`${shell.label}.plist`, agentName, "the label names the plist");
    assert.equal(bundleId, shell.label, "the bundle id is the launchd label");
    assert.equal(subsystem, shell.label, "the log subsystem is the label, as the docs tell an operator");
  });
});
