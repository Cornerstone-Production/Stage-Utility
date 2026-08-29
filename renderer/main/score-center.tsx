// score-center.tsx — what is happening right now, in this sport's own terms.
//
// A bases diamond in a basketball game is nonsense and a down-and-distance line
// means nothing in the ninth inning, so this is a switch over the situation's
// discriminant rather than one shape wearing different labels.
//
// The DEFAULT arm is not a fallback nobody hits — it is the normal case for any
// sport whose situation ESPN did not send, and for every sport this app has not
// specialised. It draws the status detail, which ESPN has already formatted per
// sport, so an unspecialised sport still reads correctly.

import { cn } from "../lib/cn";

/**
 * ESPN's shortDetail for a clock sport is one string: "4:47 - 3rd". The centre
 * draws the clock and the period at different sizes, so they are split here.
 *
 * Deliberately not a parse of ESPN's formatting beyond the one shape actually
 * observed: if `shortDetail` does not begin with the clock, the WHOLE string
 * becomes the period label and nothing is thrown away. The failure mode of
 * guessing harder is a period label with a chunk missing, which is worse than
 * one that is merely long.
 *
 * Baseball never reaches this — its centre draws no clock, because
 * `displayClock` is "0:00" all game and showing it would be a lie.
 */
export function splitDetail(
  shortDetail: string,
  clock: string,
): { period: string; clock: string | null } {
  if (clock !== "" && shortDetail.startsWith(clock)) {
    // "4:47 - 3rd" -> period "3rd". The separator is whatever sits between them.
    const rest = shortDetail.slice(clock.length).replace(/^[\s-]+/, "").trim();
    return { period: rest === "" ? shortDetail : rest, clock };
  }
  return { period: shortDetail, clock: clock === "" ? null : clock };
}

function Period({ children }: { children: React.ReactNode }) {
  return <span className="score-period">{children}</span>;
}

/**
 * The bases diamond.
 *
 * A 2x2 grid rotated 45deg: top-left becomes the TOP and bottom-left becomes
 * the LEFT, so the cells read second, first, third, home. Third base ends up on
 * the left and first on the right, which is how a diamond is drawn. A
 * three-cell row rotated 45deg would put third base on a diagonal.
 */
function Bases({ first, second, third }: { first: boolean; second: boolean; third: boolean }) {
  return (
    <div
      className="score-bases"
      role="img"
      aria-label={
        [second && "runner on second", first && "runner on first", third && "runner on third"]
          .filter(Boolean)
          .join(", ") || "bases empty"
      }
    >
      <span className={cn("score-base", second && "score-base-on")} />
      <span className={cn("score-base", first && "score-base-on")} />
      <span className={cn("score-base", third && "score-base-on")} />
      <span className="score-base score-base-home" />
    </div>
  );
}

function Outs({ outs }: { outs: number }) {
  return (
    <div className="score-outs" role="img" aria-label={`${outs} out`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={cn("score-out", i < outs && "score-out-on")} />
      ))}
    </div>
  );
}

/**
 * Which team has the ball.
 *
 * A pip in the NEUTRAL CENTRE, pointing toward the side that has it — not a dot
 * beside the score, where it would be lost against a brand colour.
 *
 * `side` is resolved by comparing the possession team id against this game's two
 * teams, never by assuming home or away. When possession is unknown this renders
 * NOTHING: ESPN omits the field entirely in some states, and an arrow pointing
 * at the wrong team is worse than no arrow.
 */
function Possession({ side }: { side: "away" | "home" }) {
  return (
    <span
      className={cn("score-possession", `score-possession-${side}`)}
      aria-label={`${side} team has the ball`}
    >
      {side === "away" ? (
        <>
          <span className="score-pip" />
          BALL
        </>
      ) : (
        <>
          BALL
          <span className="score-pip" />
        </>
      )}
    </span>
  );
}

/**
 * Which side of THIS game holds the ball, or null.
 *
 * Exported because the mapping is the part worth testing: possession is a bare
 * team id and the only correct way to place it is against the two ids in the
 * game it came from.
 */
export function possessionSide(game: ScoreGameDTO): "away" | "home" | null {
  if (game.situation?.kind !== "football") return null;
  const { possession } = game.situation;
  if (possession === null) return null;
  if (possession === game.away.id) return "away";
  if (possession === game.home.id) return "home";
  // A team id belonging to neither side of this game. Render nothing rather
  // than pick one: this is exactly the case a possessionText mix-up produces.
  return null;
}

export function ScoreCenter({ game }: { game: ScoreGameDTO }) {
  const situation = game.situation;

  // Before it starts, the only true thing to say is when. Once it is over, that
  // it is over. Neither wants a bases diamond.
  if (game.state !== "in") {
    return (
      <div className="score-center">
        <Period>{game.shortDetail || (game.state === "post" ? "Final" : "Scheduled")}</Period>
      </div>
    );
  }

  // A rain delay reports state "in". Saying "Top 3rd" through a delay is a
  // display that is confidently wrong, so the delay wins over the sport centre.
  if (game.delayed) {
    return (
      <div className="score-center">
        <Period>{game.shortDetail || "Delayed"}</Period>
        <span className="score-note">DELAYED</span>
      </div>
    );
  }

  switch (situation?.kind) {
    case "baseball":
      return (
        <div className="score-center">
          <Period>{game.shortDetail}</Period>
          <Bases first={situation.onFirst} second={situation.onSecond} third={situation.onThird} />
          <Outs outs={situation.outs} />
          <Period>
            {situation.balls}-{situation.strikes}
          </Period>
        </div>
      );

    case "football": {
      const { period, clock } = splitDetail(game.shortDetail, game.clock);
      const side = possessionSide(game);
      return (
        <div className="score-center">
          <Period>{period}</Period>
          {clock && <span className="score-clock">{clock}</span>}
          {situation.downDistance && (
            <span className="score-downdistance">{situation.downDistance}</span>
          )}
          {side && <Possession side={side} />}
          {situation.redZone && <span className="score-note">RED ZONE</span>}
        </div>
      );
    }

    case "basketball":
    case "hockey": {
      const { period, clock } = splitDetail(game.shortDetail, game.clock);
      return (
        <div className="score-center">
          <Period>{period}</Period>
          {clock && <span className="score-clock">{clock}</span>}
        </div>
      );
    }

    default: {
      // No situation at all. ESPN's own pre-formatted string is already
      // sport-appropriate, so this still reads correctly for a sport nothing
      // here has specialised.
      const { period, clock } = splitDetail(game.shortDetail, game.clock);
      return (
        <div className="score-center">
          <Period>{period}</Period>
          {clock && <span className="score-clock">{clock}</span>}
        </div>
      );
    }
  }
}
