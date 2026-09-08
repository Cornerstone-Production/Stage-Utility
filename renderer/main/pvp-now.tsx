// pvp-now.tsx — ProVideoPlayer as ONE reading: what is on now, how long is left,
// and what the playlist has queued behind it.
//
// A DIFFERENT QUESTION FROM pvp-object.tsx, so a different idiom rather than a
// shrunken copy of the list. The list answers "what is every layer doing", which
// is what an operator asks while setting up; this answers "what is on right now
// and how long have I got", which is what they ask during a service. So it uses
// the app's other convention — the caption / value / sub readout that fifteen
// widget types already share — and it draws through the SAME Readout those use,
// not a second implementation of the same composition.
//
// It shows NO PICTURE, and there is no setting that would: PVP exposes no
// thumbnail, preview or frame endpoint at all.

import { fmtDuration } from "./pco-timer";
import { computePvpProgress, computeStillProgress, pvpMeterKey, pvpUnavailableReason, stillOnScreenSec } from "./pvp-progress";
import { Readout } from "./readout";
import type { LayoutHAlign } from "@main/types/views";
import { hasContent, type PvpLayerDTO, type PvpStatusDTO } from "@main/types/pvp";

/** Both surfaces' configs, which differ only in whether a layer can be named. */
export type PvpNowConfig = {
  layerName?: string | null;
  showProgress?: boolean;
  showNextCue?: boolean;
  compact?: boolean;
  // Named `nowLabel`, not the shorter `label`: half the button-type objects in
  // this same config union already carry a required `label: string` of their
  // own (a button's caption), and card-toggles.ts derives its exhaustive
  // per-setting type from the KEY NAME alone — `label` would have pulled every
  // one of those unrelated types into this setting's record.
  nowLabel?: PvpNowLabel;
  /** Count a still down, the way a rolling clip already counts down. See the
   *  field's own doc on the `pvp-now` config member in main/types/views.ts. */
  countStills?: boolean;
  /** Per-widget override of the PVP card's Image Duration default. Ignored
   *  unless `countStills` is on; absent on `home-pvp-now`. */
  stillHoldSec?: number | null;
};

/** Which name compact mode's caption borrows. See {@link pvpNowLabel}. */
export type PvpNowLabel = "cue" | "file" | "file-ext" | "layer";

export const DEFAULT_PVP_NOW_LABEL: PvpNowLabel = "cue";

/** The Label picker's options, shared by the layout inspector's select and
 *  Home's card menu — one list, so the two cannot drift apart. */
export const PVP_NOW_LABEL_OPTIONS: { value: PvpNowLabel; label: string }[] = [
  { value: "cue", label: "Cue" },
  { value: "file", label: "File name" },
  { value: "file-ext", label: "File name (with extension)" },
  { value: "layer", label: "Layer name" },
];

/**
 * Drop a file name's extension. PURE, so the one rule ("Mark Vance - Lead
 * Pastor.mov" -> "Mark Vance - Lead Pastor") is testable without a layer.
 *
 * A name with no dot, or a leading dot with nothing before it (a dotfile),
 * is returned unchanged — `lastIndexOf` gives -1 or 0 for those, and neither
 * is a real extension to strip.
 */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The name compact mode's caption borrows from a layer that HAS CONTENT.
 *
 * Never called on an empty layer — the caller draws the bare "PVP" caption for
 * that case instead, because a label borrowed from stale content (a name that
 * lingers after the layer clears) is exactly the "residual" trap `lastCueName`
 * already carries elsewhere in this file.
 *
 * "cue" reads `lastCueName` — the DTO carries no "current cue" field of its own,
 * and this is the one place reading it is safe: the layer holds content, so it
 * is not the stale echo `hasContent`'s own doc warns about. Falls back to the
 * file name without its extension when PVP has not sent a cue name at all.
 */
export function pvpNowLabel(layer: PvpLayerDTO, label: PvpNowLabel): string {
  if (label === "layer") return layer.name;
  if (label === "file-ext") return layer.mediaName ?? layer.name;
  if (label === "file") return layer.mediaName ? stripExtension(layer.mediaName) : layer.name;
  return layer.lastCueName ?? (layer.mediaName ? stripExtension(layer.mediaName) : layer.name);
}

/**
 * Compact mode's value when there is no countdown to show — the next most
 * useful name that is not ALREADY the caption.
 *
 * A pinned layer's caption already names the layer, so the cue name is the
 * useful thing left to show (falling back to the file name via `pvpNowLabel`'s
 * own "cue" rule). With no layer pinned, the caption already carries whichever
 * of cue/file the operator's Label choice picked, so the value shows the OTHER
 * one — never the literal "no duration", and never the same name twice on a
 * two-line tile.
 */
