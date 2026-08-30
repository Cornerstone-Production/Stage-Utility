// scores-object.tsx — a followed team's live score, at wall distance.
//
// Its own file rather than a case in layout-renderer's switch, like osc-button:
// choosing WHICH game to show is a real decision with two modes, and it composes
// the shared strip rather than drawing anything of its own.
//
// It renders ScoreStrip — the same component the context-bar capsule and the
// Home card use. A capsule, a Live Activity card and a wall widget are DIFFERENT
// SIZES OF THE SAME THING, never three implementations, so a team colour or a
// bases diamond can only ever be wrong in one place.

import { useLayoutEffect, useRef } from "react";

import { clamp } from "@main/services/clamp";
import { useLatestRef } from "@renderer/lib/use-latest-ref";
import { ScoreStrip } from "./score-strip";
import { liveIndex } from "../app/score-activity";

/**
 * What a pinned team is stored as: `league:teamId`, e.g. "mlb:16".
 *
 * ESPN'S TEAM IDS ARE ONLY UNIQUE WITHIN A LEAGUE. Measured across the eight
 * leagues the picker offers, 267 ids name different clubs in different ones —
 * id 16 alone is the Cubs, the Vikings, the Timberwolves, the Penguins and
 * Sacramento State. An object pinned to a bare "16" by a church that follows two
 * of those matches both games and shows whichever happens to be live, which is
 * the wrong sport on the wall with nothing to say it went wrong.
 *
 * Exported so the inspector writes the same key this reads. Splitting on the
 * first colon, not `split(":")`, so an id containing one could never lose its
 * tail — none does today, and this is an undocumented API.
 */
export function teamPin(league: string, teamId: string): string {
  return `${league}:${teamId}`;
}

function parsePin(pin: string): { league: string | null; teamId: string } {
  const at = pin.indexOf(":");
  // A BARE ID IS A PRE-COLLEGE CONFIG and still resolves, by team id in any
  // league — exactly what it did before. Migrating saved layouts would mean
  // guessing a league for an id that names up to five clubs, which is the
  // ambiguity this format exists to avoid inventing.
  return at < 0 ? { league: null, teamId: pin } : { league: pin.slice(0, at), teamId: pin.slice(at + 1) };
}

/**
 * Which of today's followed games this object is for.
 *
 * `"auto"` is the wall-display case and is the default: nobody is standing at a
 * stage monitor to pick, so it follows whichever followed game is live,
 * preferring the one that scored most recently. When nothing is live it falls
 * back to the next one to start, so the object says "7:05 PM" rather than going
 * blank on the afternoon of a game.
 *
 * Anything else is a TEAM PIN — see teamPin. It resolves to that team's game
 * today. Pinning an EVENT id is deliberately not offered: an event id is a
 * per-day value that means nothing next week, so a wall would go blank every
 * Monday.
 *
 * Exported and pure, because "which game" is the whole decision this object
 * makes and it is the part worth testing.
 */
export function pickGame(
  scores: ScoresStatusDTO | null,
  game: "auto" | string,
): ScoreGameDTO | null {
  const games = scores?.games ?? [];
  if (games.length === 0) return null;

  if (game !== "auto") {
    const pin = parsePin(game);
    const mine = games.filter(
      (g) =>
        (pin.league === null || g.league === pin.league) &&
        (g.away.id === pin.teamId || g.home.id === pin.teamId),
    );
    if (mine.length === 0) return null;
    // A doubleheader is two games for one team on one day. Prefer the one being
    // played; otherwise the earliest that has not finished; otherwise the last
    // one, so a wall shows this evening's final rather than nothing.
    return (
      mine.find((g) => g.state === "in") ??
      mine.find((g) => g.state === "pre") ??
      mine[mine.length - 1]
    );
  }

  const live = liveIndex(games, scores?.lastEvents ?? []);
  if (live >= 0) return games[live];
  // `games` is sorted by start time, so the first "pre" is the next one on.
  return games.find((g) => g.state === "pre") ?? games[games.length - 1];
}

/**
 * The message when there is no game to draw.
 *
 * Never an empty box. A wall widget that renders nothing is indistinguishable
 * from a widget that is broken, and the operator who placed it is not in the
 * room to check.
 */
