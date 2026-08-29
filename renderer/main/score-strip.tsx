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
import { inkFor, inkSoft } from "./score-ink";
import { cn } from "../lib/cn";

/** A team's colour and the ink chosen for it, as CSS custom properties. */
function sideVars(team: ScoreTeamDTO): React.CSSProperties {
  const ink = inkFor(team.color);
  return {
    // No colour means no colour: the side stays the neutral card and the ink is
    // the light one, rather than inventing a brand colour ESPN did not send.
    "--score-team": team.color ?? "transparent",
    "--score-ink": ink,
    "--score-ink-soft": inkSoft(ink),
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

function Side({
  team,
  side,
  size,
}: {
  team: ScoreTeamDTO;
  side: "away" | "home";
  size: "compact" | "full";
}) {
  return (
    <div className={cn("score-side", `score-side-${side}`)} style={sideVars(team)}>
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
      <span className="score-value">
        {/* null is NO READING, and is not 0. An em dash says "we have not been
            told" rather than asserting a nil-nil game. */}
        {team.score ?? "—"}
      </span>
    </div>
  );
}

export function ScoreStrip({
  game,
  size = "full",
  className,
}: {
  game: ScoreGameDTO;
  size?: "compact" | "full";
  className?: string;
}) {
  return (
    <div
      // The stack measures this element to normalise every card to the tallest
      // strip in it — see layoutStack.
      data-score-strip=""
      className={cn("score-strip", size === "compact" && "score-strip-compact", className)}
      aria-label={`${game.away.displayName} ${game.away.score ?? "no score"}, ${game.home.displayName} ${game.home.score ?? "no score"}. ${game.shortDetail}`}
    >
      <Side team={game.away} side="away" size={size} />
      <ScoreCenter game={game} />
      <Side team={game.home} side="home" size={size} />
    </div>
  );
}
