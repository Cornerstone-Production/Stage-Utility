// stageplots-venues-card.tsx — the editor's Venues card: add, pick, rename,
// Home or Offsite, notes, delete. Each change saves at once.

import { useState } from "react";
import { PlusIcon } from "lucide-react";

import { STAGEPLOT_LIMITS, type StagePlotsView, type Venue, type VenueKind } from "@main/types/stageplots";

import { Button } from "../../components/ui/button";
import { confirm } from "../../components/ui/confirm-dialog";
import { venueGroups } from "../../main/stageplots/doc-helpers";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { CardHeader, CommitText, Num, SaveError, Segmented, eyebrow, type Save } from "./stageplots-shared";

const KINDS = [
  { value: "home", label: "Home" },
  { value: "offsite", label: "Offsite" },
] as const;

export function VenuesCard({
  doc,
  selected,
  onSelect,
  save,
}: {
  doc: StagePlotsView;
  selected: Venue | null;
  onSelect: (id: string) => void;
  save: Save;
}) {
  const [error, setError] = useState<string | null>(null);

  /** Run a save and keep its failure, if any, on this card. */
  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    const r = await save(fn);
    setError(r.ok ? null : r.error);
    return r.ok ? r.value : null;
  };

  const add = async () => {
    const venue = await run(() => stageplotsApi.createVenue({ name: "New venue", kind: "home", notes: "" }));
    if (venue) onSelect(venue.id);
  };

  const remove = async (venue: Venue) => {
    const n = venue.plotIds.length;
    const ok = await confirm({
      title: `Delete ${venue.name}?`,
      message: n > 0 ? `Its ${n === 1 ? "plot goes" : `${n} plots go`} with it. Backgrounds stay for other venues.` : "It has no plots.",
      confirmLabel: "Delete venue",
      destructive: true,
    });
    if (ok) await run(() => stageplotsApi.deleteVenue(venue.id));
  };

  return (
    <section className="su-card flex flex-col gap-2.5 px-3.5 py-3" aria-label="Venues">
      <CardHeader title="Venues">
        <Button variant="transparent" size="small" onClick={() => void add()} disabled={doc.venues.length >= STAGEPLOT_LIMITS.venues}>
          <PlusIcon className="size-3.5" />
          Venue
        </Button>
      </CardHeader>
      <SaveError message={error} />
      {doc.venues.length === 0 && <p className="text-caption1 text-fg-subtle">No venues yet. Add the rooms you play in, and the places you visit.</p>}
      {venueGroups(doc.venues).map((g) => (
        <div key={g.label} className="flex flex-col gap-0.5">
          <span className={`${eyebrow} px-1.5 py-1`}>{g.label}</span>
          {g.venues.map((v) => (
            <div key={v.id}>
              <button
                type="button"
                aria-current={v.id === selected?.id}
                onClick={() => onSelect(v.id)}
                className="grid min-h-[30px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1 text-left text-footnote text-fg transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-[current=true]:bg-accent-soft"
              >
                <span className="truncate">{v.name}</span>
                <span className="text-[11px] text-fg-subtle">
                  <Num>{v.plotIds.length}</Num> {v.plotIds.length === 1 ? "plot" : "plots"}
                </span>
              </button>
              {v.id === selected?.id && (
                <div className="mt-1 mb-1 ml-2 flex flex-col gap-2 border-l-2 border-line pt-2 pb-1 pl-2.5">
                  <CommitText
                    aria-label="Venue name"
                    value={v.name}
                    maxLength={STAGEPLOT_LIMITS.nameChars}
                    onCommit={async (name) => (await run(() => stageplotsApi.updateVenue(v.id, { name }))) !== null}
                  />
                  <Segmented
                    label="Kind"
                    value={v.kind}
                    options={KINDS}
                    onChange={(kind: VenueKind) => void run(() => stageplotsApi.updateVenue(v.id, { kind }))}
                  />
                  <CommitText
                    multiline
                    aria-label="Venue notes"
                    value={v.notes}
                    maxLength={STAGEPLOT_LIMITS.notesChars}
                    onCommit={async (notes) => (await run(() => stageplotsApi.updateVenue(v.id, { notes }))) !== null}
                  />
                  <Button variant="transparent" size="small" className="self-start text-danger-11" onClick={() => void remove(v)}>
                    Delete venue…
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
