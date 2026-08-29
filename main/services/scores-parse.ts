// scores-parse.ts — folding an ESPN scoreboard into our DTOs, and spotting a score.
//
// Pure, no I/O, no clock. Everything here is testable against a saved fixture,
// which is the point: the two bugs that matter in this feature both live in this
// file, and both are only visible against a real payload.
//
// ESPN's payload is an undocumented third-party shape that can change without
// notice, and its `situation` object differs by sport. So every read is
// defensive and every failure degrades to "score and status" rather than
// throwing — but a payload that yields NOTHING is reported by the caller, never
// swallowed.

import type {
  LeagueId,
  ScoreEvent,
  ScoreGameDTO,
  ScoreSituation,
  ScoreState,
  ScoreTeamDTO,
  SportKind,
} from "../types/scores.js";
import { leagueById } from "../types/scores.js";

/** A JSON object we have not proved anything about yet. */
type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}

/** ESPN sends whole numbers as strings on some endpoints and numbers on others. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** ESPN sends colours as bare six-digit hex with no leading #. */
function colour(v: unknown): string | null {
  const s = str(v);
  return s && /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
}

function parseTeam(competitor: Obj): ScoreTeamDTO | null {
  const team = obj(competitor.team);
  const id = str(competitor.id) ?? (team ? str(team.id) : null);
  if (!team || !id) return null;
  const records = arr(competitor.records).map(obj);
  const overall = records.find((r) => r && str(r.type) === "total") ?? records[0];
  return {
    id,
    abbreviation: str(team.abbreviation) ?? id,
    name: str(team.shortDisplayName) ?? str(team.name) ?? str(team.displayName) ?? id,
    displayName: str(team.displayName) ?? str(team.name) ?? id,
    color: colour(team.color),
    logo: str(team.logo),
    record: overall ? str(overall.summary) : null,
    // NOT `?? 0`. A missing score is no reading; see ScoreTeamDTO.score.
    score: num(competitor.score),
  };
}

/**
 * The sport-specific garnish, or null.
 *
 * Returns null rather than a half-filled object whenever the sport's own fields
 * are absent — a renderer that draws an empty bases diamond over a football game
 * is worse than one that draws the status detail alone.
 */
function parseSituation(kind: SportKind, situation: Obj | null): ScoreSituation | null {
  if (!situation) return null;
  switch (kind) {
    case "baseball": {
      const outs = num(situation.outs);
      // The count and the bases are what make a baseball centre worth drawing.
      // Without outs there is nothing sport-specific to say.
      if (outs === null) return null;
      return {
        kind: "baseball",
        onFirst: bool(situation.onFirst),
        onSecond: bool(situation.onSecond),
        onThird: bool(situation.onThird),
        balls: num(situation.balls) ?? 0,
        strikes: num(situation.strikes) ?? 0,
        outs,
      };
    }
    case "football": {
      const down = num(situation.down);
      return {
        kind: "football",
        // ESPN uses -1 for "no down", e.g. during a timeout.
        down: down !== null && down > 0 ? down : null,
        distance: num(situation.distance),
        redZone: bool(situation.isRedZone),
        // A bare team id, ABSENT (not null) in some states — an official
        // timeout, and between a kickoff and the receiving team's first snap.
        // Deliberately not possessionText, which is the ball's field position
        // ("SJSU 28"), and not lastPlay.start.team.id, which on that same
        // kickoff names the team that just kicked it away.
        //
        // Read INDEPENDENTLY of downDistance below. Bailing out of this whole
        // arm when possession is missing would drop the down and distance for
        // the first play of every drive, where it is present and possession is not.
        possession: str(situation.possession),
        // The short form: "3rd & 10". The long form repeats the field position,
        // which the centre has no room for.
        downDistance: str(situation.shortDownDistanceText),
      };
    }
    case "basketball":
      return { kind: "basketball" };
    case "hockey":
      return { kind: "hockey" };
  }
}

function parseState(v: unknown): ScoreState {
  return v === "in" || v === "post" ? v : "pre";
}

/**
 * Followed games from one league's scoreboard.
 *
 * `followed` is a set of ESPN team ids. An empty set matches nothing — "follow
 * everything" is not a state this feature has, and defaulting an empty
 * favourites list to every game in a league would poll and render 15 games
 * nobody asked for.
 */
