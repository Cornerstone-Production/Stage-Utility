import { useEffect, useState } from "react";
import { Tooltip } from "../components/ui/tooltip";
import { Trash2Icon, ChevronRightIcon } from "lucide-react";

import { invoke } from "../lib/api";
import { cn } from "../lib/cn";
import { useBaptismState, fmtClock, fmtDate } from "./use-baptism-state";
import { BaptismHeader } from "../settings/sections/baptisms/header";
import { TimerCard } from "../settings/sections/baptisms/timer-card";

/**
 * Baptisms — an operator stopwatch for baptism services. Each person has a
 * testimony then a baptism; the panel times the current segment, logs each
 * person's splits, and shows running totals + averages. Drives the shared
 * baptism-timer service, so every surface that renders this controls the SAME
 * live session — they stay in sync via the "baptism:state" SSE channel. Also
 * surfaced read-only on a display via the "Baptism timer" layout object.
 *
 * The page shell (BaptismHeader: title, recording pill, service sub-line,
 * actions, stat strip, section nav) and the Timer card live in
 * ../settings/sections/baptisms/ — reusing the History module's StatStrip,
 * RecordingPill and section-nav pattern rather than a bespoke header for one
 * more page. This component composes them and keeps two sections that predate
 * that shell: the per-person log and the past-sessions list. Both are
 * SUPERSEDED by later tasks in this same PR (People and Past sessions cards) —
 * they stay here, working exactly as before, until those land.
 */
export function BaptismOperator() {
  const state = useBaptismState();
  const [sessions, setSessions] = useState<BaptismSession[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  function reloadSessions() {
    invoke<BaptismSession[]>("baptism:sessions").then(setSessions).catch(() => setSessions([]));
  }
  useEffect(() => {
    reloadSessions();
  }, []);

  async function deleteSession(id: string) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    try {
      await invoke("baptism:deleteSession", { id });
    } catch {
      reloadSessions();
    }
  }

  if (!state) {
    return <p className="text-caption1 text-gray-9 py-6">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <BaptismHeader state={state} />
      <TimerCard state={state} onFinished={reloadSessions} />

      {/* Per-person log — superseded by the People card, Task 13. */}
      {state.people.length > 0 && (
        <div className="flex flex-col rounded-lg border border-gray-5 overflow-hidden">
          <div className="grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem] gap-2 px-3 py-1.5 bg-gray-3 text-caption2 font-medium text-gray-10">
            <span>#</span><span>Person</span><span className="text-right">Testimony</span><span className="text-right">Baptism</span><span className="text-right">Total</span>
          </div>
          {state.people.map((p, i) => (
            <div key={i} className={`grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem] gap-2 px-3 py-1.5 text-caption1 tabular-nums ${i % 2 ? "bg-gray-2" : "bg-gray-1"}`}>
              <span className="text-gray-9">{i + 1}</span>
              <span className="text-gray-12">Person {i + 1}</span>
              <span className="text-right text-accent">{fmtClock(p.testimonyMs)}</span>
              <span className="text-right text-green-11">{fmtClock(p.baptizeMs)}</span>
              <span className="text-right text-gray-12">{fmtClock(p.testimonyMs + p.baptizeMs)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Past sessions — superseded by the Past sessions card, Task 13. Click a
          row to see its per-person splits + averages. */}
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
        <Tooltip label="Delete session">
          <button className="touch-target shrink-0 rounded-md p-2 text-gray-9 hover:bg-gray-4 hover:text-red-11 transition-colors" onClick={onDelete} aria-label="Delete session">
            <Trash2Icon className="size-4" />
          </button>
        </Tooltip>
      </div>
      {open && (
        <div className="border-t border-gray-5">
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-caption2 text-gray-9 tabular-nums">
            <span>Avg testimony <span className="text-accent">{fmtClock(n ? totT / n : 0)}</span></span>
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
              <span className="text-right text-accent">{fmtClock(p.testimonyMs)}</span>
              <span className="text-right text-green-11">{fmtClock(p.baptizeMs)}</span>
              <span className="text-right text-gray-12">{fmtClock(p.testimonyMs + p.baptizeMs)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
