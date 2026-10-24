// lyrics-object.tsx — draws a Lyrics object: the words on the ProPresenter slide
// now, the group it belongs to as a tag, and what comes next underneath.
//
// WHAT is drawn is lyrics-reading.ts's; this file is how it looks. Everything
// is sized in em off one font size — the lyric's — so the tag, the strip and the
// dimmed row keep the proportions of the approved mockup at whatever size the
// lyric is.
//
// Not unit-tested for its measurements, and why: the size comes from the box
// (clientHeight, offsetHeight), and jsdom reports 0 for both and loads no
// stylesheet. The tests pin what is drawn and which settings change it; the sizes,
// the Fit measurement and the wrapping were driven in a real browser.

import type { CSSProperties } from "react";
import type { ProPresenterStatusDTO } from "@main/types/live";
import { useBoxFit } from "./fit-to-box";
import { LYRICS_SIZE_OF_BOX, lyricsSettings, type LyricsConfig, type LyricsSettings } from "./lyrics-config";
import { readLyrics, type LyricsChip, type LyricsReading, type LyricsRow, type LyricsTag } from "./lyrics-reading";
import { INK_DARK, INK_LIGHT, contrastOf } from "./score-ink";

const ACCENT = "var(--color-accent)";
const ON_ACCENT = "var(--color-on-accent)";

/** The smallest the lyric is allowed to become when it has to shrink to fit. */
const FIT_MIN_PX = 8;
/** Before the box is measured, and wherever it never is (jsdom), the canvas stands
 *  in for it: a share of its height for the box, and a share of the box for Fit's
 *  first paint. Both are placeholders, replaced before the first frame in a browser. */
const UNMEASURED_BOX_OF_CANVAS = 0.4;
const UNMEASURED_FIT_OF_BOX = 0.1;

/** White on a colour, unless the colour is too light for white to be read on it.
 *  Not `inkFor`, which turns the approved red, blue and amber tags dark-on-colour. */
const MIN_WHITE_CONTRAST = 1.8;
function inkOn(hex: string): string {
  return contrastOf(hex, INK_LIGHT) < MIN_WHITE_CONTRAST ? INK_DARK : INK_LIGHT;
}

/** A group's colour under the Colour setting, and the ink that reads on it. */
function tagColours(s: LyricsSettings, hex: string): { colour: string; ink: string } {
  return s.tagColor === "propresenter" ? { colour: hex, ink: inkOn(hex) } : { colour: ACCENT, ink: ON_ACCENT };
}

/**
 * The lyric's font size in px, from the shared fit (fit-to-box.ts).
 *
 * S, M and L are a share of the object's own box height, and Fit's ceiling is the
 * box height itself. Both are CEILINGS: when the whole block would not fit the box
 * at that size it comes down until it does, because a widget cannot scroll and a
 * clipped last line is a lyric the room never reads. Where it fits, S, M and L are
 * exactly their size and Fit is the largest size that fits.
 */
function useLyricsSize(size: LyricsSettings["size"], contentKey: string, fallbackBoxH: number) {
  const ceilingFor = ({ h }: { h: number }) => {
    const boxH = h > 0 ? h : fallbackBoxH;
    return Math.max(FIT_MIN_PX, size === "fit" ? boxH : boxH * LYRICS_SIZE_OF_BOX[size]);
  };
  const { wrapRef, contentRef, value } = useBoxFit<HTMLDivElement>({
    floor: FIT_MIN_PX,
    ceiling: ceilingFor,
    initial: size === "fit" ? ceilingFor({ h: 0 }) * UNMEASURED_FIT_OF_BOX : ceilingFor({ h: 0 }),
    contentKey: `${size}|${contentKey}`,
    apply: (el, px) => {
      el.style.fontSize = `${px}px`;
    },
  });
  return { wrapRef, contentRef, px: Math.max(FIT_MIN_PX, value) };
}

/** How much of its strength the tag underneath keeps. */
function tagDim(s: LyricsSettings, under: boolean): number {
  return under ? (s.underDim === "strong" ? 0.45 : 0.75) : 1;
}

function tagStyle(tag: LyricsTag, s: LyricsSettings, under: boolean): CSSProperties {
  const { colour, ink } = tagColours(s, tag.colorHex);
  const base: CSSProperties = {
    display: "inline-block",
    fontWeight: 700,
    whiteSpace: "nowrap",
    fontSize: under ? "0.42em" : "0.5em",
    lineHeight: 1.15,
  };
  if (s.tagStyle === "filled") {
    // Dimmed by its fill alone: the ink keeps its strength, so the tag reads as the
    // same tag in a quieter colour on any ground, dark wall or light card.
    return { ...base, position: "relative", padding: "0.19em 0.45em", borderRadius: "0.32em", color: ink };
  }
  const outlined: CSSProperties = { ...base, opacity: tagDim(s, under), color: colour };
  if (s.tagStyle === "outline") return { ...outlined, padding: "0.16em 0.42em", borderRadius: "0.32em", border: `0.065em solid ${colour}` };
  return outlined;
}

function Tag({ tag, s, under }: { tag: LyricsTag; s: LyricsSettings; under: boolean }) {
  const filled = s.tagStyle === "filled";
  return (
    <span data-lyrics-tag="" style={tagStyle(tag, s, under)}>
      {filled && (
        <span
          aria-hidden="true"
          data-lyrics-fill=""
          style={{ position: "absolute", inset: 0, borderRadius: "inherit", background: tagColours(s, tag.colorHex).colour, opacity: tagDim(s, under) }}
        />
      )}
      <span style={{ position: "relative" }}>{tag.text}</span>
    </span>
  );
}

