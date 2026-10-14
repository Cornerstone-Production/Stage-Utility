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
//
// Every rule here was proved red by a scratch edit of the script that reintroduces
// the bug it guards (see the commit that added the case). Two behaviours cannot be
// made red and are tested only as documentation: a CRLF line ending in a SOURCE
// file (every rule's pattern already stops at whitespace, so splitting on "\n"
// changes nothing), and the symlink target being read through a tracked symlink
// to a directory.

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
const winHome = (user: string, sep = "\\") => ["C:", "Users", user].join(sep);

const made: string[] = [];

interface RepoOptions {
  /** Written but never `git add`ed. */
  untracked?: Record<string, string>;
  /** Contents of a `.private-terms` file at the root. */
  privateTerms?: string;
  /** Tracked symlinks: name -> absolute target. */
  links?: Record<string, string>;
  /** Deleted from the working tree after being added to the index. */
  removeAfterAdd?: string[];
}

/** A git repo whose index holds `tracked`. */
function makeRepo(tracked: Record<string, string | Buffer>, opts: RepoOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-test-"));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(tracked)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  for (const [name, target] of Object.entries(opts.links ?? {})) fs.symlinkSync(target, path.join(dir, name));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  for (const name of opts.removeAfterAdd ?? []) fs.rmSync(path.join(dir, name));
  for (const [name, content] of Object.entries(opts.untracked ?? {})) fs.writeFileSync(path.join(dir, name), content);
  if (opts.privateTerms !== undefined) fs.writeFileSync(path.join(dir, ".private-terms"), opts.privateTerms);
  return dir;
}

after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const scan = (repo: string, terms: string[] = [], skipped: { file: string; line: number }[] = []) => {
  const { root, files } = listTrackedFiles(repo);
  return findViolations(root, files, terms, skipped).map(formatFinding);
};

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
    repo = makeRepo(PLANTED, { untracked: { "untracked.md": `${ip(192, 168, 16, 61)} Foo Bar\n` } });
  });

  it("reports exactly these findings, sorted", () => {
    const got = scan(repo, TERMS);
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
    const printed = scan(repo, TERMS).join("\n").toLowerCase();
    for (const t of TERMS) assert.ok(!printed.includes(t.toLowerCase()), `the output contains the secret term "${t}"`);
  });

  it("does not scan an untracked file, a binary, or a lockfile", () => {
    const { files } = listTrackedFiles(repo);
    assert.ok(!files.includes("untracked.md"), "git ls-files listed an untracked file");
    const from = scan(repo, TERMS).join("\n");
    for (const skipped of ["untracked.md", "bin/blob.dat", "package-lock.json"]) {
      assert.ok(!from.includes(skipped), `${skipped} was scanned`);
    }
  });

  it("lists the line hygiene-allow suppressed", () => {
    const skipped: { file: string; line: number }[] = [];
    scan(repo, TERMS, skipped);
    assert.deepEqual(skipped, [{ file: "notes/a.md", line: 10 }]);
  });
});

describe("the address, email and path rules at their edges", () => {
  // Each line is here because a bug in its rule would change the answer.
  const RULES = [
    /* 1 */ `${ip(172, 30, 1, 1)} and ${ip(172, 31, 255, 254)} are inside 172.16/12`,
    /* 2 */ `${ip(172, 15, 0, 1)} and ${ip(172, 32, 0, 1)} are outside it`,
    /* 3 */ `${ip(100, 64, 0, 1)} and ${ip(100, 127, 255, 254)} are carrier-grade NAT`,
    /* 4 */ `${ip(100, 63, 0, 1)} and ${ip(100, 128, 0, 1)} are not`,
    /* 5 */ `${ip(169, 254, 1, 1)} is link-local; ${ip(169, 255, 0, 1)} is not; ${ip(169, 254, 169, 254)} is the metadata endpoint`,
    /* 6 */ `near misses: ${ip(110, 20, 30, 40)} ${ip(1, 192, 168, 20, 5)} ${ip(10, 20, 30, 4000)}`,
    /* 7 */ `ok: a@mail.example.org and 123+name@users.noreply.github.com and pkg@1.2.30`,
    /* 8 */ `escaped: ${winHome("jdoe", "\\\\")} and ${winHome("jdoe", "\\")}`,
    /* 9 */ `shared: ${unixHome("Users", "Shared")}/Library`,
    /* 10 */ `subdomain only: ${email("jane", "corp.example.org.evil.com")}`,
  ].join("\n");

  it("reports exactly these findings", () => {
    const repo = makeRepo({ "rules.md": RULES });
    assert.deepEqual(scan(repo), [
      `rules.md:1: private IPv4 ${ip(172, 30, 1, 1)}`,
      `rules.md:1: private IPv4 ${ip(172, 31, 255, 254)}`,
      // Sorted as text, so "100.127" comes before "100.64".
      `rules.md:3: private IPv4 ${ip(100, 127, 255, 254)}`,
      `rules.md:3: private IPv4 ${ip(100, 64, 0, 1)}`,
      `rules.md:5: private IPv4 ${ip(169, 254, 1, 1)}`,
      `rules.md:8: home path ${winHome("jdoe", "\\")}`,
      `rules.md:8: home path ${winHome("jdoe", "\\\\")}`,
      `rules.md:10: email address ${email("jane", "corp.example.org.evil.com")}`,
    ]);
  });
});

