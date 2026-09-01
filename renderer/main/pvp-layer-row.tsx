// pvp-layer-row.tsx — ONE row of the PVP layer list.
//
// The single component both PVP surfaces render, so the rules below live in
// exactly one place. With a component per surface there would be two chances to
// draw a stale cue name on an empty layer, which is the mistake CLAUDE.md calls
// the most expensive recurring one in this repo.
//
// THE SHAPE IS charger-battery's, deliberately and exactly: the label truncates
// and flexes left, the values sit right in tabular figures, and an absent row is
// the word `empty` at low opacity. This drew its own two-line row for a release
// and matched neither of the two conventions the app already had — so three
// layers read as six, nothing lined up, and no column could be scanned.
//
// "LAST CUE" IS GONE FROM THE ROW. `playingItem` is residual: four idle layers
// were observed simultaneously naming the same cue while showing nothing, and it
// disagrees on live layers too (media LoopGraphic_1_HeisWorthy.mp4 under a cue
// reading SERIES GRAPHIC). It used to be the loudest text on the tile. It stays
// on the DTO, where an action verifies against it and where `pvp-now` uses it to
// look up what comes next.
//
// It shows NO PICTURE, and there is no prop that would. PVP exposes no
// thumbnail, preview or frame endpoint — all 80 documented paths were enumerated
// — so "what is on this layer" is answerable only as a name, a state and a time.

import { fmtDuration } from "./pco-timer";
import { computePvpProgress, pvpMeterKey } from "./pvp-progress";
import { MeterFill } from "./readout-meter";
import { hasContent, type PvpLayerDTO } from "@main/types/pvp";

export interface PvpLayerRowProps {
  layer: PvpLayerDTO;
  /** From PvpStatusDTO. The anchor every progress reading is measured from. */
  sampledAt: string | null;
  now: number;
  skewMs: number;
  /**
   * Draw the hairline progress rule under a rolling clip.
   *
   * The TIME is not behind this and never was — that is the reading the widget
   * exists for, and hiding it behind the bar's switch is how a countdown that
   * was never drawn read as a countdown PVP was not reporting.
   */
  showProgress?: boolean;
}

/**
 * The qualifiers that follow the time, in the order they are read out.
 *
 * PURE and exported so every state in the approved table is pinned by a test
 * rather than read off a screen.
 *
 *   rolling video   ->  []                 the number says it
 *   still graphic   ->  ["still"]          up, but not counting
 *   paused clip     ->  ["paused"]         keeps its duration, number stops
 *   hidden / muted  ->  ["hidden"]         live content nobody can see
 *
 * `hidden` covers a zero opacity too: a layer faded to nothing is invisible for
 * every practical purpose, and reporting it as "0%" would make the reader do the
 * inference. A partial fade keeps its percentage, because that is a look somebody
 * chose rather than a layer that is off.
 */
export function rowQualifiers(layer: PvpLayerDTO, timed: boolean): string[] {
  if (!hasContent(layer)) return [];
  const out: string[] = [];
  if (layer.hidden || layer.opacity === 0) out.push("hidden");
  else if (layer.opacity < 1) out.push(`${Math.round(layer.opacity * 100)}%`);
  if (layer.muted) out.push("muted");
  // ROLLING is playbackRate > 0, never isPlaying: a still reports isPlaying true
  // with rate 0, so isPlaying would call every still a rolling clip and put a
  // countdown to nothing under a graphic that is up indefinitely.
  if (timed && layer.playbackRate <= 0) out.push("paused");
  if (!timed) out.push("still");
  return out;
}

export function PvpLayerRow({ layer, sampledAt, now, skewMs, showProgress = false }: PvpLayerRowProps) {
  const empty = !hasContent(layer);
  // Computed whatever showProgress says: it gates the BAR, not the number.
  const progress = computePvpProgress(layer, sampledAt, now, skewMs);
  const quals = rowQualifiers(layer, progress != null);

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-[0.5em] w-full min-w-0">
        {/* flex-auto, NOT charger-battery's flex-1.
            A charger bay's values are fixed-width ("87%"), so its label can take
            the whole remainder and the values can refuse to shrink. This row has
            TWO variable-length strings, and with the values held at shrink-0 a
            forty-character PVP file name pushed the layer name out of existence:
            measured at a 257x159 tile, "Graphics (1s)" rendered 0px wide while
            its media name ran off the left edge. Both sides shrink now, in
            proportion to their content, so the long one gives way first and
            neither disappears. */}
        <span className="truncate min-w-0 flex-auto text-fg-muted">{layer.name}</span>
        <span className="flex items-center gap-[0.6em] min-w-0 tabular-nums">
          {empty ? (
            /* The same word and the same 0.35 opacity charger-battery uses for an
               empty bay. Never the residual cue name, which is what an idle layer
               would otherwise claim to be showing. */
            <span className="shrink-0" style={{ opacity: 0.35 }}>empty</span>
          ) : (
            <>
              {/* Capped as well as truncated: PVP file names run to forty
                  characters and an uncapped one would push the time off the row
                  it is meant to sit beside. */}
              <span className="truncate min-w-0 max-w-[14em]">{layer.mediaName ?? "Playing"}</span>
              {/* The time and the state word never shrink. They are short, and
                  they are the reading — a half-drawn countdown is worse than a
                  half-drawn file name. */}
              {progress && <span className="shrink-0 font-semibold">{fmtDuration(progress.remainingSec)}</span>}
              {quals.length > 0 && (
                <span className="shrink-0 text-[0.85em] text-fg-subtle">{quals.join(" ")}</span>
              )}
            </>
          )}
        </span>
      </div>

      {/* Under the row rather than in it, and only for something that is
          actually moving. A rule under a still would sit permanently at one end
          and read as a clip that had finished. */}
      {showProgress && progress && (
        /* currentColor, not a token. A widget on a stage canvas carries the
           colour the operator chose and is not inside .kiosk-surface, so a
           token here resolved to the LIGHT theme's grey — a pale track under a
           white bar on a black card, measured in the editor. Deriving both from
           the ink in use keeps them in the same family on any ground. */
        <div
          data-pvp-bar
          className="h-[0.14em] w-full rounded-full overflow-hidden mt-[0.15em]"
          style={{ background: "color-mix(in srgb, currentColor 18%, transparent)" }}
        >
          {/* The SAME fill the readout composition's rule uses, not a second
              copy of it. Both are fed by computePvpProgress on a 1 Hz tick, so
              both stepped once a second, and fixing one of two identical rules
              is how this repo has shipped drifting copies before. */}
          <MeterFill
            fraction={progress.fraction}
            seriesKey={pvpMeterKey(layer)}
            fill="currentColor"
          />
        </div>
      )}
    </div>
  );
}
