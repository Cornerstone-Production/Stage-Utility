// score-strip.tsx — away side, centre, home side. The one strip every surface
// renders.
//
// A capsule, a Live Activity card and a wall widget are DIFFERENT SIZES OF THE
// SAME THING, never two implementations. That is the whole reason this file
// exists: the stack in the activity reuses it at exactly the size the
// single-game panel uses, because a shrunken variant would be a second set of
// dimensions to keep in step and the scores are the thing you are reading.
//
// The team colour fills each side and feathers toward the centre through a mask
// on a background layer — see .score-side in styles.css for why it is a mask and
// why it is not on the element.

import { ScoreCenter } from "./score-center";
import { discInk, inkFor } from "./score-ink";
import { cn } from "../lib/cn";

/** A team's colour and the ink chosen for it, as CSS custom properties. */
function sideVars(team: ScoreTeamDTO): React.CSSProperties {
  return {
    // No colour means no colour: the side stays the neutral card and the ink is
    // the light one, rather than inventing a brand colour ESPN did not send.
    "--score-team": team.color ?? "transparent",
    "--score-ink": inkFor(team.color),
    // Only for a team with NO logo: the abbreviation standing in for the mark on
    // the disc. The disc itself is the same for every team — see DISC.
    "--score-disc-ink": discInk(team.color),
  } as React.CSSProperties;
}

/**
 * The team's mark.
 *
 * An <img> with the ABBREVIATION as its alt, so a blocked CDN degrades to
 * readable text rather than a hole. Church networks that will not reach
 * a.espncdn.com are the reason the logo URL is cached at selection time rather
 * than fetched per poll, and the reason this has to survive not loading at all.
 */
function TeamLogo({ team }: { team: ScoreTeamDTO }) {
  return (
    <span className="score-logo">
      {team.logo ? <img src={team.logo} alt={team.abbreviation} /> : team.abbreviation}
    </span>
  );
}

/**
 * One team's half of a strip: its colour, its mark, its score.
 *
 * Exported because the context-bar capsule is a <button>, not a strip, and so
 * cannot be a ScoreStrip — but the part that must not be written twice is this
 * one. The colour, the feather mask and the WCAG ink live here and nowhere else,
 * so the capsule and the wall widget cannot drift into disagreeing about what
 * colour a team is.
 *
 * `scored` marks the side a score just landed on. It drives a one-pass sweep in
 * CSS and is set only when the caller has already checked reduced motion.
 */
export function ScoreSide({
  team,
  side,
  size,
  scored = false,
}: {
  team: ScoreTeamDTO;
  side: "away" | "home";
  size: ScoreStripSize;
  scored?: boolean;
}) {
  return (
    <div
      className={cn("score-side", `score-side-${side}`, scored && "score-side-scored")}
      style={sideVars(team)}
    >
      <TeamLogo team={team} />
      {size === "full" && (
        <span className="score-names">
          {/* The full team name, not the abbreviation. There is room for "Cubs"
              here, and a mark plus a name reads faster than a mark plus a code.
              The abbreviation survives in the logo chip and in the context-bar
              capsule, where width is genuinely scarce. */}
          <span className="score-name">{team.name}</span>
          {team.record && <span className="score-record">{team.record}</span>}
        </span>
      )}
      <span className={cn("score-value", scored && "score-value-bump")}>
        {/* null is NO READING, and is not 0. An em dash says "we have not been
            told" rather than asserting a nil-nil game. */}
        {team.score ?? "—"}
      </span>
    </div>
  );
}

/**
 * How much of a side there is room for.
 *
 * "full" is a card: mark, name, record, score. "capsule" is the context bar,
 * where width is genuinely scarce and a side is a mark and a score.
 *
 * There was a third, "compact", described as the wall tile and the stack peek.
 * It was wrong about both — the wall tile (scores-object.tsx) and the activity
 * stack (score-activity.tsx) both take the "full" default, and the only sites
 * that name a size at all are the two capsule ones — so no call site ever passed
 * it and six `.score-strip-compact` rules were unreachable. The width-based
 * name-hiding it described is owned by `.score-strip`'s own
 * `@container (max-width: 460px)` rule, which answers about the STRIP's box
 * rather than about a prop a caller has to remember to set: one decision, one
 * mechanism.
 */
export type ScoreStripSize = "capsule" | "full";

/**
 * How a game reads out: both teams, both scores, and where it is up to.
 *
 * The string is written out THREE times — here, on the activity stack's card,
 * and on the context-bar capsule with a different trailing sentence — so "no
 * score" becoming "not reported" is a three-place edit that can land in two.
 *
 * ONLY THIS COPY IS CONVERTED so far. The other two live in
 * renderer/app/score-activity.tsx:246 and :321 and are still literals; both
 * should become gameLabel(game) and gameLabel(game, `${open ? "Hide" : "Show"}
 * details.`), which is what `suffix` was added for and why it currently has no
 * caller.
 *
 * @param suffix what the surface adds about ITSELF (a control says what pressing
 *   it does). Omitted for a plain readout.
 */
export function gameLabel(game: ScoreGameDTO, suffix?: string): string {
  const away = `${game.away.displayName} ${game.away.score ?? "no score"}`;
  const home = `${game.home.displayName} ${game.home.score ?? "no score"}`;
  return `${away}, ${home}. ${suffix ?? game.shortDetail}`;
}

export function ScoreStrip({
  game,
  size = "full",
  scored = null,
  detail = true,
  labelled = true,
  className,
}: {
  game: ScoreGameDTO;
  size?: ScoreStripSize;
  /** Which side a score just landed on, or null. Already reduced-motion checked. */
  scored?: "away" | "home" | null;
  /** Draw the sport-specific centre, or just the status line. See ScoreCenter. */
  detail?: boolean;
  /**
   * False when the caller has ALREADY labelled a wrapper around this strip.
   *
   * A screen reader in browse mode announces a labelled element and then the
   * labelled element inside it, so a card that names the game and then draws a
   * strip that names the game reads the whole fixture twice. Default true,
   * because the wall widget has no wrapper to carry it.
   *
   * NOT YET PASSED by the caller that needs it: ScoreCard in
   * renderer/app/score-activity.tsx labels its own role="button" wrapper at :246
   * and renders this strip at :255 without it, so the double announcement is
   * still there. The prop is the half of the fix that lives in this file.
   */
  labelled?: boolean;
  className?: string;
}) {
  return (
    <div
      // The stack measures this element to normalise every card to the tallest
      // strip in it — see layoutStack.
      data-score-strip=""
      className={cn("score-strip", className)}
      aria-label={labelled ? gameLabel(game) : undefined}
    >
      <ScoreSide team={game.away} side="away" size={size} scored={scored === "away"} />
      <ScoreCenter game={game} detail={detail} />
      <ScoreSide team={game.home} side="home" size={size} scored={scored === "home"} />
    </div>
  );
}