function Row({ row, s }: { row: LyricsRow; s: LyricsSettings }) {
  const beside = s.display === "beside";
  const centred = s.align === "center" && !beside;
  const rowStyle: CSSProperties = beside
    ? { display: "flex", alignItems: "flex-start", gap: "0.39em" }
    : { display: "flex", flexDirection: "column", gap: "0.16em", alignItems: centred ? "center" : "flex-start" };
  const cell: CSSProperties = beside
    ? s.tagWidth === "column"
      ? { flexShrink: 0, width: "3.7em", display: "flex", justifyContent: "flex-end", paddingTop: "0.1em" }
      : { flexShrink: 0, paddingTop: "0.1em" }
    : { flexShrink: 0 };
  const dim = s.underDim === "strong" ? 0.36 : 0.55;
  return (
    <div data-lyrics-row={row.under ? "under" : "current"} style={rowStyle}>
      {row.tag && (
        <div style={cell}>
          <Tag tag={row.tag} s={s} under={row.under} />
        </div>
      )}
      {row.words != null && (
        <div
          data-lyrics-words=""
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "pre-line",
            lineHeight: 1.2,
            fontSize: row.under ? "0.6em" : "1em",
            fontWeight: s.weight === "bold" ? 600 : 400,
            opacity: row.under ? dim : 1,
            textAlign: centred ? "center" : "left",
          }}
        >
          {row.words}
        </div>
      )}
    </div>
  );
}

function Chip({ chip, s, ring }: { chip: LyricsChip; s: LyricsSettings; ring: string }) {
  const { colour, ink } = tagColours(s, chip.colorHex);
  const now = chip.state === "now";
  const base: CSSProperties = {
    padding: "0.3em 0.6em",
    borderRadius: "0.4em",
    fontSize: "0.32em",
    lineHeight: 1.4,
    fontWeight: 700,
  };
  // The chips that are not lit take the theme's own fill and text, so they are
  // neutral by construction and read on the wall and on a light Home card alike.
  const quiet: CSSProperties =
    chip.state === "done"
      ? { color: "var(--color-fg-faint)", background: "var(--color-fill)" }
      : { color: "var(--color-fg)", background: "var(--color-fill-active)" };
  return (
    <div
      data-lyrics-chip={chip.state}
      style={now ? { ...base, color: ink, background: colour, boxShadow: `0 0 0 0.1em ${ring}` } : { ...base, ...quiet, borderLeft: `0.2em solid ${colour}` }}
    >
      {chip.text}
    </div>
  );
}

/** What changes the block's size, so the fit measures again: the words and tags
 *  (the chips' own text, not just how many there are) and the settings that change
 *  their size, never the colours. */
export function lyricsFitKey(reading: LyricsReading, s: LyricsSettings): string {
  if (reading.kind !== "slide") return "";
  return JSON.stringify([
    reading.title,
    reading.strip?.map((c) => c.text),
    reading.rows.map((r) => [r.under, r.tag?.text, r.words]),
    s.display, s.tagStyle, s.tagWidth, s.weight, s.under,
  ]);
}

export function LyricsObject({
  config,
  pro,
  known,
  color,
  fallbackH,
}: {
  config: LyricsConfig;
  /** The status of the instance this object reads. */
  pro: ProPresenterStatusDTO | null | undefined;
  /** Whether that status has answered. */
  known: boolean;
  /** The object's own text colour; unset follows the surface it is drawn on. */
  color: string | undefined;
  /** The canvas height, for the moment the box has not been measured. */
  fallbackH: number;
}) {
  const s = lyricsSettings(config);
  const reading = readLyrics(config, { pro, known });
  const { wrapRef, contentRef, px } = useLyricsSize(s.size, lyricsFitKey(reading, s), fallbackH * UNMEASURED_BOX_OF_CANVAS);

  const wrap: CSSProperties = {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    ...(color ? { color } : null),
  };

  if (reading.kind === "loading") return <div ref={wrapRef} data-lyrics="loading" style={wrap} />;
  if (reading.kind === "none") {
    return (
      <div ref={wrapRef} data-lyrics="none" style={{ ...wrap, alignItems: "center" }}>
        <span style={{ opacity: 0.4, fontSize: `${px * 0.5}px` }}>{"—"}</span>
      </div>
    );
  }

  return (
    <div ref={wrapRef} data-lyrics="slide" data-lyrics-display={s.display} style={wrap}>
      {reading.title != null && (
        <div data-lyrics-title="" style={{ position: "absolute", top: `${px * 0.29}px`, left: `${px * 0.58}px`, right: `${px * 0.58}px`, fontSize: `${px * 0.29}px`, fontWeight: 500, opacity: 0.6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {reading.title}
        </div>
      )}
      <div
        ref={contentRef}
        style={{
          width: "100%",
          boxSizing: "border-box",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: "0.45em",
          fontSize: `${px}px`,
          // Room above and below for the song title, so a tall block never runs under it.
          padding: reading.title != null ? "0.9em 0.58em" : "0.5em 0.58em",
        }}
      >
        {reading.strip && (
          <div data-lyrics-strip="" style={{ display: "flex", flexWrap: "wrap", gap: "0.1em", justifyContent: s.align === "center" ? "center" : "flex-start" }}>
            {reading.strip.map((chip, i) => (
              <Chip key={i} chip={chip} s={s} ring={color ?? "var(--color-fg)"} />
            ))}
          </div>
        )}
        {reading.rows.map((row, i) => (
          <Row key={i} row={row} s={s} />
        ))}
      </div>
    </div>
  );
}
