// scripts/uninstall.sh, run for real, as --dry-run, against a scratch directory.
//
// The script is shell and its job is to find what scripts/kiosk/install-macos.sh
// put on a Mac and name every removal, so these tests run the whole script with
// STAGE_UNINSTALL_TEST_ROOT pointing at a scratch directory and read the list of
// `would run:` lines it prints. Every change the script makes goes through its
// run() helper, so that list is the complete list of what a real run would do.
//
// Why only --dry-run: a real run needs root (need_root dies without it), and the
// commands it would run (launchctl bootout, rm -rf /Applications/...) are the ones
// a test must not run on the machine it is on. launchctl, brew, pgrep, systemctl
// and uname are stood in for by shims, so nothing here reaches the real ones, and
// the scratch root holds every path the script reads.
//
// The paths the installer writes are read from install-macos.sh itself and used to
// build the fixtures, so an installer that moves a file the uninstaller looks for
// fails here instead of leaving a Mac with a helper nobody can remove.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "uninstall.sh");
const INSTALLER = path.join(HERE, "kiosk", "install-macos.sh");

const ME = os.userInfo().username;
const has = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

/**
 * Stand-ins for the commands that read or change a real machine. `launchctl print
 * <target>` answers "loaded" (0) when the target is, or ends in "/" and, a word of
 * SHIM_LOADED (whole labels: com.stageutility.output is not the updater's),
 * else "not loaded" (1); every call is appended to SHIM_LOG. `uname` says Darwin
 * (the script returns early elsewhere); brew, systemctl and pgrep find nothing.
 */
const SHIMS: Record<string, string> = {
  launchctl: `#!/bin/sh
echo "launchctl $*" >>"$SHIM_LOG"
if [ "$1" = print ]; then
  for w in \${SHIM_LOADED:-}; do case "$2" in "$w" | */"$w") exit 0 ;; esac; done
  exit 1
fi
exit 0
`,
  uname: "#!/bin/sh\necho Darwin\n",
  brew: "#!/bin/sh\nexit 1\n",
  systemctl: "#!/bin/sh\nexit 1\n",
  pgrep: "#!/bin/sh\nexit 1\n",
};

let scratch: string;
let shimDir: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "su-uninstall-"));
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "su-uninstall-shims-"));
  for (const [name, body] of Object.entries(SHIMS)) fs.writeFileSync(path.join(shimDir, name), body, { mode: 0o755 });
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(shimDir, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  out: string;
  err: string;
  /** Every `would run:` line, with the scratch root and uids made stable. Unsorted. */
  actions: string[];
  /** The same, sorted: what a test compares against an exact list. */
  sorted: string[];
  /** Every launchctl call the script made, which must only ever be reads. */
  launchctl: string[];
}

function uninstall(opts: { loaded?: string[]; consoleUser?: string; shell?: string } = {}): Run {
  const log = path.join(shimDir, "calls.log");
  fs.writeFileSync(log, "");
  const r = spawnSync(opts.shell ?? "bash", [SCRIPT, "--dry-run"], {
    encoding: "utf8",
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      HOME: path.join(scratch, "home"),
      STAGE_UNINSTALL_TEST_ROOT: scratch,
      STAGE_UNINSTALL_TEST_CONSOLE_USER: opts.consoleUser ?? ME,
      SHIM_LOG: log,
      SHIM_LOADED: (opts.loaded ?? []).join(" "),
    },
  });
  const stable = (s: string) => s.split(scratch).join("<root>").replace(/gui\/\d+/g, "gui/<uid>");
  const out = r.stdout ?? "";
  const actions = [...out.matchAll(/^ {2}would run: (.*)$/gm)].map((m) => stable(m[1]));
  return {
    status: r.status,
    out: stable(out),
    err: stable(r.stderr ?? ""),
    actions,
    sorted: [...actions].sort(),
    launchctl: fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
}

