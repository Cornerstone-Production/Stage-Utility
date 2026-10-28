// The upgrade a Windows-hosted git checkout takes across the release that pins
// scripts/kiosk/kiosk-windows.ps1 `-text`, run with real git.
//
// A clone made with core.autocrlf=true has the launcher CRLF. Checking out the
// commit that adds the attribute, with the file's blob unchanged, leaves it CRLF
// and the tree dirty, which would stop every in-app update from then on. The
// fixture reproduces exactly that, then runs the real function, and the Updater
// test below shows the updater calls it before it refuses a dirty tree.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { restorePinnedLineEnds } from "./pinned-line-ends.js";
import { Updater } from "../updater.js";
import { APP_ROOT } from "../app-root.js";

let dir: string;
let clone: string;
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const LF = "Write-Output 'one'\nWrite-Output 'two'\n";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "su-pinned-"));
  const origin = path.join(dir, "origin");
  fs.mkdirSync(origin);
  git(origin, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(origin, "launcher.ps1"), LF);
  git(origin, ["add", "."]);
  git(origin, ["commit", "-q", "-m", "before the attribute"]);
  clone = path.join(dir, "clone");
  execFileSync("git", ["-c", "core.autocrlf=true", "clone", "-q", origin, clone]);
  git(clone, ["config", "core.autocrlf", "true"]);
  assert.match(fs.readFileSync(path.join(clone, "launcher.ps1"), "utf8"), /\r\n/, "the fixture's clone converted line ends");
  // The release that pins it, with the file's blob unchanged.
  fs.writeFileSync(path.join(origin, ".gitattributes"), "launcher.ps1 -text\n");
  git(origin, ["add", ".gitattributes"]);
  git(origin, ["commit", "-q", "-m", "pin it"]);
  git(clone, ["pull", "-q", "--ff-only"]);
  // git compares content only when a file's stat no longer matches the index
  // (or the entry is racily clean, as straight after a clone). A later touch is
  // what a server's tree meets sooner or later; made here so the fixture does not
  // depend on timing.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(clone, "launcher.ps1"), later, later);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const runner = async (args: string[]) => git(clone, args).trim();
const status = () => git(clone, ["status", "--porcelain"]).trim();

describe("restorePinnedLineEnds", () => {
  it("the upgrade leaves the pinned file CRLF and the tree dirty: the fixture, not the fix", () => {
    assert.equal(status(), "M launcher.ps1");
  });

  it("checks the file out again as its blob, and the tree is clean", async () => {
    assert.deepEqual(await restorePinnedLineEnds(runner), ["launcher.ps1"]);
    assert.equal(fs.readFileSync(path.join(clone, "launcher.ps1"), "utf8"), LF);
    assert.equal(status(), "");
  });

  it("leaves a pinned file with a real edit alone", async () => {
    fs.writeFileSync(path.join(clone, "launcher.ps1"), "Write-Output 'one'\r\nWrite-Output 'edited'\r\n");
    assert.deepEqual(await restorePinnedLineEnds(runner), []);
    assert.match(fs.readFileSync(path.join(clone, "launcher.ps1"), "utf8"), /edited/);
  });

  it("leaves a file that is not pinned alone, though only its line ends differ", async () => {
    // No attribute, and no conversion either, so the CRLF copy reads as modified.
    fs.writeFileSync(path.join(clone, ".gitattributes"), "");
    git(clone, ["update-index", "--assume-unchanged", ".gitattributes"]);
    git(clone, ["config", "core.autocrlf", "false"]);
    assert.notEqual(git(clone, ["diff", "--name-only"]).trim(), "", "the fixture: the file is modified");
    assert.deepEqual(await restorePinnedLineEnds(runner), []);
    assert.match(fs.readFileSync(path.join(clone, "launcher.ps1"), "utf8"), /\r\n/);
  });
});

describe("the updater", () => {
  for (const [label, act, refusal] of [
    ["an update", (u: Updater) => u.applyUpdate(), /before updating/],
    ["a track switch", (u: Updater) => u.switchTrack("beta"), /before switching tracks/],
  ] as const) {
  it(`restores pinned line ends before it refuses ${label} on a dirty tree`, async () => {
    const calls: string[] = [];
    let restored = false;
    const fake = async (args: string[]): Promise<string> => {
      const a = args.join(" ");
      calls.push(a);
      if (a === "rev-parse --show-toplevel") return APP_ROOT;
      if (a === "rev-parse --abbrev-ref HEAD") return "main";
      if (a === "status --porcelain") return restored ? "M something-else.ts" : "M scripts/kiosk/kiosk-windows.ps1";
      if (a === "diff --name-only --diff-filter=M") return restored ? "something-else.ts" : "scripts/kiosk/kiosk-windows.ps1";
      if (a === "check-attr text -- scripts/kiosk/kiosk-windows.ps1") return "scripts/kiosk/kiosk-windows.ps1: text: unset";
      if (a === "checkout -- scripts/kiosk/kiosk-windows.ps1") {
        restored = true;
        return "";
      }
      if (a.startsWith("tag --list")) return "v1.0.0";
      if (a.startsWith("describe")) return "v1.0.0";
      return "";
    };
    const u = new Updater({ git: fake, fetchReleases: async () => [], version: () => "1.0.0" });
    const s = await u.checkForUpdate();
    assert.equal(s.isGitRepo, true, "the fixture is a checkout");
    await assert.rejects(act(u), refusal);
    const checkout = calls.indexOf("checkout -- scripts/kiosk/kiosk-windows.ps1");
    assert.ok(checkout >= 0, calls.join("\n"));
    assert.ok(calls.lastIndexOf("status --porcelain") > checkout, "the dirty check reads the tree after the restore");
  });
  }
});
