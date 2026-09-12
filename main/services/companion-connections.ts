// companion-connections.ts — what Companion says about its own connections.
//
// PURE: no I/O. companion-api.ts does the GET and hands the body here; the
// reconcile and the Test button read the summary off it.
//
// `GET /api/connections` is a 5.x addition — it is not in the v4.1 API docs and a
// 4.x Companion answers 404 for it, which is why the fetch treats 404 as "this
// build does not report it" rather than as a fault. On 5.0.3+9703 it answers a
// flat array:
//
//   { id, label, moduleId, enabled, status: { category, level, message } | null }
//
// WHY THIS APP CARES, and it is not tidiness. A cue bound to a module variable
// reads `/api/variable/<label>/<name>/value`, and what a NOT-`good` connection
// answers is not one thing. All forty enabled connections on modules the state
// table knows were read live off the install this was built against:
//
//   good (18)                     200, a real current value, every one
//   error/Connecting, kasa (6)    404 — the module registered no variables
//   no status at all, kasa (10)   404 — same reason
//   error/Connecting, red-rcp2(5) 200 with an EMPTY body
//   error/Connection Failure (1)  200 `Off` — the LAST VALUE IT SAW
//
// So the read alone cannot tell a current value from a stale one, and the last
// row is the dangerous one: a bound switch reports that television confidently
// off while Companion has lost it. A 404 at least reads *unknown*.
//
// Only a `good` connection's value can be trusted, and nothing in this app knew
// which connections were good.
//
// THREE BUCKETS, and only two of them are Companion's own words. `good` and
// `error` were both read live. Everything else on an ENABLED connection is
// `unknown` — including `status: null`, which is not rare and not a fault: ten of
// the fifty-two enabled connections on the install this was built against are
// smart plugs sitting at null. Companion's status vocabulary has other words
// (`warning`) that were never observed here, so they are not given a meaning
// they might not have; they land in `unknown` carrying their own level string,
// which is what the log line prints.
//
// DISABLED connections are not counted at all. A connection somebody switched
// off in Companion is not a fault, and counting the install's thirty-two of them
// as problems would bury the twelve that are real.

/** One connection as `GET /api/connections` reports it. */
export interface CompanionConnection {
  id: string;
  /** The label a module-variable reference names it by. "" when absent. */
  label: string;
  moduleId: string;
  enabled: boolean;
  /**
   * Companion's live status, or null when it reports none.
   *
   * Every field is nullable and every field has been seen null: a disabled Dante
   * controller on the live install answers
   * `{ category: null, level: null, message: "Disabled" }`.
   *
   * `message` is read and nothing reads it back. It is one of the three fields
   * of Companion's own status object and this interface is that object — a
   * parser that silently dropped a third of the payload is how the next person
   * to need it concludes Companion does not send it. It is the only field here
   * with no consumer.
   */
  status: { category: string | null; level: string | null; message: string | null } | null;
}

/** How an enabled connection is counted. See the three buckets above. */
export type ConnectionHealthLevel = "ok" | "unknown" | "error";

/** One group of enabled connections that are not `ok`, for the log line. */
export interface ConnectionProblem {
  moduleId: string;
  /** Companion's own level word (`Connecting`, `Connection Failure`), or "" for none. */
  level: string;
  count: number;
  /** Which bucket the group is in, so the line can say when it is not an error. */
  bucket: Exclude<ConnectionHealthLevel, "ok">;
  /**
   * The labels in this group, in the order Companion listed them.
   *
   * A group of one is worth naming — "SA-HL-Stage-TV (Connection Failure)" sends
   * an operator to a television, where "1 vizio-smartcast" sends them to a list
   * of twelve. A group of six bulbs is not: six device names on an hourly line
   * is the noise the grouping exists to avoid. connectionDetail decides where
   * the line falls.
   */
  labels: string[];
}

/** Above this many in a group, the module id says more than the names do. */
const NAME_THEM_UP_TO = 3;

