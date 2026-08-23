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
import type { SignageHorizonEntry, SignageTransition } from "@main/types/signage";
import { isSignageVideo } from "@main/types/signage";

import { itemAt } from "./signage-cycle";
import { layerStyles } from "./signage-transition";

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

  const current = playlist.items[at.index];
  const transition: SignageTransition = current.transition ?? playlist.transition;

  // The outgoing item is simply the previous one in the cycle, which wraps. A
  // one-item playlist has no previous item other than itself, and crossfading an
  // item with itself is a visible flicker every revolution for no reason.
  const hasPrevious = playlist.items.length > 1;
  const previous = hasPrevious
    ? playlist.items[(at.index - 1 + playlist.items.length) % playlist.items.length]
    : null;

  // The transition occupies the FIRST `ms` of this item's own slot — which is
  // what keeps the cycle equal to the plain sum of durations, and therefore what
  // keeps two screens in step.
  const during = transition.kind !== "cut" && transition.ms > 0 && at.offsetMs < transition.ms;
  const progress = during ? at.offsetMs / transition.ms : 1;
  const styles = layerStyles(transition, progress);

  return (
    <div
      data-signage-player=""
      className={className}
      style={{ position: "relative", background: "#000", overflow: "hidden" }}
    >
      {during && previous ? (
        <Layer item={previous} fit={playlist.fit} style={{ ...FILL, ...styles.outgoing }} />
      ) : null}
      <Layer item={current} fit={playlist.fit} style={{ ...FILL, ...styles.incoming }} />
      {styles.veilOpacity > 0 ? (
        <div style={{ ...FILL, background: "#000", opacity: styles.veilOpacity, pointerEvents: "none" }} />
      ) : null}
    </div>
  );
}

function Layer({
  item,
  fit,
  style,
}: {
  item: SignageHorizonEntry["playlist"] extends infer P
    ? P extends { items: (infer I)[] }
      ? I
      : never
    : never;
  fit: "contain" | "cover";
  style: CSSProperties;
}) {
  const objectFit = (item.fit ?? fit) as CSSProperties["objectFit"];
  const common: CSSProperties = { ...style, width: "100%", height: "100%", objectFit };

  if (isSignageVideo(item.mime)) {
    return (
      <video
        key={item.url}
        src={item.url}
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

  return <img key={item.url} src={item.url} alt="" style={common} />;
}
