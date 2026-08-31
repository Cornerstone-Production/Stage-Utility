// score-activity.tsx — the score card that grows out of the context-bar capsule.
//
// THE COLOUR IS NOT ANIMATED. It is painted at full strength from the first
// frame and scales with the shell.
//
// Three earlier passes gave the coloured sides their own opacity and transform,
// and every one of them read as the box "clipping" on the way open: an outline
// that had already landed with colour still travelling inside it. It was never a
// race on opacity — it was a second, slower animation running inside a shell that
// had already arrived. There is now ONE moving object. The shell's own scale IS
// the expansion.
//
// The one exception is the centre, and it is deliberately neutral-coloured:
// staggering grey text reads as detail settling, not as the panel filling in.
//
// The rule is enforced structurally rather than by discipline: the cards carry NO
// transitions at all until `is-settled` lands, one shell-length after the panel
// opened. So a score that opens the panel AND moves the focus to a different game
// cannot animate the focus change inside the opening shell — there is nothing to
// animate it with until the shell has stopped.
//
// ONE CODE PATH for one game and for four. A single-game panel is a stack of one,
// focused. The mockup drew them as two components; they have identical markup, and
// a second one would be a second set of dimensions to keep in step.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { ScoreSide, ScoreStrip } from "../main/score-strip";
import { leagueById } from "@main/types/scores";
import { formatClock } from "../lib/clock-format";
import { cn } from "../lib/cn";
import { scoreActivity, useScoreActivity } from "./score-activity-store";
// ONE definition of "does this viewer want motion", in lib. There were two —
// this file had its own copy without the `typeof window` guards — and a third
// was about to be added for the drawer drag. The reason it is asked in JS at
// all is unchanged: the global CSS override collapses `transition-duration`
// and cannot reach a `transform` or a class set from JS.
import { prefersReducedMotion } from "../lib/use-slide-on-move";

/** The gap between two cards in the stack, in px. Mirrored in no stylesheet:
 *  the stack is positioned entirely from JS, so this is the only copy. */
const STACK_GAP = 8;

/** How long the shell takes to arrive. Matches `.score-host.is-open .score-shell`
 *  in styles.css — nothing inside the shell may transition before this elapses. */
const SHELL_MS = 620;

/**
 * Which side of THIS game a score landed on, or null.
 *
 * Resolved against the game's OWN two team ids, never by assuming home or away —
 * the same rule possessionSide follows, and for the same reason: a bare team id
 * that matches neither side must highlight neither. Sweeping a light across the
 * team that did NOT score is worse than sweeping nothing.
 */
export function scoredSide(
  game: ScoreGameDTO,
  events: readonly ScoreEvent[],
): "away" | "home" | null {
  for (const e of events) {
    if (e.eventId !== game.eventId) continue;
    if (e.teamId === game.away.id) return "away";
    if (e.teamId === game.home.id) return "home";
  }
  return null;
}

/**
 * Which live game the one-line capsule speaks for.
 *
 * The one that scored most recently, else the earliest to start — `games` is
 * already sorted by start time. Returns -1 when nothing is live.
 */
export function liveIndex(
  games: readonly ScoreGameDTO[],
  events: readonly ScoreEvent[],
): number {
  const scored = new Set(events.map((e) => e.eventId));
  let first = -1;
  for (let i = 0; i < games.length; i++) {
    if (games[i].state !== "in") continue;
    if (scored.has(games[i].eventId)) return i;
    if (first === -1) first = i;
  }
  return first;
}

/**
 * The remount key that restarts a one-shot score animation.
 *
 * The sweep (`.score-side-scored::after`) and the bump (`.score-value-bump`) are
 * CSS animations that run once on mount, so the ONLY way to play one twice is to
 * hand React a different key and let it build a new node. What that key is made
 * of decides which strips replay.
 *
 * It is made of the reading being animated — this game's id and this side's
 * score — so a strip remounts exactly when the number on it changed. It used to
 * be the global `scoreRev`, which is a counter for "some followed game scored":
 * one run in one game remounted the strip of every OTHER game in the stack, and
 * both sides of the capsule, none of which had moved.
 *
 * That was invisible, and only invisible by luck: a remounted strip that did not
 * score carries no `is-scored` class, so it had nothing to animate. The first
 * unconditional entrance animation added to a card would have replayed it on all
 * four cards every time any one of them scored.
 *
 * THE PROPERTY TO KEEP is the one the old key had: a SECOND score in the SAME
 * game must still restart that game's animation. Keying on the game id alone, or
 * on anything else that holds still between two runs, silently stops the second
 * one — which is why the guard in score-activity.test.tsx scores the same game
 * twice rather than once.
 */
