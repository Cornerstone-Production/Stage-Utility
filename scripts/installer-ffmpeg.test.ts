// install_ffmpeg in install.sh and scripts/install.sh, and Install-Ffmpeg in install.ps1,
// run for real against stand-in package managers. Each is best effort by design:
// whatever a package manager does, the install carries on, because video works
// without ffmpeg.
//
// The two shell scripts carry the same function, asserted identical once; the matrix
// then runs against one. install.ps1 runs under pwsh when it is installed; without
// it these are skipped, or fail under UPDATE_REQUIRE_PWSH=1.

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

{
  const file = SCRIPTS["install.sh"];
  describe("install_ffmpeg", () => {
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

describe("the two shell installers", () => {
  it("carry the same install_ffmpeg", () => {
    assert.equal(functionText(SCRIPTS["install.sh"]), functionText(SCRIPTS["scripts/install.sh"]));
  });
  it("both call it", () => {
    for (const [label, file] of Object.entries(SCRIPTS)) {
      assert.match(fs.readFileSync(file, "utf8"), /^ {0,2}install_ffmpeg$/m, `${label} defines install_ffmpeg and never calls it`);
    }
  });
});

const PS1 = path.join(HERE, "..", "install.ps1");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
const hasPwsh = pwsh.status === 0;
if (!hasPwsh && process.env.UPDATE_REQUIRE_PWSH === "1") throw new Error("UPDATE_REQUIRE_PWSH=1 but pwsh is not installed");

describe("Install-Ffmpeg in install.ps1", { skip: hasPwsh ? false : "pwsh is not installed" }, () => {
  function ps1Function(): string {
    const m = /^function Install-Ffmpeg \{\n[\s\S]*?\n\}\n/m.exec(fs.readFileSync(PS1, "utf8"));
    assert.ok(m, "Install-Ffmpeg is not defined at the top level of install.ps1");
    return m[0];
  }
  /** Runs the function under `$ErrorActionPreference = "Stop"`, as the installer does,
   *  with a PATH holding nothing, `winget` and `ffmpeg` being whatever `stubs` defines. */
  function run(stubs: string): { status: number | null; out: string } {
    const script = [
      '$ErrorActionPreference = "Stop"',
      "$env:PATH = $env:TEMP_EMPTY",
      "$global:calls = @()",
      'function Say($m) { Write-Host "SAY $m" }',
      'function Log($m) { Write-Host "LOG $m" }',
      stubs,
      ps1Function(),
      "Install-Ffmpeg",
      'Write-Host "END calls=$($global:calls -join \';\')"',
    ].join("\n");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "su-ps1-"));
    try {
      const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...process.env, TEMP_EMPTY: empty } });
      return { status: r.status, out: r.stdout + r.stderr };
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }
  const winget = (body: string) => `function winget { $global:calls += ($args -join ' '); ${body} }`;

  it("installs Gyan.FFmpeg with winget when winget exists", () => {
    const r = run(winget("$global:LASTEXITCODE = 0"));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /END calls=install --id Gyan\.FFmpeg -e /);
    assert.match(r.out, /LOG ffmpeg installed/);
  });
  it("says so and carries on when winget is not there", () => {
    const r = run("");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /warn: winget was not found/);
    assert.match(r.out, /END calls=$/m);
  });
  it("judges winget by its exit code: an error record on stderr with exit 0 is a success", () => {
    const r = run(winget('Write-Error "progress"; $global:LASTEXITCODE = 0'));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /LOG ffmpeg installed/);
    assert.doesNotMatch(r.out, /could not install/);
  });
  it("warns, and still finishes, when winget fails", () => {
    const r = run(winget("$global:LASTEXITCODE = 1"));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /warn: could not install ffmpeg \(winget exit 1\)/);
    assert.match(r.out, /END/);
  });
  it("warns, and still finishes, when winget throws", () => {
    const r = run(winget('throw "boom"'));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /warn: could not install ffmpeg: boom/);
    assert.match(r.out, /END/);
  });
  it("does nothing when ffmpeg is already installed", () => {
    const r = run(`function ffmpeg { }\n${winget("$global:LASTEXITCODE = 0")}`);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /LOG ffmpeg is already installed/);
    assert.match(r.out, /END calls=$/m);
  });
  it("is called by the installer, after the update swap has returned", () => {
    const text = fs.readFileSync(PS1, "utf8");
    const call = text.search(/^ {2}Install-Ffmpeg$/m);
    assert.ok(call > 0, "the installer never calls Install-Ffmpeg");
    assert.ok(call > text.indexOf('$env:STAGE_UPDATE_MODE -eq "swap"'), "an update swap would install packages");
  });
});
