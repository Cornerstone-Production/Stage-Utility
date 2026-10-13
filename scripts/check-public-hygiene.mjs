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
// With no list the script says so and checks rules 1-3 only, which is what a fork
// or a Dependabot run sees (neither can read repository secrets).
//
// A line containing `hygiene-allow` is skipped by every rule. Use it for a
// genuine exception, with a reason beside it.
//
// The scan covers exactly what `git ls-files` lists, so untracked files, build
// output and node_modules are never read. Binary files and lockfiles are skipped.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The one escape: a line carrying this is skipped by every rule. */
export const ALLOW_MARKER = "hygiene-allow";

// ── rule 1: private IPv4 ──────────────────────────────────────────────────────

/**
 * The /24s that placeholders may live in — written as the first three octets.
 * Everything else in 10/8, 172.16/12 and 192.168/16 fails.
 *
 *   192.168.1   the placeholder for "a machine on the LAN" in fixtures and docs
 *   10.0.0      the placeholder for "some other network" (tests that need two)
 *   192.168.0   RossTalk's documented default device address (192.168.0.123) and
 *               the `192.168.0.0/16` firewall rule in INSTALL.md
 */
export const PLACEHOLDER_NETS = ["10.0.0", "192.168.0", "192.168.1"];

const PRIVATE_IPV4 =
  /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?!\d)/g;

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
 */
export const PLACEHOLDER_USERS = new Set(["x", "op", "someone", "<someone>", "youruser", "pi"]);

// A macOS, Linux or Windows home directory followed by a user name, matched only
// where the prefix starts a path: a preceding word character, dot, tilde or
// hyphen means it is the middle of a longer one (`renderer/app/home/cards`).
const HOME_PATH = /(?:(?<![\w.~-])\/(?:Users|home)\/|[A-Za-z]:\\Users\\)([^/\\\s"'`:*)\],;|]+)/g;

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

// ── scanning ──────────────────────────────────────────────────────────────────

const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "Package.resolved"]);

function isBinary(buf) {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

/** `path` with every private term replaced by `***`, so the path is safe to print. */
export function redactPath(file, terms) {
  let shown = file;
  for (const t of terms) shown = shown.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "***");
  return shown;
}

/**
 * Every finding in one file's text. Pure, so a test can drive it directly.
 *
 * @param {string} file path as reported (relative to the repo root)
 * @param {string} text
 * @param {string[]} terms the private term list
 * @returns {{ file: string, line: number, message: string }[]}
 */
export function scanText(file, text, terms) {
  const lowerTerms = terms.map((t) => t.toLowerCase());
  const out = [];

  // A private term in a FILE NAME is as public as one in its content, and the
  // name is printed on every finding, so it is printed with the term blanked.
  const shown = redactPath(file, terms);
  lowerTerms.forEach((t, i) => {
    if (file.toLowerCase().includes(t)) out.push({ file: shown, line: 0, message: `private term #${i + 1}` });
  });

  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (line.includes(ALLOW_MARKER)) return;
    const n = idx + 1;

    for (const m of line.matchAll(PRIVATE_IPV4)) {
      const net = m[0].split(".").slice(0, 3).join(".");
      if (!PLACEHOLDER_NETS.includes(net)) out.push({ file: shown, line: n, message: `private IPv4 ${m[0]}` });
    }

    for (const m of line.matchAll(EMAIL)) {
      if (!emailAllowed(m[0], m[1])) out.push({ file: shown, line: n, message: `email address ${m[0]}` });
    }

    for (const m of line.matchAll(HOME_PATH)) {
      if (!PLACEHOLDER_USERS.has(m[1])) out.push({ file: shown, line: n, message: `home path ${m[0]}` });
    }

    // The matched text is deliberately not in the message: the list is secret.
    const lower = line.toLowerCase();
    lowerTerms.forEach((t, i) => {
      if (lower.includes(t)) out.push({ file: shown, line: n, message: `private term #${i + 1}` });
    });
  });
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
 */
export function findViolations(root, files, terms) {
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
    findings.push(...scanText(file, buf.toString("utf8"), terms));
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
    console.log("[hygiene] PRIVATE_TERMS not set; checking generic rules only");
  }
  const findings = findViolations(root, files, terms);
  for (const f of findings) console.log(formatFinding(f));
  if (findings.length > 0) {
    console.error(`[hygiene] ${findings.length} finding(s) in ${files.length} tracked files. See docs/contributing.md, "Public hygiene".`);
    process.exitCode = 1;
  }
}

// Only when run directly, so a test can import the scan.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
