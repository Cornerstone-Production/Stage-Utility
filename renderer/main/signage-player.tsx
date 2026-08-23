// signage-player.tsx — what a signage screen actually draws.
//
// A pure function of (entry, nowMs). No timers, no refs, no "previous item"
// state: the transition is derived from the clock exactly as the current item
// is, so two screens playing the same playlist are mid-crossfade at the same
// instant rather than merely arriving at the same graphic eventually. It also
// means the whole thing is testable by passing a number.
//
// The parent supplies `nowMs` and decides how often to advance it. That keeps
// the ticking in one place (the surface — a wall, an editor preview, the Now
// board) instead of one interval per player.
//
// Ground is black, always, and nothing else is ever drawn. A signage screen with
// a placeholder or an error message on it is a signage screen with a placeholder
// on the wall.

import type { CSSProperties } from "react";
import type {
  SignageFit,
  SignageHorizonEntry,
  SignageHorizonItem,
  SignageTransition,
} from "@main/types/signage";
import { isSignageVideo } from "@main/types/signage";

import { itemAt } from "./signage-cycle";
import { transitionPlan } from "./signage-transition";

const FILL: CSSProperties = { position: "absolute", inset: 0 };

export function SignagePlayer({
  entry,
  nowMs,
  className,
}: {
  entry: SignageHorizonEntry | null;
  nowMs: number;
  className?: string;
}) {
  // Marks the signage surface in the DOM. Black-on-black is otherwise
  // indistinguishable from a screen that rendered nothing at all — which is the
  // difference between "playing, between graphics" and "the shell gave up".
  const black = (
    <div
      data-signage-player=""
      className={className}
      style={{ position: "relative", background: "#000", overflow: "hidden" }}
    />
  );

  const playlist = entry?.playlist;
  if (!playlist) return black;

  const at = itemAt(playlist.items, nowMs - playlist.startedAt);
  if (!at) return black; // empty playlist, or every item zero-length

  const incomingItem = playlist.items[at.index];
  const transition: SignageTransition = incomingItem.transition ?? playlist.transition;
  // CLAMPED to the item's own slot, at the input, so the animation the browser
  // is given is the one that actually runs. A 3s fade-through-black on a 1s clip
  // otherwise held `showingPrevious` true for the whole slot: the wall showed
  // item N-1 during item N's turn, every revolution, forever. Nothing clamps
  // MAX_TRANSITION_MS against MIN_ITEM_MS, so it is reachable with a short
  // trimmed clip today.
  const plan = transitionPlan(
    transition.ms > incomingItem.durationMs
      ? { ...transition, ms: incomingItem.durationMs }
      : transition,
  );

  // The outgoing item is simply the previous one in the cycle, which wraps. A
  // one-item playlist has no previous item other than itself, and crossfading an
  // item with itself is a visible flicker every revolution for no reason.
  const hasPrevious = playlist.items.length > 1;
  const previousIndex = (at.index - 1 + playlist.items.length) % playlist.items.length;
  const previous = hasPrevious ? playlist.items[previousIndex] : null;

  // The transition occupies the FIRST `plan.ms` of this item's own slot — which
  // is what keeps the cycle equal to the plain sum of durations, and therefore
  // what keeps two screens in step.
  //
  // `plan.ms`, not a second reading of the transition: what counts as a cut is
  // transitionPlan's to decide, and asking here as well was the same rule stated
  // twice with one of them negated.
  const during = at.offsetMs < plan.ms;

  // Fade through black swaps under the opaque middle, so for the first half of
  // the transition the layer is still showing the item going out.
  const showingPrevious = during && plan.swapAtMidpoint && at.offsetMs < plan.ms / 2;
  const shown = showingPrevious && previous ? previous : incomingItem;
  const shownIndex = showingPrevious && previous ? previousIndex : at.index;

  return (
    <div
      data-signage-player=""
      className={className}
      style={{ position: "relative", background: "#000", overflow: "hidden" }}
    >
      {/* ONE key namespace across both slots, so the element that was playing
          item N is MOVED into the outgoing slot rather than unmounted and
          rebuilt. With `out-N` and `in-N` as separate namespaces React saw two
          different elements, and for a video that meant a fresh <video> at the
          boundary: a 30-second clip crossfaded out showing its first 600ms
          instead of its last, and two decoders spinning up per boundary on a Pi.

          The animation still starts, because the moved element's animationName
          changes (static -> signage-fade-out is a new animation).

          showOutgoing and swapAtMidpoint are mutually exclusive in every plan,
          so the two layers can never claim the same key. */}
      {[
        during && plan.showOutgoing && previous ? (
          <Layer
            key={`layer-${previousIndex}`}
            item={previous}
            fit={playlist.fit}
            style={{ ...FILL, ...plan.outgoing }}
          />
        ) : null,
        <Layer
          key={`layer-${shownIndex}`}
          item={shown}
          fit={playlist.fit}
          // Once the transition is over, plain and static: an animation left
          // declared on a layer that is simply sitting there keeps it on its own
          // compositor surface for the whole eight seconds.
          style={{ ...FILL, ...(during ? plan.incoming : { opacity: 1 }) }}
        />,
      ]}
      {during && plan.veil ? (
        <div key={`veil-${at.index}`} style={{ ...FILL, ...plan.veil, pointerEvents: "none" }} />
      ) : null}
    </div>
  );
}