export function pvpNowCompactValue(layer: PvpLayerDTO, pinned: boolean, label: PvpNowLabel): string {
  if (pinned) return pvpNowLabel(layer, "cue");
  return pvpNowLabel(layer, label === "cue" ? "file" : "cue");
}

/**
 * The caption, fixed — unless a layer is pinned, in which case IT names the
 * caption in every state.
 *
 * An operator who pinned a tile to "Graphics" wants that word on the tile
 * whether Graphics is playing, empty, or the operator mistyped it and PVP has
 * no such layer — the caption is the one thing on the widget that answers
 * "which tile is this" without waiting for content. So a pinned name wins over
 * everything else: Compact mode's Label choice, the fixed "ProVideoPlayer" of
 * the normal composition, even the empty and not-found states below.
 *
 * With NO layer pinned, today's behaviour is unchanged: full mode's caption is
 * the fixed word (the operator picked "ProVideoPlayer" over "PVP" because a wall
 * reader who does not already know the initials learns nothing from them), and
 * compact mode borrows the Label choice from whichever layer has content, or
 * falls back to the bare "PVP" while nothing does.
 */
export function pvpNowCaption(
  layerName: string | null | undefined,
  compact: boolean,
  layer: PvpLayerDTO | null,
  label: PvpNowLabel,
): string {
  const pinned = (layerName ?? "").trim();
  if (pinned) return `PVP · ${pinned}`;
  if (compact) return layer ? `PVP · ${pvpNowLabel(layer, label)}` : "PVP";
  return PVP_NOW_CAPTION;
}

/** The full mode caption, kept as the constant it always was. */
export const PVP_NOW_CAPTION = "ProVideoPlayer";

/**
 * Which layer this widget reads.
 *
 * PURE and exported so the choice is testable without React.
 *
 * A named layer is matched on its NAME and returned whether or not it holds
 * anything — an operator who pinned a widget to Exit Screen wants to know Exit
 * Screen is empty, not to watch the widget wander to another layer.
 *
 * With no name it follows content, preferring the FIRST layer in PVP's own
 * stack order that holds something. That is what a wall wants, since nobody is
 * there to pick, and it is the same "with-content" rule the list object uses.
 */
export function chooseNowLayer(
  layers: readonly PvpLayerDTO[],
  layerName: string | null | undefined,
): PvpLayerDTO | null {
  const want = (layerName ?? "").trim().toLowerCase();
  if (want) return layers.find((l) => l.name.trim().toLowerCase() === want) ?? null;
  return layers.find(hasContent) ?? null;
}

/**
 * Does a pinned layer name exist among the live layers?
 *
 * Matched the way `chooseNowLayer` matches — trimmed, case-insensitive — so the
 * two never disagree about whether a name is "in the list". An unpinned widget
 * (blank name) has no notion of "not found" and answers true.
 */
export function pinnedLayerExists(layers: readonly PvpLayerDTO[], layerName: string | null | undefined): boolean {
  const want = (layerName ?? "").trim().toLowerCase();
  if (!want) return true;
  return layers.some((l) => l.name.trim().toLowerCase() === want);
}

export type PvpNowBadge = "playing" | "paused" | "still" | "ended" | "empty" | "not found";

/**
 * The state word for a layer ALONE — no progress object needed, because
 * "paused" vs "still" is decided by `state`, not by whether a countdown could be
 * computed. Shared by `nowBadge` below and by the inspector's layer picker,
 * which lists every live layer with this same word as a muted suffix.
 *
 * `playing` is `playbackRate > 0`, NEVER `isPlaying` — which the DTO does not
 * even carry, because a still reports it true with rate 0 and a field whose name
 * says the opposite of what it means is one somebody reads wrongly. A paused
 * clip is the one whose state is still "video" but whose rate has dropped to 0;
 * a still is the one whose state says so outright.
 */
export function pvpLayerStateWord(layer: PvpLayerDTO | null): PvpNowBadge {
  if (!layer || !hasContent(layer)) return "empty";
  if (layer.state === "ended") return "ended";
  if (layer.state === "still") return "still";
  return layer.playbackRate > 0 ? "playing" : "paused";
}

/**
 * The state word beside the caption.
 *
 * `found` is false only for a PINNED name PVP is not reporting — never for the
 * ordinary "nothing has content" case, which is `empty`. It is checked first:
 * a layer that does not exist has no state of its own to report.
 */