export function scoreKey(game: ScoreGameDTO, side?: "away" | "home"): string {
  if (side === "away") return `${game.eventId}:a:${game.away.score}`;
  if (side === "home") return `${game.eventId}:h:${game.home.score}`;
  return `${game.eventId}:${game.away.score}:${game.home.score}`;
}

export type ScoreCapsuleView = { kind: "none" } | { kind: "game"; game: ScoreGameDTO };

/**
 * What the bar shows: a live game, or NOTHING AT ALL.
 *
 * This item used to have four states, three of them words — "No teams", "No
 * games", "Scores offline", or ESPN's own "7:05 PM ET" / "Final". They are gone
 * on purpose, and the no-reflow rule the rest of the bar keeps is amended for
 * this one item rather than routed around; the reasoning lives on
 * BarItem.canBeEmpty in bar-items.tsx, which is what the guard reads.
 *
 * The short version: for most of the year nothing a church follows is playing,
 * so a permanent "No games" is a word that never changes on a strip where every
 * other entry means something. The honest rendering of "nothing is on" is
 * nothing.
 *
 * A game today that has not started, and a game that finished this afternoon,
 * both count as nothing: "active" is a game IN PLAY. The other surfaces — the
 * Home card and the layout object — still say why they are empty, and rightly.
 * A wall widget that draws nothing is indistinguishable from a broken one, and
 * the operator who placed it is not in the room; a bar item is one reading among
 * eight on a strip that is always on screen.
 *
 * Pure and exported so the item's whole decision can be tested without a DOM.
 */
export function capsuleView(scores: ScoresStatusDTO | null): ScoreCapsuleView {
  const games = scores?.games ?? [];
  const live = liveIndex(games, scores?.lastEvents ?? []);
  return live >= 0 ? { kind: "game", game: games[live] } : { kind: "none" };
}

/**
 * Place every card, and return the height the stack needs.
 *
 * MEASURED, never assumed. And measured on the card's BODY CONTENT, never on the
 * grid item being animated: the body-in is the item of a row going 0fr -> 1fr, so
 * reading it at the instant focus changes returns the height it is LEAVING, not
 * the one it is going to. That placed every later card as though the focused one
 * had no body, and let the open panel paint over the card beneath it — which is a
 * card the operator then cannot click.
 *
 * The strips are normalised first: a four-row baseball centre and a two-row
 * hockey centre would otherwise sit at visibly different heights in one stack.
 * Read every height, then write every height — reading back inside the loop that
 * is also writing would thrash layout once per card.
 *
 * Cards are FULL SIZE. Never scaled down: a shrunken variant would be a second
 * set of dimensions to keep in step, and the scores are the thing you are reading.
 */
export function layoutStack(
  cards: readonly HTMLElement[],
  focus: number,
  gap: number,
  instant: boolean,
): number {
  const strips = cards.map((c) => c.querySelector<HTMLElement>("[data-score-strip]"));
  for (const s of strips) if (s) s.style.height = "";

  // Every read, before any write.
  const tallest = strips.reduce((m, s) => Math.max(m, s?.offsetHeight ?? 0), 0);
  const body =
    cards[focus]?.querySelector<HTMLElement>("[data-score-body]")?.offsetHeight ?? 0;

  for (const s of strips) if (s) s.style.height = `${tallest}px`;

  let y = 0;
  const tops = cards.map((_, i) => {
    const at = y;
    y += tallest + (i === focus ? body : 0) + gap;
    return at;
  });

  cards.forEach((c, i) => {
    // Moved by TRANSFORM only, so focusing one animates on the compositor rather
    // than reflowing the page under it. Only the container's height animates in
    // layout, from the same numbers, so the two cannot disagree.
    c.style.transform = `translateY(${tops[i]}px)`;
    c.style.zIndex = String(i === focus ? 5 : 1);
    // Reduced motion places the cards at their FINAL offsets with nothing to
    // travel through. The global CSS override cannot reach an inline transform.
    c.style.transition = instant ? "none" : "";
  });

  return Math.max(0, y - gap);
}

function ScoreCardBody({ game, error }: { game: ScoreGameDTO; error: string | null }) {
  const league = leagueById(game.league);
  const start = Date.parse(game.startsAt);
  return (
    // Measured for the stack. It sits INSIDE the clip and always reports its own
    // natural height, which is the whole reason the measurement is taken here.
    <div className="score-more" data-score-body="">
      <div className="score-meta">
        {game.venue && <span>{game.venue}</span>}
        {league && <span>{league.label}</span>}
        {Number.isFinite(start) && <span>{formatClock(start)}</span>}
      </div>
      {/* A failed poll reaches the operator rather than freezing the panel on
          numbers that stopped being true an hour ago. */}
      {error && <p className="score-stale">Last update failed — {error}</p>}
    </div>
  );
}

