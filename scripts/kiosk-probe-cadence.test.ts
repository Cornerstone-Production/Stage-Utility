// The discovery probe each kiosk agent sends, and how often, run for real.
//
// A kiosk bound to a server that has gone says so in its probe ("unreachable":true)
// once it has failed long enough, because every other server ignores a screen that
// names somebody else unless it says its own server is gone (kiosk-discovery.ts).
// The Linux agent, the Mac shell agent and the Mac helper (Schedule.swift) must
// agree on the cadence: 2 s between probes for ten unanswered ones, then 30 s, and
// the flag from the 32nd probe, after 30 unanswered. The Mac shell agent once sent
// no flag at all, so a Mac kiosk bound to a retired server never showed on any
// other server's Screens page.
//
// Each shell launcher is taken as its installer renders it and its own discovery
// loop is run with only the network tools (nc, socat), ifconfig and sleep replaced
// by shims on PATH: the shims record the probe each call was handed and the sleep
// it was asked for, and answer on the 40th probe so the loop ends. The helper's
// Swift copy and the Windows agent are read as text, since Swift is not run here and
// PowerShell is not on every machine; the exact values are compared.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-cadence-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const text = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** The one cadence every agent shares: FAST_SECONDS between probes for FAST_PROBES
 *  unanswered ones, then SLOW_SECONDS, and the flag after UNREACHABLE_AFTER. The shell
 *  and PowerShell agents are held to it by running them below; the helper's Swift copy
 *  by reading its assignments (parity block at the end). */
const FAST_SECONDS = 2;
const FAST_PROBES = 10;
const SLOW_SECONDS = 30;
const UNREACHABLE_AFTER = 30;
const ANSWERED_ON = 40;
const REPLY = '{"stageUtility":"reply","v":1,"serverId":"srv-a","url":"http://192.0.2.1:8788","claimed":true}';

interface Boot {
  probes: string[];
  sleeps: string[];
}

