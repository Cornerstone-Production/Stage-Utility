// stageplots-this-week-card.tsx — the editor's This week card: which plot the
// selected venue shows for the live or next plan, the upcoming plans that have
// a plot of their own, and a way to give another upcoming plan one. Each
// change saves at once (PUT /api/stageplots/overrides) and every open
// /stageplots follows it.
//
// The plan is the one /stageplots follows (useCurrentPlan: the stage state's
// live or next plan), handed in by the editor with the names it gives plans,
// so the card and the plot delete confirm name them the same way. Other plans
// come from the upcoming-plans list the slot editor's plan switcher walks, the
// only plan list the app keeps; the patch sheet's Weekly assignment card
// offers the live plan alone. Dates are the plan's, on the app's calendar;
// "upcoming" is looked at again every minute, so a card left open overnight
// drops yesterday's plans.

import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";

import type { StagePlotsView, Venue } from "@main/types/stageplots";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";
import { plotsOf } from "../../main/stageplots/doc-helpers";
import { Mono } from "../../main/stageplots/mono";
import { isUpcoming, type CurrentPlan } from "../../main/stageplots/plan-following";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { CardHeader, SaveError, eyebrow, iconButton, type Save } from "./stageplots-shared";

/** Now, to the minute: what "upcoming" is measured against. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** A row of the overrides list: date, plot, and its control. */
const ROW = "grid min-h-7 grid-cols-[minmax(86px,auto)_minmax(0,1fr)_24px] items-center gap-1.5 border-t border-line text-caption1 first:border-t-0";

export function ThisWeekCard({
  doc,
  venue,
  plan,
  nameOf,
  save,
}: {
  doc: StagePlotsView;
  venue: Venue;
  plan: CurrentPlan;
  /** A plan's name: its date, with the time where two plans share a day. */
  nameOf: (p: { planId: string; planDate?: string | null }) => string;
  save: Save;
}) {
  const { connected, plans } = plan;
  const [error, setError] = useState<string | null>(null);
  /** The upcoming plan being given a plot, before its plot is chosen. */
  const [adding, setAdding] = useState<string | null>(null);
  const now = useMinuteNow();

  const plots = plotsOf(doc, venue);
  if (plots.length === 0) return null;
  const defaultPlot = plots.find((p) => p.id === venue.defaultPlotId) ?? null;
  const mine = doc.overrides.filter((o) => o.venueId === venue.id);
  const listed = (planId: string) => plans.find((p) => p.planId === planId);
  /** The plots a plan can be given: every plot but the default, which "Default" stands for. */
  const choices = (current: string | null) => plots.filter((p) => p.id !== venue.defaultPlotId || p.id === current);

  const set = async (planId: string, plotId: string | null, planDate: string | null) => {
    const r = await save(() => stageplotsApi.setOverride(planId, venue.id, plotId, planDate));
    setError(r.ok ? null : r.error);
    return r.ok;
  };

  const current = plan.planId ? (mine.find((o) => o.planId === plan.planId) ?? null) : null;
  const day = plan.planId && plan.planDate ? nameOf({ planId: plan.planId, planDate: plan.planDate }) : plan.label;

  const upcoming = mine
    .filter((o) => o.planId !== plan.planId)
    .map((o) => ({ o, date: o.planDate ?? listed(o.planId)?.sortDate ?? null, name: nameOf(o) }))
    // A dated override is upcoming from its day on; an undated one only while
    // the upcoming list still carries its plan.
    .filter(({ o, date }) => (date ? isUpcoming(date, now, plan.timeZone) : !!listed(o.planId)))
    .sort((a, b) => (a.date ?? "\uffff").localeCompare(b.date ?? "\uffff"));
  // The list also carries the last few days' plans, for the slot editor: only
  // what is still to come is offered here.
  const candidates = plans.filter(
    (p) => p.planId !== plan.planId && !mine.some((o) => o.planId === p.planId) && (!p.sortDate || isUpcoming(p.sortDate, now, plan.timeZone)),
  );
  const addingPlan = adding ? (listed(adding) ?? null) : null;

  return (
    <section className="su-card flex flex-col gap-2.5 px-3.5 py-3" aria-label="This week">
      <CardHeader title="This week" />
      <SaveError message={error} />
      {!connected ? (
        <p className="text-caption1 text-fg-subtle">Connect Planning Center to give a plan its own plot.</p>
      ) : !plan.planId ? (
        <p className="text-caption1 text-fg-subtle">No plan is live or coming up.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className={eyebrow}>
            <Mono text={day ? `Plan · ${day}` : "Plan"} />
          </span>
          <Select value={current?.plotId ?? ""} onValueChange={(v) => void set(plan.planId!, v || null, plan.planDate)}>
            <SelectTrigger aria-label="Plot for this plan" className="w-full" />
            <SelectContent>
              <SelectItem value="">{defaultPlot ? `Default (${defaultPlot.name})` : "Default"}</SelectItem>
              {choices(current?.plotId ?? null).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-caption1 text-fg-subtle">For {venue.name} only. /stageplots shows it for this plan, then goes back to the default.</p>
        </div>
      )}
      <span className={eyebrow}>Upcoming plans with an override</span>
      {upcoming.length === 0 && !addingPlan ? (
        <p className="-mt-1.5 text-caption1 text-fg-subtle">None.</p>
      ) : (
        <ul className="flex flex-col" aria-label="Upcoming plans with an override">
          {upcoming.map(({ o, name }) => (
            <li key={o.planId} className={ROW}>
              <span className="whitespace-nowrap text-fg-muted">
                <Mono text={name} />
              </span>
              <span className="truncate text-fg">{plots.find((p) => p.id === o.plotId)?.name ?? "?"}</span>
              <button
                type="button"
                className={`${iconButton} size-6`}
                title="Use the default"
                aria-label={`Use the default for ${name}`}
                onClick={() => void set(o.planId, null, null)}
              >
                <XIcon className="size-3.5" />
              </button>
            </li>
          ))}
          {addingPlan && (
            <li className={ROW}>
              <span className="whitespace-nowrap text-fg-muted">
                <Mono text={nameOf({ planId: addingPlan.planId })} />
              </span>
              <Select
                value=""
                onValueChange={(v) => {
                  if (!v) return;
                  void set(addingPlan.planId, v, addingPlan.sortDate).then((ok) => ok && setAdding(null));
                }}
              >
                <SelectTrigger aria-label="Plot for the plan being added" className="h-6 w-full px-1.5 text-caption1">
                  <SelectValue placeholder="Choose a plot" />
                </SelectTrigger>
                <SelectContent>
                  {choices(null).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button type="button" className={`${iconButton} size-6`} title="Cancel" aria-label="Cancel adding a plan" onClick={() => setAdding(null)}>
                <XIcon className="size-3.5" />
              </button>
            </li>
          )}
        </ul>
      )}
      {connected && plan.listProblem && <p className="text-caption1 text-fg-subtle">Planning Center is unreachable; other plans can&apos;t be listed.</p>}
      {connected && !plan.listProblem && !addingPlan && candidates.length > 0 && choices(null).length > 0 && (
        <Select value="" onValueChange={(v) => v && setAdding(v)}>
          <SelectTrigger aria-label="Give another plan its own plot" className="w-full text-fg-muted">
            <SelectValue placeholder="Another plan…" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((p) => (
              <SelectItem key={p.planId} value={p.planId}>
                {`${nameOf({ planId: p.planId })} · ${p.serviceTypeName}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </section>
  );
}
