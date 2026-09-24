// rebuild.ts — the Rebuild from raw logic: why the button is disabled, what
// it confirms, and how it posts and reports success or failure.
//
// Shared so the save-failure entry's own Rebuild action reuses the exact
// flow rather than a second copy of it.

import type { BaptismRebuildOutcome } from "@main/services/history-edit";

import { errorMessage } from "@main/services/errors";
import { invoke, type ApiError } from "../../../lib/api";
import { toast, confirm } from "../../../components/ui";
import { fmtDate } from "../../../main/use-baptism-state";
import type { LiveCheck, LiveStatus } from "./use-service-live";

/**
 * What a baptism-only rebuild did, in a sentence — the same "say what
 * changed" discipline describeRebuild uses for History's whole-service one,
 * over the narrower shape rebuildServiceBaptisms answers with.
 *
 * `newer` and `kept` are both "left alone", but for different reasons worth
 * telling apart: `kept` is a session these rows never touched at all; `newer`
 * is one they DID match, and the store's own copy won because it is newer
 * than what the rows can show (a correction made after the service closed).
 * Folding them into one number would hide that the second kind exists at all.
 */
export function describeBaptismRebuild(out: BaptismRebuildOutcome): string {
  const parts = [`${out.updated} updated`, `${out.added} added`];
  if (out.newer > 0) parts.push(`${out.newer} newer than their rows`);
  if (out.disagreeing > 0) parts.push(`${out.disagreeing} disagreeing with the rows`);
  if (out.invalid > 0) parts.push(`${out.invalid} could not be read`);
  if (out.kept > 0) parts.push(`${out.kept} left alone`);
  // A rebuild never evicts an existing session to make room (see
  // baptismStore.mergeRebuilt) — at the MAX_SESSIONS cap it simply stops
  // adding new ones, and says so, rather than silently discarding them.
  if (out.full > 0) parts.push(`the store is full, so ${out.full} were not added`);
  return `Rebuilt from raw: ${parts.join(", ")}`;
}

/**
 * Why Rebuild from raw is disabled, or `null` when it is not.
 *
 * Pure and exported so each reason is provable directly in header.test.tsx
 * without needing Radix's hover machinery to reach a rendered tooltip (jsdom
 * mounts a Tooltip's content only while it is open — see this file's own
 * comment; a few of the tests below drive that open with a real focus event
 * where the exact rendered text matters, but the exhaustive "every reason is
 * distinct" check calls this function directly). Conflating any of these
 * would send an operator to reload a page that was actually fine (a load
 * failure), to look for a "missing" recording that a session simply predates
 * the serviceKey field on, or to wait out a recording that already ended
 * because the last check of it happened to fail.
 */
export function baptismRebuildDisabledReason(args: {
  targetServiceKey: string | null;
  liveStatus: LiveStatus;
  sessionsLoadFailed: boolean;
  mostRecentSession: { serviceKey?: string | null } | null;
}): string | null {
  if (args.targetServiceKey != null) {
    switch (args.liveStatus) {
      case "live":
        return "This service is still recording — rebuild once it ends";
      case "checking":
        return "Checking whether this service is still recording…";
      case "failed":
        return "Could not check whether this service is still recording — try again shortly";
      case "not-live":
        return null;
    }
  }
  if (args.sessionsLoadFailed) return "Past sessions could not be loaded — reload the page and try again";
  if (args.mostRecentSession) return "The most recent session has no linked service to rebuild from";
  return "Nothing has been recorded yet — there is no service to rebuild";
}

/**
 * How Rebuild from raw names its target in a confirm dialog: title and date
 * together when both exist, whichever one exists alone, or a neutral
 * fallback when neither does. Shared so the header's own action and each
 * save-failure entry's own (which has a date from its session id but never
 * a title) describe "this service" the same way rather than two slightly
 * different sentences drifting apart.
 */
export function rebuildTargetLabel(title: string | null, date: string | null): string {
  return title && date ? `${title} (${fmtDate(date)})` : (title ?? (date ? fmtDate(date) : "this service"));
}

