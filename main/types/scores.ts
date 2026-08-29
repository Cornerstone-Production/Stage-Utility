// scores.ts — the shapes the scores integration speaks.
//
// Every field here was observed in a real ESPN response on 2026-08-29; see
// docs/superpowers/research/2026-08-29-espn-scores.md. Fields the research could
// not observe live are NOT in this file — a DTO field nothing ever fills is a
// renderer branch that is never exercised.

/** The leagues the picker offers. Adding one is a row here plus a fixture. */
export const LEAGUES = [
  { id: "mlb", path: "baseball/mlb", label: "MLB", kind: "baseball" },
  { id: "nfl", path: "football/nfl", label: "NFL", kind: "football" },
  { id: "nba", path: "basketball/nba", label: "NBA", kind: "basketball" },
  { id: "nhl", path: "hockey/nhl", label: "NHL", kind: "hockey" },
] as const;

export type LeagueId = (typeof LEAGUES)[number]["id"];
export type SportKind = (typeof LEAGUES)[number]["kind"];

export function leagueById(id: string): (typeof LEAGUES)[number] | null {
  return LEAGUES.find((l) => l.id === id) ?? null;
}

/**
 * A followed team.
 *
 * Keyed on ESPN's numeric `id`, NOT the abbreviation or the display name.
 * Abbreviations are unique only within a league and both names move on a
 * relocation or rebrand — exactly the season rollover this has to survive. The
 * display fields are a CACHE for rendering the settings row before the first
 * successful fetch; they are re-resolved from /teams, and the id is the thing
 * that is authoritative.
 */
export interface ScoreFavourite {
  league: LeagueId;
  teamId: string;
  /** Cached for the settings row. Refreshed on every successful /teams read. */
  displayName: string;
  abbreviation: string;
  /** Cached at selection time so no display ever fetches a.espncdn.com itself. */
  logo: string | null;
  /** "#0e3386", already prefixed. null when ESPN sent nothing usable. */
  color: string | null;
}

export interface ScoresConfig {
  favourites: ScoreFavourite[];
}

/** ESPN's three-way game state. `status.type.state`. */
export type ScoreState = "pre" | "in" | "post";

export interface ScoreTeamDTO {
  id: string;
  abbreviation: string;
  /** "Cubs" — shortDisplayName. What a card shows. */
  name: string;
  /** "Chicago Cubs" — for the settings row and the accessible label. */
  displayName: string;
  /** "#0e3386", already prefixed. null means "no colour" — render neutral. */
  color: string | null;
  logo: string | null;
  /** "78-56", or null. */
  record: string | null;
  /**
   * null means NO READING, and is not the same as 0.
   *
   * The per-team endpoint returns null scores for a game that is demonstrably in
   * progress, and a null-to-0 transition read as a score would fire a phantom
   * event on every followed team the first time one of those was ever parsed.
   */
  score: number | null;
}

/**
 * Sport-shaped garnish over the common core.
 *
 * ESPN's `situation` object is NOT uniform — baseball has bases and a count,
 * football has down and distance, and the two share only `lastPlay`. So this is
 * a discriminated union rather than a wide optional-everything record, and every
 * renderer switches on `kind` with a default that draws the status detail alone.
 */
export type ScoreSituation =
  | {
      kind: "baseball";
      onFirst: boolean;
      onSecond: boolean;
      onThird: boolean;
      balls: number;
      strikes: number;
      outs: number;
    }
  | {
      kind: "football";
      down: number | null;
      distance: number | null;
      redZone: boolean;
      /**
       * The team id with the ball, or null.
       *
       * ESPN OMITS this key entirely — absent, not null — in some states. Two
       * were observed: an official timeout, and the gap between a kickoff and
       * the receiving team's first snap. It was PRESENT at the end of a quarter,
       * so "absent at dead ball" is too broad a rule to write code against. Null
       * is simply a normal, recurring state.
       *
       * Render nothing when it is null. An arrow pointing at the wrong team is
       * worse than no arrow.
       *
       * NOT possessionText, which despite the name is the ball's FIELD POSITION
       * ("SJSU 28"). NOT lastPlay.start.team.id: between a kickoff and the first
       * snap that reads as the team who just KICKED, which is precisely the team
       * that does not have the ball.
       */
      possession: string | null;
      /**
       * "3rd & 10" — ESPN's own short form.
       *
       * Independent of `possession`: the first play of a drive was observed with
       * a down and distance but no possession. Read them separately, never as a
       * pair, or every drive's opening play loses its down and distance.
       */
      downDistance: string | null;
    }
  | { kind: "basketball" }
  | { kind: "hockey" };

export interface ScoreGameDTO {
  /** ESPN event id. Half of the diff key — see diffScores. */
  eventId: string;
  league: LeagueId;
  sport: SportKind;
  state: ScoreState;
  /**
   * A rain delay reports state "in". Anything keying only on `state` shows a
   * delayed game as live, so the delay is called out separately.
   */
  delayed: boolean;
  /** ESPN's own pre-formatted, already-sport-appropriate string: "Top 3rd". */
  detail: string;
  shortDetail: string;
  /** ESPN's clock string, e.g. "3:22". Empty for sports without one. */
  clock: string;
  /** ISO-8601. Render through app-timezone, never the host clock. */
  startsAt: string;
  venue: string | null;
  away: ScoreTeamDTO;
  home: ScoreTeamDTO;
  situation: ScoreSituation | null;
}

/** One team's score moving between two polls. */
export interface ScoreEvent {
  eventId: string;
  teamId: string;
  from: number;
  to: number;
}

export interface ScoresStatusDTO {
  connected: boolean;
  /** Followed games for today, sorted by start time then eventId — see sortGames. */
  games: ScoreGameDTO[];
  /**
   * Bumped only when a score actually moved.
   *
   * A client uses it to tell "news arrived" from "React re-rendered", which is
   * what drives the auto-open. Same idiom as the presence work: a monotonic
   * counter, because comparing DTOs in the client is a second place for the
   * change rule to live and drift.
   */
  rev: number;
  /** The scoring changes carried by the poll that last bumped `rev`. */
  lastEvents: ScoreEvent[];
  /** ISO-8601 of the last successful poll, or null. */
  fetchedAt: string | null;
  /**
   * Non-null when the last poll failed.
   *
   * Carried in the DTO as well as reported to the Integrations panel, so a
   * display shows a stale-data notice rather than silently freezing on numbers
   * that stopped being true an hour ago.
   */
  error: string | null;
}

export const SCORES_OFFLINE: ScoresStatusDTO = {
  connected: false,
  games: [],
  rev: 0,
  lastEvents: [],
  fetchedAt: null,
  error: null,
};
