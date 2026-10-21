// One shape for a server address, in four places.
//
// Root on a Mac and SYSTEM on a Windows PC decide which server they install
// software from by whether an address looks like a server root, and the server
// decides what it stamps into an installer the same way. The rule is written once
// per language: HOST_RE (TypeScript, the stamping), is_origin (install-macos.sh,
// the Mac updater), and $OriginPattern in kiosk-update-windows.ps1 and
// install-windows.ps1. Copies drift; this runs every one of them, for real, against
// one list, so a copy that admits what the others refuse is red.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { originFromHost } from "../main/services/kiosk-installer-origin.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIOSK = path.join(HERE, "kiosk");
const has = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

const ACCEPT = [
  "http://192.0.2.10:8788",
  "http://stage.local",
  "https://stage-utility.example.org:8443",
  "http://[fd00::1]:8788",
  "http://a",
];
const REJECT = [
  "http://-leading-dash.example",
  "http://trailing-.example",
  "http://two..dots",
  "http://host:port",
  "http://host:123456",
  "http://host/path",
  "http://host:8788/",
  'http://x"; id; "',
  "http://a b",
  "http://$(id)",
  "file:///etc/passwd",
  "ftp://host",
  "http://",
  "",
];

/** The TypeScript rule: a host[:port] that HOST_RE admits, behind http(s)://. */
function typescript(origin: string): boolean {
  const m = /^https?:\/\/(.*)$/.exec(origin);
  return m !== null && originFromHost(m[1], false) !== null;
}

/** install-macos.sh's is_origin, sourced and run. */
function shell(origins: string[]): boolean[] {
  const script = path.join(KIOSK, "install-macos.sh");
  const r = spawnSync("sh", ["-c", `. "${script}"; for o in "$@"; do if is_origin "$o"; then echo yes; else echo no; fi; done`, "sh", ...origins], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", STAGE_INSTALL_SOURCED: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").map((l) => l === "yes");
}

/** A script's $OriginPattern line, exactly as written. */
function pattern(file: string): string {
  const line = fs.readFileSync(path.join(KIOSK, file), "utf8").split(/\r?\n/).filter((l) => l.startsWith("$OriginPattern = '"));
  assert.equal(line.length, 1, `${file} has ${line.length} $OriginPattern lines`);
  return line[0].slice("$OriginPattern = '".length, -1);
}

/** That pattern, run by PowerShell's own -match. */
function powershell(pat: string, origins: string[]): boolean[] {
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", `$p = $env:PAT; $input | ForEach-Object { if ($_ -match $p) { 'yes' } else { 'no' } }`], {
    encoding: "utf8",
    env: { ...process.env, PAT: pat },
    input: origins.join("\n") + "\n",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split(/\r?\n/).map((l) => l === "yes");
}

const ALL = [...ACCEPT, ...REJECT];
const expected = ALL.map((o) => ACCEPT.includes(o));

describe("a server address is the same shape everywhere", () => {
  it("in the server's HOST_RE", () => {
    assert.deepEqual(ALL.map(typescript), expected);
  });

  it("in install-macos.sh's is_origin", () => {
    assert.deepEqual(shell(ALL), expected);
  });

  it("in both Windows scripts, which carry the same pattern", { skip: !has("pwsh") && "pwsh is not installed" }, () => {
    const update = pattern("kiosk-update-windows.ps1");
    assert.equal(pattern("install-windows.ps1"), update, "the two Windows scripts' patterns differ");
    // An empty line cannot be piped through as an item, so it is checked apart.
    const piped = ALL.filter((o) => o !== "");
    assert.deepEqual(powershell(update, piped), piped.map((o) => ACCEPT.includes(o)));
    assert.equal(new RegExp(update).test(""), false);
  });
});
