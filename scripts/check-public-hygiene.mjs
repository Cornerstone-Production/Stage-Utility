// Keeps personal and building-specific details out of the repository.
//
// This repository is public. Fixtures, comments and docs drift toward whatever
// the author had in front of them: a LAN address, a work email, a home
// directory, the name of the room or the ministry. This script reads every
// tracked file and fails on the ones that name something real.
//
//   node scripts/check-public-hygiene.mjs [repo-root]
//
// Four rules. The first three name nothing private, so they can be published:
//
//   1. a private IPv4 address outside the placeholder ranges below
//   2. an email address outside the placeholder domains below
//   3. a home-directory path whose user is not a placeholder
//   4. a private term, from $PRIVATE_TERMS and/or a local `.private-terms` file
//
// The list behind rule 4 is secret, so it is never published and never printed:
// a finding reports `private term #N`, the 1-based position of the entry among
// the non-blank lines of the list (environment entries first, then the file).
// A term is matched twice: per line, as written, and across the whole file with
// whitespace and comment markers collapsed, so a name wrapped over two lines of
// a comment ("Foo\n * Bar") is still found. With no list the script says so and
// checks rules 1-3 only, which is what a fork or a Dependabot run sees (neither
// can read repository secrets). REQUIRE_TERMS=1 turns "no list" into an error,
// for the runs that should have one.
//
// A line containing `hygiene-allow` is skipped by every rule. Use it for a
// genuine exception, with a reason beside it. Every line whose finding was
// skipped this way is listed in the output, so an exception is never invisible.
//
// The scan covers exactly what `git ls-files` lists, so untracked files, build
// output and node_modules are never read. Binary files and lockfiles are skipped.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The one escape: a line carrying this is skipped by every rule. */
export const ALLOW_MARKER = "hygiene-allow";

// ── rule 1: private IPv4 ──────────────────────────────────────────────────────

/**
 * The /24s that placeholders may live in — written as the first three octets.
 * Everything else in a private range fails. The private ranges are 10/8,
 * 172.16/12, 192.168/16, 100.64/10 (carrier-grade NAT, which Tailscale hands
 * out) and 169.254/16 (link-local).
 *
 *   192.168.1   the placeholder for "a machine on the LAN" in fixtures and docs
 *   10.0.0      the placeholder for "some other network" (tests that need two)
 *   192.168.0   RossTalk's documented default device address (192.168.0.123) and
 *               the `192.168.0.0/16` firewall rule in INSTALL.md
 */
export const PLACEHOLDER_NETS = ["10.0.0", "192.168.0", "192.168.1"];

/**
 * Whole addresses that name no machine of anyone's. Each needs a reason.
 *
 *   169.254.169.254   the cloud-metadata endpoint every provider serves; the same
 *                     everywhere, and what an SSRF test has to name
 */
const ALLOWED_IPV4 = new Set(["169.254.169.254"]);

const PRIVATE_IPV4 = new RegExp(
  "(?<![\\d.])(?:" +
    [
      "10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}",
      "172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}",
      "192\\.168\\.\\d{1,3}\\.\\d{1,3}",
      "100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}",
      "169\\.254\\.\\d{1,3}\\.\\d{1,3}",
    ].join("|") +
    ")(?!\\d)",
  "g",
);

// ── rule 2: email ─────────────────────────────────────────────────────────────

/** Any address at these domains, or a subdomain of them (RFC 2606). */
const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "example.net"];
/** Any address at a domain ending in one of these reserved TLDs (RFC 2606). */
const RESERVED_TLDS = ["example", "test", "invalid", "localhost"];
/** The address GitHub assigns to an account that hides its email. */
const GITHUB_NOREPLY_DOMAIN = "users.noreply.github.com";
/**
 * Whole addresses that are legitimate and name no one here. Each needs a reason.
 */
