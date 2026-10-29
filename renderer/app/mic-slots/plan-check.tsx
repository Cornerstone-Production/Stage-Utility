// This plan's check, under the boards: what the saved layouts leave wrong for the
// plan being edited. Read from the server (GET /api/boards/check), which reads
// every board at the target the way a screen showing it would.

import { useQuery } from "@tanstack/react-query";

import { Button, ErrorNote } from "../../components/ui";
import { invoke as ipc } from "../../lib/api";
import { plural } from "@main/services/plural";
import { checkKey, type MicSlots } from "./use-mic-slots";

export function PlanCheck({ mic }: { mic: MicSlots }) {
  const { serviceTypeId, planId } = mic.editing.target;
  const q = useQuery({
    queryKey: checkKey(serviceTypeId, planId),
    queryFn: () => ipc<BoardCheckDTO>("boards:check", { serviceTypeId, planId }),
    enabled: !!serviceTypeId && mic.boards.length > 0,
  });
  if (mic.boards.length === 0 || !serviceTypeId) return null;
  const check = q.data;
  const problems = (check?.unplaced.length ?? 0) + (check?.noPosition.length ?? 0) + (check?.noCapsule.length ?? 0);

  return (
    <section aria-label="This plan's check" className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 shadow-[var(--su-shadow-1)]">
      <div className="flex items-baseline gap-2">
        <h2 className="text-subheadline font-semibold text-fg">This plan's check</h2>
        <span className="text-caption1 text-fg-muted">
          {mic.hasPlan ? mic.label : "The default has no plan"} · read from the saved layouts
        </span>
      </div>
      {q.isError ? (
        <ErrorNote>Couldn't run the check: {q.error instanceof Error ? q.error.message : "the read failed"}.</ErrorNote>
      ) : !check ? (
        <p className="text-footnote text-fg-muted">Checking.</p>
      ) : (
        <>
          {check.roster === "unavailable" && (
            <p className="text-footnote text-warn-11">Planning Center could not be read, so people are not checked{check.reason ? `: ${check.reason}` : "."}</p>
          )}
          {check.roster === "none" && <p className="text-footnote text-fg-muted">A default layout has no people to check.</p>}
          {check.unplaced.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-caption1 font-medium text-fg">On the plan, on no slot</h3>
              {check.unplaced.map((u) => (
                <div key={`${u.personId ?? u.name}`} className="flex flex-wrap items-center gap-2 text-footnote text-fg" data-check-unplaced={u.personId ?? u.name}>
                  <span className="font-medium">{u.name}</span>
                  <span className="text-fg-muted">{u.position}</span>
                  {u.boards.map((b) => (
                    <Button
                      key={b.id}
                      variant="filled"
                      size="small"
                      onClick={() => mic.addSlot(b.id, u.position ? { link: { kind: "pco", matchBy: "position", positions: [{ name: u.position }] } } : undefined)}
                    >
                      Add to {b.name}
                    </Button>
                  ))}
                </div>
              ))}
            </div>
          )}
          {check.noPosition.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-caption1 font-medium text-fg">Slots that accept no position</h3>
              {check.noPosition.map((n) => (
                <div key={n.slotId} className="flex items-center gap-2 text-footnote text-fg" data-check-no-position={n.slotId}>
                  <span>
                    {n.boardName} · slot {n.index}
                    {n.channel ? ` (channel ${n.channel})` : ""}
                  </span>
                  <Button variant="filled" size="small" onClick={() => mic.select(n.slotId)}>
                    Show it
                  </Button>
                </div>
              ))}
            </div>
          )}
          {check.noCapsule.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-footnote text-fg" data-check-no-capsule={check.noCapsule.length}>
              <span>
                {plural(check.noCapsule.length, "person", "people")} on slots with a mic {check.noCapsule.length === 1 ? "has" : "have"} no Capsule tag yet
              </span>
              <Button variant="filled" size="small" onClick={() => mic.showSlots(check.noCapsule.map((n) => n.slotId))}>
                Show them
              </Button>
            </div>
          )}
          {problems === 0 && check.roster !== "unavailable" && (
            <p className="text-footnote text-fg-muted">
              {check.roster === "none" ? "Every slot accepts a position." : `Everyone on the plan is on a slot, and every slot accepts a position.`}
            </p>
          )}
          {problems > 0 && <p className="sr-only">{plural(problems, "thing")} to look at.</p>}
        </>
      )}
    </section>
  );
}
