// timer-card.tsx — the Baptisms tab's Timer card: the readout an operator
// touches during a live service, and the controls around it.
//
// MOVED out of baptism-operator.tsx, not rewritten: every PR 1 behaviour this
// panel was hardened through many review rounds for survives unchanged here —
// the armed readout, the grouped button labels, Pause hidden while armed, the
// typed primaryChannel, the workflow toggle locked mid-session, and
// BaptismTriggersPanel. renderer/main/baptism-operator-armed.test.tsx drives
// this through <BaptismOperator/> and is proof: it still passes unedited.
//
// The old Totals grid that used to sit below the controls does NOT move here —
// it is superseded by the header's stat strip (see ./header.tsx), which shows
// the same six numbers (and more) whether or not anyone has been baptized yet.

import { useState } from "react";
import { DropletIcon, RotateCcwIcon, Undo2Icon, FlagIcon, PauseIcon, PlayIcon } from "lucide-react";

import { segmentElapsedMs } from "@main/services/baptism-elapsed";
import { invoke, type IpcChannel } from "../../../lib/api";
import { Button, confirm, toast } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { summarizeBaptism, fmtClock } from "../../../main/use-baptism-state";
import { useServerNow } from "../../../lib/server-clock";
import { BaptismTriggersPanel } from "../../../main/baptism-triggers-panel";

/**
 * Invoke a channel, tracking a busy flag around it and surfacing a failure as
 * a toast rather than swallowing it.
 *
 * A plain top-level function, not a method on TimerCard — nothing here reads
 * component state, only the setter it's given. (It also keeps `act` a
 * standalone `function` declaration api-channels.test.ts's structural scan can
 * find on its own: nested one level inside TimerCard, its own `invoke` call
 * was being attributed to TimerCard's enclosing declaration instead, because
 * nothing between the two closed a brace first — the scan is a literal source
 * walk, not a parser, and this is the shape it needs.)
 */
