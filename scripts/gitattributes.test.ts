// A file the release signs from the tree is checked out byte for byte, everywhere.
//
// A server serves scripts/kiosk/kiosk-windows.ps1 from its own checkout, and the
// release signs the blob in the tagged tree. A checkout that converted line ends
// (Git for Windows defaults to core.autocrlf=true) would serve bytes no signature
// covers, and every Windows kiosk would refuse every launcher from that server.
//
// So this asks git itself what a checkout would write: `git cat-file --filters`
// applies the same end-of-line conversion a checkout does, under each setting a
// machine might have, and the result must be the blob. The files are read from
// the release workflow's signing step, so a payload signed from the tree and not
// pinned in .gitattributes goes red.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = path.join(REPO, ".github", "workflows", "release.yml");

/** The payloads the signing step names that live in the tree (not build output). */
function signedFromTree(): string[] {
  const jobs = (parse(fs.readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> }).jobs;
  const step = jobs["artifacts"].steps?.find((s) => s.name === "Sign the update payloads");
  assert.ok(step?.run, "no signing step in the artifacts job");
  const m = /payloads=\(([^)]*)\)/.exec(step.run);
  assert.ok(m, "the signing step no longer starts its list as payloads=(...)");
  return m[1].split(/\s+/).filter((p) => p.startsWith("scripts/"));
}

const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });

describe("files the release signs from the tree", () => {
  it("are the Windows launcher", () => {
    assert.deepEqual(signedFromTree(), ["scripts/kiosk/kiosk-windows.ps1"]);
  });

  for (const file of signedFromTree()) {
    it(`${file} is checked out as its blob, whatever the machine's end-of-line settings`, () => {
      const blob = git(["cat-file", "blob", `HEAD:${file}`]);
      assert.equal(blob.status, 0, blob.stderr.toString());
      for (const config of [["core.autocrlf=true"], ["core.autocrlf=input"], ["core.autocrlf=false", "core.eol=crlf"]]) {
        const out = git([...config.flatMap((c) => ["-c", c]), "cat-file", "--filters", `HEAD:${file}`]);
        assert.equal(out.status, 0, out.stderr.toString());
        assert.ok(out.stdout.equals(blob.stdout), `with ${config.join(" ")}, a checkout of ${file} is not the signed blob (${out.stdout.length} bytes, not ${blob.stdout.length}); pin it with -text in .gitattributes`);
      }
    });
  }
});
