#!/usr/bin/env node
// release-notes.mjs — the notes attached to a GitHub release.
//
// The workflow used to pass `git log` straight through from the previous tag of
// any kind. On main that range is nearly empty — the betas already consumed it —
// so v1.9.3 shipped with two lines, one of them a release-bump commit and the
// other an eighteen-month-old merge subject. Useless to anyone deciding whether
// to update.
//
// So: span the range a reader actually cares about, drop everything invisible,
// and group what is left.
//
//   node scripts/release-notes.mjs <version> <from-ref>
//
// `from-ref` is the previous STABLE release for a stable release, and the
// previous tag for a prerelease — the caller decides, because that is the same
// anchor question the version calculation answers.

import { execFileSync } from "node:child_process";
import SCOPE_LABEL_FILE from "../main/services/scope-labels.json" with { type: "json" };

const SCOPE_LABELS = Object.fromEntries(
  Object.entries(SCOPE_LABEL_FILE).filter(([k]) => !k.startsWith("_")),
);
import { readFileSync } from "node:fs";
import * as path from "node:path";

const [, , version, fromRef] = process.argv;
if (!version) {
  console.error("usage: release-notes.mjs <version> [from-ref]");
  process.exit(1);
}

/**
 * A hand-written notice for one release, prepended above everything generated.
 *
 * Some releases need a sentence no commit range can produce — "this one needs
 * a manual step", "this changes where X lives". Generated notes cannot know
 * that, and a note remembered at release time is a note eventually forgotten,
 * so it lives in the repo next to the change that made it necessary.
 *
 * docs/release-notes/1.10.0.md → shown on the v1.10.0 release, and nowhere else.
 */
function upgradeNotice(v) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  try {
    // Trailing newline restored after the trim: the generated sections each end
    // in one and are joined with another, which is what puts a blank line
    // between them. A fully-trimmed notice left the next heading butted
    // straight onto its last line of prose.
    return readFileSync(path.join(here, "..", "docs", "release-notes", `${v}.md`), "utf8").trim() + "\n";
  } catch {
    return ""; // the ordinary case: nothing special about this release
  }
}

/** Commit types that change nothing an operator could notice. */
const INVISIBLE = new Set(["chore", "ci", "build", "docs", "test", "refactor", "style"]);

/** `type(scope)!: subject` */
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i;

/** How many bullets a section may carry before the rest are summarised. */
const CAP = 12;

