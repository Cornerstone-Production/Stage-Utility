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
  /**
   * Change lines this section is NOT showing — cut by the notes generator, by
   * the cap below, or both.
   *
   * It used to be thrown away twice over. The generator honestly wrote
   * `- …and 37 more` and the parser dropped that bullet as furniture; the cap
   * here then cut more and said nothing at all. A release with 49 features
   * showed twelve, with nothing to suggest the other 37 existed — a new
   * websocket transport, rate-limit backoff, viewer counts and six more among
   * them. A count nobody can see is the same as no count.
   */
  omitted: number;
  /**
   * Prose the release wrote under this heading, e.g. why fixes were held back.
   *
   * The generator's "N further fixes made while building the features above are
   * not listed" is a paragraph, not a bullet, so the dialog dropped it for the
   * same reason it dropped the truncation marker: it only ever read `- ` lines.
   */
  note?: string;
}

/** Heading -> canonical name, so `## BREAKING` and `## breaking` render alike. */
const CANONICAL = new Map<string, SectionName>(
  SECTION_ORDER.map((s) => [s.toLowerCase(), s]),
);

/** "…and 12 more", the notes generator's own truncation marker. The count is
 *  captured rather than discarded — it is the only place the size of what was
 *  cut still exists by the time a dialog reads the body. */
const TRUNCATION_MARKER = /^(?:…|\.\.\.)and (\d+) more$/;

/** One `## Heading` line, if it names a section we show. */
function sectionOf(line: string): SectionName | null {
  const m = /^##\s+([a-z]+)\b/i.exec(line);
  return m ? CANONICAL.get(m[1].toLowerCase()) ?? null : null;
}

/** What one section collected, before the cap is spent on it. */
interface Collected {
  lines: string[];
  /** From the notes body's own `- …and N more` markers. */
  omitted: number;
  /** Prose lines, "" marking a paragraph break. */
  note: string[];
}

/** The prose lines of one section, as paragraphs the dialog can render. */
function noteText(parts: string[]): string {
  return parts
    .join("\n")
    .split(/\n{2,}/)
    .map((para) => para.split("\n").filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/**
 * Emit sections in SECTION_ORDER, spending the cap as it goes.
 *
 * The cap is on TOTAL lines and is spent most-important-first, so a release with
 * thirty fixes and one breaking change still leads with the breaking change
 * rather than truncating it away.
 *
 * A section the budget cannot reach still appears, with no lines and everything
 * counted as omitted. Dropping it outright would reproduce the bug this whole
 * file is here to avoid one level up: "thirty fixes and one breaking change"
 * would render as the breaking change alone, with nothing saying thirty fixes
 * had been cut.
 */
function takeInOrder(bySection: Map<SectionName, Collected>, cap: number): ReleaseSection[] {
  const out: ReleaseSection[] = [];
  let budget = Math.max(0, cap);
  for (const section of SECTION_ORDER) {
    const got = bySection.get(section);
    if (!got) continue;
    const note = noteText(got.note);
    if (!got.lines.length && !got.omitted && !note) continue;

    const take = Math.min(got.lines.length, budget);
    out.push({
      section,
      lines: got.lines.slice(0, take),
      omitted: got.omitted + (got.lines.length - take),
      ...(note ? { note } : {}),
    });
    budget -= take;
  }
  return out;
}

/**
 * A lead longer than this is an essay, not an overview.
 *
 * ~900 characters is two solid paragraphs — enough to say what a release is and
 * roughly how it works, which is what an operator opening this actually wants.
 * The first number here was 600 and it truncated the real 1.11.0 notice
 * mid-sentence, which is the failure that matters: a cap that cuts the last
 * thing the writer chose to say is worse than no cap.
 */
const INTRO_CAP = 900;

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
  const bySection = new Map<SectionName, Collected>();
  let current: SectionName | null = null;
  let inFence = false;

  const at = (section: SectionName): Collected => {
    const got = bySection.get(section);
    if (got) return got;
    const made: Collected = { lines: [], omitted: 0, note: [] };
    bySection.set(section, made);
    return made;
  };

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith("#")) {
      current = sectionOf(line);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("- ") || line.startsWith("* ")) {
      const text = line.slice(2).trim().replace(/\*\*/g, "").replace(/`/g, "").trim();
      if (!text) continue;
      // The generator's own truncation marker. Counted, not discarded — it is
      // the only record of how much the release page itself left out.
      const cut = TRUNCATION_MARKER.exec(text);
      if (cut) at(current).omitted += Number(cut[1]);
      else at(current).lines.push(text);
      continue;
    }

    // Prose under a change heading: the generator's held-back sentence, or
    // anything a hand-written release chose to say there. Kept for the same
    // reason the count is — a section that explains itself and is rendered
    // without the explanation says less than it was written to say.
    const got = bySection.get(current);
    if (!line) {
      if (got?.note.length && got.note[got.note.length - 1] !== "") got.note.push("");
      continue;
    }
    at(current).note.push(line.replace(/^>\s?/, "").replace(/\*\*/g, "").replace(/`/g, "").trim());
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
  const bySection = new Map<SectionName, Collected>();
  for (const list of lists) {
    for (const { section, lines, omitted, note } of list) {
      const got = bySection.get(section);
      // Counts sum and notes stack, because each belongs to one release and
      // three releases installed at once really did hold three lots back. One
      // release's sentence standing for all three would be a number that is
      // wrong for two of them.
      if (got) {
        got.lines.push(...lines);
        got.omitted += omitted;
        if (note) got.note.push("", note);
      } else {
        bySection.set(section, { lines: [...lines], omitted, note: note ? [note] : [] });
      }
    }
  }

  return takeInOrder(bySection, cap);
}
