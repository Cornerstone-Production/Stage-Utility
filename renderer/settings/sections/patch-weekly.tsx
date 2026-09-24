import { useEffect, useState } from "react";

import { invoke } from "../../lib/api";
import { useFailedReads } from "../../lib/use-failed-reads";
import { useResyncOn } from "../../lib/use-resync-on";
import { pcoConnected, useStageState } from "../../main/use-stage-state";
import { Collapsible, ErrorNote, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";

/**
 * Weekly assignment — pick a standing variant per PCO service type. The resolved
 * week patch (default → service-type variant → per-plan override → week tweaks) is
 * what the /patch volunteer view shows. Per-plan overrides land in a later increment.
 */
export function PatchWeekly({
  variants,
  assignments,
  plan,
  onChange,
}: {
  variants: PatchVariant[];
  assignments: PatchAssignments;
  plan: { serviceTypeId: string | null; planId: string | null; planTitle: string | null } | null;
  onChange: (a: PatchAssignments) => void;
}) {
  // Null until read, so "none" is never drawn for a list still on its way.
  const [types, setTypes] = useState<ServiceTypeDTO[] | null>(null);
  const stage = useStageState();
  // Only offer the service types enabled on the Plan tab (allowedServiceTypeIds).
  // Empty list = "all active", matching the Plan section's own filter.
  const allowed = stage.state?.allowedServiceTypeIds ?? [];
  // The service types come from Planning Center, so they are asked for only
  // once it is connected, and until then the panel says to connect it (see
  // pcoConnected).
  const pcoConfigured = pcoConnected(stage.state, stage.error);
  // Which read FAILED, as opposed to came back empty: a failed filter read is
  // not "the Plan tab enables every type", and a failed service-type read on a
  // connected server is not "connect Planning Center".
  const { failed, fail, clear } = useFailedReads<"types" | "allowed">("patch");
  // The filter is the stage state's. One that could not be read is said here,
  // on this panel's tag, and taken back when a state arrives.
  useEffect(() => {
    if (stage.state) clear("allowed");
    else if (stage.error) fail("allowed", "which service types the Plan tab enables", stage.error);
  }, [stage.state, stage.error, fail, clear]);
  // A read tried while the state was unknown may have failed only because
  // Planning Center is not connected; once the state says so, that is the panel.
  useResyncOn([pcoConfigured], () => {
    if (pcoConfigured === false) clear("types");
  });
  useEffect(() => {
    if (!pcoConfigured) return;
    let cancelled = false;
    invoke<ServiceTypeDTO[]>("stage:listServiceTypes")
      .then((t) => {
        if (cancelled) return;
        setTypes(t);
        clear("types");
      })
      .catch((err: unknown) => { if (!cancelled) fail("types", "the service types", err); });
    return () => {
      cancelled = true;
    };
  }, [pcoConfigured, fail, clear]);
  const visibleTypes = !types ? [] : allowed.length === 0 ? types : types.filter((t) => allowed.includes(t.id));

  function setStanding(stId: string, variantId: string) {
    const byServiceType = { ...assignments.byServiceType };
    if (variantId) byServiceType[stId] = variantId;
    else delete byServiceType[stId];
    onChange({ ...assignments, byServiceType });
  }

  // Per-plan override: set/clear the variant for this specific plan (keeps any
  // week tweaks already stored under it). Empty = fall back to the service-type.
  function setPlanVariant(planId: string, variantId: string) {
    const byPlan = { ...assignments.byPlan };
    const entry = { ...(byPlan[planId] ?? {}) };
    if (variantId) entry.variantId = variantId;
    else delete entry.variantId;
    if (Object.keys(entry).length) byPlan[planId] = entry;
    else delete byPlan[planId];
    onChange({ ...assignments, byPlan });
  }

  const standingForPlan = plan?.serviceTypeId ? assignments.byServiceType[plan.serviceTypeId] : undefined;
  const planEntry = plan?.planId ? assignments.byPlan[plan.planId] : undefined;
  const setCount = Object.keys(assignments.byServiceType).length;

  return (
    <div className="rounded-xl border border-line bg-surface">
      <Collapsible label="Weekly assignment" summary={`${setCount} set`} headerClassName="px-4 py-2.5">
        <div className="flex flex-col gap-2 px-3 pb-3">
          {failed.has("allowed") && types && types.length > 0 && (
            // The unfiltered list is still the useful thing to show: every
            // assignment in it is real, there are just more rows than the Plan
            // tab would offer.
            <ErrorNote>Couldn't load which service types the Plan tab enables, so all of them are listed.</ErrorNote>
          )}
          {pcoConfigured === false ? (
            <p className="text-footnote text-fg-subtle">Connect Planning Center to assign a standing patch per service type.</p>
          ) : failed.has("types") ? (
            <ErrorNote>Couldn't load the service types.</ErrorNote>
          ) : !types ? (
            <p className="text-footnote text-fg-subtle">Loading service types…</p>
          ) : visibleTypes.length === 0 ? (
            <p className="text-footnote text-fg-subtle">No service types to assign.</p>
          ) : (
            visibleTypes.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
                <span className="text-footnote text-fg">{t.name}</span>
                <Select value={assignments.byServiceType[t.id] ?? ""} onValueChange={(v) => setStanding(t.id, v)}>
                  <SelectTrigger className="px-2"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Default patch</SelectItem>
                    {variants.map((v) => (
                      <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))
          )}
          {plan?.planId && (
            <div className="mt-1 flex flex-col gap-1 rounded-lg border border-line-strong bg-surface-raised px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-footnote font-medium text-fg">This week{plan.planTitle ? ` · ${plan.planTitle}` : ""}</span>
                {/* The per-plan override is the one assignment no delete path
                    cleans up: removing a variant clears it from byServiceType and
                    leaves byPlan pointing at it. The Select keeps that id visible
                    rather than reading as "Use standing". */}
                <Select value={planEntry?.variantId ?? ""} onValueChange={(v) => setPlanVariant(plan.planId!, v)}>
                  <SelectTrigger className="px-2"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Use standing{standingForPlan ? ` — ${variants.find((v) => v.id === standingForPlan)?.name ?? "variant"}` : " — Default"}</SelectItem>
                    {variants.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {planEntry?.tweaks && Object.keys(planEntry.tweaks).length > 0 && (
                <span className="text-caption2 text-fg-subtle">{Object.keys(planEntry.tweaks).length} one-off tweak{Object.keys(planEntry.tweaks).length === 1 ? "" : "s"} this week — edit via the “This week” target above the table.</span>
              )}
            </div>
          )}
          <p className="text-caption2 text-fg-subtle">Each service type falls back to the Default patch unless a variant is assigned; a specific week can override that.</p>
        </div>
      </Collapsible>
    </div>
  );
}
