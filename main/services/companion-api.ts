// companion-api.ts — the OUTBOUND half of the Companion integration.
//
// Companion has always dialled us: its module opens an SSE stream to this server
// and that is what the integration row counts. This is the other direction — this
// app talking to Companion's own HTTP API, so a rule can press a named button.
//
// Two endpoints, and nothing else:
//
//   POST /api/location/<page>/<row>/<col>/press      presses a button
//   GET  /int/export/full?format=json                the whole configuration
//   GET  /api/custom-variable/<name>/value           one custom variable's value
//
// Companion answers the press with 200 and the body `ok` when the coordinate
// exists. An INVALID coordinate answers 204 and presses nothing — so 2xx alone is
// not success, and `press` treats anything that is not 200 as a failure. That
// distinction is the whole reason a press reports "dispatched" rather than "on":
// Companion confirms it delivered the press to a control, never that the
// projector came up.
//
// The export is large (4 MB on a real install) and changes when somebody edits
// Companion, which is rarely and never mid-service. It is cached for five
// minutes; the picker's Refresh button busts it.

import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";
import {
  type CompanionButton,
  type CompanionPair,
  customVariableNames,
  exportBuild,
  findPairs,
  isCompanionVariableName,
  parseButtons,
} from "./companion-export.js";

/** Companion's default HTTP/web port. */
export const DEFAULT_COMPANION_PORT = 8000;

const REQUEST_TIMEOUT_MS = 8000;
/**
 * A custom variable read, which a Home Assistant sensor is waiting on.
 *
 * Shorter than a press on purpose: `GET /api/cues/states` reads every bound
 * pair before it answers, and Home Assistant polls it on a schedule. Three
 * seconds is long enough for a Companion on the same LAN and short enough that
 * an unplugged one reports unknown rather than holding the request open.
 */
const VARIABLE_TIMEOUT_MS = 3000;
/** The export is 4 MB on a real install; give it longer than a press. */
const EXPORT_TIMEOUT_MS = 20_000;
const EXPORT_CACHE_MS = 5 * 60 * 1000;

export interface CompanionTarget {
  host: string;
  port: number;
}

/**
 * The seams. Tests replace `fetch` with a stub and `getTarget` with a fixed
 * host, which is what lets the press path be covered without a Companion —
 * and without pressing anything on the real one.
 *
 * `getTarget` reaches the integration manager through a DYNAMIC import rather
 * than a top-level one: integration-manager imports the services it drives, so a
 * static import here would close a cycle through it.
 */
export const companionDeps: {
  fetch: typeof fetch;
  getTarget: () => Promise<CompanionTarget | null>;
} = {
  fetch: (input, init) => fetch(input, init),
  getTarget: async () => {
    const { integrationManager } = await import("./integration-manager.js");
    return integrationManager.getCompanionTarget();
  },
};

export interface PressLocation {
  page: number;
  row: number;
  col: number;
}

export interface PressResult {
  ok: boolean;
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  detail: string;
}

/** The parsed export plus when it was read. */
interface ExportCache {
  at: number;
  buttons: CompanionButton[];
  pairs: CompanionPair[];
  build: string | null;
  /** The names of Companion's custom variables — what a pair's state can bind to. */
  customVariables: string[];
}

export type ExportResult =
  | {
      ok: true;
      buttons: CompanionButton[];
      pairs: CompanionPair[];
      build: string | null;
      customVariables: string[];
      cachedAt: number;
    }
  | { ok: false; reason: string };

/**
 * One custom variable read: the value, or why there is not one.
 *
 * A failure is RETURNED, never thrown and never flattened into "": a variable
 * holding "" and a Companion that could not be reached are the same screen
 * otherwise, and the whole point of reading state is to stop showing a state
 * nobody confirmed.
 */
export type VariableResult = { value: string } | { error: string };

class CompanionApi {
  private cache: ExportCache | null = null;
  /** In-flight fetch, so a page of pickers opening at once reads one export. */
  private inFlight: Promise<ExportResult> | null = null;

