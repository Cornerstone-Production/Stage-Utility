import { useEffect, useState } from "react";

import { invoke } from "../../lib/api";
import { Collapsible } from "../../components/ui";

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
  const [types, setTypes] = useState<ServiceTypeDTO[]>([]);
  useEffect(() => {
    invoke<ServiceTypeDTO[]>("stage:listServiceTypes")
      .then(setTypes)
      .catch(() => setTypes([]));
  }, []);

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
          {types.length === 0 ? (
            <p className="text-footnote text-fg-subtle">Connect Planning Center to assign a standing patch per service type.</p>
          ) : (
            types.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
                <span className="text-footnote text-fg">{t.name}</span>
                <select
                  value={assignments.byServiceType[t.id] ?? ""}
                  onChange={(e) => setStanding(t.id, e.target.value)}
                  className="h-7 rounded-md border border-line-strong bg-field px-2 text-footnote text-fg focus:outline-none focus:border-focus"
                >
                  <option value="">Default patch</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </div>
            ))
          )}
          {plan?.planId && (
            <div className="mt-1 flex flex-col gap-1 rounded-lg border border-line-strong bg-surface-raised px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-footnote font-medium text-fg">This week{plan.planTitle ? ` · ${plan.planTitle}` : ""}</span>
                <select
                  value={planEntry?.variantId ?? ""}
                  onChange={(e) => setPlanVariant(plan.planId!, e.target.value)}
                  className="h-7 rounded-md border border-line-strong bg-field px-2 text-footnote text-fg focus:outline-none focus:border-focus"
                >
                  <option value="">Use standing{standingForPlan ? ` — ${variants.find((v) => v.id === standingForPlan)?.name ?? "variant"}` : " — Default"}</option>
                  {variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
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