function ScoreCard({
  game,
  index,
  focused,
  scored,
  error,
}: {
  game: ScoreGameDTO;
  index: number;
  focused: boolean;
  /** Which side a score just landed on, or null. Reduced motion is already applied. */
  scored: "away" | "home" | null;
  error: string | null;
}) {
  return (
    <div
      data-score-card=""
      className={cn("score-card", focused && "is-focused")}
      role="button"
      tabIndex={0}
      aria-expanded={focused}
      aria-label={`${game.away.displayName} ${game.away.score ?? "no score"}, ${game.home.displayName} ${game.home.score ?? "no score"}. ${game.shortDetail}`}
      onClick={() => scoreActivity.focus(index)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        scoreActivity.focus(index);
      }}
    >
      {/* Keyed on this game's own two scores — see scoreKey. */}
      <ScoreStrip key={scoreKey(game)} game={game} scored={scored} />
      {/* Clipped by HEIGHT rather than faded, so a peek strip is a real strip and
          not a ghost of a taller card. */}
      <div className="score-card-body">
        <div className="score-card-body-in">
          <ScoreCardBody game={game} error={error} />
        </div>
      </div>
    </div>
  );
}

/**
 * The capsule in the bar.
 *
 * A real <button>, because it is one: the operator taps it to look and taps it to
 * dismiss, and the auto-open on a score is the same state arriving by a different
 * route.
 *
 * LOGOS ONLY, no city names. The abbreviation is redundant next to a mark the
 * operator already recognises, and dropping it buys back real width in a bar that
 * also carries the plan, the timer and whatever else they put there.
 */
export function ScoreCapsule({
  game,
  scored,
  preview = false,
}: {
  game: ScoreGameDTO;
  /** Which side a score just landed on, or null. Reduced motion already applied. */
  scored: "away" | "home" | null;
  /** Rendered as a chip in the bar configurator: shows the reading, does nothing.
   *  A live button in there would toggle the panel behind the dialog on the very
   *  press that was reaching for the drag handle. */
  preview?: boolean;
}) {
  const { open } = useScoreActivity();
  // Each side is keyed on ITS OWN score, so the side that did not move is not
  // rebuilt — see scoreKey. The game id is in the key too because this one
  // capsule speaks for whichever game is live, and it CHANGES game when another
  // one scores: without the id, switching to a game whose away score happened to
  // match the old one would reuse the node and play nothing.
  //
  // The BUTTON is deliberately never remounted: it can hold focus, and a
  // keyboard operator must not lose it because somebody scored.
  const inner = (
    <>
      <ScoreSide key={scoreKey(game, "away")} team={game.away} side="away" size="capsule" scored={scored === "away"} />
      {/* "Bot 7th" is the first thing the capsule gives up when the bar runs out
          of room — it is the widest part of the capsule that is not a score, and
          the panel behind it says the same thing at length. The scores either
          side of it never go and never shorten: a shortened score is a different
          number. See bar-fit.ts. */}
      <span className="score-capsule-mid bar-drop-1">{game.shortDetail}</span>
      <ScoreSide key={scoreKey(game, "home")} team={game.home} side="home" size="capsule" scored={scored === "home"} />
    </>
  );

  if (preview) return <span className="score-capsule">{inner}</span>;

  return (
    <button
      type="button"
      data-score-capsule=""
      className="score-capsule"
      aria-expanded={open}
      aria-label={`${game.away.displayName} ${game.away.score ?? "no score"}, ${game.home.displayName} ${game.home.score ?? "no score"}. ${open ? "Hide" : "Show"} details.`}
      onClick={() => scoreActivity.toggle()}
    >
      {inner}
    </button>
  );
}

/**
 * The panel, hosted under the bar.
 *
 * It expands in place rather than flying to full screen, so it needs nothing from
 * the multiview expand overlay — and the page underneath is untouched.
 */
