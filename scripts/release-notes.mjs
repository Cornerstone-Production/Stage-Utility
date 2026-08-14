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
    return readFileSync(path.join(here, "..", "docs", "release-notes", `${v}.md`), "utf8").trim();
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

const range = fromRef ? `${fromRef}..v${version}` : `v${version}`;
const subjects = log(range);

const features = [];
const fixes = [];
const breaking = [];
const seen = new Set();

for (const subject of subjects) {
  const m = CONVENTIONAL.exec(subject);
  if (!m) continue;
  const [, rawType, scope, bang, text] = m;
  const type = rawType.toLowerCase();
  if (INVISIBLE.has(type) && !bang) continue;

  // The scope is the most useful part of a subject — it says which surface
  // changed — so keep it as a lead-in rather than dropping it.
  const line = scope ? `**${scope}** — ${text}` : text;
  if (seen.has(line)) continue;
  seen.add(line);

  if (bang) breaking.push(line);
  else if (type === "feat") features.push(line);
  else if (type === "fix" || type === "perf") fixes.push(line);
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

const parts = [
  upgradeNotice(version),
  breaking.length ? section("Breaking", breaking) : "",
  section("New", features),
  section("Fixed", fixes),
  install,
];

const body = parts.filter(Boolean).join("\n");
process.stdout.write(
  body.trim() ? body : `Maintenance release — no user-facing changes.\n\n${install}`,
);
