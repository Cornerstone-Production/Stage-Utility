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
  onChange,
}: {
  variants: PatchVariant[];
  assignments: PatchAssignments;
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
          <p className="text-caption2 text-fg-subtle">Each service type falls back to the Default patch unless a variant is assigned.</p>
        </div>
      </Collapsible>
    </div>
  );
}
