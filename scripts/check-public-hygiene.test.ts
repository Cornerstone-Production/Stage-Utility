// The public-hygiene scan, run for real over a throwaway git repository.
//
// Every violation below is planted in a file of a temp repo, and the scan is
// asserted against the EXACT sorted list of what it reports. A count would not
// notice one finding swapped for another.
//
// This file is itself scanned by the guard (it is tracked), so no violation is
// written out literally here: each is assembled from pieces at run time. A
// literal private address in a test about private addresses would fail CI on its
// own test.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findViolations, formatFinding, listTrackedFiles, loadPrivateTerms } from "./check-public-hygiene.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-public-hygiene.mjs");

const ip = (...octets: number[]) => octets.join(".");
const email = (local: string, domain: string) => `${local}@${domain}`;
const unixHome = (root: string, user: string) => `/${root}/${user}`;
const winHome = (user: string) => ["C:", "Users", user].join("\\");

const made: string[] = [];

/** A git repo whose index holds `tracked`; `untracked` is written but never added. */
function makeRepo(tracked: Record<string, string | Buffer>, untracked: Record<string, string> = {}, ignored = ""): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-test-"));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(tracked)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  for (const [name, content] of Object.entries(untracked)) fs.writeFileSync(path.join(dir, name), content);
  if (ignored) fs.writeFileSync(path.join(dir, ".private-terms"), ignored);
  return dir;
}

after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// Line numbers below are the line's position in this array.
const NOTES = [
  /* 1 */ `server at ${ip(192, 168, 16, 61)} here`,
  /* 2 */ `fine: ${ip(192, 168, 1, 50)} and ${ip(10, 0, 0, 5)} and ${ip(192, 168, 0, 123)}`,
  /* 3 */ `${ip(172, 16, 5, 4)} is private; ${ip(172, 32, 0, 1)} is not`,
  /* 4 */ `version v${ip(1, 10, 0, 1)} and ${ip(110, 0, 0, 1)} are not addresses`,
  /* 5 */ `reach ${email("jane.doe", "corp.com")} or ${email("someone", "example.org")} or ${email("x", "test.example")}`,
  /* 6 */ `${email("git", "github.com")}:o/r.git, actions/checkout@v7.0.1, ${email("noreply", "anthropic.com")}`,
  /* 7 */ `data in ${unixHome("Users", "jane")}/Library`,
  /* 8 */ `${unixHome("Users", "someone")}/x ${unixHome("home", "pi")}/.cfg app${unixHome("home", "cards")} ${winHome("x")}\\y`,
  /* 9 */ `${unixHome("home", "jdoe")}/bin and ${winHome("jdoe")}\\Desktop`,
  /* 10 */ `${ip(10, 9, 9, 9)} hygiene-allow: a documented example`,
  /* 11 */ "The Foo Bar Church",
].join("\n");

const TERMS = ["foo bar", "never-appears", "CHURCH", "zebra"];

const PLANTED = {
  "notes/a.md": NOTES,
  // A private term in a file NAME is as public as one in its content.
  "notes/zebra-room.md": "nothing inside\n",
  // Binary: a NUL in the first 8 KB. The address inside must not be read.
  "bin/blob.dat": Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(`${ip(192, 168, 16, 61)} Foo Bar`)]),
  // Lockfiles are skipped whatever they contain.
  "package-lock.json": `{"resolved": "http://${ip(192, 168, 16, 61)}/x"}`,
};

