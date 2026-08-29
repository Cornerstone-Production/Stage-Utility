// scores-service.ts — follows chosen teams' live scores from ESPN.
//
// The HTTP-polling shape, modelled on reaper-service.ts: ONE timer carries both
// the steady cadence and the back-off, through scheduleIn(). Two timers would
// double the poll rate after a reconnect.
//
// What is different from the LAN integrations: there is no box to connect to and
// no session to hold. "connected" means the last poll reached ESPN and parsed.
// A failure is reported to the Integrations panel AND carried in the DTO, so a
// display shows a stale-data notice instead of silently freezing on numbers that
// stopped being true an hour ago.

import { appTimeZone } from "./app-timezone.js";
import { errorMessage } from "./errors.js";
import { fetchScoreboard, fetchTeams } from "./espn-client.js";
import { StatusIntegration } from "./integration-base.js";
import {
  baselineOf,
  diffScores,
  parseScoreboard,
  scoresChanged,
  sortGames,
  type ScoreBaseline,
} from "./scores-parse.js";
import { nextPoll } from "./scores-schedule.js";
import { scoresStore } from "./scores-store.js";
import {
  LEAGUES,
  SCORES_OFFLINE,
  leagueById,
  type LeagueId,
  type ScoreFavourite,
  type ScoreGameDTO,
  type ScoresStatusDTO,
} from "../types/scores.js";

/** How long a league's team list stays good. Teams change about once a decade. */
const TEAM_CACHE_MS = 86_400_000;

/**
 * ESPN wants YYYYMMDD in the league's own reckoning.
 *
 * Servers run UTC, so this goes through the app time zone — a UTC box rolls its
 * date at 19:00 in Chicago, which would ask for tomorrow's scoreboard all
 * evening and show an operator an empty board through the whole of a Sunday
 * night game.
 */
function todayStamp(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: appTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");
}

class ScoresService extends StatusIntegration<ScoresStatusDTO> {
  private favourites: ScoreFavourite[] = [];
  private baseline: ScoreBaseline = new Map();
  private seeded = false;
  private rev = 0;
  /** One league's team list, cached for the picker. Teams change about once a
   *  decade; re-opening a dropdown must not re-fetch 30 rows. */
  private teamCache = new Map<LeagueId, { at: number; teams: ScoreFavourite[] }>();

  constructor() {
    super("scores", "scores:status", SCORES_OFFLINE);
  }

  protected get configured(): boolean {
    return this.favourites.length > 0;
  }

