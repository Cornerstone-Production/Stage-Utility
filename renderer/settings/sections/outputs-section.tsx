import { ScreenDevice } from "../../app/screens/screen-device";
import { NewScreenDialog } from "./new-screen-dialog";
import { SignageScreenRow } from "./signage-screen-row";
import { AppLink } from "../../app/app-link";
import { useState, useEffect, type ChangeEvent } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { DropdownMenu } from "radix-ui";
import { PlusIcon, TrashIcon, MonitorIcon, HandIcon, ExternalLinkIcon, RefreshCwIcon, LockIcon, LockOpenIcon, MoreVerticalIcon, CopyIcon, LinkIcon, PencilIcon, RotateCwIcon, CheckIcon } from "lucide-react";
import { LazyPreview } from "./lazy-preview";
import { cn } from "../../lib/cn";

/** Shared menu-item styling, so the six actions cannot drift apart. */
const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-fg outline-none data-[highlighted]:bg-fill";
const MENU_CONTENT =
  "z-50 min-w-48 rounded-md border border-line-strong bg-popover p-1 shadow-md backdrop-blur-xl";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  toast,
  confirm, Dialog} from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { IconTint } from "../../components/icon-tint";
import { NewViewDialog, KIND_LABELS } from "./new-view-dialog";
import { ScreenUrlsDialog } from "./screen-urls-dialog";
import { ImportLayout } from "./import-layout";
import { viewSurface, outputMode, screenRotation } from "@main/types/views";
import { screensListViews } from "@main/services/home-view";
import { invoke, onNotification } from "../../lib/api";
import type { SectionProps } from "../types";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useSortableRow } from "../../lib/use-sortable-row";

/**
 * The Views a given screen may actually be pointed at.
 *
 * Convenience, NOT the safety property: the server refuses an invalid binding
 * regardless (stage-controller's setOutputView). This only stops the operator
 * reaching for something that will be refused.
 */
/**
 * Every view a screen can be given.
 *
 * This used to hide console views from a display screen, which is what made
 * "use a control surface" a two-step job: you had to know to flip the screen's
 * mode FIRST, because until you did, the view you wanted was not in the list.
 * Nothing was unsafe about the hidden state — a display renders controls inert
 * either way — so hiding it only removed the obvious route to the thing you
 * were trying to do.
 *
 * Everything is offered now, and picking a console view for a display OFFERS to
 * switch the screen. The safety property is unchanged: making a screen live to
 * whoever stands at it is still an explicit yes.
 */
export function bindableViews(views: readonly View[], _output: Pick<Output, "mode">): View[] {
  return [...views];
}

const UNROUTED = "__none__";
// A sentinel, never a stored value: picking it opens the new-view dialog.
const NEW_VIEW = "__new__";

interface OutputRowProps {
  output: Output;
  views: View[];
  /** Base origin for this display's URL — the configured public URL or the current origin. */
  baseUrl: string;
  /** Whether a live kiosk page is currently connected for this output. */
  online: boolean;
  canRemove: boolean;
  onRename: (name: string) => void;
  /** This display's icon tint, or undefined for the theme default. */
  iconColor?: string;
  /** Save the friendly URL slug ("" clears it). Rejects with a reason the card shows. */
  onSetSlug: (slug: string) => Promise<void>;
  onSetView: (viewId: string | null) => void;
  /** Rename the view this screen is showing (not the screen). */
  onRenameView: (viewId: string, name: string) => void;
  onSetLocked: (locked: boolean) => void;
  /** Awaited: switching a screen to a panel must LAND before a console view
   *  is assigned to it, because the server refuses the pair in the wrong order. */
  onSetMode: (mode: "display" | "panel") => Promise<void>;
  onSetRotation: (rotation: 0 | 90 | 180 | 270) => Promise<void>;
  onOpenWindow: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  /** Open the layout editor for this display's view. Absent when it has no
   *  free-form layout to edit (every kind except "custom"). */
  onEditLayout?: () => void;
  onRequestNewView: () => void;
}

