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

import { useLayoutEffect, useRef, useState } from "react";

import { clamp } from "@main/services/clamp";
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
  return <div className="score-object-empty">{children}</div>;
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
 * The strip, sized to whatever box the operator drew.
 *
 * A layout object that ignores its box is the widget equivalent of a control
 * that does not do anything: every other object here answers to the box, and an
 * operator who made this one twice as tall would otherwise reach for a font-size
 * field that does not exist.
 *
 * NOT layout-renderer's useFitScale, deliberately. That hook back-derives the
 * natural size as `el.scrollWidth / currentScale`, which assumes the measured
 * content REFLOWS as the scale changes. The strip does not: it is a fixed-size
 * block, its scrollWidth stays 520 whatever transform is on it (measured in the
 * browser: scrollWidth 520 at scale 1.227), so dividing by the scale reports it
 * as ever smaller and the scale climbs away every pass. Reading offsetWidth and
 * offsetHeight -- which are LAYOUT sizes a transform does not touch -- needs no
 * back-derivation and converges in one pass.
 *
 * The strip is also laid out at a definite width rather than stretched:
 * `.score-strip` declares `container-type: inline-size`, which takes its contents
 * out of its own inline sizing, so as a bare flex item it measured zero and spilled
 * 164px out of a box it had no width in.
 */
function ScoresFitted({ game, detail }: { game: ScoreGameDTO; detail: boolean }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const el = elRef.current;
    if (!wrap || !el) return;
    const measure = () => {
      const natW = el.offsetWidth;
      const natH = el.offsetHeight;
      if (natW < 1 || natH < 1 || wrap.clientWidth < 1 || wrap.clientHeight < 1) return;
      const next = clamp(
        Math.min(wrap.clientWidth / natW, wrap.clientHeight / natH),
        FIT_MIN,
        FIT_MAX,
      );
      // Only on a real change, or the observer's own write wakes it again.
      setScale((cur) => (Math.abs(next - cur) > 0.005 ? next : cur));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    // The strip too: a four-row baseball centre is taller than a one-row final,
    // so the natural height changes with the game, not only with the box.
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="score-object-fit">
      <div ref={elRef} style={{ transform: `scale(${scale})`, transformOrigin: "center" }}>
        <ScoreStrip game={game} detail={detail} className="score-object-strip" />
      </div>
    </div>
  );
}