/** What Companion's connection list adds up to. */
export interface ConnectionHealth {
  /** Every connection in the document, switched on or not. */
  total: number;
  /** The ones switched on — the denominator of every count below. */
  enabled: number;
  ok: number;
  unknown: number;
  error: number;
  /** The worst bucket any ENABLED connection is in. `ok` when there are none. */
  worst: ConnectionHealthLevel;
  /**
   * The not-`ok` enabled connections grouped by module and level, worst first
   * then commonest first.
   *
   * Grouped rather than listed: twelve labels is twelve device names on one
   * hourly line, and "6 tplink-kasasmartbulb (Connecting)" is the sentence that
   * tells an operator where to go.
   */
  problems: ConnectionProblem[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The connection list out of whatever `GET /api/connections` answered.
 *
 * Defensive in the same way companion-export.ts is: a body that is not an array
 * is an empty list rather than a throw, and an entry missing a field takes the
 * empty answer for it. `enabled` is read as `!== false`, so a build that omits
 * the field entirely reports its connections as switched on rather than
 * reporting an install with nothing in it.
 *
 * An entry with no `id` is dropped. Everything downstream identifies a
 * connection by it, and an entry Companion could not name is an entry this
 * cannot report on.
 */
export function parseConnections(raw: unknown): CompanionConnection[] {
  if (!Array.isArray(raw)) return [];
  const out: CompanionConnection[] = [];
  const orNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
  for (const entry of raw) {
    const c = rec(entry);
    const id = str(c.id).trim();
    if (!id) continue;
    const s = c.status;
    out.push({
      id,
      label: str(c.label).trim(),
      moduleId: str(c.moduleId).trim(),
      enabled: c.enabled !== false,
      status:
        s === null || s === undefined
          ? null
          : {
              category: orNull(rec(s).category),
              level: orNull(rec(s).level),
              message: orNull(rec(s).message),
            },
    });
  }
  return out;
}

/** Which bucket one ENABLED connection falls in. */
function levelOf(c: CompanionConnection): ConnectionHealthLevel {
  const category = c.status?.category?.trim().toLowerCase() ?? "";
  if (category === "good") return "ok";
  if (category === "error") return "error";
  return "unknown";
}

/** Worst first: an error is what an operator acts on, an unknown is what they check. */
const WORST_FIRST: readonly ConnectionHealthLevel[] = ["error", "unknown", "ok"];

/**
 * Add the list up.
 *
 * Enabled connections only, for every count but `total`.
 */
export function summariseConnections(connections: readonly CompanionConnection[]): ConnectionHealth {
  const enabled = connections.filter((c) => c.enabled);
  const counts: Record<ConnectionHealthLevel, number> = { ok: 0, unknown: 0, error: 0 };
  // Keyed by module and level together: a module with four cameras failing and
  // two connecting is two rows, because the two say different things.
  const groups = new Map<string, ConnectionProblem>();
  for (const c of enabled) {
    const bucket = levelOf(c);
    counts[bucket]++;
    if (bucket === "ok") continue;
    const level = c.status?.level?.trim() ?? "";
    // JSON, not a separator character. Companion's level words contain
    // spaces (`Connection Failure`), so any single-character join can be
    // forged by a value that contains it, and two different states would
    // add up as one row.
    const key = JSON.stringify([c.moduleId, level, bucket]);
    const found = groups.get(key);
    if (found) {
      found.count++;
      found.labels.push(c.label);
    } else {
      groups.set(key, { moduleId: c.moduleId, level, count: 1, bucket, labels: [c.label] });
    }
  }
  const problems = [...groups.values()].sort(
    (a, b) =>
      WORST_FIRST.indexOf(a.bucket) - WORST_FIRST.indexOf(b.bucket) ||
      b.count - a.count ||
      a.moduleId.localeCompare(b.moduleId),
  );
  return {
    total: connections.length,
    enabled: enabled.length,
    ...counts,
    worst: counts.error > 0 ? "error" : counts.unknown > 0 ? "unknown" : "ok",
    problems,
  };
}

/**
 * The one sentence the integration row and the Test button show.
 *
 * Both numbers, when both are non-zero: twelve in error is the actionable half
 * and ten not reporting is why the other switches read unknown, and an operator
 * shown only the first would go looking for a thirteenth fault.
 */
export function connectionSentence(health: ConnectionHealth): string {
  const { enabled, error, unknown } = health;
  if (enabled === 0) return "no connections enabled in Companion";
  if (error > 0) {
    return (
      `${error} of ${enabled} connection(s) in error` + (unknown > 0 ? `, ${unknown} not reporting` : "")
    );
  }
  if (unknown > 0) return `${unknown} of ${enabled} connection(s) not reporting`;
  return `${enabled} connection(s) ok`;
}

/**
 * The sentence plus what is behind it, for the log.
 *
 * Only called when there is something to say — see companion-reconcile.ts, which
 * stays silent on a clean hourly pass.
 */
export function connectionDetail(health: ConnectionHealth): string {
  const groups = health.problems.map((p) => {
    // Few enough to name: the labels ARE the answer, and a count in front of
    // them would only repeat what the list already shows.
    const who =
      p.count <= NAME_THEM_UP_TO && p.labels.every((l) => l !== "")
        ? p.labels.join(", ")
        : `${p.count} ${p.moduleId || "unnamed module"}`;
    // Companion's level word alone would read the same for two buckets on one
    // module — `error/Connecting` and a `warning/Connecting` both render
    // "(Connecting)" — so an unknown group says which it is. An error group does
    // not: the sentence in front of it already said how many are in error.
    const why = [p.level, p.bucket === "unknown" ? "not reporting" : ""].filter(Boolean).join(", ");
    return why ? `${who} (${why})` : who;
  });
  return groups.length ? `${connectionSentence(health)}: ${groups.join(", ")}` : connectionSentence(health);
}

/**
 * What Companion said about its connections, or why there is no answer.
 *
 * Declared HERE rather than in companion-api.ts, which is the only thing that
 * produces one, because healthReport below consumes it and the two files would
 * otherwise import each other.
 *
 * `unsupported` is its own outcome and not an error. `GET /api/connections` is a
 * 5.x addition — a 4.x Companion answers 404 for it, and reporting that as a
 * fault would put a red sentence on the row of every older install for a
 * diagnostic it was never going to have.
 */
export type ConnectionsResult =
  | { ok: true; health: ConnectionHealth; cachedAt: number }
  | { ok: false; unsupported: boolean; reason: string };

/**
 * One read, said two ways: what goes on the integration row, and what goes in
 * the log.
 *
 * PURE, and separate from the reconcile that calls it, because the reconcile's
 * own entry point needs the automation engine to test at all and this is the
 * part with the decisions in it.
 *
 * `log` is null on a CLEAN read on purpose. This runs hourly against the same
 * /log page an operator reads on a Sunday morning, and "52 connection(s) ok"
 * twenty-four times a day is what buries the pass that found twelve in error.
 * The row still carries the clean sentence — a screen somebody is looking at is
 * not a log nobody asked for.
 *
 * `sentence` is null for an UNSUPPORTED build. There is no fact to put on the
 * row, and "unavailable" would read as a fault on every 4.x install.
 */
export function healthReport(result: ConnectionsResult): {
  sentence: string | null;
  log: string | null;
} {
  if (result.ok) {
    return {
      sentence: connectionSentence(result.health),
      log: result.health.worst === "ok" ? null : connectionDetail(result.health),
    };
  }
  if (result.unsupported) return { sentence: null, log: null };
  // Said on both. The caller only gets here having ALREADY read the export off
  // the same Companion, so a connection list that failed is a new fact rather
  // than the box being off — and the export's own failure line does not cover it.
  const said = `connection status unavailable: ${result.reason}`;
  return { sentence: said, log: said };
}
