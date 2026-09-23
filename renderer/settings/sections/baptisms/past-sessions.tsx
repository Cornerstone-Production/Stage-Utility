// past-sessions.tsx — the Baptisms tab's Past sessions card: History's own
// list-row shape, one row per FINISHED session, each linking to that
// service's History page.
//
// Supersedes baptism-operator.tsx's old expandable list. That list's own
// expand arrow showed a finished session's per-person splits; this card does
// not reproduce that view — the mockup does not show one either, and the
// richer replacement (the SAME lane and table Session renders, read-only, on
// History's own Baptisms card) is PR 3's Task 18, which reuses the spans this
// PR's Session card already draws rather than a second copy (see progress.md's
// Ruling 38, T9|T18). Nothing recorded is lost: every person's split is still
// on the session, Copy report and the CSV export both still carry it, and a
// keyed session's cross-link lands on the right service today even before
// PR 3 richens what is there. Only the per-person VIEW of a past session is a
// PR 3 stop rather than an expand arrow here — the same kind of interim gap
// Ruling 39 already accepted for the header's Rebuild action.
//
// Counts and averages come from baptismStats, applied to ONE session at a
// time — never s.people.length, which would count a grouped session's
// mid-testimony entries as baptized. See link-baptisms.ts's own doc comment.

import { Trash2Icon } from "lucide-react";

import { AppLink } from "../../../app/app-link";
import { confirm } from "../../../components/ui";
import { Tooltip } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/cn";
import { baptismStats } from "../../../lib/link-baptisms";
import { fmtClock, fmtDate } from "../../../main/use-baptism-state";
import { historyServiceHref } from "../service-history-section";

export interface PastSessionsCardProps {
  sessions: readonly BaptismSession[];
  /** The list failed to load — distinct from "sessions: []", which is what
   *  zero recorded sessions actually looks like. See baptism-operator.tsx. */
  loadError: boolean;
  onDelete: (id: string) => void;
}

export function PastSessionsCard({ sessions, loadError, onDelete }: PastSessionsCardProps) {
  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete this session?",
      message: "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) onDelete(id);
  }

  return (
    <section id="s-past" className="su-card flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold text-fg">Past sessions</h2>
      </div>
      {loadError ? (
        <p role="alert" className="px-4 py-4 text-caption1 text-danger-11">
          Past sessions could not be loaded — see the server log.
        </p>
      ) : sessions.length === 0 ? (
        <p className="px-4 py-4 text-caption1 text-fg-muted">No finished sessions yet.</p>
      ) : (
        <div className="flex flex-col">
          {sessions.map((s) => {
            const stats = baptismStats([s]);
            return (
              <div key={s.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-footnote font-medium text-fg">{s.title ?? "Baptisms"}</span>
                  <span className="truncate text-caption2 text-fg-subtle">
                    {fmtDate(s.startedAt)}
                    {s.serviceKey && (
                      <>
                        {" · "}
                        <AppLink to={historyServiceHref(s.serviceKey)} className="text-accent hover:underline">
                          open in History →
                        </AppLink>
                      </>
                    )}
                  </span>
                </div>
                <RowFigure label="Baptized" value={String(stats.people)} className="flex flex-col" />
                <RowFigure label="Avg testimony" value={fmtClock(stats.avgTestimonySec * 1000)} className="hidden flex-col sm:flex" />
                <RowFigure label="Avg baptism" value={fmtClock(stats.avgBaptismSec * 1000)} className="hidden flex-col sm:flex" />
                <RowFigure label="Total" value={fmtClock(stats.totalSec * 1000)} className="flex flex-col" />
                <Tooltip label="Delete session">
                  <button
                    className="shrink-0 rounded-md p-2 text-fg-subtle transition-colors hover:bg-fill hover:text-danger-11"
                    onClick={() => void handleDelete(s.id)}
                    aria-label="Delete session"
                  >
                    <Trash2Icon className="size-4" />
                  </button>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RowFigure({ label, value, className }: { label: string; value: string; className: string }) {
  return (
    <div className={cn("shrink-0 items-end", className)}>
      <span className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</span>
      <span className="font-mono text-footnote tabular-nums text-fg">{value}</span>
    </div>
  );
}