describe("terms split across lines, spaces and Unicode forms", () => {
  const WRAPPED = [
    /* 1 */ "/**",
    /* 2 */ " * the Foo",
    /* 3 */ " * Bar room",
    /* 4 */ "plain Foo Bar here",
    /* 5 */ "doubled Foo  Bar",
    /* 6 */ "nbsp Foo Bar",
    /* 7 */ "# yaml Foo",
    /* 8 */ "#   Bar",
    /* 9 */ "> quoted Foo",
    /* 10 */ "> Bar",
    /* 11 */ "hygiene-allow x Foo",
    /* 12 */ "Bar",
    /* 13 */ "Foo, then something else, Bar",
    /* 14 */ "caf" + "é decomposed",
  ].join("\n");

  it("reports each wrapped match once, on the line it starts", () => {
    const repo = makeRepo({ "wrap.ts": WRAPPED });
    const skipped: { file: string; line: number }[] = [];
    assert.deepEqual(scan(repo, ["foo bar", "café"], skipped), [
      "wrap.ts:2: private term #1", // " * the Foo" / " * Bar room"
      "wrap.ts:4: private term #1", // on one line: found once, not twice
      "wrap.ts:5: private term #1", // doubled space
      "wrap.ts:6: private term #1", // non-breaking space
      "wrap.ts:7: private term #1", // "# " and spaces between
      "wrap.ts:9: private term #1", // "> " between
      "wrap.ts:14: private term #2", // NFC: composed term, decomposed text
    ]);
    assert.deepEqual(skipped, [{ file: "wrap.ts", line: 11 }], "a match starting on a hygiene-allow line was not listed");
  });

  it("is off when there is no term list", () => {
    assert.deepEqual(scan(makeRepo({ "wrap.ts": WRAPPED })), []);
  });
});

describe("a file name that contains a term", () => {
  it("is printed with every occurrence blanked, whatever the case", () => {
    const repo = makeRepo({ "docs/Zebra-and-ZEBRA.md": "fine\n" });
    assert.deepEqual(scan(repo, ["zebra"]), ["docs/***-and-***.md:0: private term #1"]);
  });

  it("is withheld whole when lower-casing changes its length, so no index can be wrong", () => {
    // U+0130 lower-cases to two characters, which shifts every later index.
    const repo = makeRepo({ "docs/İ-zebra.md": "fine\n" });
    assert.deepEqual(scan(repo, ["zebra"]), ["<path withheld>:0: private term #1"]);
  });
});

describe("what the scan does not read", () => {
  it("skips a tracked symlink, whatever it points at", () => {
    // In a directory of its own, made with an unpredictable name, never a fixed
    // name straight in the shared temp directory.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-outside-"));
    made.push(outsideDir);
    const outside = path.join(outsideDir, "outside.txt");
    fs.writeFileSync(outside, `${ip(192, 168, 16, 61)}\n`);
    const repo = makeRepo({ "real.md": "fine\n" }, { links: { "link.md": outside } });
    assert.deepEqual(scan(repo), []);
  });

  it("skips a tracked file that is gone from the working tree, and still scans the rest", () => {
    const repo = makeRepo(
      { "gone.md": "fine\n", "there.md": `${ip(192, 168, 16, 61)}\n` },
      { removeAfterAdd: ["gone.md"] },
    );
    assert.deepEqual(scan(repo), [`there.md:1: private IPv4 ${ip(192, 168, 16, 61)}`]);
  });
});

describe("CRLF line endings", () => {
  it("in the files, in PRIVATE_TERMS and in .private-terms", () => {
    const repo = makeRepo(
      {
        "a.md": ["line one", `srv ${ip(192, 168, 16, 61)}`, "the Foo Bar", ""].join("\r\n"),
        "b.md": ["plain", "a Quux appears", ""].join("\r\n"),
      },
      { privateTerms: "quux\r\n\r\n" },
    );
    const r = run(repo, { PRIVATE_TERMS: "zzz\r\nfoo bar\r\n" });
    assert.deepEqual(r.lines, [
      `a.md:2: private IPv4 ${ip(192, 168, 16, 61)}`,
      "a.md:3: private term #2",
      "b.md:2: private term #3",
    ]);
  });
});

