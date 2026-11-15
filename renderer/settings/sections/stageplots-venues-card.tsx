// stageplots-venues-card.tsx — the editor's Venues card: add, pick, rename,
// Home or Offsite, notes, delete. Each change saves at once. A right-click or
// long press on a venue opens its menu: Rename (selects it and puts the cursor in
// its name), Home or Offsite, Open on /stageplots, Copy its address, Delete venue.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PlusIcon } from "lucide-react";

import { STAGEPLOT_LIMITS, type StagePlotsView, type Venue, type VenueKind } from "@main/types/stageplots";

import { Button } from "../../components/ui/button";
import { confirm } from "../../components/ui/confirm-dialog";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { useContextMenuState, useContextMenuTrigger } from "../../components/ui/context-menu-trigger";
import { copyText } from "../../lib/clipboard";
import { useRouterHandle } from "../../lib/use-search-param";
import { venueGroups } from "../../main/stageplots/doc-helpers";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { CardHeader, CommitText, Num, SaveError, Segmented, eyebrow, type Save } from "./stageplots-shared";

/** How long "Copied …" stays under the header. */
const COPIED_MS = 4000;

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
  /** Picks a venue; answers whether it did (unsaved work may have been kept instead). */
  onSelect: (id: string) => Promise<boolean>;
  save: Save;
}) {
  const [error, setError] = useState<string | null>(null);
  /** What Copy its address did: copied, or the address to copy by hand. */
  const [copied, setCopied] = useState<string | null>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenuState();
  // The status is for reading once: it goes after a few seconds.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const cardRef = useRef<HTMLElement>(null);
  const router = useRouterHandle();
  const focusName = () => {
    const field = cardRef.current?.querySelector<HTMLInputElement>('input[aria-label="Venue name"]');
    field?.focus();
    field?.select();
  };
  /** Rename asked from the menu for another venue: once it is selected (unsaved work may ask first), its name field takes the cursor. */
  const renameNext = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || renameNext.current !== selected.id) return;
    renameNext.current = null;
    focusName();
  }, [selected]);

  /** Run a save and keep its failure, if any, on this card. */
  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    const r = await save(fn);
    setError(r.ok ? null : r.error);
    return r.ok ? r.value : null;
  };

  const add = async () => {
    const venue = await run(() => stageplotsApi.createVenue({ name: "New venue", kind: "home", notes: "" }));
    if (venue) void onSelect(venue.id);
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

  const address = (v: Venue) => `${window.location.origin}/stageplots/${encodeURIComponent(v.id)}`;
  const menuFor = (v: Venue): ContextMenuItem[] => [
    {
      label: "Rename",
      onSelect: () => {
        if (v.id === selected?.id) return focusName();
        renameNext.current = v.id;
        // Declined (unsaved work kept): the venue is not selected, so nothing is left waiting to rename it.
        void onSelect(v.id).then((switched) => {
          if (!switched && renameNext.current === v.id) renameNext.current = null;
        });
      },
    },
    ...KINDS.map((k): ContextMenuItem => ({
      label: k.label,
      checked: v.kind === k.value,
      onSelect: () => {
        // A checked row leaves the menu open; this one closes it, as its tick would otherwise lag the save.
        closeMenu();
        if (v.kind !== k.value) void run(() => stageplotsApi.updateVenue(v.id, { kind: k.value }));
      },
    })),
    {
      label: "Open on /stageplots",
      // Through the router when there is one (no page load); else the browser goes there.
      onSelect: () => (router ? void router.navigate({ to: `/stageplots/${encodeURIComponent(v.id)}`, search: {} }) : window.location.assign(address(v))),
    },
    {
      label: "Copy its address",
      onSelect: () => {
        const byHand = () => setCopied(`Copy this address by hand: ${address(v)}`);
        void copyText(address(v))
          .then((ok) => (ok ? setCopied(`Copied ${address(v)}`) : byHand()))
          .catch(byHand);
      },
    },
    { separator: true },
    { label: "Delete venue…", danger: true, onSelect: () => void remove(v) },
  ];

  return (
    <section ref={cardRef} className="su-card flex flex-col gap-2.5 px-3.5 py-3" aria-label="Venues">
      <CardHeader title="Venues">
        <Button variant="transparent" size="small" onClick={() => void add()} disabled={doc.venues.length >= STAGEPLOT_LIMITS.venues}>
          <PlusIcon className="size-3.5" />
          Venue
        </Button>
      </CardHeader>
      <SaveError message={error} />
      {copied && (
        <p role="status" className="text-caption1 break-all text-fg-subtle">
          {copied}
        </p>
      )}
      {doc.venues.length === 0 && <p className="text-caption1 text-fg-subtle">No venues yet. Add the rooms you play in, and the places you visit.</p>}
      {venueGroups(doc.venues).map((g) => (
        <div key={g.label} className="flex flex-col gap-0.5">
          <span className={`${eyebrow} px-1.5 py-1`}>{g.label}</span>
          {g.venues.map((v) => (
            <div key={v.id}>
              <VenueRow current={v.id === selected?.id} onClick={() => void onSelect(v.id)} onMenu={(at) => openMenu(at, menuFor(v))}>
                <span className="truncate">{v.name}</span>
                <span className="text-[11px] text-fg-subtle">
                  <Num>{v.plotIds.length}</Num> {v.plotIds.length === 1 ? "plot" : "plots"}
                </span>
              </VenueRow>
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
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </section>
  );
}

/** A venue in the list: a press picks it, a right-click or long press opens its menu. */
function VenueRow({ current, onClick, onMenu, children }: { current: boolean; onClick: () => void; onMenu: (at: { x: number; y: number }) => void; children: ReactNode }) {
  const { cancel: _cancel, ...trigger } = useContextMenuTrigger(onMenu);
  return (
    <button
      type="button"
      aria-current={current}
      onClick={onClick}
      {...trigger}
      className="grid min-h-[30px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1 text-left text-footnote text-fg transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-[current=true]:bg-accent-soft"
    >
      {children}
    </button>
  );
}