const ALLOWED_ADDRESSES = new Set([
  // The trailer docs/contributing.md shows for an agent's commits: a role
  // address, published by the vendor.
  "noreply@anthropic.com",
  // The SSH form of a GitHub remote, as in `git@github.com:owner/repo.git`.
  "git@github.com",
  // The worked example in RFC 2617 (HTTP Digest). A test asserts the digest
  // computed over that realm, so the realm cannot be renamed.
  "testrealm@host.com",
]);

// The TLD must be alphabetic so `pkg@1.2.3` and `uses: x@v7.0.1` are not read as
// addresses.
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g;

function emailAllowed(address, domain) {
  const a = address.toLowerCase();
  const d = domain.toLowerCase();
  if (ALLOWED_ADDRESSES.has(a)) return true;
  if (d === GITHUB_NOREPLY_DOMAIN) return true;
  if (PLACEHOLDER_DOMAINS.some((p) => d === p || d.endsWith(`.${p}`))) return true;
  return RESERVED_TLDS.some((t) => d.endsWith(`.${t}`));
}

// ── rule 3: home paths ────────────────────────────────────────────────────────

/**
 * User names that may follow a home-directory prefix. Explicit, so a real name
 * cannot slip in as a "placeholder".
 *
 *   x, op, someone, <someone>, youruser   invented names used by fixtures and docs
 *   pi                                    the Raspberry Pi OS default account
 *   Shared                                macOS's shared folder, not a person
 */
export const PLACEHOLDER_USERS = new Set(["x", "op", "someone", "<someone>", "youruser", "pi", "Shared"]);

// A macOS, Linux or Windows home directory followed by a user name, matched only
// where the prefix starts a path: a preceding word character, dot, tilde or
// hyphen means it is the middle of a longer one (`renderer/app/home/cards`). The
// Windows form also matches with its backslashes doubled, as in a JSON or source
// string.
const HOME_PATH = /(?:(?<![\w.~-])\/(?:Users|home)\/|[A-Za-z]:\\{1,2}Users\\{1,2})([^/\\\s"'`:*)\],;|]+)/g;

// ── rule 4: private terms ─────────────────────────────────────────────────────

/**
 * The private term list: `$PRIVATE_TERMS` entries first, then `.private-terms`.
 * One term per line, trimmed, blank lines ignored.
 *
 * @param {string | undefined} envValue
 * @param {string} root repository root, where `.private-terms` would live
 * @returns {string[]}
 */
export function loadPrivateTerms(envValue, root) {
  const lines = [];
  if (envValue) lines.push(...envValue.split(/\r?\n/));
  const file = path.join(root, ".private-terms");
  if (fs.existsSync(file)) lines.push(...fs.readFileSync(file, "utf8").split(/\r?\n/));
  return lines.map((l) => l.trim()).filter(Boolean);
}

/** Whitespace, comment markers and slashes: what can sit between two wrapped words. */
const SEPARATORS = /[\s*#>/]+/g;

/**
 * The term list in the forms the scan compares against, computed once.
 *
 * `lower` is the per-line form (NFC, lower-case). `squashed` is the whole-file
 * form: the same with every run of separators collapsed to one space. An entry
 * that squashes to nothing (only punctuation) is left out of the whole-file pass,
 * where it would match everywhere.
 *
 * @param {string[]} terms
 */
export function prepareTerms(terms) {
  const lower = terms.map((t) => t.normalize("NFC").toLowerCase());
  const squashed = lower.map((t) => t.replace(SEPARATORS, " ").trim());
  return { count: terms.length, lower, squashed };
}

// ── scanning ──────────────────────────────────────────────────────────────────

const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "Package.resolved"]);

function isBinary(buf) {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

/**
 * `file` with every private term replaced by `***`, so the path is safe to print.
 *
 * Detection and redaction use the same lower-cased string and the same match
 * indexes, so they cannot disagree. If lower-casing changed the path's length the
 * indexes no longer line up with the original, and the whole path is withheld.
 */
export function redactPath(file, prepared) {
  const hay = file.normalize("NFC").toLowerCase();
  const ranges = [];
  for (const t of prepared.lower) {
    if (!t) continue;
    for (let at = hay.indexOf(t); at !== -1; at = hay.indexOf(t, at + 1)) ranges.push([at, at + t.length]);
  }
  if (ranges.length === 0) return file;
  if (hay.length !== file.length) return "<path withheld>";
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [s, e] of ranges) {
    if (e <= pos) continue;
    out += file.slice(pos, Math.max(s, pos)) + "***";
    pos = e;
  }
  return out + file.slice(pos);
}

/**
 * The text with every separator run squashed to one space, for the whole-file
 * term pass, plus a way to find which original line a position came from.
 */
function squash(text) {
  let out = "";
  /** [offset in `out` where a separator run starts, line number after the run] */
  const marks = [[0, 1]];
  let line = 1;
  let last = 0;
  for (const m of text.matchAll(SEPARATORS)) {
    out += text.slice(last, m.index).toLowerCase();
    marks.push([out.length, line + (m[0].match(/\n/g) ?? []).length]);
    out += " ";
    line += (m[0].match(/\n/g) ?? []).length;
    last = m.index + m[0].length;
  }
  out += text.slice(last).toLowerCase();
  return {
    text: out,
    lineAt(pos) {
      let lo = 0;
      let hi = marks.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (marks[mid][0] <= pos) lo = mid;
        else hi = mid - 1;
      }
      return marks[lo][1];
    },
  };
}

