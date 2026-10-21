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
import INTERNAL_SCOPE_FILE from "../main/services/internal-scopes.json" with { type: "json" };
import COMMIT_TYPE_FILE from "../main/services/commit-types.json" with { type: "json" };

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
 * Where the hand-written notices and the Beta-only overrides live.
 *
 * Normally `docs/release-notes` in this checkout, found from the script's own
 * location rather than the caller's cwd — the generator reads the repo it ships
 * in, whatever directory the workflow runs it from.
 *
 * `STAGE_UTILITY_RELEASE_NOTES_DIR` points it at a different tree. That exists
 * for the tests: they need a notice file and an override file on disk, and
 * writing those into the real `docs/release-notes` made two copies of the suite
 * running at once clobber each other's fixtures and each other's deletes. The
 * exact-list scan over the shipped overrides then found a neighbour's temp file
 * and went red. Nothing in the release workflow sets it.
 */
function releaseNotesDir() {
  const override = process.env.STAGE_UTILITY_RELEASE_NOTES_DIR;
  if (override) return override;
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.join(here, "..", "docs", "release-notes");
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
  try {
    // Trailing newline restored after the trim: the generated sections each end
    // in one and are joined with another, which is what puts a blank line
    // between them. A fully-trimmed notice left the next heading butted
    // straight onto its last line of prose.
    return readFileSync(path.join(releaseNotesDir(), `${v}.md`), "utf8").trim() + "\n";
  } catch {
    return ""; // the ordinary case: nothing special about this release
  }
}

/**
 * Commit types that change nothing an operator could notice, and the legacy ones
 * the lint refuses but old history may still carry.
 */
const INVISIBLE = new Set([...COMMIT_TYPE_FILE.invisible, ...COMMIT_TYPE_FILE.legacy]);

/** A minor type announces a capability: New. */
const MINOR_TYPES = new Set(COMMIT_TYPE_FILE.minor);

/**
 * A patch type is a bug fix, an improvement, or both, and any of them can be held
 * back as beta-only. `fix` alone has the Fixed section; every other patch type is
 * listed under Improved.
 */
const PATCH_TYPES = new Set(COMMIT_TYPE_FILE.patch);
const FIX_TYPE = "fix";

/**
 * Scopes that name this machinery rather than the app. `fix(release)` is a
 * real fix and honestly typed, and 1.18.0's notes carried four such lines that
 * no operator could act on. Shared with the update dialog and the workflow's
 * version decision via main/services/internal-scopes.json.
 */
const INTERNAL_SCOPES = new Set(INTERNAL_SCOPE_FILE.scopes);

/** `type(scope)!: subject` */
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i;

/**
 * How many change bullets one release's notes carry, and the least any section
 * with something to say gets.
 *
 * The lever used to be a CAP of 12 PER SECTION, which is the wrong one. It
 * cannot tell a three-commit release from a 239-commit one, and it spends the
 * same allowance on a two-line Breaking section as on forty-nine features:
 * 1.18.0 hit it in both directions at once and cut 57 of 81 bullets.
 *
 * A total budget, floors first and then the rest shared out in proportion to
 * what each section still has to show, follows the shape of the release
 * instead. Whatever is left over is counted and stated — see bulletList() — and
 * the full range is linked below the last one.
 *
 * 40 is under the update dialog's own NOTES_CAP of 60 (release-check.ts), so
 * for a single release the release page and the dialog show the same bullets
 * and the same count. The dialog's cap is then free to do the job it is for:
 * bounding a box that installs three releases at once.
 */
const BULLET_BUDGET = 40;
const SECTION_FLOOR = 6;

/**
 * How many bullets each section gets, given how many each HAS.
 *
 * Floors are handed out in display order, so a budget too small for every floor
 * still favours Breaking over Fixed. The remainder goes in proportion to what
 * each section still has left, and the rounding loss goes back out in display
 * order — so the budget is always spent exactly.
 */