function run(repo: string, env: Record<string, string> = {}, script = SCRIPT) {
  const clean = { ...process.env };
  delete clean.PRIVATE_TERMS;
  delete clean.REQUIRE_TERMS;
  const r = spawnSync(process.execPath, [script, repo], { encoding: "utf8", env: { ...clean, ...env } });
  return { status: r.status, lines: r.stdout.split("\n").filter(Boolean), stderr: r.stderr };
}

describe("the command line", () => {
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
      "[hygiene] 1 line(s) skipped by hygiene-allow",
      "notes/a.md:10",
    ]);
  });

  it("says nothing about hygiene-allow when no line needed it", () => {
    const repo = makeRepo({ "a.md": "plain hygiene-allow text, nothing to skip\n" });
    const r = run(repo);
    assert.equal(r.status, 0);
    assert.deepEqual(r.lines, ["[hygiene] PRIVATE_TERMS not set; checking generic rules only"]);
  });

  it("with PRIVATE_TERMS: numbers the match, never prints it, and exits 1", () => {
    const repo = makeRepo({ "docs/b.md": "ordinary text\nthe Quokka sanctuary\n" });
    const r = run(repo, { PRIVATE_TERMS: "  \nplatypus\n  quokka  \n\n" });
    assert.equal(r.status, 1);
    assert.deepEqual(r.lines, ["docs/b.md:2: private term #2"]);
    assert.ok(!(r.lines.join("") + r.stderr).toLowerCase().includes("quokka"), "the term leaked into the output");
  });

  it("reads a local .private-terms file after the environment's entries", () => {
    const repo = makeRepo({ "docs/b.md": "the Quokka sanctuary\n" }, { privateTerms: "quokka\n" });
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

  it("REQUIRE_TERMS=1 with no list is an error, and scans nothing", () => {
    const repo = makeRepo({ "docs/b.md": `fine: ${ip(192, 168, 1, 50)}\n` });
    const r = run(repo, { REQUIRE_TERMS: "1" });
    assert.equal(r.status, 1);
    assert.deepEqual(r.lines, []);
    assert.match(r.stderr, /REQUIRE_TERMS=1 but there is no private term list/);
  });

  it("REQUIRE_TERMS=1 with an empty PRIVATE_TERMS is the same error", () => {
    const repo = makeRepo({ "docs/b.md": "x\n" });
    assert.equal(run(repo, { REQUIRE_TERMS: "1", PRIVATE_TERMS: " \n\n" }).status, 1);
  });

  it("REQUIRE_TERMS=1 with a list runs normally", () => {
    const repo = makeRepo({ "docs/b.md": "the Quokka sanctuary\n" });
    const r = run(repo, { REQUIRE_TERMS: "1", PRIVATE_TERMS: "quokka" });
    assert.equal(r.status, 1);
    assert.deepEqual(r.lines, ["docs/b.md:1: private term #1"]);
    const clean = run(makeRepo({ "docs/b.md": "fine\n" }), { REQUIRE_TERMS: "1", PRIVATE_TERMS: "quokka" });
    assert.equal(clean.status, 0);
    assert.deepEqual(clean.lines, []);
  });

  it("an empty REQUIRE_TERMS is not a requirement (a fork or Dependabot run)", () => {
    const repo = makeRepo({ "docs/b.md": "fine\n" });
    const r = run(repo, { REQUIRE_TERMS: "" });
    assert.equal(r.status, 0);
    assert.deepEqual(r.lines, ["[hygiene] PRIVATE_TERMS not set; checking generic rules only"]);
  });

  it("runs when invoked through a symlink with another name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-link-"));
    made.push(dir);
    const link = path.join(dir, "gate.mjs");
    fs.symlinkSync(SCRIPT, link);
    const repo = makeRepo({ "a.md": `${ip(192, 168, 16, 61)}\n` });
    const r = run(repo, {}, link);
    assert.equal(r.status, 1, "a symlinked invocation exited without scanning");
    assert.deepEqual(r.lines, ["[hygiene] PRIVATE_TERMS not set; checking generic rules only", `a.md:1: private IPv4 ${ip(192, 168, 16, 61)}`]);
  });
});

describe("loadPrivateTerms", () => {
  it("trims, drops blank lines, and puts the environment before the file", () => {
    const repo = makeRepo({ "a.txt": "x\n" }, { privateTerms: " from-file \n\n" });
    assert.deepEqual(loadPrivateTerms(" from-env \n\n second ", repo), ["from-env", "second", "from-file"]);
    assert.deepEqual(loadPrivateTerms(undefined, repo), ["from-file"]);
    assert.deepEqual(loadPrivateTerms("", makeRepo({ "a.txt": "x\n" })), []);
  });
});