  configure(favourites: ScoreFavourite[]): void {
    this.favourites = favourites;
    // The baseline is keyed by game and team, so a favourites change invalidates
    // it: a team added mid-game must not immediately report its whole score as
    // having just happened.
    this.baseline = new Map();
    this.seeded = false;
    this.resetReport();
    this.restart();
    // restart() only starts when configured. Following nobody is a legitimate
    // state (the operator removed their last team), and it must leave the
    // channel empty rather than holding the last game up forever.
    if (!this.configured) this.emitIfChanged({ ...SCORES_OFFLINE });
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[scores] following ${this.favourites.length} team(s)`);
    super.start();
  }

  /** Which leagues have at least one followed team. Never poll an empty league. */
  private activeLeagues(): LeagueId[] {
    return [...new Set(this.favourites.map((f) => f.league))];
  }

  private followedIn(league: LeagueId): Set<string> {
    return new Set(this.favourites.filter((f) => f.league === league).map((f) => f.teamId));
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.configured) return;
    const stamp = todayStamp();
    const games: ScoreGameDTO[] = [];
    const failures: string[] = [];

    for (const id of this.activeLeagues()) {
      const meta = leagueById(id);
      if (!meta) continue;
      try {
        const payload = await fetchScoreboard(meta.path, stamp);
        games.push(...parseScoreboard(id, payload, this.followedIn(id)));
      } catch (err) {
        // Collected, not swallowed. A function that can partially fail returns
        // what failed; the operator decides what it means that MLB is reachable
        // and the NHL is not.
        failures.push(`${meta.label}: ${errorMessage(err)}`);
      }
    }
    if (!this.running) return;

    // EVERY league failed. That is a connection failure, not a partial result.
    if (failures.length > 0 && games.length === 0) {
      this.fail(failures.join("; "));
      return;
    }

    const sorted = sortGames(games);
    const events = this.seeded ? diffScores(this.baseline, sorted) : [];
    this.baseline = baselineOf(sorted);
    this.seeded = true;

    if (events.length > 0) this.rev++;
    if (!this.last.connected) {
      this.resetBackoff();
      this.report("connected", `Following ${this.favourites.length} team(s)`);
    }
    // A partial failure is reported but does not stop the feature: the leagues
    // that answered still show.
    if (failures.length > 0) this.report("error", failures.join("; "));

    this.emitIfChanged({
      connected: true,
      games: sorted,
      rev: this.rev,
      // Carried only on the poll that produced them. A client reads them when
      // `rev` moves and ignores them otherwise.
      lastEvents: events,
      fetchedAt: new Date().toISOString(),
      error: failures.length > 0 ? failures.join("; ") : null,
    });

    const decision = nextPoll(sorted, Date.now(), this.inDemand);
    this.scheduleIn(decision.delayMs);
  }

  /**
   * Broadcast only on something a viewer would notice.
   *
   * The base class compares the DTO's keys shallowly, which on this DTO is
   * always "changed": `games` is a fresh array every poll and `fetchedAt` is a
   * new timestamp by definition. Left alone it would turn a 25-second poll into
   * a 25-second SSE frame to every display. The rule itself is a pure function
   * so it can be tested — see scoresChanged.
   *
   * This is the OPPOSITE of REAPER's override, which deliberately ticks every
   * poll to advance a timecode. A game clock would tempt the same thing; the
   * client counts down locally instead.
   */
  protected override emitIfChanged(next: ScoresStatusDTO): void {
    if (scoresChanged(this.last, next)) this.emit(next);
    else this.last = next;
  }

  private fail(message: string): void {
    if (this.attempt === 0) {
      console.warn(`[scores] ESPN unreachable (${message}) — backing off quietly`);
    }
    this.report("error", message);
    // The scores we last had are kept and marked stale rather than blanked:
    // a display going empty reads as "no games", which is a different and wrong
    // statement from "we could not ask".
    this.emitIfChanged({ ...this.last, connected: false, error: message });
    this.scheduleReconnect();
  }

  /** One-shot check for the panel's Test button. */
  async test(): Promise<{ ok: boolean; message?: string }> {
    const league = this.activeLeagues()[0];
    if (!league) return { ok: false, message: "No teams followed yet" };
    const meta = leagueById(league);
    if (!meta) return { ok: false, message: "No league selected" };
    try {
      const payload = await fetchScoreboard(meta.path, todayStamp());
      const games = parseScoreboard(league, payload, this.followedIn(league));
      return {
        ok: true,
        message:
          games.length > 0
            ? `Reached ESPN — ${games.length} followed ${meta.label} game(s) today`
            : `Reached ESPN — no followed ${meta.label} games today`,
      };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /**
   * One league's teams, for the picker.
   *
   * Cached for a day. The picker opens often and a team list changes about once
   * a decade; re-fetching 30 rows to render a dropdown is the sort of traffic
   * this whole integration is built to avoid.
   *
   * Throws rather than returning []. An empty dropdown and a failed request look
   * identical to the operator, and the panel is required to say which league
   * could not be loaded.
   */
  async listTeams(league: LeagueId): Promise<ScoreFavourite[]> {
    const hit = this.teamCache.get(league);
    if (hit && Date.now() - hit.at < TEAM_CACHE_MS) return hit.teams;

    const meta = leagueById(league);
    if (!meta) throw new Error(`Unknown league ${league}`);
    const payload = (await fetchTeams(meta.path)) as {
      sports?: { leagues?: { teams?: { team?: Record<string, unknown> }[] }[] }[];
    };
    const raw = payload.sports?.[0]?.leagues?.[0]?.teams ?? [];
    const teams: ScoreFavourite[] = [];
    for (const entry of raw) {
      const t = entry?.team;
      if (!t || typeof t.id !== "string") continue;
      const colour =
        typeof t.color === "string" && /^[0-9a-f]{6}$/i.test(t.color)
          ? `#${t.color.toLowerCase()}`
          : null;
      const logos = Array.isArray(t.logos) ? (t.logos as { href?: unknown }[]) : [];
      teams.push({
        league,
        teamId: t.id,
        displayName: typeof t.displayName === "string" ? t.displayName : t.id,
        abbreviation: typeof t.abbreviation === "string" ? t.abbreviation : t.id,
        // Cached at selection time so no wall display ever reaches a.espncdn.com
        // itself — some church networks will not allow it, and the logo's own
        // cache-control is 103 seconds, so a display left running would re-fetch
        // it all week.
        logo: typeof logos[0]?.href === "string" ? logos[0].href : null,
        color: colour,
      });
    }
    if (teams.length === 0) throw new Error(`${meta.label} returned no teams`);
    teams.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.teamCache.set(league, { at: Date.now(), teams });
    return teams;
  }

  /** Every league the picker offers, for the settings panel. */
  leagues(): typeof LEAGUES {
    return LEAGUES;
  }

  async init(): Promise<void> {
    await scoresStore.init();
    this.configure(scoresStore.get().favourites);
  }
}

export const scoresService = new ScoresService();