// One card per display: the name reads as a title, the View it shows is the one
// prominent control, Open + Lock stay in reach, and the URL sits quietly in the
// footer. Refresh/Remove tuck into the overflow menu so they don't compete.
function OutputRow({ output, views, baseUrl, online, canRemove, iconColor, onRename, onRenameView, onSetSlug, onSetView, onSetLocked, onSetMode, onSetRotation, onOpenWindow, onRefresh, onRemove, onEditLayout, onRequestNewView }: OutputRowProps) {
  const [editName, setEditName] = useState(output.name);
  const assignedView = views.find((v) => v.id === output.viewId) ?? null;
  const [renamingView, setRenamingView] = useState(false);
  const [viewName, setViewName] = useState("");

  const { setNodeRef, style, dragA11y, listeners } = useSortableRow(output.id);

  useResyncOn([output.name], () => {
    setEditName(output.name);
  });

  /**
   * Assign a view, offering to make the screen match what that view IS.
   *
   * A control surface used to have to be declared twice — once on the view and
   * again on the screen — and in a fixed order, because the SERVER refuses a
   * console view on a display screen. That refusal is the safety property and
   * it stays exactly as it is: a wall screen must not be able to render a live
   * control. What was wrong is that the operator had to know the order, and
   * find the second switch in a different menu, before the view they wanted
   * even appeared in the list.
   *
   * So the offer comes FIRST and the mode change is awaited. Decline it and
   * nothing is assigned, because the server would refuse that binding anyway —
   * an assignment that silently failed would be worse than one that did not
   * happen.
   */
  async function assignView(viewId: string | null): Promise<void> {
    if (!viewId) { onSetView(null); return; }
    const picked = views.find((v) => v.id === viewId);
    const needsPanel = picked && viewSurface(picked) === "console" && outputMode(output) !== "panel";
    if (needsPanel) {
      const ok = await confirm({
        title: `Use "${output.name}" as a control surface?`,
        message: `"${picked.name}" has live controls, so it can only go on a control surface. Its buttons will work for anyone standing at this screen.`,
        confirmLabel: "Use as a control surface",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      await onSetMode("panel");
    }
    onSetView(viewId);
  }

  function handleBlur() {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== output.name) {
      onRename(trimmed);
    } else {
      setEditName(output.name);
    }
  }

  const outputUrl = `${baseUrl}/${encodeURIComponent(output.id)}`;

  // The friendly-URL editor is revealed from the overflow menu rather than
  // always shown. It is set once per screen and then never touched, and two
  // permanent rows of mono URL per card buried the thing the card is FOR — what
  // that screen is showing.
  const [nameFocused, setNameFocused] = useState(false);
  const [urlsOpen, setUrlsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--su-shadow-1)]"
    >
      {/* Header: the drag handle + tinted icon + editable name + status + overflow.
          Only the HEADER drags. The card as a whole cannot, because the preview
          below it is now a link to the live display - one gesture per region, so
          neither has to guess which the operator meant.
          listeners plus attributes MINUS role/tabIndex: dnd-kit's attributes set
          role="button", which would announce a button wrapping this row's
          textbox. The drag-description attributes are kept. */}
      <div
        {...dragA11y}
        {...listeners}
        className="flex cursor-grab items-center gap-2 px-3 pt-2.5 active:cursor-grabbing"
      >
        {/* Also inside the drag handle: the swatch opens a colour picker. */}
        <span
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          className="flex shrink-0"
        >
          <IconTint itemKey={output.id} icon={MonitorIcon} color={iconColor} label={output.name} />
        </span>
        <Input
          value={editName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
          onBlur={() => { setNameFocused(false); handleBlur(); }}
          onFocus={() => setNameFocused(true)}
          // Claim the gesture ONLY while editing. This field is flex-1, so
          // blocking unconditionally made the entire middle of the header
          // undraggable - a dead strip exactly where you would grab the card.
          // Unfocused it passes the gesture through to the drag handle, which is
          // safe because the sensors need 5px of travel (mouse) or a 200ms hold
          // (touch): a plain click still lands here and focuses. Once focused,
          // dragging to select text works normally again.
          //
          // mousedown/touchstart, NOT pointerdown: dnd-kit's MouseSensor and
          // TouchSensor bind onMouseDown/onTouchStart, and stopping a
          // pointerdown does nothing to the mousedown that follows it. The
          // pointerdown version of this guard was inert.
          onMouseDown={(e) => { if (nameFocused) e.stopPropagation(); }}
          onTouchStart={(e) => { if (nameFocused) e.stopPropagation(); }}
          className="h-auto flex-1 min-w-0 rounded-md border-0 bg-transparent px-1 -mx-1 py-0 text-callout font-semibold leading-tight text-fg focus:bg-fill focus:ring-0"
          aria-label="Display name"
        />
        {outputMode(output) === "panel" && (
          <Tooltip label="A control surface: controls on this screen are live">
            <span className="shrink-0 rounded-full border border-accent bg-accent-a3 px-2 py-0.5 text-caption2 font-medium text-accent">
              panel
            </span>
          </Tooltip>
        )}
        <Tooltip label={online ? "A screen is connected to this display" : "No screen is currently connected"}>
          <span className="flex shrink-0 items-center gap-1.5 text-caption2 text-fg-muted">
            <span className={`size-2 rounded-full ${online ? "bg-ok-9" : "bg-fg-faint"}`} />
            {online ? "Online" : "Offline"}
          </span>
        </Tooltip>

        {/* Everything set-once lives here: opening, locking, the URLs, refresh
            and remove. The card face keeps only what an operator changes while
            working — what it shows, and the way into its layout. */}
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              // Inside the drag handle, so it must claim the gesture or opening
              // the menu reads as the start of a drag. See the name field above
              // for why this is mousedown/touchstart and not pointerdown.
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-fill hover:text-fg transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-focus"
              aria-label={`More actions for ${output.name}`}
            >
              <MoreVerticalIcon className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT}>
              <DropdownMenu.Item onSelect={onOpenWindow} className={MENU_ITEM}>
                <ExternalLinkIcon className="size-3.5 text-fg-subtle" />
                Open display
              </DropdownMenu.Item>
              {/* Renaming the VIEW, from the screen showing it. Rename only
                  ever lived on the view's own card, and a view loses that card
                  the moment it is assigned — so the name you look at every week
                  was the one name you could not change. */}
              {assignedView && (
                <DropdownMenu.Item onSelect={() => setRenamingView(true)} className={MENU_ITEM}>
                  <PencilIcon className="size-3.5 text-fg-subtle" />
                  Rename view
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item
                // Confirmed, and the confirm says what actually changes. Turning
                // a screen into a panel makes its controls live to anyone
                // standing at it, which is not something to do by misclick.
                onSelect={async () => {
                  const toPanel = outputMode(output) !== "panel";
                  const ok = await confirm({
                    title: toPanel ? `Use "${output.name}" as a control surface?` : `Make "${output.name}" a display again?`,
                    message: toPanel
                      ? "Buttons on this screen will work. Anyone standing at it can press them."
                      : "This screen becomes read-only. Its buttons will render but do nothing.",
                    confirmLabel: toPanel ? "Use as a control surface" : "Make it a display",
                  });
                  if (ok) await onSetMode(toPanel ? "panel" : "display");
                }}
                className={MENU_ITEM}
              >
                {outputMode(output) === "panel"
                  ? <MonitorIcon className="size-3.5 text-fg-subtle" />
                  : <HandIcon className="size-3.5 text-fg-subtle" />}
                {outputMode(output) === "panel" ? "Use as a display" : "Use as a control surface"}
              </DropdownMenu.Item>
              {/* How the panel is MOUNTED — a physical fact about the TV, not a
                  property of what it is playing. Four quarter turns, because a
                  panel is hung one of four ways and an arbitrary angle is a
                  mis-typed number that leaves a wall crooked. */}
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className={MENU_ITEM}>
                  <RotateCwIcon className="size-3.5 text-fg-subtle" />
                  Rotation
                  <span className="ml-auto text-caption2 text-fg-subtle">
                    {screenRotation(output) === 0 ? "Normal" : `${screenRotation(output)}°`}
                  </span>
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent className={MENU_CONTENT} sideOffset={2}>
                    {([0, 90, 180, 270] as const).map((deg) => (
                      <DropdownMenu.Item
                        key={deg}
                        onSelect={() => void onSetRotation(deg)}
                        className={MENU_ITEM}
                      >
                        <CheckIcon
                          className={
                            screenRotation(output) === deg
                              ? "size-3.5 text-accent"
                              : "size-3.5 opacity-0"
                          }
                        />
                        {deg === 0 ? "Normal" : deg === 180 ? "Upside down" : `${deg}° clockwise`}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
              <DropdownMenu.Item
                onSelect={() => onSetLocked(!(output.locked ?? false))}
                className={MENU_ITEM}
              >
                {output.locked ? <LockIcon className="size-3.5 text-accent" /> : <LockOpenIcon className="size-3.5 text-fg-subtle" />}
                {output.locked ? "Unlock display" : "Lock display"}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                // preventDefault keeps the menu OPEN across the copy. Without it
                // Radix closes and returns focus to the trigger, which discards
                // the textarea selection the fallback path copies from - so over
                // plain HTTP (how prod is served) this button did nothing at all.
                onSelect={(e) => {
                  e.preventDefault();
                  // Mount the copy textarea inside the menu itself: Radix traps
                  // focus in there, so a textarea anywhere else loses its
                  // selection before the copy happens.
                  const menu = (e.currentTarget as HTMLElement | null)?.closest<HTMLElement>(
                    "[data-radix-menu-content]",
                  );
                  void copyText(outputUrl, menu).then((ok) => {
                    setMenuOpen(false);
                    if (ok) toast.success("URL copied");
                    else toast.error("Couldn't copy — use Friendly URL below to see it");
                  });
                }}
                className={MENU_ITEM}
              >
                <CopyIcon className="size-3.5 text-fg-subtle" />
                Copy URL
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => setUrlsOpen(true)}
                className={MENU_ITEM}
              >
                <LinkIcon className="size-3.5 text-fg-subtle" />
                URLs and friendly link
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item onSelect={onRefresh} className={MENU_ITEM}>
                <RefreshCwIcon className="size-3.5 text-fg-subtle" />
                Refresh display
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={onRemove}
                disabled={!canRemove}
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-red-11 outline-none data-[highlighted]:bg-red-3 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
              >
                <TrashIcon className="size-3.5" />
                Remove display
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* A LIVE preview: the real kiosk renderers in an iframe, scaled. It only
          mounts once the card is on screen — eight iframes booting at once each
          fetch state and open a stream, which timed out the server on a real
          install with eight displays. */}
      <div className="px-3 pt-2">
        {output.viewId ? (
          // The preview IS the display, so clicking it opens the real thing in a
          // new tab - the same place the menu's "Open display" goes. An anchor
          // rather than an onClick so it behaves like a link: middle-click and
          // cmd-click open a tab, and the URL shows in the status bar on hover.
          // The preview iframe sets pointer-events:none, so the click lands here.
          <LazyPreview
            viewId={output.viewId}
            // Signage resolves per OUTPUT, so its card previews the screen
            // rather than the view every signage screen shares.
            outputId={output.id}
            onExpand={onEditLayout}
            expandLabel={`Edit what ${output.name} shows`}
          />
        ) : (
          <div className="grid aspect-video place-items-center rounded-lg border border-dashed border-line text-caption1 text-fg-subtle">
            Nothing assigned
          </div>
        )}
      </div>

      {/* What it shows, and the way into its layout. The two controls an
          operator actually reaches for. */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        {/* A pill, not a full-width field. The card is a thing you glance at;
            a form control spanning it made every card read as a form. */}
        {/* Controlled, because it is opened from a menu item: Radix closes the
            menu on select, which would unmount an inline trigger mid-click. */}
        {assignedView && (
          <Dialog
            open={renamingView}
            onOpenChange={(o: boolean) => { setRenamingView(o); if (o) setViewName(assignedView.name); }}
            title={`Rename "${assignedView.name}"`}
            description="This renames the view itself, so it changes everywhere the view is used."
            confirmLabel="Rename"
            confirmDisabled={viewName.trim().length === 0}
            onConfirm={() => {
              const next = viewName.trim();
              if (next && next !== assignedView.name) onRenameView(assignedView.id, next);
            }}
          >
            <Input value={viewName} onChange={(e) => setViewName(e.target.value)} autoFocus />
          </Dialog>
        )}
        <Select
          value={output.viewId ?? UNROUTED}
          onValueChange={(v: string) => {
            // Creating a view is nearly always in service of assigning one, so
            // the picker is where the need arises. The sentinel opens the
            // dialog and the new view is assigned here on the way back, rather
            // than sending a sentinel id to the server as a real value.
            if (v === NEW_VIEW) { onRequestNewView(); return; }
            void assignView(v === UNROUTED ? null : v);
          }}
        >
          <SelectTrigger
            className={cn(
              "h-7 w-auto min-w-0 max-w-[70%] truncate rounded-lg border-transparent px-2.5 text-footnote font-medium",
              output.viewId ? "bg-fill text-fg" : "bg-warn-3 text-warn-11",
            )}
          >
            <SelectValue placeholder="Pick a view" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNROUTED}>— Unrouted —</SelectItem>
            {bindableViews(views, output).map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {/* Say which ones are control surfaces, so choosing one is an
                    informed choice rather than a surprise confirm. */}
                {viewSurface(v) === "console" ? `${v.name} — control surface` : v.name}
              </SelectItem>
            ))}
            <SelectItem value={NEW_VIEW}>+ New view…</SelectItem>
          </SelectContent>
        </Select>
        {/* Opening the real screen moved here, because the preview now opens the
            editor. An anchor, so middle-click and cmd-click behave and the URL
            shows on hover. */}
        <Tooltip label={`Open ${output.name} in a new tab`}>
          <a
            href={outputUrl}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-1 text-footnote text-accent transition-opacity hover:underline"
          >
            Open
            <ExternalLinkIcon className="size-3" />
          </a>
        </Tooltip>
      </div>

      {/* Revealed from the menu. The permanent address never changes, so a Pi, a
          bookmark or a printed QR keeps working whatever is typed here. */}
      <ScreenUrlsDialog
        open={urlsOpen}
        onOpenChange={setUrlsOpen}
        outputName={output.name}
        outputUrl={outputUrl}
        baseUrl={baseUrl}
        slug={output.slug ?? ""}
        onSave={onSetSlug}
      />

      {/* The machine showing this screen, when one is bound. Nothing when it is
          a browser tab somebody opened. */}
      <ScreenDevice outputId={output.id} name={output.name} />
    </div>
  );
}

