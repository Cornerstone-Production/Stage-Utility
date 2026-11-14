// stageplots-venues-card.tsx — the editor's Venues card: add, pick, rename,
// its address, Home or Offsite, notes, delete. Each change saves at once. A
// right-click or long press on a venue opens its menu: Rename (selects it and puts
// the cursor in its name), Home or Offsite, Open on /stageplots, Copy its address,
// Delete venue.
//
// The address is /stageplots/<address>, made from the name when the venue is
// added and never changed by a rename. Changing it keeps the old one working: the
// venue lists its old addresses, each with a × to stop it answering.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CopyIcon, PlusIcon, XIcon } from "lucide-react";

import { STAGEPLOT_LIMITS, type StagePlotsView, type Venue, type VenueKind } from "@main/types/stageplots";

import { Button } from "../../components/ui/button";
import { confirm } from "../../components/ui/confirm-dialog";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { useContextMenuState, useContextMenuTrigger } from "../../components/ui/context-menu-trigger";
import { copyText } from "../../lib/clipboard";
import { useRouterHandle } from "../../lib/use-search-param";
import { cn } from "../../lib/cn";
import { useResyncOn } from "../../lib/use-resync-on";
import { venueGroups, venuePath, venueSegment } from "../../main/stageplots/doc-helpers";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { CardHeader, CommitText, DraftDot, Num, SaveError, Segmented, eyebrow, iconButton, type Save } from "./stageplots-shared";

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
  drafted,
}: {
  doc: StagePlotsView;
  selected: Venue | null;
  /** Picks a venue; answers whether it did (unsaved work may have been kept instead). */
  onSelect: (id: string) => Promise<boolean>;
  save: Save;
  /** Plots with an unsaved draft kept on the server: a venue holding one carries a dot. */
  drafted?: ReadonlySet<string>;
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

  /** + Venue asks for the name first: the venue's address is made from the name it is added with, and a rename keeps it. */
  const [naming, setNaming] = useState(false);
  const add = async (name: string) => {
    setNaming(false);
    const venue = await run(() => stageplotsApi.createVenue({ name, kind: "home", notes: "" }));
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

  const address = (v: Venue) => `${window.location.origin}${venuePath(v)}`;
  const copyAddress = (v: Venue) => {
    const byHand = () => setCopied(`Copy this address by hand: ${address(v)}`);
    void copyText(address(v))
      .then((ok) => (ok ? setCopied(`Copied ${address(v)}`) : byHand()))
      .catch(byHand);
  };
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
      onSelect: () => (router ? void router.navigate({ to: venuePath(v), search: {} }) : window.location.assign(address(v))),
    },
    { label: "Copy its address", onSelect: () => copyAddress(v) },
    { separator: true },
    { label: "Delete venue…", danger: true, onSelect: () => void remove(v) },
  ];

  return (
    <section ref={cardRef} className="su-card flex flex-col gap-2.5 px-3.5 py-3" aria-label="Venues">
      <CardHeader title="Venues">
        <Button variant="transparent" size="small" onClick={() => setNaming(true)} disabled={naming || doc.venues.length >= STAGEPLOT_LIMITS.venues}>
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
      {naming && <NewVenueName onDone={(name) => (name ? void add(name) : setNaming(false))} />}
      {doc.venues.length === 0 && !naming && <p className="text-caption1 text-fg-subtle">No venues yet. Add the rooms you play in, and the places you visit.</p>}
      {venueGroups(doc.venues).map((g) => (
        <div key={g.label} className="flex flex-col gap-0.5">
          <span className={`${eyebrow} px-1.5 py-1`}>{g.label}</span>
          {g.venues.map((v) => (
            <div key={v.id}>
              <VenueRow current={v.id === selected?.id} onClick={() => void onSelect(v.id)} onMenu={(at) => openMenu(at, menuFor(v))}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{v.name}</span>
                  {v.plotIds.some((id) => drafted?.has(id)) && <DraftDot />}
                </span>
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
                  <AddressField
                    venue={v}
                    onCopy={() => copyAddress(v)}
                    onCommit={async (slug) => {
                      // Its own error under the field, not the card's: the field keeps what was typed.
                      const r = await save(() => stageplotsApi.updateVenue(v.id, { slug }));
                      return r.ok ? null : r.error;
                    }}
                  />
                  <OldAddresses venue={v} run={run} />
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

/**
 * The venue's address: `/stageplots/` and the field, saved when it loses focus or Enter is
 * pressed. A refused one stays as typed, outlined, with the server's reason under it, until it
 * is changed or Escape puts back the saved one. Shows the id for a venue that has no address yet.
 */
function AddressField({ venue, onCommit, onCopy }: { venue: Venue; onCommit: (slug: string) => Promise<string | null>; onCopy: () => void }) {
  const saved = venueSegment(venue);
  const [draft, setDraft] = useState(saved);
  const [refused, setRefused] = useState<string | null>(null);
  useResyncOn([saved], () => {
    setDraft(saved);
    setRefused(null);
  });
  const commit = async () => {
    const next = draft.trim();
    if (next === saved) {
      setDraft(saved);
      setRefused(null);
      return;
    }
    setRefused(await onCommit(next));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setDraft(saved);
      setRefused(null);
    }
    if (e.key === "Enter") e.currentTarget.blur();
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`venue-address-${venue.id}`} className={cn(eyebrow, "mt-0.5")}>
        Address
      </label>
      <div
        className={cn(
          "flex h-7 min-w-0 items-center rounded-md border bg-field pr-0.5 pl-2 transition-colors focus-within:ring-1",
          refused ? "border-danger-11 focus-within:ring-danger-11" : "border-line-strong focus-within:border-focus focus-within:ring-focus",
        )}
      >
        <span className="shrink-0 font-mono text-caption1 text-fg-subtle">/stageplots/</span>
        <input
          id={`venue-address-${venue.id}`}
          value={draft}
          maxLength={STAGEPLOT_LIMITS.slugChars}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={refused !== null}
          aria-describedby={`venue-address-${venue.id}-note`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-caption1 text-fg outline-none"
        />
        {!refused && (
          <button type="button" className={cn(iconButton, "size-6")} aria-label="Copy address" title="Copy the full address" onClick={onCopy}>
            <CopyIcon className="size-3.5" />
          </button>
        )}
      </div>
      <p id={`venue-address-${venue.id}-note`} role={refused ? "alert" : undefined} className={cn("-mt-0.5 text-[11px] leading-[14px]", refused ? "text-danger-11" : "text-fg-subtle")}>
        {refused ? `${refused.charAt(0).toUpperCase()}${refused.slice(1)}.` : "Stays when the venue is renamed, so printed QR codes keep working."}
      </p>
    </div>
  );
}

/** The addresses a venue had before, each still opening it, with a × that stops one answering (after asking). */
function OldAddresses({ venue, run }: { venue: Venue; run: <T>(fn: () => Promise<T>) => Promise<T | null> }) {
  if (venue.oldSlugs.length === 0) return null;
  const drop = async (slug: string) => {
    const ok = await confirm({
      title: `Stop answering to /stageplots/${slug}?`,
      message: "Links and QR codes with this address stop opening the venue.",
      confirmLabel: "Stop answering",
      destructive: true,
    });
    if (ok) await run(() => stageplotsApi.updateVenue(venue.id, { oldSlugs: venue.oldSlugs.filter((s) => s !== slug) }));
  };
  return (
    <div className="flex flex-col gap-0.5" data-testid="old-addresses">
      <span className={eyebrow}>Old addresses, still working</span>
      {[...venue.oldSlugs].reverse().map((slug) => (
        <span key={slug} className="flex min-h-6 items-center gap-1 text-caption1">
          <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">/stageplots/{slug}</span>
          <button type="button" className={cn(iconButton, "size-6")} aria-label={`Stop answering to /stageplots/${slug}`} title="Stop answering to this address" onClick={() => void drop(slug)}>
            <XIcon className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** The new venue's name, typed before it is added: Enter or leaving the field adds it, Escape or an empty name adds nothing. */
function NewVenueName({ onDone }: { onDone: (name: string | null) => void }) {
  const [name, setName] = useState("");
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value && value.trim() ? value.trim() : null);
  };
  return (
    <input
      autoFocus
      aria-label="New venue name"
      placeholder="Venue name"
      value={name}
      maxLength={STAGEPLOT_LIMITS.nameChars}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => finish(name)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(name);
        if (e.key === "Escape") finish(null);
      }}
      className="flex h-7 w-full rounded-md border border-line-strong bg-field px-2.5 py-1 text-footnote text-fg placeholder:text-gray-a8 transition-colors focus:border-focus focus:ring-1 focus:ring-focus focus:outline-none"
    />
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