function allocate(sizes) {
  const alloc = sizes.map(() => 0);
  let left = BULLET_BUDGET;

  sizes.forEach((n, i) => {
    alloc[i] = Math.min(n, SECTION_FLOOR, left);
    left -= alloc[i];
  });

  const want = sizes.map((n, i) => n - alloc[i]);
  const total = want.reduce((a, b) => a + b, 0);
  const share = left;
  if (total > 0 && share > 0) {
    want.forEach((w, i) => {
      const give = Math.min(w, Math.floor((share * w) / total));
      alloc[i] += give;
      left -= give;
    });
    for (let i = 0; i < alloc.length && left > 0; i++) {
      const give = Math.min(left, sizes[i] - alloc[i]);
      alloc[i] += give;
      left -= give;
    }
  }
  return alloc;
}

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
  const file = path.join(releaseNotesDir(), "overrides", `${v}.json`);
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
    // A SHA, not a name. `git rev-parse` resolves "beta" perfectly happily, and
    // an override pinned to a branch would apply to whatever that branch points
    // at on the day the release is cut — the one thing a correction to a frozen
    // commit must not be.
    if (!/^[0-9a-f]{7,40}$/i.test(e.commit.trim())) {
      throw new Error(`${at}: "${e.commit}" is not a commit SHA — an override must name one immutable commit`);
    }
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
/**
 * `perf` and `polish`: every patch-level type but `fix`. A section of its own
 * rather than a share of Fixed, which is where `perf` used to land: "anchor the
 * record clock instead of polling a timecode" reached an operator as a bug
 * report about their install, and a refinement ("pages sit 8px from the
 * sidebar") is not one either. The dialog has rendered an Improved heading since
 * it learned about sections.
 */
const improvements = [];
const breaking = [];
/** Held back as build-out churn, counted so each omission is stated. */
let buildOutFixes = 0;
let buildOutImprovements = 0;
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
  // Skipped before featScopes: a feat(release) must not make `release` read as
  // a surface introduced this cycle.
  if (key && INTERNAL_SCOPES.has(key) && !bang) continue;
  if (!bang && MINOR_TYPES.has(type) && key) featScopes.add(key);

  const trailer = BETA_ONLY.test(body);
  const override = overrides.get(sha);
  // Only a patch-level commit is ever held back, so an override on anything else
  // would read as applied and change nothing. Left unapplied, and caught below.
  const correctable = !bang && PATCH_TYPES.has(type);
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
    `docs/release-notes/overrides/${version}.json names ${o.given}, which is not a non-breaking ${[...PATCH_TYPES].map((t) => `${t}:`).join("/")} ` +
      `commit in ${range}. An override that matches nothing is a correction that would never be applied.`,
  );
}

/**
 * A fix nobody outside the beta track could have hit.
 *
 * A stable release folds in thirty-odd betas, so "Fixed" filled up with the
 * small corrections that built the release's own new features — a reader who has
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
  else if (MINOR_TYPES.has(type)) features.push(line);
  else if (type === FIX_TYPE) {
    if (isBuildOutFix(entry, oldScopes)) buildOutFixes++;
    else fixes.push(line);
  } else if (PATCH_TYPES.has(type)) {
    if (isBuildOutFix(entry, oldScopes)) buildOutImprovements++;
    else improvements.push(line);
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
function bulletList(items, limit) {
  const shown = items.slice(0, limit).map((s) => `- ${s}`);
  const rest = items.length - shown.length;
  if (rest > 0) shown.push(`- …and ${rest} more`);
  return shown.join("\n");
}

/**
 * Lift out of a hand-written notice every section the generator also writes.
 *
 * Prepended whole, a notice's `## Improved` and the generated one sat on the
 * release page as two headings with the same name. The dialog merges repeats on
 * read; the page does not. So those sections are taken out here and written once
 * by `renderSection`. Everything else — the overview, `## Changed`, anything a
 * notice invents — stays where it is.
 *
 * Only a `##` heading starts or ends a section, so a `###` under it stays inside.
 * It does split the section: the dialog ends a section at ANY line starting with
 * `#`, so what follows the first one is the `tail`, and the generated lines have
 * to go above it, after the `head`. A `## comment` inside a code fence is not a
 * heading at all.
 *
 * @returns {{ prose: string, lead: Map<string, {head: string, tail: string}> }}
 *   `lead` by lower-case title
 */
