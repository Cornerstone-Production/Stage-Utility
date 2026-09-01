// log-rows.ts — turn raw buffer lines into the rows the /log viewer draws.
//
// This is the one piece of the viewer with real logic in it, and it exists as a
// module — rather than as more JavaScript inside the page's template string —
// for two reasons.
//
// It is INLINED INTO THE PAGE VERBATIM, via decorateLogLines.toString() (see
// log-page.ts). The page is deliberately framework-free and unbuilt so it still
// works when the renderer bundle is missing, so it cannot import anything; but
// embedding the function's own source means the browser runs the exact function
// the tests run. There is no second copy to drift.
//
// That in turn is what lets log-rows.test.ts be a real guard instead of a scan
// of the template string for a hoped-for substring.
//
// KEEP THE BODY SELF-CONTAINED: no imports, no module-scope helpers, no closures.
// Only the function's own text ships to the browser. Types on the signature are
// fine — they are stripped before toString() ever sees it.

export interface DecoratedLogRow {
  seq: number;
  level: string;
  msg: string;
  /** The `[tag]` a line opens with (without the brackets), or "" when untagged. */
  tag: string;
  /** YYYY-MM-DD in the app's zone, or "" when the timestamp did not parse. */
  day: string;
  /** HH:MM:SS in the app's zone. */
  time: string;
  /** First row of a new calendar day — the page draws a date separator above it. */
  newDay: boolean;
  /**
   * This row's timestamp is EARLIER than the row above it.
   *
   * The buffer is not chronological and never can be. On boot the previous run's
   * server.log tail is replayed with its original timestamps, and then
   * update-log.ts replays the last update's activity — also with its original
   * timestamps, which predate lines already sitting above it. Rendered as a flat
   * list of HH:MM:SS with no date, that reads as a live server whose clock jumped
   * backwards, and it has cost real debugging time.
   *
   * Marking the jump is the honest fix. Re-sorting is not: the replayed blocks
   * are meaningful as blocks, and interleaving them by timestamp would scatter
   * one update's output through unrelated lines.
   */
  backwards: boolean;
}

export interface RawLogLine {
  seq: number;
  t: string;
  level: string;
  msg: string;
}

/**
 * Annotate lines with tag, day/time in `timeZone`, day boundaries, and any
 * backwards time jump.
 *
 * `timeZone` is the APP's zone (app-timezone.ts), passed in from the server —
 * not the viewer's browser zone and never the raw UTC the lines are stamped in.
 * A log page is read against a service that happened at a wall-clock time in the
 * building, so that building's zone is the only one the timestamps can be
 * compared against. An unusable zone falls back to the viewer's own rather than
 * throwing, on the same grounds app-timezone falls back to the host: a slightly
 * wrong clock beats a blank page.
 */
export function decorateLogLines(lines: RawLogLine[], timeZone: string): DecoratedLogRow[] {
  // An unusable zone must not blank every timestamp on the page — that is
  // strictly worse than a slightly wrong clock. Try the app's zone, fall back to
  // the viewer's own, and give up only if Intl itself refuses. The header still
  // names the zone the page BELIEVES it is in, so a mismatch stays visible.
  //
  // en-CA renders YYYY-MM-DD, which sorts and compares as a plain string.
  //
  // NO INNER FUNCTIONS and no object spread. Only this function's own text ships
  // to the browser, and the bundler rewrites both into calls to module-scope
  // helpers that are not there — a nested `function formatter()` compiled to a
  // trailing `__name(formatter, "formatter")` and threw `__name is not defined`
  // on page load. log-rows.test.ts re-evaluates the emitted source in an empty
  // scope for exactly this reason; a test importing the module directly finds the
  // helper in scope and passes on a page that cannot run.
  var dayOpts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timeZone || undefined,
  };
  var timeOpts: Intl.DateTimeFormatOptions = {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: timeZone || undefined,
  };
  var dayFmt: Intl.DateTimeFormat | null;
  var timeFmt: Intl.DateTimeFormat | null;
  try {
    dayFmt = new Intl.DateTimeFormat("en-CA", dayOpts);
    timeFmt = new Intl.DateTimeFormat("en-GB", timeOpts);
  } catch {
    dayOpts.timeZone = undefined;
    timeOpts.timeZone = undefined;
    try {
      dayFmt = new Intl.DateTimeFormat("en-CA", dayOpts);
      timeFmt = new Intl.DateTimeFormat("en-GB", timeOpts);
    } catch {
      dayFmt = null;
      timeFmt = null;
    }
  }

  var rows: DecoratedLogRow[] = [];
  var prevDay: string | null = null;
  var prevMs: number | null = null;

  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var ms = Date.parse(l.t);
    var ok = !isNaN(ms);
    var d = ok ? new Date(ms) : null;
    var day = ok && dayFmt ? dayFmt.format(d as Date) : "";
    var time = ok && timeFmt ? timeFmt.format(d as Date) : "--:--:--";
    var m = /^\[([^\]\s]+)\]/.exec(l.msg);
    rows.push({
      seq: l.seq,
      level: l.level,
      msg: l.msg,
      tag: m ? m[1] : "",
      day: day,
      time: time,
      // A line whose timestamp is unreadable never opens a day and never counts
      // as a jump — it has no time to compare, and inventing one would put a
      // separator in the middle of an otherwise continuous run.
      newDay: ok && day !== prevDay,
      backwards: ok && prevMs !== null && ms < prevMs,
    });
    if (ok) {
      prevDay = day;
      prevMs = ms;
    }
  }
  return rows;
}
