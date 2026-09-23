import { useCallback, useEffect, useState } from "react";

import { errorMessage } from "@main/services/errors";
import { invoke } from "../lib/api";
import { logToServer } from "../lib/client-log";
import { toast } from "../components/ui";
import { useBaptismState } from "./use-baptism-state";
import { BaptismHeader } from "../settings/sections/baptisms/header";
import { SessionChart } from "../settings/sections/baptisms/session-chart";
import { TimerCard } from "../settings/sections/baptisms/timer-card";
import { PeopleCard } from "../settings/sections/baptisms/people-table";
import { PastSessionsCard } from "../settings/sections/baptisms/past-sessions";
import { TrendsCard } from "../settings/sections/baptisms/trends-card";
import type { StatFigure } from "../settings/sections/history-chart";

/**
 * Baptisms — an operator stopwatch for baptism services. Each person has a
 * testimony then a baptism; the panel times the current segment, logs each
 * person's splits, and shows running totals + averages. Drives the shared
 * baptism-timer service, so every surface that renders this controls the SAME
 * live session — they stay in sync via the "baptism:state" SSE channel. Also
 * surfaced read-only on a display via the "Baptism timer" layout object.
 *
 * The page shell (BaptismHeader: title, recording pill, service sub-line,
 * actions, stat strip, section nav), the Timer card and the Session chart live
 * in ../settings/sections/baptisms/ — reusing the History module's StatStrip,
 * RecordingPill, lane geometry and section-nav pattern rather than bespoke ones
 * for one more page. This component composes them, and lifts the Session
 * chart's hover up into the header's own strip: the two are siblings here, not
 * parent and child, so hovering a segment has to travel back up through this
 * component to reach the strip it replaces.
 *
 * The People, Past sessions and Trends cards live beside the Timer and
 * Session cards in the same module, and replace the inline per-person log
 * and expandable past-sessions list this component used to carry directly —
 * see git history for the shape they superseded. `sessions` and its load
 * failure are still owned here rather than in either card, because BOTH Past
 * sessions and Trends read the identical fetch and must agree about whether it
 * failed.
 */
export function BaptismOperator() {
  const state = useBaptismState();
  const [sessions, setSessions] = useState<BaptismSession[]>([]);
  const [sessionsError, setSessionsError] = useState(false);
  const [hoverFigures, setHoverFigures] = useState<StatFigure[] | null>(null);

  const reloadSessions = useCallback(() => {
    invoke<BaptismSession[]>("baptism:sessions")
      .then((list) => {
        setSessions(list);
        setSessionsError(false);
      })
      .catch((err: unknown) => {
        // Distinct from "sessions: []", which is what zero recorded sessions
        // actually looks like — a network blip must not read as an empty
        // list to either the Past sessions or the Trends card.
        setSessionsError(true);
        logToServer("baptism", `could not load past sessions: ${errorMessage(err)}`);
      });
  }, []);

  useEffect(() => {
    reloadSessions();
  }, [reloadSessions]);

  async function deleteSession(id: string) {
    const previous = sessions;
    setSessions((cur) => cur.filter((s) => s.id !== id));
    try {
      await invoke("baptism:deleteSession", { id });
    } catch (err) {
      // Roll back the optimistic removal rather than leave the operator
      // believing a delete that never reached the server.
      setSessions(previous);
      toast.error(`Couldn't delete that session: ${errorMessage(err)}`);
      logToServer("baptism", `delete session ${id} failed: ${errorMessage(err)}`);
    }
  }

  if (!state) {
    return <p className="text-caption1 text-fg-muted py-6">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <BaptismHeader state={state} hoverFigures={hoverFigures} sessions={sessions} onRebuilt={reloadSessions} />
      <TimerCard state={state} onFinished={reloadSessions} />
      <SessionChart state={state} onHover={setHoverFigures} />
      <PeopleCard state={state} />
      <PastSessionsCard sessions={sessions} loadError={sessionsError} onDelete={(id) => void deleteSession(id)} />
      <TrendsCard sessions={sessions} loadError={sessionsError} />
    </div>
  );
}
