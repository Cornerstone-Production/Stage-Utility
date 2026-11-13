// app-zone.ts — the zone a page answers "what day is it" in.
//
// Its own module, importing only app-timezone.ts (Intl, nothing else): the
// History page, the editor's plan switcher, the Mic slots dialogs, the Video feeds
// export and the ServiceCue page all ask it, and the ServiceCue page is also the
// public page, whose bundle carries only what it needs.
//
// Two zones are easy to mix up here. `hostTimeZone()`, run in a browser, answers
// the BROWSER's zone: the machine the page is open on. `state.hostTimezone` is the
// SERVER's clock, which the server reasons in when no zone is set. Only the second
// is the app's answer; the first is the last resort before state arrives.

import { hostTimeZone, type TimeZone } from "@main/services/app-timezone";

/**
 * Which zone a browser should answer "what day is it" in.
 *
 * In the server's own order: the operator's SETTING first, then the SERVER's
 * host clock, which is what `appTimeZone()` resolves to when nothing is set.
 *
 * The last fallback is this browser's own zone, and it is only reached when
 * stage state has not arrived yet. Reaching for it sooner is the bug: a UTC
 * server viewed from a laptop in Chicago would have the page deciding the day
 * ended five hours before the server did, and the two would disagree about
 * which Sunday a 7pm service belongs to.
 */
export function appZoneOf(
  state: { timezone?: string | null; hostTimezone?: string | null } | null | undefined,
  browserZone: TimeZone = hostTimeZone(),
): TimeZone {
  return state?.timezone ?? state?.hostTimezone ?? browserZone;
}