function log(range) {
  try {
    return execFileSync("git", ["log", "--no-merges", "--format=%s", range], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * SHA, subject AND body, so a commit can say something about itself that its
 * subject cannot — see BETA_ONLY — and so an override can name one.
 *
 * Records are separated by RS and the fields by NUL, because a commit body
 * contains blank lines, bullet lists and code fences, and every cheaper
 * separator has appeared inside one.
 */
function commits(range) {
  try {
    return execFileSync("git", ["log", "--no-merges", "--format=%H%x00%s%x00%b%x1e", range], { encoding: "utf8" })
      .split("\x1e")
      .map((rec) => {
        const [sha = "", subject = "", body = ""] = rec.split("\x00");
        return { sha: sha.trim(), subject: subject.trim(), body };
      })
      .filter((c) => c.subject);
  } catch {
    return [];
  }
}

/**
 * `Beta-only: true` — this fixed a bug that never reached a stable release.
 *
 * The scope heuristic below cannot see these. It asks whether a fix's SCOPE is
 * new this release, which catches a whole new subsystem and misses a new feature
 * built under an existing one: `fix(integrations): the Setup guide links to this
 * build's branch` is a fix to something added in the same release, but
 * `integrations` is years old, so it reads as a fix to long-standing behaviour
 * and survives into the notes. In 1.13.0 there were 13 such scopes carrying 42
 * fixes — a reader coming from 1.12.1 being told about bugs they never had.
 *
 * Only the author knows, so only the author can say. Prereleases keep them
 * either way: someone on the beta track HAS been running the broken version.
 */
const BETA_ONLY = /^Beta-only:\s*(true|yes)\s*$/im;

/**
 * Corrections to a `Beta-only:` decision that can no longer be made in the commit.
 *
 * The trailer is the author's, and the author gets it wrong. Four cycles have
 * now shipped a fix whose trailer was missed or misapplied, and by the time a
 * review finds it the commit is on `beta`, which is never force-pushed — so
 * there is nowhere left to put the correction except beside the notes.
 *
 * docs/release-notes/overrides/1.18.0.json → applied to the v1.18.0 notes, and
 * nowhere else. A JSON array, each entry naming one commit:
 *
 *   [{ "commit": "c9d5c29", "betaOnly": true, "reason": "…" }]
 *
 * `betaOnly` is the decision the commit SHOULD have carried, so it works in
 * both directions: true holds a fix back that has no trailer, false shows one
 * whose trailer is wrong. `reason` is required — an override with no reason is
 * the same silent lie moved to a different file — and is printed to stderr when
 * it is applied, so the release log says what was changed and why.
 *
 * Every problem here throws. Generating the notes anyway is exactly the failure
 * this mechanism exists to prevent, and a stale or mistyped override is a
 * correction that would silently never be applied.
 *
 * @returns {Map<string, {betaOnly: boolean, reason: string, given: string}>} by full SHA
 */
function betaOnlyOverrides(v) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const file = path.join(here, "..", "docs", "release-notes", "overrides", `${v}.json`);
  const shown = path.posix.join("docs/release-notes/overrides", `${v}.json`);

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    // The ordinary case: no release needs one. Anything else is a file that
    // exists and could not be read, which is not the same answer at all.
    if (err.code === "ENOENT") return new Map();
    throw new Error(`cannot read ${shown}: ${err.message}`, { cause: err });
  }

  let list;
  try {
    list = JSON.parse(text);
  } catch (err) {
    throw new Error(`${shown} is not valid JSON: ${err.message}`, { cause: err });
  }
  if (!Array.isArray(list)) throw new Error(`${shown} must be a JSON array of overrides`);

  const out = new Map();
  list.forEach((e, i) => {
    const at = `${shown} entry ${i}`;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`${at} is not an object`);
    if (typeof e.commit !== "string" || !e.commit.trim()) throw new Error(`${at} has no "commit"`);
    if (typeof e.betaOnly !== "boolean") throw new Error(`${at} (${e.commit}) needs "betaOnly": true or false`);
    if (typeof e.reason !== "string" || !e.reason.trim()) {
      throw new Error(`${at} (${e.commit}) has no "reason" — say why the commit's own trailer cannot be trusted`);
    }

    let sha;
    try {
      sha = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${e.commit.trim()}^{commit}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (err) {
      throw new Error(`${at}: ${e.commit} does not name one commit in this repository`, { cause: err });
    }
    if (out.has(sha)) throw new Error(`${at}: ${sha.slice(0, 9)} is overridden twice`);
    out.set(sha, { betaOnly: e.betaOnly, reason: e.reason.trim(), given: e.commit.trim() });
  });
  return out;
}

const range = fromRef ? `${fromRef}..v${version}` : `v${version}`;
const entries = commits(range);

/** A prerelease has a `-` in it: 1.11.0-beta.27. A stable release does not. */
const isPrerelease = version.includes("-");

/**
 * Scopes that existed before this range, from every conventional subject up to
 * the anchor. Used to tell "a fix to something you already had" apart from "a
 * fix made while building something you have never seen".
 */
function scopesBefore(ref) {
  if (!ref) return null; // no anchor: nothing is known to be old, so suppress nothing
  const before = new Set();
  for (const subject of log(ref)) {
    const m = CONVENTIONAL.exec(subject);
    if (m?.[2]) before.add(m[2].toLowerCase());
  }
  return before;
}

const features = [];
const fixes = [];
const breaking = [];
/** Fixes held back as build-out churn, counted so the omission is stated. */
let buildOutFixes = 0;
const seen = new Set();

const parsed = [];
const featScopes = new Set();

// A prerelease keeps every fix either way, so its notes are not a place a
// trailer decision can go wrong and the file for the stable version it is
// building towards is deliberately not read here.
const overrides = isPrerelease ? new Map() : betaOnlyOverrides(version);
const overridesApplied = new Set();

for (const { sha, subject, body } of entries) {
  const m = CONVENTIONAL.exec(subject);
  if (!m) continue;
  const [, rawType, scope, bang, text] = m;
  const type = rawType.toLowerCase();
  if (INVISIBLE.has(type) && !bang) continue;
  const key = scope?.toLowerCase() ?? null;
  if (!bang && type === "feat" && key) featScopes.add(key);

  const trailer = BETA_ONLY.test(body);
  const override = overrides.get(sha);
  // Only a fix or a perf is ever held back, so an override on anything else
  // would read as applied and change nothing. Left unapplied, and caught below.
  const correctable = !bang && (type === "fix" || type === "perf");
  if (override && correctable) {
    overridesApplied.add(sha);
    console.error(`[release-notes] ${sha.slice(0, 9)} ${say(override.betaOnly, trailer)} — ${override.reason}`);
  }

  parsed.push({
    type, scope, key, bang, text,
    betaOnly: trailer,
    override: override && correctable ? override.betaOnly : null,
  });
}

/** What an applied override did, for the release log. */
function say(betaOnly, trailer) {
  if (betaOnly === trailer) return `override changes nothing: the commit already reads ${trailer ? "beta-only" : "not beta-only"}`;
  if (betaOnly) return "held back as beta-only, overriding a missing trailer";
  return "kept in the notes, overriding a wrong Beta-only trailer";
}

for (const [sha, o] of overrides) {
  if (overridesApplied.has(sha)) continue;
  throw new Error(
    `docs/release-notes/overrides/${version}.json names ${o.given}, which is not a non-breaking fix: or perf: ` +
      `commit in ${range}. An override that matches nothing is a correction that would never be applied.`,
  );
}

/**
 * A fix nobody outside the beta track could have hit.
 *
 * A stable release folds in thirty-odd betas, so "Fixed" filled up with the
 * polish commits that built the release's own new features — a reader who has
 * never had digital signage does not need eleven lines about signage bugs, and
 * they crowded out the fixes to things they DO have.
 *
 * Both conditions are required, and the second is the one that keeps this
 * honest. A scope with a feat in this range is not enough on its own: a release
 * carrying `feat(ui)` for a new colour picker also carried `fix(ui)` for tinted
 * icons that scrolled wrong, which is a real fix to long-standing behaviour and
 * must survive. Only a scope that ALSO never appeared before the anchor is one
 * the reader is meeting for the first time, fixes and all.
 *
 * Prereleases keep everything. Someone on the beta track has been running the
 * broken version — for them the fix IS the news.
 */
function isBuildOutFix(entry, oldScopes) {
  if (isPrerelease) return false;
  // An override is the author correcting a decision the commit can no longer
  // carry, and it decides outright — in BOTH directions. Letting it set only
  // the trailer would leave the scope heuristic below still suppressing a fix
  // an override exists to put back.
  if (entry.override !== null) return entry.override;
  // The author said so outright. No scope reasoning required, and it is the only
  // thing that catches a new feature built under an old scope.
  if (entry.betaOnly) return true;
  if (!oldScopes || !entry.key) return false;
  return featScopes.has(entry.key) && !oldScopes.has(entry.key);
}

const oldScopes = scopesBefore(fromRef);

for (const entry of parsed) {
  const { type, scope, bang, text } = entry;
  // The scope is the most useful part of a subject — it says which surface
  // changed — so keep it as a lead-in rather than dropping it.
  const line = scope ? `**${scopeLabel(scope)}** — ${text}` : text;
  if (seen.has(line)) continue;
  seen.add(line);

  if (bang) breaking.push(line);
  else if (type === "feat") features.push(line);
  else if (type === "fix" || type === "perf") {
    if (isBuildOutFix(entry, oldScopes)) buildOutFixes++;
    else fixes.push(line);
  }
}

/**
 * What to call a scope in something an operator reads.
 *
 * `a11y` is the one that prompted this: it went out in 1.13.0's notes eight
 * times, and it means nothing to anybody who has not written a commit message.
 * The map is shared with main/services/changelog.ts, which formats the same
 * lines for a checkout's update dialog, so the two cannot drift.
 *
 * A scope that is not listed is shown as written — scores, calendar, patch,
 * layout and the rest already say what they are.
 */
function scopeLabel(scope) {
  return SCOPE_LABELS[scope.toLowerCase()] ?? scope;
}

/** A capped bullet list, saying plainly how much was left out. */
function section(title, items) {
  if (items.length === 0) return "";
  const shown = items.slice(0, CAP).map((s) => `- ${s}`);
  const rest = items.length - CAP;
  if (rest > 0) shown.push(`- …and ${rest} more`);
  return `## ${title}\n\n${shown.join("\n")}\n`;
}

const install = `## Install

Two supported ways in. Pick whichever suits the machine.

**Linux and macOS** — one line, registers an auto-starting service

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.sh | sudo bash
\`\`\`

**Windows** — in an Administrator PowerShell

\`\`\`powershell
irm https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.ps1 | iex
\`\`\`

Each archive below carries its own Node runtime — nothing else to install. Already
running it? Update from **Settings → Advanced → Updates**.
`;

/**
 * What was held back, said out loud.
 *
 * A silent filter reads as "nothing else changed", which is the failure this
 * whole file exists to avoid. One line, under the fixes it belongs with.
 */
const buildOutNote = buildOutFixes
  ? `${buildOutFixes} further fix${buildOutFixes === 1 ? "" : "es"} made while building the features above ${buildOutFixes === 1 ? "is" : "are"} not listed — ${buildOutFixes === 1 ? "it was" : "they were"} never in a released version.\n`
  : "";

// The note needs the heading above it. With every fix held back there is no
// section to hang it under, so one is written — a floating sentence with no
// heading reads as a stray line of prose in the middle of a release.
const fixed =
  fixes.length ? `${section("Fixed", fixes)}\n${buildOutNote}`
  : buildOutNote ? `## Fixed\n\n${buildOutNote}`
  : "";

const parts = [
  upgradeNotice(version),
  breaking.length ? section("Breaking", breaking) : "",
  section("New", features),
  fixed,
  install,
];

const body = parts.filter(Boolean).join("\n");
process.stdout.write(
  body.trim() ? body : `Maintenance release — no user-facing changes.\n\n${install}`,
);
