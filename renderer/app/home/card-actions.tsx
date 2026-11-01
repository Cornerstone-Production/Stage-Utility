// A Home tile's own action.
//
// One per tile, and only where the tile has an obvious one: Prev and Next on the
// live timer, Start and Stop on a recorder. Streaming has none on purpose;
// starting a broadcast from a tile is too easy to do by accident and too public
// to get wrong.
//
// Three rules shape everything here.
//
//  - A button never reads as done before the status channel says so. Start shows
//    a spinner until the recorder reports it is recording, and gives up out loud
//    if it never does. Reporting "started" on the strength of a request being
//    accepted is the lie this exists to avoid.
//  - Stop takes two presses. A stray tap mid-sermon must not end the recording.
//    Prev and Next are one press, because they are reversible.
//  - A failure says so on the tile for a few seconds. The server already logs a
//    failed invoke on its own tag (`action-invoke`), so nothing is logged here.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";

import { errorMessage } from "@main/services/errors";

import { invoke } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/button";
import { useLiveStep } from "../../main/live-controls";
import type { Recorder } from "../recording-status";

/** How long "Stop recording?" waits for its second press. */
export const STOP_CONFIRM_MS = 3000;
/** How long a failure stays on the tile. */
export const ACTION_NOTE_MS = 5000;
/** How long a Start or Stop waits for the recorder's status to agree. */
export const CONFIRM_GIVE_UP_MS = 10_000;

/** A short message that clears itself. */
export function useTransientNote(ms = ACTION_NOTE_MS): [string | null, (message: string) => void] {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = useCallback(
    (message: string) => {
      setNote(message);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setNote(null), ms);
    },
    [ms],
  );
  return [note, show];
}

/**
 * Two presses within `ms`. The first arms, the second confirms; an armed press
 * that is not followed up disarms itself.
 */
export function useStopConfirm(onConfirm: () => void, scope: unknown, ms = STOP_CONFIRM_MS) {
  // The ask belongs to the state it was made about (`scope`): a recorder that
  // restarts inside the window is a different question, and one press must not
  // answer it.
  const [asked, setAsked] = useState<{ scope: unknown } | null>(null);
  // Any change of scope disarms, adjusted during render so there is no frame in
  // which the old ask is still showing. false, true, false, true inside the
  // window must not land back on an armed button.
  const [seen, setSeen] = useState(scope);
  if (!Object.is(seen, scope)) {
    setSeen(scope);
    if (asked) setAsked(null);
  }
  const armed = asked !== null && Object.is(asked.scope, scope) && Object.is(seen, scope);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const press = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (armed) {
      setAsked(null);
      onConfirm();
      return;
    }
    setAsked({ scope });
    timer.current = setTimeout(() => setAsked(null), ms);
  }, [armed, onConfirm, scope, ms]);
  return { armed, press };
}

/**
 * The tile with its action to the right of the reading.
 *
 * The action column is dropped where the tile is too narrow to hold a 44px
 * control beside the text, rather than squeezing it: a control a finger cannot
 * hit is worse than none. Container-query driven, so it follows the tile's own
 * width and not the window's.
 */
export function ActionTile({
  action,
  reserveCorner = false,
  children,
}: {
  action: ReactNode;
  /** The tile also expands, and its expand control sits in the bottom-right
   *  corner. The column keeps clear of that corner (44px control, 4px inset)
   *  rather than centring into it: on a Small tile the two otherwise overlap and
   *  a press meant for Next lands on Expand. */
  reserveCorner?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="@container/tile flex h-full w-full">
      <div className="relative min-w-0 flex-1">{children}</div>
      <div
        data-tile-action=""
        className={cn(
          "hidden shrink-0 flex-col items-end justify-center gap-2 pr-3 @min-[13rem]/tile:flex",
          reserveCorner && "pb-12",
        )}
      >
        {action}
      </div>
    </div>
  );
}

/** Every control on a tile is at least 44px square under a coarse pointer. */
const TOUCH = "coarse:h-11 coarse:min-w-11 coarse:px-4";

/** A button that is busy says so with aria-disabled, not `disabled`: a disabled
 *  button drops keyboard focus to <body>, and the operator's next key press
 *  would start from the top of the page. */
const BUSY = "aria-disabled:pointer-events-none aria-disabled:opacity-40";

function Note({ children }: { children: ReactNode }) {
  return (
    <span role="alert" className="max-w-40 text-right text-caption1 text-danger-11">
      {children}
    </span>
  );
}

// ── Recording ───────────────────────────────────────────────────────────────

/** How each recorder is told to start and stop: an action in the automation
 *  registry, the same ones a rule or a console button runs. */
const RECORDER_ACTION: Record<string, { actionId: string; start: string; stop: string; label: string }> = {
  REAPER: { actionId: "reaper.transport", start: "record", stop: "stop", label: "Reaper" },
  OBS: { actionId: "obs.record", start: "start", stop: "stop", label: "OBS" },
};

type Verb = "start" | "stop";

/** What the recorders must report for `verb` to have happened. */
function arrived(list: readonly Recorder[], names: readonly string[], verb: Verb): boolean {
  return names.every((n) => {
    const r = list.find((x) => x.name === n);
    // A recorder that is gone or disconnected is not recording, so a Stop is
    // done. A Start is not: it keeps waiting, and gives up naming it.
    if (verb === "stop" && (!r || !r.connected)) return true;
    return r?.recording === (verb === "start");
  });
}

