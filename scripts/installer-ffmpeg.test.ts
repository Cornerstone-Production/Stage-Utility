// install_ffmpeg, from install.sh and scripts/install.sh, run for real against
// stand-in package managers. The function is best effort by design: whatever a
// package manager does, it returns 0, because a failed ffmpeg must never fail
// an install (video works without it).
//
// The two scripts carry the same function; this extracts each from its own source
// so a fix to one that the other lacks fails here. install.ps1 is PowerShell and
// is not run: it is only checked for the winget command and for being guarded.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = { "install.sh": path.join(HERE, "..", "install.sh"), "scripts/install.sh": path.join(HERE, "install.sh") };

function functionText(file: string): string {
  const m = /^install_ffmpeg\(\) \{\n[\s\S]*?\n\}\n/m.exec(fs.readFileSync(file, "utf8"));
  assert.ok(m, `install_ffmpeg is not defined at the top level of ${file}`);
  return m[0];
}

let bin = "";
let calls = "";
beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "su-ffmpeg-inst-"));
  calls = path.join(bin, "calls.log");
  // The one real tool the function uses besides builtins.
  fs.symlinkSync(spawnSync("sh", ["-c", "command -v tail"], { encoding: "utf8" }).stdout.trim(), path.join(bin, "tail"));
  stub("id", `echo 0`);
});
afterEach(() => fs.rmSync(bin, { recursive: true, force: true }));

/** A command on the stand-in PATH. `body` is shell; $@ is what it was given. */
function stub(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
/** A package manager that logs its arguments and then answers `answer` (a shell command). */
function manager(name: string, answer: string): void {
  stub(name, `echo "${name} $*" >> "${calls}"\n${answer}`);
}
const called = (): string[] => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);

function run(file: string): { status: number | null; out: string } {
  const script = `log() { echo "log: $*"; }\nwarn() { echo "warn: $*"; }\n${functionText(file)}\nset -euo pipefail\ninstall_ffmpeg\necho reached-the-end`;
  const r = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { PATH: bin } });
  return { status: r.status, out: r.stdout + r.stderr };
}

for (const [label, file] of Object.entries(SCRIPTS)) {
  describe(`install_ffmpeg in ${label}`, () => {
    it("installs with apt-get when that is what the machine has", () => {
      manager("apt-get", "exit 0");
      const r = run(file);
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(called(), ["apt-get install -y ffmpeg"]);
      assert.match(r.out, /ffmpeg installed/);
    });

    it("refreshes the package lists and tries once more when the first apt-get install fails", () => {
      stub("apt-get", `echo "apt-get $*" >> "${calls}"\nif [ "$1" = update ]; then exit 0; fi\nif [ -f "${bin}/updated" ]; then exit 0; fi\ntouch "${bin}/updated"; exit 100`);
      const r = run(file);
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(called(), ["apt-get install -y ffmpeg", "apt-get update", "apt-get install -y ffmpeg"]);
    });

    it("never fails the install when the package manager does: it says why and carries on", () => {
      manager("apt-get", `echo "E: Unable to locate package ffmpeg"; exit 100`);
      const r = run(file);
      assert.equal(r.status, 0, "an ffmpeg failure failed the installer");
      assert.match(r.out, /warn: Could not install ffmpeg: E: Unable to locate package ffmpeg/);
      assert.match(r.out, /reached-the-end/);
    });

    it("uses dnf, falling back to ffmpeg-free", () => {
      manager("dnf", `case "$*" in *ffmpeg-free*) exit 0;; *) exit 1;; esac`);
      const r = run(file);
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(called(), ["dnf install -y ffmpeg", "dnf install -y ffmpeg-free"]);
    });

    it("uses pacman", () => {
      manager("pacman", "exit 0");
      const r = run(file);
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(called(), ["pacman -S --noconfirm --needed ffmpeg"]);
    });

    it("says so, and carries on, when there is no package manager it knows", () => {
      const r = run(file);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /warn: No apt-get, dnf or pacman found/);
    });

    it("does nothing when ffmpeg is already installed", () => {
      stub("ffmpeg", "exit 0");
      manager("apt-get", "exit 0");
      const r = run(file);
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(called(), []);
    });

    it("does not try to install without the rights to", () => {
      stub("id", "echo 1000");
      manager("apt-get", "exit 0");
      const r = run(file);
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(called(), []);
      assert.match(r.out, /warn: ffmpeg is not installed and this is not running as root/);
    });
  });
}

describe("the two installers", () => {
  it("carry the same install_ffmpeg", () => {
    assert.equal(functionText(SCRIPTS["install.sh"]), functionText(SCRIPTS["scripts/install.sh"]));
  });
  it("both call it", () => {
    for (const [label, file] of Object.entries(SCRIPTS)) {
      assert.match(fs.readFileSync(file, "utf8"), /^ {0,2}install_ffmpeg$/m, `${label} defines install_ffmpeg and never calls it`);
    }
  });
});

describe("install.ps1", () => {
  const ps1 = fs.readFileSync(path.join(HERE, "..", "install.ps1"), "utf8");
  // PowerShell is not run here, so this reads the source: the command, that it is
  // only tried when winget exists, and that its failure is caught, not thrown.
  const block = /\$wingetOut = (winget install [^\n]*)/.exec(ps1);
  it("installs Gyan.FFmpeg with winget", () => {
    assert.ok(block, "no winget install of ffmpeg");
    assert.match(block[1]!, /^winget install --id Gyan\.FFmpeg -e /);
  });
  it("only when winget exists, and a failure is a warning inside try/catch", () => {
    const i = ps1.indexOf("$wingetOut =");
    const before = ps1.slice(0, i);
    assert.ok(before.lastIndexOf("Get-Command winget") > before.lastIndexOf("Register it") - 3000, "winget is not checked first");
    assert.ok(before.lastIndexOf("try {") > before.lastIndexOf("Get-Command winget"), "the winget call is not inside try");
    assert.match(ps1.slice(i, i + 900), /\} catch \{\s*\n\s*Write-Host "warn: could not install ffmpeg/);
  });
});
