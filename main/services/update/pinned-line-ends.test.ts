// The upgrade a Windows-hosted git checkout takes across the release that pins
// scripts/kiosk/kiosk-windows.ps1 `-text`, run with real git.
//
// A clone made with core.autocrlf=true has the launcher CRLF. Checking out the
// commit that adds the attribute, with the file's blob unchanged, leaves it CRLF
// and the tree dirty, which would stop every in-app update from then on. The
// fixture reproduces exactly that, then runs the real function against it. The
// comparison is pinned to "CRLF made LF, then byte for byte": a looser one (git's
// --ignore-cr-at-eol or --ignore-space-at-eol) would discard a removed final
// newline or a trailing space, which are edits. The Updater tests below show the
// updater calls it, reports what it did and what failed, and still refuses a tree
// that stays dirty.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { pinnedDepsFor, restorePinnedLineEnds, type PinnedDeps } from "./pinned-line-ends.js";
import { Updater } from "../updater.js";
import { APP_ROOT } from "../app-root.js";

let dir: string;
let clone: string;
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const LF = "Write-Output 'one'\nWrite-Output 'two'\n";
const FILES = ["launcher.ps1", "second.ps1"];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "su-pinned-"));
  const origin = path.join(dir, "origin");
  fs.mkdirSync(origin);
  git(origin, ["init", "-q", "-b", "main"]);
  for (const f of FILES) fs.writeFileSync(path.join(origin, f), LF);
  git(origin, ["add", "."]);
  git(origin, ["commit", "-q", "-m", "before the attribute"]);
  clone = path.join(dir, "clone");
  execFileSync("git", ["-c", "core.autocrlf=true", "clone", "-q", origin, clone]);
  git(clone, ["config", "core.autocrlf", "true"]);
  assert.match(fs.readFileSync(path.join(clone, "launcher.ps1"), "utf8"), /\r\n/, "the fixture's clone converted line ends");
  // The release that pins them, with the files' blobs unchanged.
  fs.writeFileSync(path.join(origin, ".gitattributes"), FILES.map((f) => `${f} -text\n`).join(""));
  git(origin, ["add", ".gitattributes"]);
  git(origin, ["commit", "-q", "-m", "pin them"]);
  git(clone, ["pull", "-q", "--ff-only"]);
  // git compares content only when a file's stat no longer matches the index
  // (or the entry is racily clean, as straight after a clone). A later touch is
  // what a server's tree meets sooner or later; made here so the fixture does not
  // depend on timing.
  const later = new Date(Date.now() + 5000);
  for (const f of FILES) fs.utimesSync(path.join(clone, f), later, later);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const real = (): PinnedDeps => pinnedDepsFor(clone);
const status = () => git(clone, ["status", "--porcelain"]).trim();
const read = (f: string) => fs.readFileSync(path.join(clone, f), "utf8");
const edit = (f: string, text: string) => {
  fs.writeFileSync(path.join(clone, f), text);
  const later = new Date(Date.now() + 9000);
  fs.utimesSync(path.join(clone, f), later, later);
};

