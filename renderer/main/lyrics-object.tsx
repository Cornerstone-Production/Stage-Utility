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

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ProPresenterStatusDTO } from "@main/types/live";
import { LYRICS_SIZE_OF_BOX, lyricsSettings, type LyricsConfig, type LyricsSettings } from "./lyrics-config";
import { readLyrics, type LyricsChip, type LyricsRow, type LyricsTag } from "./lyrics-reading";
import { INK_DARK, INK_LIGHT, contrastOf } from "./score-ink";

/** One colour for every group, and the ink that reads on it. */
const ACCENT = "var(--color-accent)";
const ON_ACCENT = "var(--color-on-accent)";

/**
 * White on a colour, unless the colour is too light for white to be read on it.
 *
 * Not `inkFor`, which picks whichever of white and near-black contrasts better:
 * that turns the mockup's red, blue and amber tags dark-on-colour, which is not
 * what was approved. The approved look is white on every group colour, so white
 * stays until a colour is so light (a yellow, a cream) that it would be nearly
 * invisible, and only then does the ink go dark.
 */
const MIN_WHITE_CONTRAST = 1.8;
const inkOn = (hex: string): string => (contrastOf(hex, INK_LIGHT) < MIN_WHITE_CONTRAST ? INK_DARK : INK_LIGHT);

/** The smallest the lyric is allowed to become when Fit shrinks it. */
const FIT_MIN_PX = 8;
/** Halvings of the search range: the answer is within a fraction of a pixel. */
const FIT_STEPS = 12;

/**
 * The lyric's font size in px, and the two elements it is measured against.
 *
 * S, M and L are a fraction of the object's own box height, and Fit's ceiling is
 * the box height itself. Both are CEILINGS, not promises: when the whole block
 * would not fit the box at that size the size comes down until it does, because a
 * widget cannot scroll and a clipped last line is a lyric the room never reads.
 * Where the block fits, S, M and L are exactly their size and Fit is the largest
 * size that fits.
 *
 * Found by bisection, not by scaling: wrapping makes the height jump with the
 * size, so a back-derived scale (exact only for text that does not wrap) lands on
 * a size that overflows. Every probe happens inside one layout effect, mutating
 * the wrapper's style directly, so none is ever painted.
 */
function useLyricsSize(size: LyricsSettings["size"], contentKey: string, fallbackBoxH: number) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [fitted, setFitted] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Before the box is measured (and wherever it never is, as in jsdom) the canvas
  // stands in for it, so a first paint is a plausible size rather than none.
  const boxH = box.h > 0 ? box.h : fallbackBoxH;
  const ceiling = Math.max(FIT_MIN_PX, size === "fit" ? boxH : boxH * LYRICS_SIZE_OF_BOX[size]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const content = contentRef.current;
    if (!wrap || !content || box.h <= 0) return;
    const fitsAt = (px: number) => {
      wrap.style.fontSize = `${px}px`;
      return content.offsetHeight <= wrap.clientHeight && content.scrollWidth <= wrap.clientWidth + 1;
    };
    let best = ceiling;
    if (!fitsAt(ceiling)) {
      let lo = FIT_MIN_PX;
      let hi = ceiling;
      for (let i = 0; i < FIT_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (fitsAt(mid)) lo = mid;
        else hi = mid;
      }
      best = lo;
    }
    wrap.style.fontSize = `${best}px`;
    setFitted(best);
  }, [size, ceiling, contentKey, box.w, box.h]);

  return { wrapRef, contentRef, px: fitted ?? (size === "fit" ? ceiling * 0.1 : ceiling) };
}

function tagStyle(tag: LyricsTag, s: LyricsSettings, under: boolean): CSSProperties {
  const pro = s.tagColor === "propresenter";
  const colour = pro ? tag.colorHex : ACCENT;
  const base: CSSProperties = {
    display: "inline-block",
    fontWeight: 700,
    whiteSpace: "nowrap",
    fontSize: under ? "0.42em" : "0.5em",
    lineHeight: 1.15,
    opacity: under ? (s.underDim === "strong" ? 0.45 : 0.75) : 1,
  };
  if (s.tagStyle === "filled") {
    // The ink is chosen against the colour: a yellow group is not white text.
    return { ...base, padding: "0.19em 0.45em", borderRadius: "0.32em", color: pro ? inkOn(tag.colorHex) : ON_ACCENT, background: colour };
  }
  if (s.tagStyle === "outline") {
    return { ...base, padding: "0.16em 0.42em", borderRadius: "0.32em", color: colour, border: `0.065em solid ${colour}` };
  }
  return { ...base, color: colour };
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
          <span data-lyrics-tag="" style={tagStyle(row.tag, s, row.under)}>{row.tag.text}</span>
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
  const pro = s.tagColor === "propresenter";
  const colour = pro ? chip.colorHex : ACCENT;
  const now = chip.state === "now";
  const done = chip.state === "done";
  const base: CSSProperties = {
    padding: "0.3em 0.6em",
    borderRadius: "0.4em",
    fontSize: "0.32em",
    lineHeight: 1.4,
    fontWeight: 700,
  };
  return (
    <div
      data-lyrics-chip={chip.state}
      style={
        now
          ? { ...base, color: pro ? inkOn(chip.colorHex) : ON_ACCENT, background: colour, boxShadow: `0 0 0 0.1em ${ring}` }
          : { ...base, color: done ? "#4a4a52" : "#c9c9d0", background: done ? "#141414" : "#1e1e1e", borderLeft: `0.2em solid ${colour}` }
      }
    >
      {chip.text}
    </div>
  );
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
  // What changes the block's size, so Fit measures again: the words and tags, not
  // the colours.
  const contentKey =
    reading.kind === "slide"
      ? JSON.stringify([reading.title, reading.strip?.length, reading.rows.map((r) => [r.under, r.tag?.text, r.words]), s.display, s.tagStyle, s.tagWidth, s.weight, s.under])
      : "";
  const { wrapRef, contentRef, px } = useLyricsSize(s.size, contentKey, fallbackH * 0.4);

  const wrap: CSSProperties = {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    fontSize: `${px}px`,
    ...(color ? { color } : null),
  };

  if (reading.kind === "loading") return <div ref={wrapRef} data-lyrics="loading" style={wrap} />;
  if (reading.kind === "none") {
    return (
      <div ref={wrapRef} data-lyrics="none" style={{ ...wrap, alignItems: "center", fontSize: undefined }}>
        <span style={{ opacity: 0.4, fontSize: "0.5em" }}>{"—"}</span>
      </div>
    );
  }

  return (
    <div ref={wrapRef} data-lyrics="slide" data-lyrics-display={s.display} style={wrap}>
      {reading.title != null && (
        <div data-lyrics-title="" style={{ position: "absolute", top: "0.29em", left: "0.58em", right: "0.58em", fontSize: "0.29em", fontWeight: 500, opacity: 0.6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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
          // Room above and below for the song title, so a tall block never runs under it.
          padding: reading.title != null ? "0.9em 0.58em" : "0.5em 0.58em",
        }}
      >
        {reading.strip && (
          <div data-lyrics-strip="" style={{ display: "flex", flexWrap: "wrap", gap: "0.1em" }}>
            {reading.strip.map((chip, i) => (
              <Chip key={i} chip={chip} s={s} ring={color ?? "var(--color-fg, #fff)"} />
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
