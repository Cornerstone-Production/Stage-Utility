import { useEffect, useState } from "react";
import { DropletIcon, RotateCcwIcon, Undo2Icon, FlagIcon, Trash2Icon, ChevronRightIcon } from "lucide-react";

import { invoke } from "../lib/api";
import { Button, confirm, toast } from "../components/ui";
import { cn } from "../lib/cn";
import { useBaptismState, summarizeBaptism, fmtClock } from "./use-baptism-state";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Baptisms — an operator stopwatch for baptism services. Each person has a
 * testimony then a baptism; the panel times the current segment, logs each
 * person's splits, and shows running totals + averages. Drives the shared
 * baptism-timer service, so every surface that renders this (the Settings
 * "Baptisms" tab AND the standalone /baptism kiosk page) controls the SAME live
 * session — they stay in sync via the "baptism:state" SSE channel. Also surfaced
 * read-only on a display via the "Baptism timer" layout object.
 */
export function BaptismOperator() {
  const state = useBaptismState();
  const [now, setNow] = useState(() => Date.now());
  const [sessions, setSessions] = useState<BaptismSession[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reloadSessions() {
    invoke<BaptismSession[]>("baptism:sessions").then(setSessions).catch(() => setSessions([]));
  }
  useEffect(() => {
    reloadSessions();
  }, []);

  // Tick the live segment clock while a segment is running.
  const segStart = state?.segmentStartedAt ?? null;
  useEffect(() => {
    if (!segStart) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [segStart]);

  async function act(channel: string, after?: () => void, payload?: Record<string, unknown>) {
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

  if (!state) {
    return <p className="text-caption1 text-gray-9 py-6">Loading…</p>;
  }

  const phase = state.phase;
  const liveMs = segStart ? Math.max(0, now - Date.parse(segStart)) : 0;
  const sum = summarizeBaptism(state);
  const justFinished = phase === "idle" && state.finishedAt != null && state.people.length > 0;

  const grouped = state.mode === "grouped";
  const lastBaptism = grouped && phase === "baptism" && state.baptismIndex >= state.people.length - 1;
  const phaseColor = phase === "testimony" ? "text-blue-11" : phase === "baptism" ? "text-green-11" : "text-gray-11";

  // Phase-aware primary action (label + channel), per workflow.
  let primaryLabel: string;
  let primaryChannel: string;
  if (phase === "idle") {
    primaryLabel = grouped ? "Start testimonies" : "Start";
    primaryChannel = "baptism:start";
  } else if (phase === "testimony") {
    primaryLabel = grouped ? "Next testimony" : "Mark baptized";
    primaryChannel = grouped ? "baptism:next" : "baptism:baptized";
  } else {
    // baptism
    if (grouped) {
      primaryLabel = lastBaptism ? "Finish baptisms" : "Next baptism";
      primaryChannel = lastBaptism ? "baptism:finish" : "baptism:next";
    } else {
      primaryLabel = "Next person";
      primaryChannel = "baptism:next";
    }
  }

  // Readout heading.
  let readoutLabel: string;
  if (phase === "idle") readoutLabel = justFinished ? "Finished" : "Ready";
  else if (grouped && phase === "testimony") readoutLabel = `Testimony · Person ${state.personNumber}`;
  else if (grouped && phase === "baptism") readoutLabel = `Baptism · Person ${state.baptismIndex + 1} of ${state.people.length}`;
  else readoutLabel = `Person ${state.personNumber} · ${phase === "testimony" ? "Testimony" : "Baptism"}`;

  async function resetAll() {
    if (!(await confirm({ title: "Reset baptism timer?", message: "Clear the current session and all splits. This can't be undone.", confirmLabel: "Reset", destructive: true }))) return;
    void act("baptism:reset");
  }
  async function deleteSession(id: string) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    try {
      await invoke("baptism:deleteSession", { id });
    } catch {
      reloadSessions();
    }
  }

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <div className="flex flex-col gap-1">
        <span className="text-title3 font-semibold text-gray-12">Baptism timer</span>
        <span className="text-caption1 text-gray-9">Time testimonies and baptisms. Splits, totals and averages are tracked live and can be shown on a display with the &ldquo;Baptism timer&rdquo; layout object.</span>
      </div>

      {/* Workflow mode */}
      <div className="flex items-center gap-2">
        <span className="text-caption1 text-gray-9">Workflow</span>
        <div className="inline-flex rounded-md border border-gray-5 overflow-hidden">
          {([["per-person", "Per person"], ["grouped", "Grouped"]] as const).map(([m, label]) => (
            <button
              key={m}
              disabled={busy || phase !== "idle"}
              onClick={() => void act("baptism:setMode", undefined, { mode: m })}
              className={cn("px-2.5 py-1 text-caption1 transition-colors", state.mode === m ? "bg-blue-9 text-fg" : "text-gray-11 enabled:hover:bg-gray-3", "disabled:opacity-50")}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-caption2 text-gray-8">
          {grouped ? "all testimonies, then all baptisms" : "each person: testimony then baptism"}
          {phase !== "idle" && " · finish or reset to switch"}
        </span>
      </div>

      {/* Live readout */}
      <div className="flex flex-col items-center gap-1 rounded-xl border border-gray-5 bg-gray-2 py-6">
        <span className={`text-caption1 font-medium uppercase tracking-wide ${phaseColor}`}>
          {readoutLabel}
        </span>
        <span className="text-[3.5rem] leading-none font-bold tabular-nums text-gray-12">
          {phase === "idle" ? (justFinished ? fmtClock(sum.totalMs) : "0:00") : fmtClock(liveMs)}
        </span>
        <span className="text-caption2 text-gray-9">
          {phase === "baptism" && state.pendingTestimonyMs != null ? `testimony ${fmtClock(state.pendingTestimonyMs)}` : justFinished ? `${sum.count} baptized · total time` : " "}
        </span>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="accent" disabled={busy} onClick={() => void act(primaryChannel, primaryChannel === "baptism:finish" ? reloadSessions : undefined)} className="px-6 py-2 text-body">
          {primaryLabel}
        </Button>
        {grouped && phase === "testimony" && (
          <Button variant="filled" disabled={busy} onClick={() => void act("baptism:startBaptisms")} tooltip="Done with testimonies — start timing baptisms">
            Start baptisms →
          </Button>
        )}
        {phase !== "idle" && primaryChannel !== "baptism:finish" && (
          <Button variant="filled" disabled={busy} onClick={() => void act("baptism:finish", reloadSessions)} tooltip="End the session and log it">
            <FlagIcon className="size-4 text-gray-9" /> Finish
          </Button>
        )}
        {(phase !== "idle" || justFinished) && (
          <Button variant="transparent" disabled={busy} onClick={() => void act("baptism:undo")} tooltip="Undo the last step">
            <Undo2Icon className="size-4 text-gray-9" /> Undo
          </Button>
        )}
        {(state.people.length > 0 || phase !== "idle") && (
          <Button variant="transparent" disabled={busy} onClick={resetAll} tooltip="Clear the session">
            <RotateCcwIcon className="size-4 text-gray-9" /> Reset
          </Button>
        )}
      </div>

      {/* Totals */}
      {sum.count > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Baptized" value={String(sum.count)} />
          <Stat label="Total time" value={fmtClock(sum.totalMs)} />
          <Stat label="Avg testimony" value={fmtClock(sum.avgTestimonyMs)} accent="text-blue-11" />
          <Stat label="Avg baptism" value={fmtClock(sum.avgBaptizeMs)} accent="text-green-11" />
        </div>
      )}

      {/* Per-person log */}
      {state.people.length > 0 && (
        <div className="flex flex-col rounded-lg border border-gray-5 overflow-hidden">
          <div className="grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem] gap-2 px-3 py-1.5 bg-gray-3 text-caption2 font-medium text-gray-10">
            <span>#</span><span>Person</span><span className="text-right">Testimony</span><span className="text-right">Baptism</span><span className="text-right">Total</span>
          </div>
          {state.people.map((p, i) => (
            <div key={i} className={`grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem] gap-2 px-3 py-1.5 text-caption1 tabular-nums ${i % 2 ? "bg-gray-2" : "bg-gray-1"}`}>
              <span className="text-gray-9">{i + 1}</span>
              <span className="text-gray-12">Person {i + 1}</span>
              <span className="text-right text-blue-11">{fmtClock(p.testimonyMs)}</span>
              <span className="text-right text-green-11">{fmtClock(p.baptizeMs)}</span>
              <span className="text-right text-gray-12">{fmtClock(p.testimonyMs + p.baptizeMs)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Past sessions — click a row to see its per-person splits + averages. */}
      {sessions.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-caption1 font-medium text-gray-11">Past sessions</span>
          {sessions.map((s) => (
            <PastSession
              key={s.id}
              s={s}
              open={openId === s.id}
              onToggle={() => setOpenId((id) => (id === s.id ? null : s.id))}
              onDelete={() => void deleteSession(s.id)}
            />
          ))}
        </div>
      )}

      <span className="inline-flex items-center gap-1.5 text-caption2 text-gray-8"><DropletIcon className="size-3.5" /> Tip: leave this open during baptisms; the timer keeps running even if you navigate away.</span>
    </div>
  );
}

/** One past session row — collapsed shows date + count + total; expanded shows
 *  per-person testimony/baptism splits and the session averages. */
function PastSession({ s, open, onToggle, onDelete }: { s: BaptismSession; open: boolean; onToggle: () => void; onDelete: () => void }) {
  const n = s.people.length;
  const totT = s.people.reduce((a, p) => a + p.testimonyMs, 0);
  const totB = s.people.reduce((a, p) => a + p.baptizeMs, 0);
  const tot = totT + totB;
  return (
    <div className="flex flex-col rounded-lg border border-gray-5 bg-gray-2 overflow-hidden">
      <div className="flex items-center gap-1 pr-1.5">
        <button className="flex flex-1 min-w-0 items-center justify-between gap-3 px-3 py-2 text-left" onClick={onToggle} aria-expanded={open}>
          <span className="flex items-center gap-1.5 min-w-0">
            <ChevronRightIcon className={cn("size-3.5 text-gray-9 shrink-0 transition-transform", open && "rotate-90")} />
            <span className="text-caption1 text-gray-12 truncate">{s.title ? `${s.title} · ${fmtDate(s.startedAt)}` : fmtDate(s.startedAt)}</span>
          </span>
          <span className="shrink-0 tabular-nums text-caption1 text-gray-9">{n} baptized · {fmtClock(tot)}</span>
        </button>
        <button className="shrink-0 rounded-md p-2 text-gray-9 hover:bg-gray-4 hover:text-red-11 transition-colors" onClick={onDelete} aria-label="Delete session" title="Delete session">
          <Trash2Icon className="size-4" />
        </button>
      </div>
      {open && (
        <div className="border-t border-gray-5">
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-caption2 text-gray-9 tabular-nums">
            <span>Avg testimony <span className="text-blue-11">{fmtClock(n ? totT / n : 0)}</span></span>
            <span>Avg baptism <span className="text-green-11">{fmtClock(n ? totB / n : 0)}</span></span>
            <span>Avg / person <span className="text-gray-12">{fmtClock(n ? tot / n : 0)}</span></span>
          </div>
          <div className="grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem] gap-2 px-3 py-1 bg-gray-3 text-caption2 font-medium text-gray-10">
            <span>#</span><span>Person</span><span className="text-right">Testimony</span><span className="text-right">Baptism</span><span className="text-right">Total</span>
          </div>
          {s.people.map((p, i) => (
            <div key={i} className={`grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem] gap-2 px-3 py-1.5 text-caption1 tabular-nums ${i % 2 ? "bg-gray-2" : "bg-gray-1"}`}>
              <span className="text-gray-9">{i + 1}</span>
              <span className="text-gray-12">Person {i + 1}</span>
              <span className="text-right text-blue-11">{fmtClock(p.testimonyMs)}</span>
              <span className="text-right text-green-11">{fmtClock(p.baptizeMs)}</span>
              <span className="text-right text-gray-12">{fmtClock(p.testimonyMs + p.baptizeMs)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent = "text-gray-12" }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-gray-5 bg-gray-2 px-3 py-2">
      <div className="text-caption2 text-gray-9">{label}</div>
      <div className={`text-title3 font-semibold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}