export function parseScoreboard(
  league: LeagueId,
  payload: unknown,
  followed: ReadonlySet<string>,
): ScoreGameDTO[] {
  const meta = leagueById(league);
  if (!meta) return [];
  const root = obj(payload);
  if (!root) return [];

  const out: ScoreGameDTO[] = [];
  for (const raw of arr(root.events)) {
    const ev = obj(raw);
    if (!ev) continue;
    const eventId = str(ev.id);
    const comp = obj(arr(ev.competitions)[0]);
    if (!eventId || !comp) continue;

    const competitors = arr(comp.competitors).map(obj);
    const away = competitors.find((c) => c && str(c.homeAway) === "away");
    const home = competitors.find((c) => c && str(c.homeAway) === "home");
    if (!away || !home) continue;

    const a = parseTeam(away);
    const h = parseTeam(home);
    if (!a || !h) continue;
    if (!followed.has(a.id) && !followed.has(h.id)) continue;

    const status = obj(ev.status) ?? obj(comp.status);
    const type = status ? obj(status.type) : null;
    const venue = obj(comp.venue);

    out.push({
      eventId,
      league,
      sport: meta.kind,
      state: parseState(type?.state),
      // A rain delay reports state "in". Keying only on state shows a delayed
      // game as live, so this is called out rather than inferred by every caller.
      delayed: str(type?.name) === "STATUS_DELAYED",
      detail: (type ? str(type.detail) : null) ?? "",
      shortDetail: (type ? str(type.shortDetail) : null) ?? (type ? str(type.detail) : null) ?? "",
      clock: (status ? str(status.displayClock) : null) ?? "",
      startsAt: str(ev.date) ?? "",
      venue: venue ? str(venue.fullName) : null,
      away: a,
      home: h,
      situation: parseSituation(meta.kind, obj(comp.situation)),
    });
  }
  return sortGames(out);
}

/**
 * Stable order.
 *
 * ESPN does not promise events[] comes back the same way twice, and a stack of
 * cards that reshuffles under the operator between polls is unreadable. Start
 * time first because that is the order a person expects; eventId as the
 * tiebreak because a doubleheader's two games can share a listed start.
 */
export function sortGames(games: readonly ScoreGameDTO[]): ScoreGameDTO[] {
  return [...games].sort(
    (x, y) => x.startsAt.localeCompare(y.startsAt) || x.eventId.localeCompare(y.eventId),
  );
}

/**
 * The diff key: ONE GAME'S ONE TEAM.
 *
 * Both halves are load-bearing.
 *
 *  - `teamId`, not `homeAway`, because home/away is a ROLE. Keying on it means a
 *    swap between two polls reads as both teams scoring.
 *  - `eventId`, not the team alone, because two teams can play each other twice
 *    in a day. A real BOS @ NYY doubleheader is in the test fixture, and a
 *    team-keyed diff reports phantom scores in both directions on every poll of
 *    it, forever.
 */
function keyOf(eventId: string, teamId: string): string {
  return `${eventId}:${teamId}`;
}

/** The score each followed side was last seen at. `null` means "no reading". */
export type ScoreBaseline = Map<string, number | null>;

export function baselineOf(games: readonly ScoreGameDTO[]): ScoreBaseline {
  const m: ScoreBaseline = new Map();
  for (const g of games) {
    m.set(keyOf(g.eventId, g.away.id), g.away.score);
    m.set(keyOf(g.eventId, g.home.id), g.home.score);
  }
  return m;
}

/**
 * What scored between two polls.
 *
 * Three cases deliberately produce NOTHING:
 *
 *  - A side that was not in the baseline at all. The first successful poll seeds
 *    and emits nothing; otherwise every followed team "scores" the moment the
 *    server starts.
 *  - A move out of `null`. The per-team endpoint returns null scores for games
 *    that are demonstrably in progress, so null-to-0 is a reading arriving, not
 *    a run scoring.
 *  - A move INTO `null`, which is a reading going away.
 *
 * A score going DOWN is reported. A review reversing a touchdown is news, and a
 * silent correction would leave the card and the baseline disagreeing.
 */
export function diffScores(
  baseline: ScoreBaseline,
  games: readonly ScoreGameDTO[],
): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  for (const g of games) {
    for (const side of [g.away, g.home]) {
      const key = keyOf(g.eventId, side.id);
      if (!baseline.has(key)) continue;
      const from = baseline.get(key) ?? null;
      const to = side.score;
      if (from === null || to === null || from === to) continue;
      events.push({ eventId: g.eventId, teamId: side.id, from, to });
    }
  }
  return events;
}
