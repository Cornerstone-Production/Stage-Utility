// What changed in a release, grouped by the kind of change.
//
// The flat list this replaces was fine for a status panel you glance at. It is
// not fine for a dialog shown once after an update: "your displays will break"
// and "we renamed a button" arrived as adjacent bullets with nothing to tell
// them apart.
//
// `changeLinesFrom` in release-check.ts now flattens this, so there is one
// parser rather than two that can disagree about what counts as a change.

/**
 * The sections worth showing, most consequential first.
 *
 * Order is FIXED rather than taken from the body. A release body is written in
 * whatever order suited its author; a dialog read once is not, and Breaking is
 * the thing an operator must not scroll past. It also decides what survives the
 * cap — truncating in body order could drop Breaking entirely.
 */
export const SECTION_ORDER = ["Breaking", "New", "Changed", "Improved", "Fixed"] as const;

export type SectionName = (typeof SECTION_ORDER)[number];

export interface ReleaseSection {
  section: SectionName;
  lines: string[];
}

/** Heading -> canonical name, so `## BREAKING` and `## breaking` render alike. */
const CANONICAL = new Map<string, SectionName>(
  SECTION_ORDER.map((s) => [s.toLowerCase(), s]),
);

/** "…and 12 more", the notes generator's own truncation marker. */
const TRUNCATION_MARKER = /^(?:…|\.\.\.)and \d+ more$/;

/** One `## Heading` line, if it names a section we show. */
function sectionOf(line: string): SectionName | null {
  const m = /^##\s+([a-z]+)\b/i.exec(line);
  return m ? CANONICAL.get(m[1].toLowerCase()) ?? null : null;
}

/**
 * Emit sections in SECTION_ORDER, spending the cap as it goes.
 *
 * The cap is on TOTAL lines and is spent most-important-first, so a release with
 * thirty fixes and one breaking change still leads with the breaking change
 * rather than truncating it away.
 */
function takeInOrder(bySection: Map<SectionName, string[]>, cap: number): ReleaseSection[] {
  const out: ReleaseSection[] = [];
  let budget = Math.max(0, cap);
  for (const section of SECTION_ORDER) {
    if (budget === 0) break;
    const lines = bySection.get(section);
    if (!lines?.length) continue;
    out.push({ section, lines: lines.slice(0, budget) });
    budget -= Math.min(lines.length, budget);
  }
  return out;
}

/** A lead paragraph longer than this is an essay, not a notice. */
const INTRO_CAP = 600;

/**
 * The prose a release opens with, above its first heading.
 *
 * The sections below are a list of what changed; this is the sentence somebody
 * wrote because no commit range could produce it — "nothing to do to install
 * this", "every view comes across as it was", "the settings window has moved".
 * It was reaching GitHub and stopping there: the dialog rendered only bullets,
 * so the reassurance an operator most needs after an update they did not
 * initiate was the one thing they could not see.
 *
 * Stops at the FIRST heading of any kind, which is what keeps the Install
 * section's shell commands out — they live under `## Install`, below every
 * change list.
 *
 * Returns null when the body has no headings at all. That is a git checkout's
 * changelog, which is bare commit subjects; treating those as prose would put
 * the whole changelog in the dialog twice.
 */
export function parseReleaseIntro(body: string | null | undefined): string | null {
  if (!body) return null;
  if (!/^#{1,6}\s/m.test(body)) return null;

  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) break;
    // A fenced block before the first heading is a command, not a sentence.
    if (line.startsWith("```")) break;
    if (!line) {
      // Blank line: a paragraph break, kept only between text we already have.
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) continue;
    // Blockquote and emphasis markers are markdown furniture; the dialog styles
    // its own text and would otherwise render the leading ">" literally.
    out.push(line.replace(/^>\s?/, "").replace(/\*\*/g, "").replace(/`/g, ""));
  }

  const text = out.join("\n").trim().replace(/\n{3,}/g, "\n\n");
  if (!text) return null;
  return text.length > INTRO_CAP ? `${text.slice(0, INTRO_CAP).trimEnd()}…` : text;
}

/**
 * Group a release body's change lines by section.
 *
 * Total lines are capped, not lines per section, and the cap is spent in
 * SECTION_ORDER — so a release with thirty fixes and one breaking change still
 * leads with the breaking change.
 *
 * A body with no recognised sections returns nothing rather than one unlabelled
 * group: the prose in a release body is an upgrade notice, a Highlights
 * paragraph and shell commands, none of which is a list of what changed.
 */
export function parseReleaseSections(body: string | null | undefined, cap = 40): ReleaseSection[] {
  if (!body) return [];

  // Collected by section first, so a heading used twice merges instead of
  // rendering as two identical headings.
  const bySection = new Map<SectionName, string[]>();
  let current: SectionName | null = null;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      current = sectionOf(line);
      continue;
    }
    if (!current || !line.startsWith("- ")) continue;

    const text = line.slice(2).trim().replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (!text || TRUNCATION_MARKER.test(text)) continue;

    const lines = bySection.get(current);
    if (lines) lines.push(text);
    else bySection.set(current, [text]);
  }

  return takeInOrder(bySection, cap);
}

/**
 * Fold several releases' sections into one list.
 *
 * A box three releases behind installs all three at once, so the dialog after
 * that update has to describe all three — merged by section, in release order
 * within each, rather than three repeats of the same four headings.
 */
export function mergeReleaseSections(lists: ReleaseSection[][], cap = 40): ReleaseSection[] {
  const bySection = new Map<SectionName, string[]>();
  for (const list of lists) {
    for (const { section, lines } of list) {
      const at = bySection.get(section);
      if (at) at.push(...lines);
      else bySection.set(section, [...lines]);
    }
  }

  return takeInOrder(bySection, cap);
}
