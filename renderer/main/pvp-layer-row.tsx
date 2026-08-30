// pvp-layer-row.tsx — ONE row of the PVP layer list.
//
// The single component both PVP surfaces render, so the residual-cue rule below
// lives in exactly one place. With a component per surface there would be two
// chances to draw a stale cue name on an empty layer, which is the mistake
// CLAUDE.md calls the most expensive recurring one in this repo.
//
// It shows NO PICTURE, and there is no prop that would. PVP exposes no
// thumbnail, preview or frame endpoint — all 80 documented paths were enumerated
// — so "what is on this layer" is answerable only as a name, a state and a time.

import type { ReactNode } from "react";

import { fmtDuration } from "./pco-timer";
import { computePvpProgress } from "./pvp-progress";
import type { PvpLayerDTO } from "@main/types/pvp";

export interface PvpLayerRowProps {
  layer: PvpLayerDTO;
  /** From PvpStatusDTO. The anchor every progress reading is measured from. */
  sampledAt: string | null;
  now: number;
  skewMs: number;
  showProgress: boolean;
  /** Home's card is tighter than a wall tile: one line, no bar. */
  compact: boolean;
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="px-1 rounded-sm bg-fg/10 text-fg-muted text-[0.8em] leading-tight shrink-0">{children}</span>
  );
}

export function PvpLayerRow({ layer, sampledAt, now, skewMs, showProgress, compact }: PvpLayerRowProps) {
  const empty = layer.state === "empty";
  const progress = showProgress && !compact ? computePvpProgress(layer, sampledAt, now, skewMs) : null;

  // THE RULE. `lastCueName` is the last cue that TOUCHED this layer and it never
  // clears — four idle layers were observed simultaneously naming the same cue
  // while displaying nothing. It is carried on the DTO because it is the only
  // field that can confirm a trigger action landed, and it is drawn only here,
  // only when the layer actually holds something.
  const cue = empty ? null : layer.lastCueName;

  return (
    <div className="flex flex-col gap-[0.15em] min-w-0" style={{ opacity: empty ? 0.45 : 1 }}>
      <div className="flex items-baseline gap-[0.4em] min-w-0">
        <span className="text-fg-muted shrink-0">{layer.name}</span>
        <span className="truncate min-w-0">{empty ? "Empty" : (layer.mediaName ?? "Playing")}</span>
        {layer.hidden && <Badge>Hidden</Badge>}
        {layer.muted && <Badge>Muted</Badge>}
        {/* Only when it is actually faded. A permanent "100%" on every layer is
            chrome, and the badge row is meant to say what is unusual. */}
        {layer.opacity < 1 && <Badge>{Math.round(layer.opacity * 100)}%</Badge>}
      </div>

      {cue && !compact && <div className="text-[0.8em] text-fg-subtle truncate min-w-0">{cue}</div>}

      {progress && (
        <div className="flex items-center gap-[0.4em]">
          <div data-pvp-bar className="h-[0.18em] flex-1 min-w-0 rounded-full overflow-hidden bg-fg/15">
            <div className="h-full rounded-full bg-fg" style={{ width: `${progress.fraction * 100}%` }} />
          </div>
          <span className="text-[0.8em] text-fg-subtle tabular-nums shrink-0">
            {fmtDuration(progress.remainingSec)}
          </span>
        </div>
      )}
    </div>
  );
}
