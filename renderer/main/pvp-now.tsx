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
import { computePvpProgress, noSuchLayer, pvpMeterKey, pvpUnavailableReason, type PvpProgress } from "./pvp-progress";
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
 * The caption, fixed.
 *
 * Not configurable, and that is the point of the widget: the Home card it
 * replaces had no caption at all, and "hard to know what widget I am looking at"
 * is the report this whole change came from. The full word rather than "PVP" —
 * the operator picked it — because a wall reader who does not already know the
 * initials learns nothing from them.
 */
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

export type PvpNowBadge = "playing" | "paused" | "still" | "empty";

/**
 * The state word beside the caption.
 *
 * `playing` is `playbackRate > 0`, NEVER `isPlaying` — which the DTO does not
 * even carry, because a still reports it true with rate 0 and a field whose name
 * says the opposite of what it means is one somebody reads wrongly. A paused
 * clip is the one that still has a duration; a still is the one that does not.
 */
export function nowBadge(layer: PvpLayerDTO | null, progress: PvpProgress | null): PvpNowBadge {
  if (!layer || !hasContent(layer)) return "empty";
  if (layer.playbackRate > 0) return "playing";
  return progress ? "paused" : "still";
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
 * PURE and exported so the four cases are pinned by a test. Four different
 * nothings said differently, for the reason pvp-object's emptyReason exists: one
 * is a machine to go and look at, one is a layout to fix, one is neither, and
 * one is that we have not heard yet.
 */
export function nowEmptyReason(status: PvpStatusDTO | null, layerName: string | null | undefined): string {
  // The first two rungs are pvp-object's too — see pvp-progress.ts. It answers
  // non-null for exactly the cases where `status` is unusable, so everything
  // below it is reached with a connected snapshot in hand.
  const unavailable = pvpUnavailableReason(status);
  if (unavailable !== null) return unavailable;
  const want = (layerName ?? "").trim();
  if (want) {
    const layers = status?.layers ?? [];
    const found = layers.some((l) => l.name.trim().toLowerCase() === want.toLowerCase());
    return found ? "Nothing on this layer" : noSuchLayer(want);
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
  const layer = chooseNowLayer(status?.layers ?? [], config.layerName);
  const progress = layer ? computePvpProgress(layer, status?.sampledAt ?? null, now, skewMs) : null;
  const badge = nowBadge(layer, progress);
  const compact = config.compact ?? false;

  if (badge === "empty") {
    return (
      <Readout
        caption={compact ? "PVP" : PVP_NOW_CAPTION}
        captionEnd={<Badge badge="empty" />}
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
    // `layer` is non-null in practice — `badge === "empty"` above is the only
    // case it can be null, and that already returned — but the ternary reads
    // truer than an assertion the type checker cannot itself verify.
    const labelText = layer ? pvpNowLabel(layer, config.nowLabel ?? DEFAULT_PVP_NOW_LABEL) : null;
    return (
      <Readout
        caption={labelText ? `PVP · ${labelText}` : "PVP"}
        captionEnd={<Badge badge={badge} />}
        // The countdown alone — no "remaining" word, no next-cue line. That is
        // the whole point of the compact treatment: two lines, not three or
        // four, whenever content is up.
        value={progress ? fmtDuration(progress.remainingSec) : "no duration"}
        mono={!!progress}
        // A STILL SHOWS NO TIME AT ALL, for the same reason the normal
        // composition below shows none: dimming "no duration" rather than
        // reading a countdown is what stops a graphic that never ends looking
        // like a clip about to.
        dim={!progress}
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

  return (
    <Readout
      caption={PVP_NOW_CAPTION}
      captionEnd={<Badge badge={badge} />}
      // The media file, truncating. PVP file names run long and this is the line
      // read from across the room, so it takes the value slot and everything
      // else steps down from it.
      value={layer?.mediaName ?? "Playing"}
      // A STILL SHOWS NO TIME AT ALL. It reports isPlaying true with rate 0 and
      // timeRemaining 0, so a countdown under it would be a countdown to nothing
      // — a graphic that is up indefinitely reading 0:00.
      sub={progress ? "remaining" : "no duration"}
      subEnd={
        progress ? (
          fmtDuration(progress.remainingSec)
        ) : (
          /* A rule, not a reading. The em-dash holds the column so the widget
             does not reflow when a clip gives way to a graphic, and it says
             "there is no number here" rather than showing a zero that would read
             as a clip about to end. */
          <span style={{ opacity: 0.55 }}>&mdash;</span>
        )
      }
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