async function act(
  setBusy: (busy: boolean) => void,
  channel: IpcChannel,
  after?: () => void,
  payload?: Record<string, unknown>,
): Promise<void> {
  setBusy(true);
  try {
    await invoke(channel, payload);
    after?.();
  } catch (err) {
    toast.error(`Action failed: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

export interface TimerCardProps {
  state: BaptismState;
  /** Called after a Finish action succeeds, so the Past sessions and Trends
   *  cards (past-sessions.tsx, trends-card.tsx) pick up the newly logged
   *  session. */
  onFinished: () => void;
}

export function TimerCard({ state, onFinished }: TimerCardProps) {
  const [busy, setBusy] = useState(false);

  // The SERVER's clock. segmentStartedAt is stamped by the server, so a console
  // whose own clock has drifted would report the drift as elapsed time — and the
  // same segment would read differently here and on a display object.
  const segStart = state.segmentStartedAt ?? null;
  const now = useServerNow(250, !!segStart);

  async function resetAll() {
    if (!(await confirm({ title: "Reset baptism timer?", message: "Clear the current session and all splits. This can't be undone.", confirmLabel: "Reset", destructive: true }))) return;
    void act(setBusy, "baptism:reset");
  }

  const phase = state.phase;
  // Paused = a phase is running but its clock is not, AND there is banked time
  // to resume from. Armed (grouped baptisms, before the first press) looks the
  // same — no clock, nothing banked — but is not paused: there is nothing to
  // resume, so it must not offer a "Resume" button. The readout keeps showing
  // what was banked, so a paused timer looks stopped rather than looking broken.
  const paused = phase !== "idle" && !state.armed && !state.segmentStartedAt;
  // Includes what the segment banked before a pause, or a paused clock reads
  // 0:00 and looks broken. `now` only ticks while it runs, which is why the
  // paused value holds steady.
  const liveMs = segmentElapsedMs(state, now);
  const sum = summarizeBaptism(state);
  const justFinished = phase === "idle" && state.finishedAt != null && state.people.length > 0;

  const grouped = state.mode === "grouped";
  const lastBaptism = grouped && phase === "baptism" && state.baptismIndex >= state.people.length - 1;
  // Armed gets its own quiet, muted treatment — not the active baptism colour
  // (nothing is running yet) and deliberately not any colour a paused clock
  // would use either: armed has nothing banked to resume, so it must not read
  // as "stopped mid-segment."
  const phaseColor = state.armed ? "text-fg-subtle" : phase === "testimony" ? "text-accent" : phase === "baptism" ? "text-live-11" : "text-fg-muted";
  // The big clock itself: dimmed while armed (the mockup's own rule — the
  // number on screen is not real yet), amber while genuinely paused, full
  // strength otherwise. Independent of phaseColor, which is the LABEL above it.
  const clockColor = state.armed ? "text-fg-subtle" : paused ? "text-warn-11" : "text-fg";

  // Phase-aware primary action (label + channel), per workflow.
  let primaryLabel: string;
  // Typed against the full IpcChannel union, not `string` — an unwired or
  // misspelled channel assigned below fails `tsc`, rather than depending on the
  // text scans in api-channels.test.ts (which cannot see a channel behind a
  // variable at all; see IpcChannel's own doc comment).
  let primaryChannel: IpcChannel;
  if (state.armed) {
    // Grouped only: the song is live but nobody's clock has started. This press
    // is exactly what advance() exists for — starting person 1 without banking
    // the stretch the band's intro took. See BaptismState.armed.
    primaryLabel = "First person in";
    primaryChannel = "baptism:advance";
  } else if (phase === "idle") {
    primaryLabel = grouped ? "Start testimonies" : "Start";
    primaryChannel = "baptism:start";
  } else if (phase === "testimony") {
    primaryLabel = grouped ? "Next testimony" : "Mark baptized";
    primaryChannel = grouped ? "baptism:next" : "baptism:baptized";
  } else {
    // baptism
    if (grouped) {
      // Each press marks a boundary, not a "baptize" command — "Next person in"
      // ends the current person's segment and starts the next; "Last person
      // out" ends the final one and is the one that also finishes the session.
      primaryLabel = lastBaptism ? "Last person out" : "Next person in";
      primaryChannel = lastBaptism ? "baptism:finish" : "baptism:next";
    } else {
      primaryLabel = "Next person";
      primaryChannel = "baptism:next";
    }
  }

  // Readout heading. Armed overrides every other label — the one thing the
  // operator must not mistake it for is a baptism already under way.
  let readoutLabel: string;
  if (state.armed) readoutLabel = "Baptisms · armed";
  else if (phase === "idle") readoutLabel = justFinished ? "Finished" : "Ready";
  else if (grouped && phase === "testimony") readoutLabel = `Testimony · Person ${state.personNumber}`;
  else if (grouped && phase === "baptism") readoutLabel = `Baptism · Person ${state.baptismIndex + 1} of ${state.people.length}`;
  else readoutLabel = `Person ${state.personNumber} · ${phase === "testimony" ? "Testimony" : "Baptism"}`;

  return (
    <div id="s-timer" className="su-card flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold text-fg">Timer</h2>
        <span className="flex-1" />
        <span className="text-caption1 text-fg-subtle">Workflow</span>
        <div className="inline-flex rounded-md border border-line overflow-hidden">
          {([["per-person", "Per person"], ["grouped", "Grouped"]] as const).map(([m, label]) => (
            <button
              key={m}
              disabled={busy || phase !== "idle"}
              onClick={() => void act(setBusy, "baptism:setMode", undefined, { mode: m })}
              className={cn("px-2.5 py-1 text-caption1 transition-colors", state.mode === m ? "bg-accent text-white" : "text-fg-muted enabled:hover:bg-fill", "disabled:opacity-50")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          {/* Live readout — large and thumb-sized: this is what the operator
              touches during a live service. */}
          <div className="flex flex-col items-center gap-1 rounded-xl border border-line bg-surface-raised py-6">
            <span className={`text-caption1 font-medium uppercase tracking-wide ${phaseColor}`}>
              {readoutLabel}
            </span>
            <span className={`text-[3.5rem] leading-none font-bold tabular-nums ${clockColor}`}>
              {phase === "idle" ? (justFinished ? fmtClock(sum.totalMs) : "0:00") : fmtClock(liveMs)}
            </span>
            <span className="text-caption2 text-fg-subtle">
              {state.armed
                ? "waiting for the first person to step in"
                : phase === "baptism" && state.pendingTestimonyMs != null
                  ? `testimony ${fmtClock(state.pendingTestimonyMs)}`
                  : justFinished
                    ? `${sum.count} baptized · total time`
                    : " "}
            </span>
          </div>

          {/* Directly under the readout, because the readout above it says
              "Finished" either way. Not gated on the finished readout: Start
              and the workflow toggle carry the failure (see
              BaptismState.saveError), so it stays up until a save lands, Reset
              clears it, or the operator dismisses it here. Its own Dismiss
              because after the toggle the state holds nobody, and neither
              Reset nor Undo renders. No rebuild offer yet — nothing in the app
              replays a baptism session from its raw rows. */}
          {state.saveError && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger-9/40 bg-danger-9/10 px-3 py-2 text-footnote text-danger-11">
              <p className="flex-1">
                <span className="font-semibold">The last session did not save.</span> Finish could not write it to Past
                sessions ({state.saveError}). Its presses are still in the service&rsquo;s raw archive, baptism.csv, if a
                service was open while it ran.
              </p>
              <Button
                size="small"
                disabled={busy}
                onClick={() => void act(setBusy, "baptism:dismissSaveError")}
                className="shrink-0 text-danger-11 hover:bg-danger-9/15"
              >
                Dismiss
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="accent" disabled={busy} onClick={() => void act(setBusy, primaryChannel, primaryChannel === "baptism:finish" ? onFinished : undefined)} className="px-6 py-2 text-body">
              {primaryLabel}
            </Button>
            {phase !== "idle" && !state.armed && (
              <Button
                variant="filled"
                disabled={busy}
                onClick={() => void act(setBusy, paused ? "baptism:resume" : "baptism:pause")}
                tooltip={
                  paused
                    ? "Start the clock again from where it stopped"
                    : "Stop the clock — vows, prayer and talking between people should not land on someone's time"
                }
              >
                {paused ? <PlayIcon className="size-4 text-fg-muted" /> : <PauseIcon className="size-4 text-fg-muted" />}
                {paused ? "Resume" : "Pause"}
              </Button>
            )}
            {grouped && phase === "testimony" && (
              <Button variant="filled" disabled={busy} onClick={() => void act(setBusy, "baptism:startBaptisms")} tooltip="Done with testimonies — start timing baptisms">
                Start baptisms →
              </Button>
            )}
            {phase !== "idle" && primaryChannel !== "baptism:finish" && (
              <Button variant="filled" disabled={busy} onClick={() => void act(setBusy, "baptism:finish", onFinished)} tooltip="End the session and log it">
                <FlagIcon className="size-4 text-fg-muted" /> Finish
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(phase !== "idle" || justFinished) && (
              <Button variant="transparent" disabled={busy} onClick={() => void act(setBusy, "baptism:undo")} tooltip="Undo the last step">
                <Undo2Icon className="size-4 text-fg-muted" /> Undo
              </Button>
            )}
            {(state.people.length > 0 || phase !== "idle") && (
              <Button variant="transparent" disabled={busy} onClick={resetAll} tooltip="Clear the session">
                <RotateCcwIcon className="size-4 text-fg-muted" /> Reset
              </Button>
            )}
          </div>

          {state.autoStartedFrom && phase !== "idle" && (
            <div className="rounded-lg border border-line bg-fill px-3.5 py-2.5 text-caption2 text-fg-muted">
              Started automatically from &ldquo;{state.autoStartedFrom}&rdquo; — reset if that was wrong.
            </div>
          )}

          <span className="inline-flex items-center gap-1.5 text-caption2 text-fg-subtle">
            <DropletIcon className="size-3.5" /> Tip: leave this open during baptisms; the timer keeps running even if you navigate away.
          </span>
        </div>

        {/* The auto-start configuration for this plan — which item starts the
            testimonies, which one switches to the baptisms. Renders nothing
            (null) on a plan nobody has bound, which is most ordinary weekends;
            this column is then empty rather than missing, matching a week with
            genuinely nothing to configure. */}
        <BaptismTriggersPanel />
      </div>
    </div>
  );
}