/** The paths install-macos.sh writes, read by sourcing it (which defines and runs nothing). */
function installerPaths(root: string): Record<string, string> {
  const vars = ["HELPER_LABEL", "HELPER_PLIST", "APP_NAME", "APPS_DIR", "STATE_DIR", "KIOSK_LABEL", "AGENT", "BIN", "UPDATER_LABEL", "UPDATER_PLIST", "UPDATER_DIR"];
  const r = spawnSync("sh", ["-c", `. "${INSTALLER}"; ${vars.map((v) => `printf '${v}=%s\\n' "$${v}"`).join("; ")}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", STAGE_INSTALL_SOURCED: "1", STAGE_INSTALL_TEST_ROOT: root },
  });
  assert.equal(r.status, 0, r.stderr);
  const found: Record<string, string> = {};
  for (const line of r.stdout.split("\n").filter(Boolean)) found[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
  return found;
}

const put = (file: string, body = "") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

/** What install-macos.sh leaves for the helper, at the paths it itself names. */
function installHelper(): Record<string, string> {
  const p = installerPaths(scratch);
  put(p.HELPER_PLIST, "<plist/>");
  put(path.join(p.APPS_DIR, p.APP_NAME, "Contents", "Info.plist"), "<plist/>");
  put(path.join(p.STATE_DIR, "device-id"), "id\n");
  put(path.join(p.STATE_DIR, "token"), "secret");
  put(path.join(scratch, "Users", ME, "Library", "Application Support", "StageUtilityOutput", "outputs.json"), "{}");
  fs.mkdirSync(path.join(scratch, "Users", "Shared"), { recursive: true });
  return p;
}

/** The server as the one-line macOS installer leaves it: a daemon, its release tree, a data directory. */
function installServer(): { data: string } {
  const data = path.join(scratch, "var", "stage-utility-data");
  fs.mkdirSync(data, { recursive: true });
  put(
    path.join(scratch, "Library", "LaunchDaemons", "com.stageutility.server.plist"),
    `<dict><key>STAGE_UTILITY_DATA</key><string>${data}</string></dict>`,
  );
  put(path.join(scratch, "usr", "local", "stage-utility", "server.js"));
  return { data };
}

const DATA_AFTER = (out: string, heading: RegExp): string[] => {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => heading.test(l));
  assert.ok(at >= 0, `a line matching ${heading} in:\n${out}`);
  const listed: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("    ")) break;
    listed.push(line.trim());
  }
  return listed.sort();
};

const POWER_HEADING = /Not put back: the installer turned off display sleep/;

describe("uninstall.sh is valid shell", () => {
  it("parses under bash", () => {
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("is clean under shellcheck, when shellcheck is installed", (t) => {
    if (!has("shellcheck")) {
      t.skip("shellcheck is not installed here; bash -n above is the fallback");
      return;
    }
    const r = spawnSync("shellcheck", [SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe("uninstall.sh --dry-run on a Mac", { skip: ME === "root" && "root is never a GUI account, so there is no session to stop" }, () => {
  it("with nothing installed, says so and plans nothing", () => {
    const r = uninstall();
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.sorted, []);
    assert.match(r.out, /Nothing to remove/);
    assert.doesNotMatch(r.out, POWER_HEADING, "no power note for a Mac the installer never touched");
  });

  it("removes the helper: stops it, then its agent file, then the app", () => {
    installHelper();
    const r = uninstall({ loaded: ["com.stageutility.output"] });
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.sorted, [
      "launchctl bootout gui/<uid>/com.stageutility.output",
      "rm -f <root>/Library/LaunchAgents/com.stageutility.output.plist",
      "rm -rf <root>/Applications/StageUtilityOutput.app",
    ]);
    // Order is the point of the first: the plist alone leaves the process running.
    assert.equal(r.actions[0], "launchctl bootout gui/<uid>/com.stageutility.output");
  });

  it("lists the device id and each account's output settings, and never plans to remove them", () => {
    installHelper();
    const r = uninstall({ loaded: ["com.stageutility.output"] });
    assert.deepEqual(DATA_AFTER(r.out, /Remove deliberately with sudo rm -rf on:/), [
      `<root>/Library/Application Support/StageUtility`,
      `<root>/Users/${ME}/Library/Application Support/StageUtilityOutput`,
    ]);
    assert.ok(
      !r.actions.some((a) => a.includes("Application Support")),
      `no action touches the data: ${r.actions.join(" | ")}`,
    );
  });

  it("says what it cannot put back, and the commands to set it", () => {
    installHelper();
    const r = uninstall();
    assert.match(r.out, POWER_HEADING);
    assert.deepEqual(DATA_AFTER(r.out, /did not record what they were/), [
      "defaults -currentHost write com.apple.screensaver idleTime <seconds>      (as each account; 0 is never)",
      "defaults write com.apple.screensaver askForPassword -int <1 to ask, 0 not to>      (as each account)",
      "or System Settings > Lock Screen",
      "sudo pmset -a displaysleep <minutes> sleep <minutes>      (pmset -g custom shows what is set now)",
    ].sort());
  });

  it("removes what is left of a helper taken out by hand: a loaded job with no files", () => {
    installerPaths(scratch);
    fs.mkdirSync(path.join(scratch, "Users", ME), { recursive: true });
    const r = uninstall({ loaded: ["com.stageutility.output"] });
    assert.deepEqual(r.sorted, ["launchctl bootout gui/<uid>/com.stageutility.output"]);
  });

  it("removes the app alone, and the plist alone, each only when it is there", () => {
    const p = installerPaths(scratch);
    put(path.join(p.APPS_DIR, p.APP_NAME, "Contents", "Info.plist"));
    assert.deepEqual(uninstall().sorted, ["rm -rf <root>/Applications/StageUtilityOutput.app"]);
    fs.rmSync(path.join(p.APPS_DIR, p.APP_NAME), { recursive: true });
    put(p.HELPER_PLIST);
    assert.deepEqual(uninstall().sorted, ["rm -f <root>/Library/LaunchAgents/com.stageutility.output.plist"]);
  });

  it("stops the helper in every account that has a session, once each", (t) => {
    // A second account with a home folder: `nobody` exists on macOS and Linux, and
    // is not the account running the test. Its uid differs, so it is a second bootout.
    if (ME === "nobody" || spawnSync("sh", ["-c", "id -u nobody"]).status !== 0) {
      t.skip("no second account to stand in for a second login");
      return;
    }
    installHelper();
    fs.mkdirSync(path.join(scratch, "Users", "nobody"), { recursive: true });
    const r = uninstall({ loaded: ["com.stageutility.output"] });
    assert.deepEqual(
      r.sorted.filter((a) => a.startsWith("launchctl bootout")),
      ["launchctl bootout gui/<uid>/com.stageutility.output", "launchctl bootout gui/<uid>/com.stageutility.output"],
    );
    const asked = r.launchctl.map((c) => /^launchctl print gui\/(\d+)\/com\.stageutility\.output$/.exec(c)?.[1]).filter(Boolean);
    assert.equal(new Set(asked).size, 2, "two accounts asked");
    assert.equal(asked.length, 2, "each asked once, not the console user twice");
  });

  it("with the server and the helper, removes both and lists both sets of data", () => {
    installHelper();
    installServer();
    const r = uninstall({ loaded: ["com.stageutility.output", "system/com.stageutility.server"] });
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.sorted, [
      "launchctl bootout gui/<uid>/com.stageutility.output",
      "launchctl bootout system/com.stageutility.server",
      "rm -f <root>/Library/LaunchAgents/com.stageutility.output.plist",
      "rm -f <root>/Library/LaunchDaemons/com.stageutility.server.plist",
      "rm -rf <root>/Applications/StageUtilityOutput.app",
      "rm -rf <root>/usr/local/stage-utility",
    ]);
    assert.deepEqual(DATA_AFTER(r.out, /Data left intact \(config, history, encryption key\)/), [`<root>/var/stage-utility-data`]);
    assert.equal(DATA_AFTER(r.out, /Remove deliberately with sudo rm -rf on:/).length, 2);
  });

  it("with only the server, says nothing about the helper", () => {
    installServer();
    const r = uninstall({ loaded: ["system/com.stageutility.server"] });
    assert.deepEqual(r.sorted, [
      "launchctl bootout system/com.stageutility.server",
      "rm -f <root>/Library/LaunchDaemons/com.stageutility.server.plist",
      "rm -rf <root>/usr/local/stage-utility",
    ]);
    assert.doesNotMatch(r.out, POWER_HEADING);
    assert.doesNotMatch(r.out, /device id and token/);
  });

  it("removes the Chrome kiosk the --browser install leaves: its agent and its launcher", () => {
    const p = installerPaths(scratch);
    put(p.AGENT, "<plist/>");
    put(p.BIN, "#!/bin/sh\n");
    put(path.join(p.STATE_DIR, "device-id"), "id\n");
    fs.mkdirSync(path.join(scratch, "Users", ME), { recursive: true });
    const r = uninstall({ loaded: ["com.stageutility.kiosk"] });
    assert.deepEqual(r.sorted, [
      "launchctl bootout gui/<uid>/com.stageutility.kiosk",
      "rm -f <root>/Library/LaunchAgents/com.stageutility.kiosk.plist",
      "rm -f <root>/usr/local/bin/stage-utility-kiosk",
    ]);
    assert.match(r.out, POWER_HEADING);
  });

  it("with nobody logged in, still removes the files and has nothing to stop", () => {
    installHelper();
    fs.rmSync(path.join(scratch, "Users"), { recursive: true });
    const r = uninstall({ consoleUser: "none", loaded: ["com.stageutility.output"] });
    assert.deepEqual(r.sorted, [
      "rm -f <root>/Library/LaunchAgents/com.stageutility.output.plist",
      "rm -rf <root>/Applications/StageUtilityOutput.app",
    ]);
  });

  it("only ever reads from launchctl, and changes nothing on disk", () => {
    const p = installHelper();
    installServer();
    const r = uninstall({ loaded: ["com.stageutility.output", "system/com.stageutility.server"] });
    assert.ok(r.launchctl.length > 0);
    assert.ok(r.launchctl.every((c) => c.startsWith("launchctl print ")), r.launchctl.join(" | "));
    for (const f of [p.HELPER_PLIST, path.join(p.APPS_DIR, p.APP_NAME), p.STATE_DIR]) assert.ok(fs.existsSync(f), `${f} is still there`);
  });

  it("runs under macOS's own bash 3.2 where there is one", (t) => {
    const system = "/bin/bash";
    if (!fs.existsSync(system)) {
      t.skip("no /bin/bash here");
      return;
    }
    installHelper();
    installServer();
    const r = uninstall({ shell: system, loaded: ["com.stageutility.output", "system/com.stageutility.server"] });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.sorted.length, 6, r.out + r.err);
  });
});

describe("the names uninstall.sh and install-macos.sh share", () => {
  it("uninstall.sh finds every file the installer writes, at the installer's own paths", () => {
    const p = installerPaths(scratch);
    put(p.HELPER_PLIST);
    put(path.join(p.APPS_DIR, p.APP_NAME, "x"));
    put(p.AGENT);
    put(p.BIN);
    put(p.UPDATER_PLIST);
    put(path.join(p.UPDATER_DIR, "install-macos.sh"));
    fs.mkdirSync(path.join(scratch, "Users", ME), { recursive: true });
    const r = uninstall({ loaded: [p.HELPER_LABEL, p.KIOSK_LABEL, `system/${p.UPDATER_LABEL}`] });
    const rel = (f: string) => f.split(scratch).join("<root>");
    assert.deepEqual(r.sorted, [
      `launchctl bootout gui/<uid>/${p.HELPER_LABEL}`,
      `launchctl bootout gui/<uid>/${p.KIOSK_LABEL}`,
      `launchctl bootout system/${p.UPDATER_LABEL}`,
      `rm -f ${rel(p.AGENT)}`,
      `rm -f ${rel(p.BIN)}`,
      `rm -f ${rel(p.HELPER_PLIST)}`,
      `rm -f ${rel(p.UPDATER_PLIST)}`,
      `rm -rf ${rel(path.join(p.APPS_DIR, p.APP_NAME))}`,
      `rm -rf ${rel(p.UPDATER_DIR)}`,
    ].sort());
    // Stopped and removed before the app, so a run mid-update cannot put it back.
    const at = (needle: string) => r.actions.findIndex((a) => a.includes(needle));
    assert.ok(at(`bootout system/${p.UPDATER_LABEL}`) < at(`rm -rf ${rel(path.join(p.APPS_DIR, p.APP_NAME))}`), r.actions.join("\n"));
  });
});