describe("findViolations over a real git repo", () => {
  let repo: string;
  before(() => {
    repo = makeRepo(PLANTED, { "untracked.md": `${ip(192, 168, 16, 61)} Foo Bar\n` });
  });

  it("reports exactly these findings, sorted", () => {
    const { root, files } = listTrackedFiles(repo);
    const got = findViolations(root, files, TERMS).map(formatFinding);
    assert.deepEqual(got, [
      // The file name is printed with the term blanked, and "*" sorts first.
      "notes/***-room.md:0: private term #4",
      `notes/a.md:1: private IPv4 ${ip(192, 168, 16, 61)}`,
      `notes/a.md:3: private IPv4 ${ip(172, 16, 5, 4)}`,
      `notes/a.md:5: email address ${email("jane.doe", "corp.com")}`,
      `notes/a.md:7: home path ${unixHome("Users", "jane")}`,
      `notes/a.md:9: home path ${unixHome("home", "jdoe")}`,
      `notes/a.md:9: home path ${winHome("jdoe")}`,
      "notes/a.md:11: private term #1",
      "notes/a.md:11: private term #3",
    ]);
  });

  it("never prints the term itself", () => {
    const { root, files } = listTrackedFiles(repo);
    const printed = findViolations(root, files, TERMS).map(formatFinding).join("\n").toLowerCase();
    for (const t of TERMS) assert.ok(!printed.includes(t.toLowerCase()), `the output contains the secret term "${t}"`);
  });

  it("does not scan an untracked file, a binary, or a lockfile", () => {
    const { root, files } = listTrackedFiles(repo);
    assert.ok(!files.includes("untracked.md"), "git ls-files listed an untracked file");
    const from = findViolations(root, files, TERMS).map((f) => f.file);
    for (const skipped of ["untracked.md", "bin/blob.dat", "package-lock.json"]) {
      assert.ok(!from.includes(skipped), `${skipped} was scanned`);
    }
  });
});

describe("the command line", () => {
  const run = (repo: string, env: Record<string, string> = {}) => {
    const clean = { ...process.env };
    delete clean.PRIVATE_TERMS;
    const r = spawnSync(process.execPath, [SCRIPT, repo], { encoding: "utf8", env: { ...clean, ...env } });
    return { status: r.status, lines: r.stdout.split("\n").filter(Boolean), stderr: r.stderr };
  };

  it("with no term list: says so, checks the generic rules, and still fails on them", () => {
    const repo = makeRepo({ "notes/a.md": NOTES });
    const r = run(repo);
    assert.equal(r.status, 1);
    assert.deepEqual(r.lines, [
      "[hygiene] PRIVATE_TERMS not set; checking generic rules only",
      `notes/a.md:1: private IPv4 ${ip(192, 168, 16, 61)}`,
      `notes/a.md:3: private IPv4 ${ip(172, 16, 5, 4)}`,
      `notes/a.md:5: email address ${email("jane.doe", "corp.com")}`,
      `notes/a.md:7: home path ${unixHome("Users", "jane")}`,
      `notes/a.md:9: home path ${unixHome("home", "jdoe")}`,
      `notes/a.md:9: home path ${winHome("jdoe")}`,
    ]);
  });

  it("with PRIVATE_TERMS: numbers the match, never prints it, and exits 1", () => {
    const repo = makeRepo({ "docs/b.md": "ordinary text\nthe Quokka sanctuary\n" });
    const r = run(repo, { PRIVATE_TERMS: "  \nplatypus\n  quokka  \n\n" });
    assert.equal(r.status, 1);
    assert.deepEqual(r.lines, ["docs/b.md:2: private term #2"]);
    assert.ok(!(r.lines.join("") + r.stderr).toLowerCase().includes("quokka"), "the term leaked into the output");
  });

  it("reads a local .private-terms file after the environment's entries", () => {
    const repo = makeRepo({ "docs/b.md": "the Quokka sanctuary\n" }, {}, "quokka\n");
    const r = run(repo, { PRIVATE_TERMS: "platypus" });
    assert.deepEqual(r.lines, ["docs/b.md:1: private term #2"]);
    assert.equal(r.status, 1);
  });

  it("a clean repo passes", () => {
    const repo = makeRepo({ "docs/b.md": `fine: ${ip(192, 168, 1, 50)}, ${email("someone", "example.org")}\n` });
    const r = run(repo);
    assert.equal(r.status, 0);
    assert.deepEqual(r.lines, ["[hygiene] PRIVATE_TERMS not set; checking generic rules only"]);
  });
});

describe("loadPrivateTerms", () => {
  it("trims, drops blank lines, and puts the environment before the file", () => {
    const repo = makeRepo({ "a.txt": "x\n" }, {}, " from-file \n\n");
    assert.deepEqual(loadPrivateTerms(" from-env \n\n second ", repo), ["from-env", "second", "from-file"]);
    assert.deepEqual(loadPrivateTerms(undefined, repo), ["from-file"]);
    assert.deepEqual(loadPrivateTerms("", makeRepo({ "a.txt": "x\n" })), []);
  });
});