function Empty({ children }: { children: React.ReactNode }) {
  // Scaled like everything else in this object. At a fixed size the caption was
  // ~11px whatever the tile, so a wall tile drew a large grey box with a line
  // nobody in the room could read. See --score-fit-scale in styles.css.
  const ref = useBoxEffect((el, w, h) => {
    el.style.setProperty("--score-fit-scale", String(fitStrip(w, h, NATURAL_H_FALLBACK).scale));
  });
  return (
    <div ref={ref} className="score-object-empty">
      {children}
    </div>
  );
}

export function ScoresObject({
  config,
  scores,
}: {
  config: Extract<LayoutObjectConfig, { type: "scores" }>;
  scores: ScoresStatusDTO | null;
}) {
  const game = pickGame(scores, config.game);

  if (!game) {
    // The three reasons there is nothing, kept apart. "No games today" for a
    // failed request is a factual lie about the operator's schedule.
    if (scores?.error) return <Empty>Scores unavailable</Empty>;
    if (!scores?.connected) return <Empty>No teams followed</Empty>;
    return <Empty>{config.game === "auto" ? "No games today" : "Not playing today"}</Empty>;
  }

  return (
    <ScoresFitted
      game={game}
      // Detail off drops the sport-specific centre to the plain status line.
      // ScoreCenter already draws exactly that for a game not in play, so this is
      // the same composition with less in it rather than a second one.
      detail={config.detail !== false}
    />
  );
}

/**
 * How far the strip may grow to fill a big tile, and how far it may shrink.
 *
 * The same bounds layout-renderer's own fit uses: a ceiling so a small strip in a
 * huge tile is not absurd, a floor so a squeezed one stays legible rather than
 * vanishing.
 */
const FIT_MAX = 3;
const FIT_MIN = 0.3;

/**
 * The width the strip is DESIGNED at, in CSS pixels.
 *
 * Every proportion in `.score-strip` — the 32px logo, the 29px score, the 100px
 * centre — reads correctly against this width, so the fit lays the strip out at
 * AT LEAST this and zooms, rather than restating the design in relative units.
 * That is what keeps "make it fill its box" from being a redesign.
 *
 * It also has to be a DEFINITE width: `.score-strip` declares
 * `container-type: inline-size`, which takes its contents out of its own inline
 * sizing, so as a bare flex item it measured zero and spilled 164px out of a box
 * it had no width in.
 */
const NATURAL_W = 520;

/**
 * The strip's natural height when it cannot be measured — jsdom, and the first
 * frame of a strip that has not laid out yet.
 *
 * Measured in the browser at NATURAL_W: 86px for baseball with the detail centre.
 * A CONSTANT WOULD BE WRONG IN THE REAL CASE, which is why the live path measures
 * instead: football's four-row centre is 99px against baseball's 86, so a
 * constant either clips football or shrinks every other sport by 15%.
 */
const NATURAL_H_FALLBACK = 86;

/**
 * The zoom, and the size to lay the strip out at so that zoom exactly fills the
 * box.
 *
 * PURE, and this is the whole sizing decision. `width * scale === box.w` and
 * `height * scale === box.h` by construction — the layout size is derived FROM
 * the scale rather than fixed at NATURAL_W — which is the difference between
 * this and what it replaces:
 *
 *   • Before, the strip was laid out at a fixed 520 x natural and scaled. On a
 *     tall tile that left the strip's own ~6:1 band floating in dead ground; on
 *     a tile narrower than 520 the grid clamped the oversized item to the LEFT
 *     instead of centring it, so `overflow: hidden` ate the home team at 296px
 *     and the whole widget at 166px.
 *   • Now the layout box IS the tile divided by the zoom, so the strip always
 *     fills, its origin is always the tile's, and nothing can fall outside.
 *
 * The zoom itself is unchanged wherever the old one already fit: it is still
 * `min(w / naturalW, h / naturalH)` clamped to the same bounds.
 */