/** "#t=start,end" in seconds, or nothing when the clip is not trimmed. */
function trimFragment(url: string, startMs?: number, endMs?: number): string {
  if (startMs === undefined && endMs === undefined) return url;
  const s = (startMs ?? 0) / 1000;
  // Three decimals: the fragment is in seconds and a millisecond is the finest
  // thing anybody sets here.
  const from = s.toFixed(3).replace(/\.?0+$/, "");
  if (endMs === undefined) return `${url}#t=${from}`;
  const to = (endMs / 1000).toFixed(3).replace(/\.?0+$/, "");
  return `${url}#t=${from},${to}`;
}

function Layer({
  item,
  fit,
  style,
}: {
  item: SignageHorizonItem;
  fit: SignageFit;
  style: CSSProperties;
}) {
  const objectFit = (item.fit ?? fit) as CSSProperties["objectFit"];
  const common: CSSProperties = {
    ...style,
    width: "100%",
    height: "100%",
    objectFit,
    // No image-rendering hint. `high-quality` was tried and Chromium computed it
    // straight back to `auto` — so it would have been a line claiming to do
    // something that did nothing. `auto` already picks the good resampler for a
    // downscale; the quality that is actually at risk is a source SMALLER than
    // the panel, and no CSS fixes that. The media library warns about it instead.
  };

  if (isSignageVideo(item.mime)) {
    // A MEDIA FRAGMENT does the trimming: "#t=10,20" starts the clip ten
    // seconds in and stops it at twenty. No seeking code, no re-encode, and the
    // same file trimmed two ways in two playlists is still one file.
    //
    // The fragment is not sent to the server and is excluded from the URL a
    // Request is keyed by, so this changes neither the immutable caching nor
    // what the offline worker holds.
    const src = trimFragment(item.url, item.trimStartMs, item.trimEndMs);
    return (
      <video
        // Keyed on the trimmed src: changing where a clip starts has to remount
        // it, or the element keeps playing the range it was given.
        key={src}
        src={src}
        // muted + playsInline or a browser refuses to autoplay at all, and a
        // signage screen has nobody to press play.
        muted
        autoPlay
        playsInline
        // No loop: the cycle decides when this item's turn ends, and a clip that
        // looped would restart under a playlist that had moved on.
        preload="auto"
        style={common}
      />
    );
  }

  return (
    <img
      key={item.url}
      src={item.url}
      alt=""
      // Decoded BEFORE it is put on screen. The default is async, which lets a
      // layer mount and begin its fade while the image is still being decoded —
      // so the first frames of a crossfade are of nothing, and the graphic
      // appears to snap in part-way through.
      decoding="sync"
      // Never lazy on a wall: the whole point of the prefetch is that the next
      // graphic is ready before its turn.
      loading="eager"
      style={common}
    />
  );
}