function takeGeneratedSections(notice, titles) {
  const wanted = new Set(titles.map((t) => t.toLowerCase()));
  const prose = [];
  const lead = new Map();
  let into = null;
  let underSubheading = false;
  let fence = null; // the marker that opened the code fence we are inside, if any
  for (const line of notice.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    const title = fence ? undefined : /^##\s+(.+?)\s*$/.exec(line)?.[1].toLowerCase();
    if (title !== undefined) {
      into = wanted.has(title) ? title : null;
      if (into) {
        if (!lead.has(into)) lead.set(into, { head: [], tail: [] });
        underSubheading = false;
        continue;
      }
    }
    if (!into) {
      prose.push(line);
      continue;
    }
    if (!fence && line.trim().startsWith("#")) underSubheading = true;
    lead.get(into)[underSubheading ? "tail" : "head"].push(line);
  }
  const text = prose.join("\n").trim();
  return {
    prose: text ? `${text}\n` : "",
    lead: new Map(
      [...lead].map(([k, { head, tail }]) => [k, { head: head.join("\n").trim(), tail: tail.join("\n").trim() }]),
    ),
  };
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
 * A section, and what was held back from it said out loud.
 *
 * A silent filter reads as "nothing else changed", which is the failure this
 * whole file exists to avoid. The note needs the heading above it, so with
 * everything held back one is still written — a floating sentence with no
 * heading reads as a stray line of prose in the middle of a release.
 *
 * Fixes and improvements are counted apart so each section's arithmetic is its
 * own; calling a held-back `perf` or `polish` a "fix" is the same mislabelling
 * that put them under Fixed to begin with.
 *
 * `lead` is what the hand-written notice already said under this heading, kept
 * verbatim: its `head` first, then everything generated, then its `tail`, which
 * starts at the notice's first sub-heading. The dialog ends a section there, so
 * nothing generated may sit below it. The lead is not counted against the bullet
 * budget, which is there so the release page and the dialog's NOTES_CAP agree; the
 * notice's other sections, `Changed` included, have never been counted either.
 */
function renderSection({ title, items, held = 0, one, many, lead = { head: "", tail: "" } }, limit) {
  const note = held
    ? `${held} further ${held === 1 ? one : many} made while building the features above ${held === 1 ? "is" : "are"} not listed — ${held === 1 ? "it was" : "they were"} never in a released version.`
    : "";
  const bullets = items.length ? bulletList(items, limit) : "";
  // A hand-written list and the generated bullets are one tight list. After
  // hand-written prose they get a blank line, as any new paragraph does.
  const endsInBullet = /^\s*[-*] /.test(lead.head.split(/\n\s*\n/).pop());
  const list = [lead.head, bullets].filter(Boolean).join(endsInBullet ? "\n" : "\n\n");
  // The note gets a blank line too: directly under a bullet it is a lazy
  // continuation of it, and reads as part of that bullet on the release page.
  const text = [list, note, lead.tail].filter(Boolean).join("\n\n");
  return text ? `## ${title}\n\n${text}\n` : "";
}

/**
 * The sections, in SECTION_ORDER — the order the update dialog renders them in.
 * See main/services/update/release-notes.ts, which must recognise every heading
 * named here or the section disappears from the dialog without a word.
 */
const SECTIONS = [
  { title: "Breaking", items: breaking },
  { title: "New", items: features },
  { title: "Improved", items: improvements, held: buildOutImprovements, one: "improvement", many: "improvements" },
  { title: "Fixed", items: fixes, held: buildOutFixes, one: "fix", many: "fixes" },
];
const limits = allocate(SECTIONS.map((s) => s.items.length));

const notice = takeGeneratedSections(upgradeNotice(version), SECTIONS.map((s) => s.title));

/**
 * Where the rest of it is.
 *
 * Any cap leaves "…and 27 more" pointing nowhere unless something says where
 * "more" lives. Its own heading, deliberately not one of SECTION_ORDER's, so
 * the dialog's parser reads it as the end of the change lists rather than
 * folding a markdown link into the section above it.
 */
const fullChangelog = fromRef
  ? `## Full changelog\n\n[${fromRef}…v${version}](https://github.com/Cornerstone-Production/Stage-Utility/compare/${fromRef}...v${version})\n`
  : "";

const parts = [
  notice.prose,
  ...SECTIONS.map((s, i) => renderSection({ ...s, lead: notice.lead.get(s.title.toLowerCase()) }, limits[i])),
  fullChangelog,
  install,
];

const body = parts.filter(Boolean).join("\n");
process.stdout.write(
  body.trim() ? body : `Maintenance release — no user-facing changes.\n\n${install}`,
);