export function nowBadge(layer: PvpLayerDTO | null, found = true): PvpNowBadge {
  if (!found) return "not found";
  return pvpLayerStateWord(layer);
}

/** Colour carries the state; the word carries it for anyone who cannot see the
 *  colour. Idle states take the page's own subtle grey rather than a colour of
 *  their own — nothing is happening, and a colour would say otherwise. */
export function badgeColor(badge: PvpNowBadge): string {
  if (badge === "playing") return "var(--color-live-11)";
  if (badge === "paused") return "var(--color-warn-11)";
  return "var(--color-fg-subtle)";
}

/**
 * The state word, drawn.
 *
 * The look lives HERE rather than in Readout: the composition supplies a slot at
 * the end of the caption row and does not need to know that this particular
 * widget puts a colour-carried state word in it. Mono, because it sits beside a
 * mono countdown and a proportional word next to tabular figures reads as a
 * different family.
 */
function Badge({ badge }: { badge: PvpNowBadge }) {
  return <span style={{ color: badgeColor(badge), fontFamily: "var(--font-mono)" }}>{badge}</span>;
}

/**
 * Why this widget has nothing to show, in the operator's words.
 *
 * PURE and exported so the five cases are pinned by a test. Five different
 * nothings said differently, for the reason pvp-object's emptyReason exists: one
 * is a machine to go and look at, one is a layout to fix, one is a name that
 * does not match anything live, one is neither, and one is that we have not
 * heard yet.
 *
 * The "not found" sentence deliberately does not echo the name back — unlike
 * `noSuchLayer`, the list object's sentence for the same idea. Here the name is
 * ALREADY the caption (see `pvpNowCaption`), so repeating it in the sub-line
 * would say the same word twice on a two-line tile.
 */
export function nowEmptyReason(status: PvpStatusDTO | null, layerName: string | null | undefined): string {
  // The first two rungs are pvp-object's too — see pvp-progress.ts. It answers
  // non-null for exactly the cases where `status` is unusable, so everything
  // below it is reached with a connected snapshot in hand.
  const unavailable = pvpUnavailableReason(status);
  if (unavailable !== null) return unavailable;
  const want = (layerName ?? "").trim();
  if (want) {
    return pinnedLayerExists(status?.layers ?? [], want) ? "Nothing on this layer" : "No layer by this name in PVP";
  }
  return "Nothing on screen";
}