describe("restorePinnedLineEnds", () => {
  it("the upgrade leaves the pinned files CRLF and the tree dirty: the fixture, not the fix", () => {
    assert.equal(status(), "M launcher.ps1\n M second.ps1");
  });

  it("checks each file out again as its blob, and the tree is clean", async () => {
    assert.deepEqual(await restorePinnedLineEnds(real()), { restored: FILES, failed: [] });
    for (const f of FILES) assert.equal(read(f), LF);
    assert.equal(status(), "");
  });

  for (const [label, text] of [
    ["a changed line", "Write-Output 'one'\r\nWrite-Output 'edited'\r\n"],
    ["only a trailing space added", "Write-Output 'one' \r\nWrite-Output 'two'\r\n"],
    ["only its final newline removed", "Write-Output 'one'\r\nWrite-Output 'two'"],
  ] as const) {
    it(`leaves a pinned file with ${label} alone, and still restores the other`, async () => {
      edit("launcher.ps1", text);
      assert.deepEqual(await restorePinnedLineEnds(real()), { restored: ["second.ps1"], failed: [] });
      assert.equal(read("launcher.ps1"), text);
    });
  }

  it("leaves a file that is not pinned alone, though only its line ends differ", async () => {
    // No attribute, and no conversion either, so the CRLF copies read as modified.
    fs.writeFileSync(path.join(clone, ".gitattributes"), "");
    git(clone, ["update-index", "--assume-unchanged", ".gitattributes"]);
    git(clone, ["config", "core.autocrlf", "false"]);
    assert.notEqual(git(clone, ["diff", "--name-only"]).trim(), "", "the fixture: the files are modified");
    assert.deepEqual(await restorePinnedLineEnds(real()), { restored: [], failed: [] });
    assert.match(read("launcher.ps1"), /\r\n/);
  });

  it("goes on to the next path when one fails, and returns why", async () => {
    const deps = real();
    const failing: PinnedDeps = {
      ...deps,
      git: (args) => (args[0] === "check-attr" && args.at(-1) === "launcher.ps1" ? Promise.reject(new Error("check-attr broke")) : deps.git(args)),
    };
    assert.deepEqual(await restorePinnedLineEnds(failing), { restored: ["second.ps1"], failed: [{ file: "launcher.ps1", error: "check-attr broke" }] });
  });

  it("returns why when the modified files cannot be listed", async () => {
    const r = await restorePinnedLineEnds({ git: () => Promise.reject(new Error("not a git repository")), readFile: () => Promise.reject(new Error("unused")) });
    assert.deepEqual(r, { restored: [], failed: [{ file: "", error: "not a git repository" }] });
  });

  it("reads a path with spaces exactly", async () => {
    const origin = path.join(dir, "origin");
    fs.writeFileSync(path.join(origin, " spaced name.ps1"), LF);
    fs.appendFileSync(path.join(origin, ".gitattributes"), '" spaced name.ps1" -text\n');
    git(origin, ["add", "."]);
    git(origin, ["commit", "-q", "-m", "spaced"]);
    git(clone, ["config", "core.autocrlf", "false"]);
    git(clone, ["reset", "-q", "--hard"]);
    git(clone, ["pull", "-q", "--ff-only"]);
    edit(" spaced name.ps1", LF.replace(/\n/g, "\r\n"));
    const r = await restorePinnedLineEnds(real());
    assert.ok(r.restored.includes(" spaced name.ps1"), JSON.stringify(r));
    assert.equal(read(" spaced name.ps1"), LF);
  });
});

describe("the updater", () => {
  /** git as a checkout on main answers it, with a tree that stays dirty. */
  const fakeGit = (calls: string[]) => async (args: string[]): Promise<string> => {
    const a = args.join(" ");
    calls.push(a);
    if (a === "rev-parse --show-toplevel") return APP_ROOT;
    if (a === "rev-parse --abbrev-ref HEAD") return "main";
    if (a === "status --porcelain") return "M something-else.ts";
    if (a.startsWith("tag --list")) return "v1.0.0";
    if (a.startsWith("describe")) return "v1.0.0";
    return "";
  };

  for (const [label, act, refusal] of [
    ["an update", (u: Updater) => u.applyUpdate(), /before updating/],
    ["a track switch", (u: Updater) => u.switchTrack("beta"), /before switching tracks/],
  ] as const) {
    it(`restores pinned line ends, says what it did and what failed, then refuses ${label} on a tree still dirty`, async (t) => {
      const lines: string[] = [];
      t.mock.method(console, "log", (...a: unknown[]) => lines.push(a.map(String).join(" ")));
      const calls: string[] = [];
      const pinnedCalls: string[] = [];
      const pinned: PinnedDeps = {
        git: async (args) => {
          pinnedCalls.push(args.join(" "));
          if (args[0] === "diff") return Buffer.from("scripts/kiosk/kiosk-windows.ps1\0broken.ps1\0");
          if (args[0] === "check-attr" && args.at(-1) === "broken.ps1") throw new Error("check-attr broke");
          if (args[0] === "check-attr") return Buffer.from(`${args.at(-1)}\0text\0unset\0`);
          if (args[0] === "rev-parse" && args[1] === "--show-object-format") return Buffer.from("sha1\n");
          // The blob id of "x\n".
          if (args[0] === "rev-parse") return Buffer.from("587be6b4c3f93f93c489c0111bba5596147a26cb\n");
          return Buffer.alloc(0);
        },
        readFile: async () => Buffer.from("x\r\n"),
      };
      const u = new Updater({ git: fakeGit(calls), pinned, fetchReleases: async () => [], version: () => "1.0.0" });
      assert.equal((await u.checkForUpdate()).isGitRepo, true, "the fixture is a checkout");
      await assert.rejects(act(u), refusal);
      assert.ok(pinnedCalls.includes("checkout -- scripts/kiosk/kiosk-windows.ps1"), pinnedCalls.join("\n"));
      assert.ok(lines.some((l) => l.startsWith("[updater] checked out scripts/kiosk/kiosk-windows.ps1 again")), lines.join("\n"));
      assert.ok(lines.includes("[updater] could not check broken.ps1 for line ends .gitattributes pins: check-attr broke"), lines.join("\n"));
      assert.ok(calls.includes("status --porcelain"), "the dirty check still ran");
    });
  }
});
