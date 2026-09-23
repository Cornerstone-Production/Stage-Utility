// people-table.tsx — one row per person timed in a session, at the rundown's
// own scale — 10px uppercase headers, 13px mono-tabular rows — plus a split
// bar showing how much of each person's time was testimony versus baptism.
//
// PeopleTable is the reusable half: any BaptismPerson[], live or archived.
// PeopleCard wraps it for the Baptisms tab's own card, reading the CURRENT
// (or just-finished) session's state.people. The read-only History card
// (service-history-section.tsx, via baptisms/session-chart.tsx's
// HistorySessionChart) renders PeopleTable directly, once per linked
// session, for exactly the per-person splits that page used to show and then
// lost — the same figures, the same row, never a forked copy of either.
//
// A grouped session's `people` fills during the TESTIMONY pass, before anyone
// is baptized — see summarizeBaptism's own doc comment. An entry with
// baptizeMs === 0 has not been baptized yet and MUST NOT print "0:00" under
// Baptism: that would claim a baptism took no time when none has happened yet.
// It prints a dash instead. The same check also covers a per-person session
// finished mid-baptism, which can leave the identical shape behind.
//
// NOT unit-tested: whether the split bar's width actually reads at a glance
// next to its neighbours — jsdom lays nothing out, so this only asserts the
// computed percentages landing in the `style` attribute, not pixels.

import type { ReactNode } from "react";

import { fmtBaptizeMs, fmtClock } from "../../../main/use-baptism-state";

/**
 * The table alone — no card shell, no "none yet" copy of its own. `null` for
 * an empty list rather than an empty `<table>`: a caller with its own idea of
 * what "nobody" means here (PeopleCard's live "press Start", a past session's
 * own wording) decides what to show instead.
 */
export function PeopleTable({ people }: { people: readonly BaptismPerson[] }) {
  if (people.length === 0) return null;
  const max = Math.max(1, ...people.map((p) => p.testimonyMs + p.baptizeMs));
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line text-left">
          <Th className="w-10">#</Th>
          <Th>Person</Th>
          <Th align="right">Testimony</Th>
          <Th align="right">Baptism</Th>
          <Th align="right">Total</Th>
          <Th className="w-36">Split</Th>
        </tr>
      </thead>
      <tbody>
        {people.map((p, i) => {
          const total = p.testimonyMs + p.baptizeMs;
          const width = (total / max) * 100;
          const testimonyPct = total ? (p.testimonyMs / total) * 100 : 0;
          const baptismPct = total ? (p.baptizeMs / total) * 100 : 0;
          const baptized = p.baptizeMs > 0;
          return (
            <tr key={i} className="border-b border-line text-footnote text-fg last:border-b-0">
              <td className="px-3 py-1.5 font-mono tabular-nums text-fg-subtle">{i + 1}</td>
              <td className="px-3 py-1.5">Person {i + 1}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-accent">{fmtClock(p.testimonyMs)}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-live-11">
                {/* fmtBaptizeMs decides the TEXT (shared with Copy report's
                    header.tsx, so the two can't disagree about the same
                    person); `baptized` only decides the dimmer colour
                    for the dash. */}
                {baptized ? fmtBaptizeMs(p.baptizeMs) : <span className="text-fg-subtle">{fmtBaptizeMs(p.baptizeMs)}</span>}
              </td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-fg">{fmtClock(total)}</td>
              <td className="px-3 py-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-fill" style={{ width: `${width}%` }}>
                  <div className="flex h-full">
                    <span data-split="testimony" className="h-full bg-accent" style={{ width: `${testimonyPct}%` }} />
                    <span data-split="baptism" className="h-full bg-live-9" style={{ width: `${baptismPct}%` }} />
                  </div>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface PeopleCardProps {
  state: BaptismState;
}

export function PeopleCard({ state }: PeopleCardProps) {
  const people = state.people;

  return (
    <section id="s-people" className="su-card flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold text-fg">People</h2>
        <span className="flex-1" />
        <span className="text-caption1 text-fg-subtle">{people.length ? `${people.length} timed` : "none yet"}</span>
      </div>
      {people.length === 0 ? (
        <p className="px-4 py-4 text-caption1 text-fg-muted">Nobody timed yet — press Start.</p>
      ) : (
        <PeopleTable people={people} />
      )}
    </section>
  );
}

function Th({ children, align, className }: { children: ReactNode; align?: "right"; className?: string }) {
  return (
    <th
      className={`px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle ${align === "right" ? "text-right" : ""} ${className ?? ""}`}
    >
      {children}
    </th>
  );
}