// A view nothing is showing. Same card shape as a screen so the page has one
// visual vocabulary, but deliberately WITHOUT the screen affordances - no URL,
// no presence dot, no lock, no open-in-a-window - because it is not a screen.
// That absence is what distinguishes the two, rather than a grey wash.
function UnassignedViewCard({
  view,
  onRename,
  onDuplicate,
  onToggleSurface,
  onRemove,
  onEditLayout,
}: {
  view: View;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onToggleSurface: () => void;
  onRemove: () => void;
  onEditLayout?: () => void;
}) {
  const [editName, setEditName] = useState(view.name);
  // Follow a rename that happened elsewhere (a duplicate, an import) without
  // clobbering what is being typed here.
  useResyncOn([view.name], () => setEditName(view.name));

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-dashed border-line bg-surface">
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <Input
          value={editName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
          onBlur={() => {
            const next = editName.trim();
            if (next && next !== view.name) onRename(next);
            else setEditName(view.name);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="h-auto flex-1 min-w-0 rounded-md border-0 bg-transparent px-1 -mx-1 py-0 text-callout font-semibold leading-tight text-fg focus:bg-fill focus:ring-0"
          aria-label="View name"
        />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="shrink-0 rounded-md p-1 text-fg-subtle hover:bg-fill hover:text-fg" aria-label={`More actions for ${view.name}`}>
              <MoreVerticalIcon className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className={MENU_CONTENT} align="end" sideOffset={4}>
              {/* Only a custom layout can be a console: the built-in kinds have
                  no layout to put a control on. */}
              {view.kind === "custom" && (
                <DropdownMenu.Item onSelect={onToggleSurface} className={MENU_ITEM}>
                  {viewSurface(view) === "console"
                    ? <MonitorIcon className="size-3.5 text-fg-subtle" />
                    : <HandIcon className="size-3.5 text-fg-subtle" />}
                  {viewSurface(view) === "console" ? "Make it a wall screen" : "Make it a control surface"}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item onSelect={onDuplicate} className={MENU_ITEM}>
                <CopyIcon className="size-3.5 text-fg-subtle" />
                Duplicate view
              </DropdownMenu.Item>
              <DropdownMenu.Item
                // Confirmed, because deleting a view cannot be undone and this
                // item sits directly under "Duplicate view". The old Views list
                // confirmed; dropping it here would have made a misclick
                // destroy an operator's layout with no way back.
                onSelect={async () => {
                  const ok = await confirm({
                    title: `Delete "${view.name}"?`,
                    message: "This cannot be undone.",
                    confirmLabel: "Delete view",
                    destructive: true,
                  });
                  if (ok) onRemove();
                }}
                className={cn(MENU_ITEM, "text-red-11 data-[highlighted]:bg-red-3")}
              >
                <TrashIcon className="size-3.5" />
                Delete view
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <div className="px-3 pt-2">
        <LazyPreview
          viewId={view.id}
          onExpand={onEditLayout}
          expandLabel={`Edit ${view.name}`}
        />
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate rounded-lg bg-fill px-2.5 py-1 text-footnote font-medium text-fg-muted">
            {KIND_LABELS[view.kind]}
          </span>
          {viewSurface(view) === "console" && (
            <span className="shrink-0 rounded-lg border border-accent px-2 py-0.5 text-caption2 font-medium text-accent">
              console
            </span>
          )}
        </span>
        {/* No "Open" here: this view is on no screen, so there is no screen URL
            to open. The preview above is the way in. */}
      </div>
    </div>
  );
}

export function OutputsSection({
  stageState,
  handlers,
  onEditLayout,
}: Pick<SectionProps, "stageState" | "handlers"> & {
  /** Open the layout editor for a view. Absent when there is nowhere to open. */
  onEditLayout?: (viewId: string) => void;
}) {
  const outputs = stageState.outputs ?? [];
  // Sorted by name. Manual view ordering used to exist and only ever sorted
  // THIS dropdown - nothing else read the order - so it was dropped in favour of
  // an order that needs no maintaining. See docs/design/app-shell-redesign.md.
  // Home is filtered out: it is the operator's front door, edited in its own
  // tab, and it has no geometry — see main/services/home-view.ts.
  const views = screensListViews(stageState.views ?? []).sort((a, b) => a.name.localeCompare(b.name));

  // Which output asked for a new view, so the created view can be assigned back
  // to it. "" means the dialog was opened from the unassigned section, where
  // there is nothing to assign to.
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [addingScreen, setAddingScreen] = useState(false);

  // Signage screens sit in their own section. A building can have a dozen of
  // them and they are all configured in one place (Signage), so mixed in they
  // pushed the two or three screens anyone actually edits here off the fold.
  // Same card, same controls — only the grouping differs.
  const signageViewIds = new Set(
    (stageState.views ?? []).filter((v) => v.kind === "signage").map((v) => v.id),
  );
  const isSignageOutput = (o: Output) => !!o.viewId && signageViewIds.has(o.viewId);
  const mainOutputs = outputs.filter((o) => !isSignageOutput(o));
  const signageOutputs = outputs.filter(isSignageOutput);

  // A view no screen points at. Without a home these are unreachable: the only
  // way in was the Views list this page replaced.
  const assigned = new Set(outputs.map((o) => o.viewId).filter(Boolean));
  const unassigned = views.filter((v) => !assigned.has(v.id));
  // Grouped, because a console and a display are different kinds of thing now:
  // one is content for a wall, the other is a control surface. An
  // undifferentiated list makes an operator open each to find out which.
  const unassignedGroups = [
    { key: "console" as const, label: "Consoles", items: unassigned.filter((v) => viewSurface(v) === "console") },
    { key: "display" as const, label: "Displays", items: unassigned.filter((v) => viewSurface(v) === "display") },
  ].filter((g) => g.items.length > 0);
  // Prefer the configured public URL (DNS) so display links match what operators
  // actually browse to; fall back to the current origin.
  const baseUrl = stageState.publicUrl || window.location.origin;

  // Live per-display presence (Connected/Offline dot). The server broadcasts the
  // connected-output set on change; kiosk pages heartbeat to keep it fresh.
  const [connected, setConnected] = useState<Set<string>>(new Set());
  useEffect(
    () =>
      onNotification("displays:presence", (p: unknown) => {
        const ids = (p as { connected?: string[] } | null)?.connected ?? [];
        setConnected(new Set(ids));
      }),
    [],
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = outputs.map((o) => o.id);
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    handlers.handleReorderOutputs(arrayMove(ids, oldIndex, newIndex));
  }

  return (
    <div data-flash-id="displays-list" className="flex flex-col gap-4 pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      <p className="text-caption1 text-gray-9">
        Each display is a physical screen at its own URL. Point it at a <span className="font-medium">View</span>{" "}
        to choose what it shows — and many screens can share one View, so you change content in one place.
      </p>

      <DndContext sensors={handlers.sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        {/* A GRID, not a column. Full-width rows made each card a page of its
            own and buried the thing the page is for - comparing screens at a
            glance. rectSortingStrategy is the grid-aware counterpart to the
            vertical strategy; the vertical one assumes a single column and
            computes the wrong drop target as soon as there are two. */}
        {/* mainOutputs, not every output: signage screens render through
            SignageScreenRow, which does not call useSortable, so their ids left
            holes in dnd-kit's sorted rects and some main cards did not animate
            to their preview position mid-drag. handleDragEnd still indexes the
            FULL list, which is what keeps the stored order correct. */}
        <SortableContext
          items={mainOutputs.map((o) => o.id)} strategy={rectSortingStrategy}>
          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
            {mainOutputs.map((output) => (
              <OutputRow
                key={output.id}
                output={output}
                views={views}
                baseUrl={baseUrl}
                online={connected.has(output.id)}
                canRemove={outputs.length > 1}
                iconColor={stageState.iconColors?.[output.id]}
                onRename={(name) => handlers.handleRenameOutput(output.id, name)}
                onRenameView={(viewId, name) => handlers.handleRenameView(viewId, name)}
                onSetSlug={(slug) => invoke("outputs:setSlug", { id: output.id, slug })}
                onSetView={(viewId) => handlers.handleSetOutputView(output.id, viewId)}
                onSetLocked={(locked) => handlers.handleSetOutputLocked(output.id, locked)}
                onSetMode={(mode) => handlers.handleSetOutputMode(output.id, mode)}
                onSetRotation={(rotation) => handlers.handleSetOutputRotation(output.id, rotation)}
                onOpenWindow={() => handlers.handleOpenOutputWindow(output.id)}
                onRefresh={() => handlers.handleRefreshDisplay(output.id)}
                onRemove={() => handlers.handleRemoveOutput(output.id)}
                onRequestNewView={() => setCreatingFor(output.id)}
                onEditLayout={
                  // ANY assigned view, not just a custom one. The comment here
                  // used to say the built-in kinds "would open an editor with
                  // nothing to edit" — which was simply wrong: a slots view's
                  // editor is where its slot set and column positions live, and
                  // a script view's is where its column preset is chosen.
                  // Greying this out left no way to edit a mic board at all.
                  onEditLayout && output.viewId ? () => onEditLayout(output.viewId!) : undefined
                }
              />
            ))}
            {/* The add tile sits IN the grid. As a button under eight cards it
                was below the fold on the page where you would want it. */}
            <button
              type="button"
              onClick={() => setAddingScreen(true)}
              className="flex flex-col rounded-xl border border-dashed border-line bg-transparent p-3 text-left transition-colors hover:border-line-strong hover:bg-fill"
            >
              <span className="flex items-center gap-2 px-0.5 pb-2 pt-0.5">
                <PlusIcon className="size-4 text-fg-subtle" />
                <span className="text-callout font-semibold text-fg">Add a screen</span>
              </span>
              <span className="grid aspect-video w-full place-items-center rounded-lg border border-dashed border-line px-3 text-center text-caption1 text-fg-subtle">
                Point a monitor at {baseUrl}
              </span>
              <span className="px-0.5 pt-2.5 text-caption1 text-fg-subtle">
                kiosk, signage or console
              </span>
            </button>
          </div>

          {signageOutputs.length > 0 && (
            <>
              <div className="flex items-baseline gap-2 pt-5">
                <h3 className="text-subheadline font-semibold text-fg">Signage</h3>
                <span className="text-caption1 text-fg-subtle">
                  {signageOutputs.length} {signageOutputs.length === 1 ? "screen" : "screens"} — what
                  they play, and their tags, are on{" "}
                  <AppLink to="/signage" className="text-accent hover:underline">
                    Signage
                  </AppLink>
                </span>
              </div>

              {/* COMPACT rows, not the full card.
                  These screens appear on the Now board too, and there they get a
                  live preview and their tags — which is the right home for both,
                  because that page is about what is playing. Repeating them here
                  was the same screen twice, and twice the preview iframes: each
                  one is a real kiosk page holding its own event stream.
                  What is left is what only Screens can answer — is it online,
                  which machine, what URL, how is it mounted. */}
              <div className="flex flex-col gap-1.5">
                {signageOutputs.map((output) => (
                  <SignageScreenRow
                    key={output.id}
                    output={output}
                    baseUrl={baseUrl}
                    online={connected.has(output.id)}
                    onRename={(name) => handlers.handleRenameOutput(output.id, name)}
                    onSetRotation={(rotation) => handlers.handleSetOutputRotation(output.id, rotation)}
                    onOpenWindow={() => handlers.handleOpenOutputWindow(output.id)}
                    onRefresh={() => handlers.handleRefreshDisplay(output.id)}
                    onRemove={() => handlers.handleRemoveOutput(output.id)}
                  />
                ))}
              </div>
            </>
          )}
        </SortableContext>
      </DndContext>

      {/* Views with no screen pointing at them.
          Deliberately NOT mixed into the grid above: a screen is a physical
          thing with a URL, a presence dot and a lock, and a view is content.
          Greying an orphan view inside the same grid reads as "disabled"
          rather than "not in use". This appears only when there is something
          to show, so the common case is the screens grid and nothing else. */}
      {unassigned.length > 0 && (
        <div className="mt-2 flex flex-col gap-2 border-t border-line pt-5">
          <h3 className="text-callout font-semibold text-fg">Views not on a screen</h3>
          <p className="text-caption2 text-fg-subtle">
            Built, but nothing is showing them. Point a screen at one above, or tidy them up here.
          </p>
          {unassignedGroups.map((g) => (
            <div key={g.key} className="flex flex-col gap-2">
              {unassignedGroups.length > 1 && (
                <h4 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">{g.label}</h4>
              )}
              <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
                {g.items.map((v) => (
                  <UnassignedViewCard
                    key={v.id}
                    view={v}
                    onRename={(name) => handlers.handleRenameView(v.id, name)}
                        onDuplicate={() => handlers.handleDuplicateView(v.id)}
                    onToggleSurface={() =>
                      handlers.handleSetViewSurface(v.id, viewSurface(v) === "console" ? "display" : "console")
                    }
                    onRemove={() => handlers.handleRemoveView(v.id)}
                    onEditLayout={onEditLayout ? () => onEditLayout(v.id) : undefined}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* One dialog for the whole page. Controlled, because it is opened from a
          view picker on any card as well as from the button below. */}
      <NewViewDialog
        handlers={handlers}
        open={creatingFor !== null}
        onOpenChange={(o) => { if (!o) setCreatingFor(null); }}
        onCreated={(id) => {
          // Assign it straight to the screen that asked, so "New view..." in a
          // picker is one action rather than create-then-go-find-it.
          if (creatingFor) handlers.handleSetOutputView(creatingFor, id);
          setCreatingFor(null);
        }}
        trigger={<span className="hidden" />}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="transparent" size="small" onClick={() => setCreatingFor("")}>
          <PlusIcon className="size-3.5 text-gray-9" />
          New view
        </Button>
        {/* Beside New view because an imported view IS a new view — it arrives
            where you would look for one. */}
        <ImportLayout />
        {outputs.length > 0 && (
          <Button
            variant="transparent"
            size="small"
            onClick={() => handlers.handleRefreshDisplay(null)}
            tooltip="Reload every connected display remotely"
          >
            <RefreshCwIcon className="size-3.5 text-gray-9" />
            Refresh all
          </Button>
        )}
      </div>

      {/* Asked at the moment a screen is made, because that is when the operator
          knows the answer. It also replaces the "turn a screen into a signage
          screen" button that lived on the signage Groups page. */}
      <NewScreenDialog
        open={addingScreen}
        onOpenChange={setAddingScreen}
        onCreate={handlers.handleCreateScreen}
      />
    </div>
  );
}