export function ScoreActivityHost({ scores }: { scores: ScoresStatusDTO | null }) {
  const { open, focus } = useScoreActivity();
  const games = scores?.games ?? [];
  const isOpen = open && games.length > 0;
  const clamped = focus >= 0 && focus < games.length ? focus : 0;
  // Read at render, so the panel honours a setting changed mid-session on the
  // very next frame rather than on the next reload.
  const motion = !prefersReducedMotion();

  const stackRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const seeded = useRef(false);

  // A score arrived. On the FIRST delivery we only seed: the hello burst
  // re-delivers the DTO to every late subscriber, so a page opened five minutes
  // after a touchdown would otherwise pop the panel as if it had just happened.
  //
  // Called on every delivery rather than only when `rev` moves, because
  // scoreActivity.scored is already idempotent per rev — that guard is the one
  // that has a test, and having a second copy of it here as an effect dependency
  // would be two places for the same rule to drift.
  useEffect(() => {
    if (!scores) return;
    if (!seeded.current) {
      seeded.current = true;
      scoreActivity.seed(scores.scoreRev);
      return;
    }
    if (scores.scoreRev === 0) return;
    const at = scores.games.findIndex((g) =>
      scores.lastEvents.some((e) => e.eventId === g.eventId),
    );
    scoreActivity.scored(scores.scoreRev, at < 0 ? 0 : at);
  }, [scores]);

  const relayout = useCallback(() => {
    const el = stackRef.current;
    if (!el) return;
    const cards = [...el.querySelectorAll<HTMLElement>("[data-score-card]")];
    if (cards.length === 0) return;
    const instant = prefersReducedMotion();
    el.style.transition = instant ? "none" : "";
    el.style.height = `${layoutStack(cards, clamped, STACK_GAP, instant)}px`;
  }, [clamped]);

  // After EVERY render, then again on the next frame. No dependency list on
  // purpose: any change to the games, the focus or the open state changes what
  // has to be measured, and a list is a place to forget one of them.
  useLayoutEffect(() => {
    relayout();
    const id = requestAnimationFrame(relayout);
    return () => cancelAnimationFrame(id);
  });

  // Width changes what a strip is tall enough to hold — below 460px the names
  // drop out and every card gets shorter. Observed on the CLIP, not on the stack
  // whose height this sets, which would observe its own writes.
  useEffect(() => {
    const el = clipRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => relayout());
    ro.observe(el);
    return () => ro.disconnect();
  }, [relayout]);

  // Nothing inside the shell may transition until the shell has landed — see the
  // header. Removed SYNCHRONOUSLY the instant it closes, so the exit is the
  // entrance reversed rather than a different animation.
  //
  // Toggled on the node rather than held in React state: it is a class React
  // never writes, and a setState here would be a cascading render on every open
  // and close for something the DOM is the owner of.
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    el.classList.remove("is-settled");
    if (!isOpen) return;
    const id = setTimeout(() => el.classList.add("is-settled"), SHELL_MS);
    return () => clearTimeout(id);
  }, [isOpen]);

  // A press anywhere else closes it. Bound on the DOCUMENT, not on a scrim: a
  // transparent full-bleed scrim is hit-tested above the page and would swallow
  // the first press on whatever is underneath — and on a console that press is
  // usually the thing the operator actually reached for.
  useEffect(() => {
    if (!isOpen) return;
    function onDown(e: PointerEvent) {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("[data-score-capsule]") || t.closest(".score-host")) return;
      scoreActivity.close();
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [isOpen]);

  // Escape, with focus returned to the capsule. Scoped to the real bar so the
  // configurator's inert preview chip can never be the thing that takes focus.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      scoreActivity.close();
      document.querySelector<HTMLElement>(".context-strip [data-score-capsule]")?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  return (
    // The ANCHOR is the only part of this in the page's flow, and it is zero
    // pixels tall. Everything below it hangs off that: the panel floats over the
    // page instead of pushing it down, which is what it does now and did not do
    // before — opening it on Screens slid the whole grid of cards down.
    //
    // A zero-height positioned parent, rather than `position: absolute` straight
    // on the host: the host's top has to be the bottom of the context strip, and
    // that is not a number anyone can write down — the strip WRAPS on a phone.
    // An empty flow element sitting exactly where the panel already sat carries
    // the offset for free, and carries it through every width.
    //
    // The animation is untouched. The host is still the grid whose single row
    // goes 0fr -> 1fr, the clip still hides the overflow, the shell still scales:
    // out of flow is a change of containing block, not of mechanism.
    <div className="score-anchor">
      <div className={cn("score-host", isOpen && "is-open")}>
        <div className="score-clip" ref={clipRef}>
          <div className="score-shell">
            <div className="score-stack" ref={stackRef}>
              {games.map((game, i) => (
                <ScoreCard
                  key={game.eventId}
                  game={game}
                  index={i}
                  focused={i === clamped}
                  scored={motion ? scoredSide(game, scores?.lastEvents ?? []) : null}
                  error={scores?.error ?? null}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