export function fitStrip(
  boxW: number,
  boxH: number,
  naturalH: number,
): { scale: number; width: number; height: number } {
  // A box is never zero here — the callers gate on it — but a fit that can
  // return 0 is a fit that can draw nothing, which is the failure this object's
  // own Empty component exists to refuse.
  const w = Math.max(1, boxW);
  const h = Math.max(1, boxH);
  const natH = naturalH >= 1 ? naturalH : NATURAL_H_FALLBACK;
  const scale = clamp(Math.min(w / NATURAL_W, h / natH), FIT_MIN, FIT_MAX);
  return { scale, width: w / scale, height: h / scale };
}

/**
 * Run `apply` against an element's own box, on mount, on every resize, and on
 * every render.
 *
 * ON EVERY RENDER IS LOAD-BEARING, not belt-and-braces. The box is not the only
 * input to the fit: the strip's natural height is too, and that changes with the
 * GAME rather than with the tile — football's four-row centre is 99px against
 * baseball's 86, and a final's one-liner is shorter than both. A resize-only
 * observer never fires on any of those, so a Home Medium tile that was sized for
 * baseball would clip the bottom row of the football centre that replaced it,
 * live, with nothing to say why. The version this replaces caught it by
 * observing the strip as well; that is not available here, because the strip is
 * given an explicit size and so has no natural box left to observe.
 *
 * One implementation, because the strip and the empty state both answer to the
 * box and a fix to how this object measures must not land in one of them and
 * miss the other.
 */
function useBoxEffect(
  apply: (el: HTMLDivElement, w: number, h: number) => void,
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  const applyRef = useLatestRef(apply);
  const runRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const run = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w >= 1 && h >= 1) applyRef.current(el, w, h);
    };
    runRef.current = run;
    run();
    const ro = new ResizeObserver(run);
    ro.observe(el);
    return () => {
      ro.disconnect();
      runRef.current = () => {};
    };
  }, [applyRef]);

  // Deliberately ungated: any render can have changed what the strip draws, and
  // re-measuring is a read plus two style writes on one element. Nothing here
  // sets React state, so this cannot re-enter.
  useLayoutEffect(() => {
    runRef.current();
  });

  return ref;
}

/**
 * The strip, filling whatever box the operator drew.
 *
 * A layout object that ignores its box is the widget equivalent of a control
 * that does not do anything: every other object here answers to the box, and an
 * operator who made this one twice as tall would otherwise reach for a font-size
 * field that does not exist.
 *
 * Sized IMPERATIVELY rather than through state. The measure/apply pass is one
 * frame with no re-render in it, so the observer cannot wake itself on its own
 * write — the loop the previous version needed an epsilon comparison to escape.
 *
 * NOT layout-renderer's useFitScale, deliberately. That hook back-derives the
 * natural size as `el.scrollWidth / currentScale`, which assumes the measured
 * content REFLOWS as the scale changes. The strip does not: its scroll size is
 * whatever box we gave it, so dividing by the scale reports it as ever smaller
 * and the scale climbs away every pass. The natural height is read the only way
 * that is not a back-derivation — by briefly laying the strip out unconstrained
 * and reading offsetHeight, a LAYOUT size a transform does not touch. That read
 * happens inside a layout effect, before paint, so nothing flickers.
 */
function ScoresFitted({ game, detail }: { game: ScoreGameDTO; detail: boolean }) {
  const boxRef = useBoxEffect((el, w, h) => {
    const scaled = el.firstElementChild as HTMLDivElement | null;
    if (!scaled) return;
    // The strip's own height at its designed width, with the fit taken off. A
    // four-row baseball centre is taller than a one-row final and football's is
    // taller again, so this is per-game, not a constant.
    scaled.style.width = `${NATURAL_W}px`;
    scaled.style.height = "auto";
    const fit = fitStrip(w, h, scaled.offsetHeight);
    scaled.style.width = `${fit.width}px`;
    scaled.style.height = `${fit.height}px`;
    scaled.style.transform = `scale(${fit.scale})`;
    el.style.setProperty("--score-fit-scale", String(fit.scale));
  });

  return (
    <div ref={boxRef} className="score-object">
      <div className="score-object-scale">
        <ScoreStrip game={game} detail={detail} className="score-object-strip" />
      </div>
    </div>
  );
}