/** Findings on one line for rules 1-3 and the per-line pass of rule 4. */
function lineFindings(line, prepared) {
  const out = [];
  for (const m of line.matchAll(PRIVATE_IPV4)) {
    const net = m[0].split(".").slice(0, 3).join(".");
    if (!PLACEHOLDER_NETS.includes(net) && !ALLOWED_IPV4.has(m[0])) out.push(`private IPv4 ${m[0]}`);
  }
  for (const m of line.matchAll(EMAIL)) {
    if (!emailAllowed(m[0], m[1])) out.push(`email address ${m[0]}`);
  }
  for (const m of line.matchAll(HOME_PATH)) {
    if (!PLACEHOLDER_USERS.has(m[1])) out.push(`home path ${m[0]}`);
  }
  if (prepared.count > 0) {
    // The matched text is deliberately not in the message: the list is secret.
    const lower = line.toLowerCase();
    prepared.lower.forEach((t, i) => {
      if (lower.includes(t)) out.push(`private term #${i + 1}`);
    });
  }
  return out;
}

/**
 * Every finding in one file's text. Pure, so a test can drive it directly.
 *
 * @param {string} file path as reported (relative to the repo root)
 * @param {string} text
 * @param {ReturnType<typeof prepareTerms>} prepared the private term list
 * @param {{ file: string, line: number }[]} [skipped] receives each line whose
 *   findings `hygiene-allow` suppressed
 * @returns {{ file: string, line: number, message: string }[]}
 */