  /**
   * A caught fetch failure, said usefully.
   *
   * Node's own message for every network failure is the word "fetch failed",
   * with the real reason — ECONNREFUSED, EHOSTUNREACH, the address and the port
   * — one level down on `cause`. Driving the picker against a dead port put
   * "Could not read Companion's configuration: fetch failed" on screen, which
   * tells an operator nothing at all.
   */
  private static why(e: unknown, target: string): string {
    const top = errorMessage(e);
    const cause = e instanceof Error && e.cause !== undefined ? errorMessage(e.cause) : "";
    const said = cause && cause !== top ? cause : top === "fetch failed" ? `could not reach ${target}` : top;
    // The cause usually already names the address ("connect ECONNREFUSED
    // 127.0.0.1:8799"); appending it again reads as two different failures.
    return said.includes(target.replace(/^https?:\/\//, "")) ? said : `${said} (${target})`;
  }

  private async baseUrl(): Promise<string | null> {
    const target = await companionDeps.getTarget();
    if (!target) return null;
    return `http://${target.host}:${target.port}`;
  }

  /**
   * Press one button.
   *
   * NEVER throws — the automation action calls this and an action provider that
   * throws stops the engine. Every failure comes back as `{ ok: false, detail }`.
   */
  async press(loc: PressLocation): Promise<PressResult> {
    // Each coordinate becomes a path segment of the press URL. A fractional one
    // is a button that cannot exist; a negative or non-numeric one would be
    // pasted into the path. Refused here as well as in the automation action,
    // because this is what every caller reaches Companion through.
    if (![loc.page, loc.row, loc.col].every((n) => Number.isInteger(n) && n >= 0)) {
      return {
        ok: false,
        status: null,
        detail: `p${loc.page} r${loc.row} c${loc.col} is not a Companion coordinate — whole numbers, none negative`,
      };
    }
    const where = `p${loc.page} r${loc.row} c${loc.col}`;
    // Inside the try, like the other two: getTarget reaches the config store,
    // and a rejection out of a method the engine calls stops the engine.
    let base = "";
    try {
      const resolved = await this.baseUrl();
      if (!resolved) {
        return { ok: false, status: null, detail: "Companion host is not configured" };
      }
      base = resolved;
      const url = `${base}/api/location/${loc.page}/${loc.row}/${loc.col}/press`;
      const res = await companionDeps.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      console.log(`[companion] press ${where} -> HTTP ${res.status}`);
      // 204 is Companion's answer for a coordinate that holds no control: the
      // request succeeded and NOTHING was pressed. Reporting that as ok is how a
      // cue for a button somebody moved reads as working forever.
      if (res.status === 204) {
        return { ok: false, status: 204, detail: `no button at ${where} (Companion answered 204)` };
      }
      if (!res.ok) {
        return { ok: false, status: res.status, detail: `Companion answered HTTP ${res.status}` };
      }
      return { ok: true, status: res.status, detail: where };
    } catch (e) {
      // `base` is "" when getTarget itself failed, and "17/2/6 at " reads as a
      // truncated sentence — the coordinate alone is what is left to say.
      const detail = CompanionApi.why(e, base ? `${loc.page}/${loc.row}/${loc.col} at ${base}` : where);
      console.warn(`[companion] press ${where} failed: ${scrub(detail)}`);
      return { ok: false, status: null, detail };
    }
  }

  /**
   * The parsed configuration export, cached for five minutes.
   *
   * Returns the failure rather than throwing or falling back to an empty list: a
   * picker that shows "no buttons" when Companion is unreachable is the same
   * screen as a Companion with no buttons, and the operator needs to know which.
   */
  async fetchExport(opts: { force?: boolean } = {}): Promise<ExportResult> {
    const now = Date.now();
    if (!opts.force && this.cache && now - this.cache.at < EXPORT_CACHE_MS) {
      const c = this.cache;
      return {
        ok: true,
        buttons: c.buttons,
        pairs: c.pairs,
        build: c.build,
        customVariables: c.customVariables,
        cachedAt: c.at,
      };
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchExportOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchExportOnce(): Promise<ExportResult> {
    // Inside the try, like the other two: getTarget reaches the config store,
    // and a rejection here would reject the shared in-flight promise for every
    // picker waiting on it.
    let base = "";
    try {
      const resolved = await this.baseUrl();
      if (!resolved) {
        const reason = "Companion host is not configured";
        console.warn(`[companion] export unavailable: ${reason}`);
        return { ok: false, reason };
      }
      base = resolved;
      const res = await companionDeps.fetch(`${base}/int/export/full?format=json`, {
        signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
      });
      if (!res.ok) {
        // 401/403 is the one worth naming: Companion's export is open unless the
        // admin set a password, and "HTTP 401" alone sends people to the network.
        const reason =
          res.status === 401 || res.status === 403
            ? `Companion refused the export (HTTP ${res.status}) — its admin password is set`
            : `Companion answered HTTP ${res.status}`;
        console.warn(`[companion] export unavailable: ${scrub(reason)}`);
        return { ok: false, reason };
      }
      const raw: unknown = await res.json();
      const buttons = parseButtons(raw);
      const pairs = findPairs(buttons);
      const build = exportBuild(raw);
      const customVariables = customVariableNames(raw);
      const pages = new Set(buttons.map((b) => b.page)).size;
      console.log(
        `[companion] export fetched: ${pages} pages, ${buttons.length} buttons, ` +
          `${customVariables.length} custom variables`,
      );
      this.cache = { at: Date.now(), buttons, pairs, build, customVariables };
      return { ok: true, buttons, pairs, build, customVariables, cachedAt: this.cache.at };
    } catch (e) {
      const reason = CompanionApi.why(e, base);
      console.warn(`[companion] export unavailable: ${scrub(reason)}`);
      return { ok: false, reason };
    }
  }

  /**
   * Read one custom variable's current value.
   *
   * NEVER throws, and never caches: this is what `GET /api/cues/states` calls,
   * and the value is the one thing in Companion that changes every time somebody
   * presses a button. The five-second cache is over the whole ANSWER, one level
   * up in cue-states.ts, so a Home Assistant sensor polling every ten seconds
   * costs one round of reads and a burst of pollers costs the same.
   *
   * A 404 is Companion's answer for a variable that does not exist, which is the
   * ordinary case when somebody binds a cue before creating the variable — so it
   * comes back as its own sentence rather than as "HTTP 404".
   */
  async readCustomVariable(name: string): Promise<VariableResult> {
    const variable = name.trim();
    // Refused rather than sent: the name goes into a URL path, and a name
    // Companion could not have is a request that cannot succeed.
    if (!isCompanionVariableName(variable)) {
      return { error: `"${variable}" is not a Companion variable name` };
    }
    // `baseUrl()` is INSIDE the try. It awaits getTarget, which reaches the
    // integration manager and its config store, and a rejection there escaped a
    // method documented as never throwing — which under the caller's batch read
    // was every other pair's state gone as well. See cue-states.ts.
    let base = "";
    try {
      const resolved = await this.baseUrl();
      if (!resolved) return { error: "Companion host is not configured" };
      base = resolved;
      const url = `${base}/api/custom-variable/${encodeURIComponent(variable)}/value`;
      const res = await companionDeps.fetch(url, {
        signal: AbortSignal.timeout(VARIABLE_TIMEOUT_MS),
      });
      if (res.status === 404) return { error: "no such custom variable in Companion" };
      if (!res.ok) return { error: `Companion answered HTTP ${res.status}` };
      // Companion answers with the value as text. Trimmed, because a variable an
      // operator set from a button expression can carry a trailing newline and
      // "on\n" matching neither value would read as unknown.
      return { value: (await res.text()).trim() };
    } catch (e) {
      // `base` is "" when getTarget itself failed. `why` appends the target only
      // when the message does not already name it, and every message contains
      // "", so an unknown host reads as the failure alone rather than as
      // "... ()".
      return { error: CompanionApi.why(e, base) };
    }
  }

  /** Drop the cache, so the next read goes to Companion. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * The integration card's Test button.
   *
   * Reads the export rather than pressing anything — a Test that pressed a button
   * would be a Test nobody dares use. Forced past the cache, because "Test" has
   * to mean "reach it now".
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const target = await companionDeps.getTarget();
    if (!target) {
      return { ok: false, message: "Host is required" };
    }
    const result = await this.fetchExport({ force: true });
    if (!result.ok) {
      return { ok: false, message: result.reason };
    }
    const version = result.build ? `Companion ${result.build}` : "Companion";
    return {
      ok: true,
      message: `${version} — ${result.buttons.length} button(s), ${result.pairs.length} on/off pair(s)`,
    };
  }
}

export const companionApi = new CompanionApi();