/** One boot of a shell launcher, bound to srv-a, hearing nobody until the 40th probe. */
function bootShell(installer: string, tool: "nc" | "socat"): Boot {
  const dir = fs.mkdtempSync(path.join(TMP, "boot-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const shim = (name: string, body: string) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  shim(
    tool,
    [
      `cat >> "${dir}/probes"; echo >> "${dir}/probes"`,
      `[ "$(wc -l < "${dir}/probes")" -ge ${ANSWERED_ON} ] && printf '%s' '${REPLY}'`,
      "exit 0",
    ].join("\n"),
  );
  shim("ifconfig", "exit 0");
  shim("sleep", `echo "$1" >> "${dir}/sleeps"`);
  fs.writeFileSync(path.join(dir, "device-id"), "dev-1");
  fs.writeFileSync(path.join(dir, "bound-to"), "srv-a");

  const body = /<<LAUNCHER\n([\s\S]*?)\nLAUNCHER\n/.exec(text(`scripts/kiosk/${installer}`))?.[1];
  assert.ok(body, `${installer} has no launcher`);
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, STATE_DIR: dir, PORT: "8789" };
  const rendered = spawnSync("bash", ["-c", `cat <<LAUNCHER\n${body}\nLAUNCHER`], { encoding: "utf8", env });
  assert.equal(rendered.status, 0, rendered.stderr);
  const lines = rendered.stdout.split("\n");
  const from = lines.findIndex((l) => l.startsWith('if [ -r "$STATE_DIR/server" ]'));
  const to = lines.findIndex((l, i) => i > from && l.startsWith("TARGET="));
  assert.ok(from >= 0 && to > from, `${installer}: no discovery loop found`);
  const run = spawnSync("bash", ["-c", lines.slice(0, to).join("\n")], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n") : []);
  return { probes: read("probes"), sleeps: read("sleeps") };
}

/** One boot of the Windows launcher's loop, with Send-Probe and Start-Sleep replaced. */
function bootWindows(): Boot {
  const dir = fs.mkdtempSync(path.join(TMP, "boot-"));
  const launcher = text("scripts/kiosk/kiosk-windows.ps1").split("\n");
  const from = launcher.findIndex((l) => l.startsWith("function Find-Server"));
  const to = launcher.findIndex((l, i) => i > from && l.startsWith("$target ="));
  assert.ok(from >= 0 && to > from, "kiosk-windows.ps1: no discovery loop found");
  const stub = [
    `$boundFile = '${dir}/bound-to'; $serverFile = '${dir}/server'; $id = 'dev-1'`,
    "function Get-MacAddress { @() }",
    "function Select-Reply($r, $b) { $r | Select-Object -First 1 }",
    "function Save-Binding($r, $b) { $false }",
    `function Start-Sleep { param($Seconds) Add-Content '${dir}/sleeps' $Seconds }`,
    "$script:n = 0",
    "function Send-Probe($probe) {",
    `  Add-Content '${dir}/probes' $probe`,
    "  $script:n++",
    `  if ($script:n -ge ${ANSWERED_ON}) { '${REPLY}' }`,
    "}",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "bound-to"), "srv-a");
  const script = path.join(dir, "loop.ps1");
  fs.writeFileSync(script, `${stub}\n${launcher.slice(from, to).join("\n")}\n`);
  const run = spawnSync("pwsh", ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n") : []);
  return { probes: read("probes"), sleeps: read("sleeps") };
}

/** Probe n (1-based) carries the flag from the 32nd, after thirty unanswered. */
const EXPECTED_FLAGS = Array.from({ length: ANSWERED_ON }, (_, i) => i + 1 > UNREACHABLE_AFTER + 1);
/** Sleep after unanswered probe n: 2 s for the first nine, 30 s after. */
const EXPECTED_SLEEPS = Array.from({ length: ANSWERED_ON - 1 }, (_, i) => (i + 1 < FAST_PROBES ? String(FAST_SECONDS) : String(SLOW_SECONDS)));

for (const [installer, tool] of [["install-linux.sh", "socat"], ["install-macos.sh", "nc"]] as const) {
  describe(`the ${installer} discovery loop`, () => {
    const boot = bootShell(installer, tool);

    it("sends unreachable from the 32nd probe, after thirty unanswered, and not before", () => {
      assert.equal(boot.probes.length, ANSWERED_ON);
      assert.deepEqual(boot.probes.map((p) => p.includes('"unreachable":true')), EXPECTED_FLAGS);
    });

    it("names the server it is bound to in every probe", () => {
      assert.ok(boot.probes.every((p) => p.includes('"boundTo":"srv-a"')));
    });

    it("waits 2 s between the first nine unanswered probes, then 30 s", () => {
      assert.deepEqual(boot.sleeps, EXPECTED_SLEEPS);
    });
  });
}

describe("the kiosk-windows.ps1 discovery loop", { skip: spawnSync("sh", ["-c", "command -v pwsh"]).status !== 0 && "pwsh is not installed" }, () => {
  const boot = bootWindows();

  it("sends unreachable from the 32nd probe, after thirty unanswered, and not before", () => {
    assert.equal(boot.probes.length, ANSWERED_ON);
    assert.deepEqual(boot.probes.map((p) => p.includes('"unreachable":true')), EXPECTED_FLAGS);
  });

  it("waits 2 s between the first nine unanswered probes, then 30 s", () => {
    assert.deepEqual(boot.sleeps, EXPECTED_SLEEPS);
  });
});

describe("the helper's copy of the probe cadence (Schedule.swift)", () => {
  const swift = text("helper/macos/Sources/StageUtilityOutputCore/Schedule.swift");
  /** The number assigned on a line that starts with the declaration, so a comment quoting it cannot satisfy this. */
  const assigned = (decl: string): number => {
    const found = [...swift.matchAll(new RegExp(`^[ \\t]*public static let ${decl} = ([0-9.]+)[ \\t]*$`, "gm"))];
    assert.equal(found.length, 1, `exactly one assignment of ${decl}, found ${found.length}`);
    return Number(found[0][1]);
  };

  for (const [name, decl, value] of [
    ["fastInterval", "fastInterval: TimeInterval", FAST_SECONDS],
    ["fastProbes", "fastProbes", FAST_PROBES],
    ["slowInterval", "slowInterval: TimeInterval", SLOW_SECONDS],
    ["unreachableAfter", "unreachableAfter", UNREACHABLE_AFTER],
  ] as const) {
    it(`${name} is ${value}, as the shell and PowerShell agents run it`, () => {
      assert.equal(assigned(decl), value);
    });
  }

  it("interval() reads its two rates and its count from those constants, not from literals", () => {
    assert.match(swift, /^[ \t]*return unanswered < fastProbes \? fastInterval : slowInterval$/m);
  });
});