export function scanText(file, text, prepared, skipped = []) {
  const out = [];

  // A private term in a FILE NAME is as public as one in its content, and the
  // name is printed on every finding, so it is printed with the term blanked.
  const shown = redactPath(file, prepared);
  const nameLower = file.normalize("NFC").toLowerCase();
  prepared.lower.forEach((t, i) => {
    if (nameLower.includes(t)) out.push({ file: shown, line: 0, message: `private term #${i + 1}` });
  });

  const nfc = text.normalize("NFC");
  const lines = nfc.split(/\r?\n/);
  /** "term index:line" for every term the per-line pass reported. */
  const perLine = new Set();
  const allowedLines = new Set();
  lines.forEach((line, idx) => {
    const n = idx + 1;
    const found = lineFindings(line, prepared);
    for (const message of found) {
      const t = /^private term #(\d+)$/.exec(message);
      if (t) perLine.add(`${t[1]}:${n}`);
    }
    if (line.includes(ALLOW_MARKER)) {
      allowedLines.add(n);
      if (found.length > 0) skipped.push({ file: shown, line: n });
      return;
    }
    for (const message of found) out.push({ file: shown, line: n, message });
  });

  // The whole-file pass: a name wrapped across lines, or with doubled or
  // non-breaking spaces, which no single line contains.
  if (prepared.count > 0) {
    const squashed = squash(nfc);
    const reported = new Set();
    prepared.squashed.forEach((t, i) => {
      if (!t) return;
      for (let at = squashed.text.indexOf(t); at !== -1; at = squashed.text.indexOf(t, at + 1)) {
        const n = squashed.lineAt(at);
        const key = `${i + 1}:${n}`;
        if (perLine.has(key) || reported.has(key)) continue;
        if (allowedLines.has(n)) {
          skipped.push({ file: shown, line: n });
          reported.add(key);
          continue;
        }
        reported.add(key);
        out.push({ file: shown, line: n, message: `private term #${i + 1}` });
      }
    });
  }
  return out;
}

/** The tracked files of the repository containing `dir`, and its top level. */
export function listTrackedFiles(dir) {
  const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const raw = execFileSync("git", ["-C", top, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { root: top, files: raw.split("\0").filter(Boolean) };
}

/**
 * Scan tracked files and return every finding, sorted by file, line, message.
 *
 * @param {string} root repository root
 * @param {string[]} files paths relative to `root` (from `git ls-files`)
 * @param {string[]} terms the private term list
 * @param {{ file: string, line: number }[]} [skipped] receives lines `hygiene-allow` suppressed
 */
export function findViolations(root, files, terms, skipped = []) {
  const prepared = prepareTerms(terms);
  const findings = [];
  for (const file of files) {
    if (LOCKFILES.has(path.basename(file))) continue;
    const abs = path.join(root, file);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      // Tracked but deleted in this working tree: nothing there to read.
      if (err.code === "ENOENT") continue;
      throw err;
    }
    // A symlink or a submodule has no content of its own to scan.
    if (!st.isFile()) continue;
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) continue;
    findings.push(...scanText(file, buf.toString("utf8"), prepared, skipped));
  }
  return findings.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}

/** `path:line: message`, the one line printed per finding. */
export function formatFinding(f) {
  return `${f.file}:${f.line}: ${f.message}`;
}

function main() {
  const { root, files } = listTrackedFiles(process.argv[2] ?? process.cwd());
  const terms = loadPrivateTerms(process.env.PRIVATE_TERMS, root);
  if (terms.length === 0) {
    if (process.env.REQUIRE_TERMS === "1") {
      console.error(
        "[hygiene] REQUIRE_TERMS=1 but there is no private term list: PRIVATE_TERMS is empty and there is no .private-terms file. " +
          'Create the repository secret (docs/contributing.md, "Public hygiene").',
      );
      process.exitCode = 1;
      return;
    }
    console.log("[hygiene] PRIVATE_TERMS not set; checking generic rules only");
  }
  const skipped = [];
  const findings = findViolations(root, files, terms, skipped);
  for (const f of findings) console.log(formatFinding(f));
  if (skipped.length > 0) {
    console.log(`[hygiene] ${skipped.length} line(s) skipped by ${ALLOW_MARKER}`);
    for (const s of skipped) console.log(`${s.file}:${s.line}`);
  }
  if (findings.length > 0) {
    console.error(`[hygiene] ${findings.length} finding(s) in ${files.length} tracked files. See docs/contributing.md, "Public hygiene".`);
    process.exitCode = 1;
  }
}

// Only when run directly, so a test can import the scan. Compared as real paths:
// a suffix match on the file name let a symlinked or Windows-style invocation
// skip main() and exit 0, which for a check is a silent pass.
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(entry));
}
if (isEntryPoint()) main();
