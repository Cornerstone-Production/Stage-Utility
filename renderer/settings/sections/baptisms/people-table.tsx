// people-table.tsx — the Baptisms tab's People card: one row per person timed
// in the CURRENT (or just-finished) session, at the rundown's own scale — 10px
// uppercase headers, 13px mono-tabular rows — plus a split bar showing how
// much of each person's time was testimony versus baptism.
//
// Supersedes baptism-operator.tsx's old inline per-person log. Past sessions
// get their own summary in past-sessions.tsx; this card only ever reads the
// LIVE session's state.people, which is why it takes BaptismState directly
// rather than a session id.
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

export interface PeopleCardProps {
  state: BaptismState;
}

export function PeopleCard({ state }: PeopleCardProps) {
  const people = state.people;
  const max = Math.max(1, ...people.map((p) => p.testimonyMs + p.baptizeMs));

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
