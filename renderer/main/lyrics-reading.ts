// lyrics-reading.ts — what a Lyrics object has to say, from ProPresenter's status.
//
// PURE, and a function of the status alone: it holds nothing from an earlier
// frame, so a slide that has gone cannot be drawn again. That is the whole of
// "never a stale lyric" — the only way a lyric is on screen is that the status
// being read right now says it is on the slide.
//
// What this decides: which of the four states the widget is in, which rows it
// draws (the current slide, and what comes next), and the strip's chips. How a row
// LOOKS (colours, sizes, the tag's style) is the component's, and is decided from
// the same settings but never changes what is said.

import type { ProPresenterStatusDTO } from "@main/types/live";
import type { ProSection } from "@main/types/views";
import { lyricsSettings, tagLabel, shortGroupName, type LyricsConfig } from "./lyrics-config";

/** One group's tag: the words to draw, and its colour. */
export interface LyricsTag {
  /** What the Text setting turns that into. */
  text: string;
  colorHex: string;
}

export interface LyricsRow {
  /** The row underneath the current slide, drawn dimmed. */
  under: boolean;
  /** Null when the tag is not drawn on this row (the strip carries it) or the
   *  slide belongs to no named group. */
  tag: LyricsTag | null;
  /** The words, or null when the row does not draw them. */
  words: string | null;
}

export interface LyricsChip {
  /** The short form: a strip is a row of small marks, never a row of names. */
  text: string;
  colorHex: string;
  /** Already played, playing now, or still to come. */
  state: "done" | "now" | "next";
}

export type LyricsReading =
  /** Nothing has answered yet: the widget says nothing, not even a dash. */
  | { kind: "loading" }
  /** ProPresenter is not connected, or no presentation is active. */
  | { kind: "none" }
  | {
      kind: "slide";
      /** The presentation's name, when the Song title setting is on. */
      title: string | null;
      /** The arrangement as chips, only in the Arrangement layout. */
      strip: LyricsChip[] | null;
      rows: LyricsRow[];
    };

export interface LyricsInput {
  /** The status of the instance this object reads; null or undefined when it has none. */
  pro: ProPresenterStatusDTO | null | undefined;
  /** Whether that status has answered. A status that has not is not "not connected". */
  known: boolean;
}

function hasWords(text: string | null): text is string {
  return text != null && text.trim() !== "";
}

export function readLyrics(config: LyricsConfig, { pro, known }: LyricsInput): LyricsReading {
  if (!known) return { kind: "loading" };
  if (!pro?.connected) return { kind: "none" };
  // Connected with nothing loaded: no presentation name, no group, no words (empty
  // or blank counts as none). A media slide still has a name, so it is not this.
  if (pro.currentItem == null && !hasWords(pro.currentSlideText) && pro.currentSection == null) {
    return { kind: "none" };
  }

  const s = lyricsSettings(config);
  const strip = s.display === "strip";
  const tagOf = (section: ProSection | null): LyricsTag | null =>
    section ? { text: tagLabel(section.name, s.tagText), colorHex: section.colorHex } : null;

  const rows: LyricsRow[] = [];

  const currentWords = hasWords(pro.currentSlideText) ? pro.currentSlideText : null;
  if (currentWords != null || s.noWords === "tag") {
    const tag = strip ? null : tagOf(pro.currentSection);
    if (tag || currentWords != null) rows.push({ under: false, tag, words: currentWords });
  }

  if (s.under) {
    const group = s.underShows === "group";
    const section = group ? pro.nextArrangementSection : pro.nextSection;
    const text = group ? pro.nextGroupText : pro.nextSlideText;
    if (section) {
      const next = hasWords(text) ? text : null;
      // The no-words rule is about the slide, not about whether its words are drawn.
      if (next != null || s.noWords === "tag") {
        rows.push({ under: true, tag: tagOf(section), words: s.underWords ? next : null });
      }
    }
  }

  let chips: LyricsChip[] | null = null;
  if (strip && pro.playOrderGroups.length > 0) {
    const at = pro.playOrderGroupIndex;
    chips = pro.playOrderGroups.map((g, i) => ({
      text: shortGroupName(g.name),
      colorHex: g.colorHex,
      state: at == null ? "next" : i < at ? "done" : i === at ? "now" : "next",
    }));
  }

  return {
    kind: "slide",
    title: s.showTitle ? pro.currentItem : null,
    strip: chips,
    rows,
  };
}