export function PvpNowObject({
  config,
  status,
  now,
  skewMs,
  align,
  uniform = false,
}: {
  config: PvpNowConfig;
  status: PvpStatusDTO | null;
  now: number;
  skewMs: number;
  align?: LayoutHAlign | null;
  /** Size the value as though the composition had every line — for Home's grid
   *  of same-height tiles. */
  uniform?: boolean;
}) {
  const layers = status?.layers ?? [];
  const layer = chooseNowLayer(layers, config.layerName);
  // "not found" is a verdict about PVP's live layer list, so it needs one. With
  // no usable snapshot (not configured, offline, nothing heard yet) the tile
  // says "empty" and the sub-line says why; claiming the layer does not exist
  // when we cannot see any layers would send the operator to fix a layout that
  // is fine.
  const found = pvpUnavailableReason(status) !== null || pinnedLayerExists(layers, config.layerName);
  // The widget's own hold wins over the PVP card's default — an operator who
  // set one on this specific tile did so to disagree with the card, and a
  // fallback that ignored it would make the override a control that does
  // nothing. Only consulted when countStills is actually on: a widget that
  // never asked to count a still down should not go looking for a hold at all.
  const stillHoldSec = config.countStills ? (config.stillHoldSec ?? status?.imageDurationSec ?? null) : null;
  const progress =
    (layer ? computePvpProgress(layer, status?.sampledAt ?? null, now, skewMs) : null) ??
    (layer ? computeStillProgress(layer, now, skewMs, stillHoldSec) : null);
  // A still NOT opted into the countdown, but whose arrival PVP has told us —
  // the full mode's "on screen m:ss" line reads this. Never set at the same
  // time as `progress`: a still that IS counting down already has its value
  // slot, and a second clock beside it would answer the same question twice.
  const onScreenSec = !progress && layer ? stillOnScreenSec(layer, now, skewMs) : null;
  const badge = nowBadge(layer, found);
  const compact = config.compact ?? false;
  const label = config.nowLabel ?? DEFAULT_PVP_NOW_LABEL;
  // The pinned-layer name, once, since both the caption and the compact value's
  // fallback rule need to know whether a name is pinned at all.
  const pinned = (config.layerName ?? "").trim();
  const caption = pvpNowCaption(config.layerName, compact, layer, label);

  if (badge === "empty" || badge === "not found") {
    return (
      <Readout
        caption={caption}
        captionEnd={<Badge badge={badge} />}
        // A DASH in the value, the sentence in the sub-line — the app's existing
        // shape for a readout with nothing to report (layout-renderer draws
        // `<Readout value="—" dim />` in two other places).
        //
        // The approved mockup puts the sentence where the value goes. That works
        // at the one card size the mockup drew and overflows below it: "Nothing
        // on this layer" measured 241px of text in a 220px box at a 257x159
        // tile, because the value line does not ellipsise — it is one nowrap
        // string that shrinks to fit and then stops. The sub-line ellipsises, so
        // the words survive at every size instead of being cut off mid-word.
        value="—"
        sub={nowEmptyReason(status, config.layerName)}
        align={align}
        uniform={uniform}
        dim
      />
    );
  }

  if (compact) {
    // `layer` is non-null here — the two cases it can be null (`empty` and
    // `not found`) already returned above.
    const valueText = progress
      ? fmtDuration(progress.remainingSec)
      : layer
        ? pvpNowCompactValue(layer, !!pinned, label)
        : "";
    return (
      <Readout
        caption={caption}
        captionEnd={<Badge badge={badge} />}
        // The countdown alone when there is one — no "remaining" word, no
        // next-cue line. That is the whole point of the compact treatment: two
        // lines, not three or four, whenever content is up.
        value={valueText}
        mono={!!progress}
        // NEVER dimmed here: whatever is showing (a countdown, a cue name, a
        // file name) is real content, unlike the empty/not-found dash above.
        meter={progress && (config.showProgress ?? true) ? progress.fraction : null}
        meterKey={pvpMeterKey(layer)}
        align={align}
        uniform={uniform}
      />
    );
  }

  // NEVER without a current cue to anchor it, and never on an empty layer: the
  // "next" line is only meaningful as the entry after the one that is up. On its
  // own it would be a claim about the future with nothing behind it.
  //
  // The label is quieter than the cue it labels, the same way the caption is
  // quieter than the value. It was one string with two spaces in it, which HTML
  // collapses to one — so the separation only ever existed in the source.
  const next =
    (config.showNextCue ?? true) && layer?.nextCueName ? (
      <>
        <span style={{ opacity: 0.6, marginRight: "0.6em" }}>Next</span>
        {layer.nextCueName}
      </>
    ) : null;

  // OPTION A: the countdown leads. While there is one to show, it takes the
  // value slot — the biggest text on the tile — because "how long have I got"
  // is the question this widget exists to answer during a service, and a media
  // file name answers a different one. The still/ended/no-countdown case falls
  // back to the same name compact mode shows, because there is nothing left to
  // count and a file name is the next most useful thing on the tile.
  const value = progress ? fmtDuration(progress.remainingSec) : layer ? pvpNowLabel(layer, "cue") : "Playing";
  // The file name moves to the sub-line once the countdown has the value slot.
  // Shown only when it says something the value does not already say — a cue
  // name and a file name are often different strings for the same clip, and
  // showing the file name twice (once as the fallback value, once as the sub)
  // would be redundant on the still/ended tiles.
  // A still PVP has told us the arrival of, but that this widget is not
  // counting down (countStills off, or no hold to count from): the file name
  // gains "on screen", and the counting-up time takes the subEnd slot the
  // countdown case uses for its own duration — the same slot, a different
  // number, never both at once.
  const sub = progress
    ? layer?.mediaName ?? "Playing"
    : onScreenSec != null
      ? `${layer?.mediaName ?? layer?.name} on screen`
      : layer?.mediaName && layer.mediaName !== value
        ? layer.mediaName
        : null;

  return (
    <Readout
      caption={caption}
      captionEnd={<Badge badge={badge} />}
      value={value}
      mono={!!progress}
      sub={sub}
      subEnd={progress ? fmtDuration(progress.durationSec) : onScreenSec != null ? fmtDuration(onScreenSec) : null}
      meter={progress && (config.showProgress ?? true) ? progress.fraction : null}
      // Which clip the fraction above is a fraction of, so the rule can tell a
      // second of a clip playing from a cut to a different one.
      meterKey={pvpMeterKey(layer)}
      footer={next}
      align={align}
      uniform={uniform}
    />
  );
}