/** The recorders still not where a press wanted them. */
function missing(list: readonly Recorder[], names: readonly string[], verb: Verb): string[] {
  return names.filter((n) => !arrived(list, [n], verb));
}

export function RecordingAction({ chosen }: { chosen: readonly Recorder[] }) {
  const targets = chosen.filter((r) => r.connected && RECORDER_ACTION[r.name]);
  const recording = targets.some((r) => r.recording);
  const [pending, setPending] = useState<{ verb: Verb; names: string[] } | null>(null);
  const [note, showNote] = useTransientNote();
  // What the give-up timer and a late failure judge against: the CURRENT status,
  // not the render that scheduled them.
  const latest = useRef(chosen);
  useEffect(() => {
    latest.current = chosen;
  });

  // The status channel is the only thing that finishes a press.
  const waiting = pending !== null && !arrived(chosen, pending.names, pending.verb);
  // Cleared during render, React's own alternative to an effect that sets state:
  // left set, the next time the recorder changed for any other reason (somebody
  // stopped it at the console) it would read as a press still waiting.
  if (pending && !waiting) setPending(null);
  // And when it never does, say so rather than spinning for ever.
  useEffect(() => {
    if (!waiting || !pending) return;
    const t = setTimeout(() => {
      const label = (n: string) => RECORDER_ACTION[n]?.label ?? n;
      const now = latest.current;
      const gone = missing(now, pending.names, pending.verb);
      const off = gone.filter((n) => !now.find((r) => r.name === n)?.connected);
      showNote(
        off.length > 0
          ? `${off.map(label).join(" and ")} disconnected`
          : `${gone.map(label).join(" and ")} did not confirm`,
      );
      setPending(null);
    }, CONFIRM_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [waiting, pending, showNote]);

  const run = useCallback(
    async (verb: Verb) => {
      // Start the ones that are stopped, stop the ones that are rolling: with
      // "any" the card speaks for every recorder at once.
      const these = targets.filter((r) => r.recording === (verb === "stop"));
      if (these.length === 0) return;
      setPending({ verb, names: these.map((r) => r.name) });
      const failures: string[] = [];
      await Promise.all(
        these.map(async (r) => {
          const a = RECORDER_ACTION[r.name]!;
          try {
            const res = await invoke<{ ok: boolean; detail: string }>("action:invoke", {
              actionId: a.actionId,
              params: { command: a[verb] },
            });
            if (!res?.ok) failures.push(res?.detail || `${a.label} did not answer`);
          } catch (e) {
            failures.push(`${a.label} did not answer: ${errorMessage(e)}`);
          }
        }),
      );
      if (failures.length > 0) {
        setPending(null);
        // A refusal that arrives after the status already shows what was asked
        // for is not news: the recorder is where the operator wanted it.
        if (!arrived(latest.current, these.map((r) => r.name), verb)) showNote(failures.join(" "));
      }
    },
    [targets, showNote],
  );

  const stop = useStopConfirm(() => void run("stop"), recording);

  if (targets.length === 0) return null;
  const spinning = pending !== null && waiting;
  // ONE button, always, with the failure note beside it rather than in its place:
  // swapping the element for a note would drop keyboard focus to <body>.
  return (
    <div className="flex flex-col items-end gap-1">
      {spinning ? (
        <Button
          variant="filled"
          aria-disabled="true"
          onClick={() => {}}
          className={cn(TOUCH, BUSY)}
          aria-label={pending.verb === "start" ? "Starting" : "Stopping"}
        >
          <Loader2Icon className="size-4 animate-spin" />
        </Button>
      ) : recording ? (
        <Button
          variant="filled"
          onClick={stop.press}
          aria-label={stop.armed ? "Stop recording, press again to confirm" : undefined}
          className={cn(TOUCH, stop.armed && "bg-danger-9 text-white hover:bg-danger-9")}
        >
          {stop.armed ? "Stop recording?" : "Stop"}
        </Button>
      ) : (
        <Button variant="accent" onClick={() => void run("start")} className={TOUCH}>
          Start
        </Button>
      )}
      {note && <Note>{note}</Note>}
    </div>
  );
}

// ── Prev / Next ─────────────────────────────────────────────────────────────

/**
 * Previous and Next on the live timer. Always the real PCO call; one press
 * each, because stepping back is the undo. No confirmation of arrival is
 * possible or needed here: the countdown beside the button is the confirmation,
 * and moves on its own when `pco:live` does.
 */
export function StepAction({ showPrev }: { showPrev: boolean }) {
  const [note, showNote] = useTransientNote();
  const { busy, go } = useLiveStep(showNote);

  return (
    <div className="flex flex-col items-end gap-1">
    <div className="flex items-center gap-2">
      {showPrev && (
        <Button variant="filled" onClick={() => void go("previous")} aria-disabled={busy !== null} className={cn(TOUCH, BUSY)}>
          {busy === "previous" ? <Loader2Icon className="size-4 animate-spin" /> : <ChevronLeftIcon className="size-4" />}
          Prev
        </Button>
      )}
      <Button variant="accent" onClick={() => void go("next")} aria-disabled={busy !== null} className={cn(TOUCH, BUSY)}>
        Next
        {busy === "next" ? <Loader2Icon className="size-4 animate-spin" /> : <ChevronRightIcon className="size-4" />}
      </Button>
    </div>
    {note && <Note>{note}</Note>}
    </div>
  );
}