/**
 * Confirm before writing, naming the service — the exact dialog this header
 * has always shown, pulled out so the save-failure note's per-entry Rebuild
 * action reuses the same wording rather than a second copy of it.
 */
async function confirmBaptismRebuild(targetLabel: string): Promise<boolean> {
  return confirm({
    title: "Rebuild from raw?",
    message:
      `Recomputes ${targetLabel}'s baptism sessions from the presses recorded in the data archive. ` +
      "Existing sessions are updated, or added to if the rows have one the store does not — never " +
      "deleted, even one these rows cannot reproduce (a session removed from Past sessions can come back).",
    confirmLabel: "Rebuild",
    destructive: true,
  });
}

/**
 * Confirm, recheck liveness right before the write, POST, and report — the
 * one place this repo posts to POST /api/baptism/rebuild, so the header's
 * own action and the save-failure note's per-entry one cannot refuse,
 * confirm or report a rebuild differently. `liveCheck` is always the
 * CALLER's own `useServiceLive()`: the header's targetServiceKey and a
 * failed entry's own serviceKey are never the same question, and each needs
 * its own answer rather than sharing one hook instance.
 */
export async function runBaptismRebuild(args: {
  serviceKey: string;
  targetLabel: string;
  liveCheck: LiveCheck;
  onRebuilt: () => void;
  /**
   * Set only by a save-failure entry's own Rebuild — never by the header's,
   * which rebuilds a whole service and has no ONE session to answer for.
   * When set, a 200 that did not actually restore THIS session (its id is
   * missing from the response's own `restoredIds`) reports that plainly
   * instead of the generic success toast: a full or read-only disk can drop
   * the `finish` row itself, not just the JSON save, leaving the raw rows
   * with no finished copy of this session for a rebuild to find at all.
   */
  sessionId?: string;
}): Promise<void> {
  if (!(await confirmBaptismRebuild(args.targetLabel))) return;
  // Asked again, right now: the confirm dialog can sit open long enough for
  // the target to start recording, and posting into that would be a race
  // the operator did not cause. Only an outright "live" answer refuses here
  // — "failed" or a slow "not live" are not reasons to hold back a POST the
  // server will refuse on its own if it has to.
  if ((await args.liveCheck.recheck()) === "live") {
    toast.error("This service started recording again — rebuild once it ends");
    return;
  }
  try {
    const out = await invoke<BaptismRebuildOutcome>("baptism:rebuild", { serviceKey: args.serviceKey });
    args.onRebuilt();
    if (args.sessionId && !out.restoredIds.includes(args.sessionId)) {
      toast.error("The raw rows hold no finished copy of this session — copy the report now");
      return;
    }
    toast.success(describeBaptismRebuild(out));
  } catch (e) {
    // A 409 is a DECISION, not one failure — the route answers it for two
    // opposite reasons (ServiceIsLiveError and NoRawRowsError both refuse
    // with 409), and treating every 409 as "started recording again" is its
    // own bug: a service recorded before the raw layer existed has a
    // timeline record but no baptism.csv at all, which is exactly this
    // page's own fallback target on a freshly upgraded server until the
    // first new session lands — every click toasted the live-service
    // message, flipped the button to "still recording," and re-enabled it
    // within 30 seconds only to repeat. The server's own `code` on the
    // response tells the two apart.
    const code = (e as ApiError)?.code;
    if (code === "live") {
      // The recheck above narrows the race but cannot close it: the service
      // can still start recording in the moment between that check and this
      // POST landing. Reflect that without waiting for yet another round
      // trip, rather than the generic failure message.
      args.liveCheck.markLive();
      toast.error("This service started recording again — rebuild once it ends");
      return;
    }
    if (code === "no-raw-rows") {
      // Not a liveness problem at all — leave the button exactly as it was
      // and say what the server actually refused on.
      toast.error(errorMessage(e));
      return;
    }
    toast.error(`Rebuild failed: ${errorMessage(e)}`);
  }
}
