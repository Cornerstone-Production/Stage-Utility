import { ScreenDevice } from "../../app/screens/screen-device";
import { useDevices } from "../../app/screens/use-devices";
import { outputStruggleSentences, struggleByScreen, type OutputStruggle } from "../../app/screens/output-helpers";
import { useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { DropdownMenu } from "radix-ui";
import { PlusIcon, TrashIcon, MonitorIcon, HandIcon, LayoutGridIcon, ExternalLinkIcon, RefreshCwIcon, MoreVerticalIcon, CopyIcon, PencilIcon, CheckIcon, SlidersHorizontalIcon } from "lucide-react";
import { LazyPreview } from "./lazy-preview";
import { cn } from "../../lib/cn";

import {
  MENU_ITEM,
  MENU_ITEM_DANGER,
  menuContent,
  Button,
  Input,
  toast,
  Dialog} from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { IconTint } from "../../components/icon-tint";
import { iconEntryAt } from "../../components/editable-icon";
import { NewViewDialog } from "./new-view-dialog";
import { ImportLayout } from "./import-layout";
import { SCREEN_PANEL_ID, type PanelTarget } from "./screen-settings-panel";
import { NONE, chooseViewForScreen } from "../screen-role-confirm";
import { OnlineBadge, Pill, ViewPicker, viewGroups } from "./screen-panel-parts";
import { viewSurface, viewShownInSidebar, screenIsControlSurface, viewCanBeControlSurface, viewIsConsole, type ViewSurface } from "@main/types/views";
import { screensListViews } from "@main/services/home-view";
import { classifyWindow, LAGGING_ADVICE } from "@main/services/video/playback-health";

import type { SectionProps } from "../types";
import { useNameDraft } from "../../lib/use-name-draft";
import { useSortableRow } from "../../lib/use-sortable-row";
import { useVideoState } from "../../main/video/use-video-state";
import { useMessageGroups, type MessageGroups } from "../../main/use-message-groups";
import { useDisplayPresence } from "../../app/screens/use-display-presence";

/** ScreenVideoHealth.episode reduced to what the card's warning box needs to
 *  say — computed once in OutputsSection from video:state's `screens` and
 *  `feeds`, never read off VideoState directly in OutputRow, so a test can
 *  hand the row a plain object with no server behind it at all. Sourced
 *  from the pair's EPISODE (the worst window since it started struggling),
 *  never the live window fields on ScreenVideoHealth itself — the live
 *  ones dilute as an old bad sample ages out from under a sticky flag that
 *  is still holding the pair struggling, which used to leave the box
 *  describing a cause (stalls, say) already gone from what it showed. */
interface ScreenStruggle {
  feedId: string;
  feedName: string;
  droppedInWindow: number;
  decodedInWindow: number;
  stallsInWindow: number;
  width: number;
  height: number;
}

/**
 * The warning box's sentences after its bold lead, chosen by which threshold
 * the EPISODE itself crossed — classifyWindow(), the same rule
 * playback-health.ts struggles a pair on, applied to the episode's frozen
 * numbers, since an episode can be a mixed one (both crossed):
 *
 * - Dropped fraction crossed: the dropped-frames sentence, plus the
 *   resolution sentence once the feed is taller than 720p (a Pi 4's own
 *   ceiling — see the mockup's "a Pi 4 plays 1280 × 720 smoothly").
 * - Stalls alone crossed (dropped fraction did not): a different lead
 *   sentence naming the stall count and pointing at the network, with
 *   NEITHER the dropped-frames nor the resolution sentence — those are
 *   decode advice, and stalls alone say nothing about decode load.
 * - Both crossed: the dropped/resolution sentences as above, with a
 *   trailing stall sentence appended.
 */
export function struggleSentences(struggle: Omit<ScreenStruggle, "feedId" | "feedName">): string[] {
  const { droppedBad, stallsBad } = classifyWindow({
    decoded: struggle.decodedInWindow,
    dropped: struggle.droppedInWindow,
    stalls: struggle.stallsInWindow,
  });
  if (!droppedBad && stallsBad) {
    return [`This screen stalled ${struggle.stallsInWindow} times in the last minute; check its network.`];
  }
  const sentences = [`This screen dropped ${struggle.droppedInWindow} frames in the last minute.`];
  if (struggle.height > 720) {
    sentences.push(`The feed is ${struggle.width} × ${struggle.height}; a Pi 4 plays 1280 × 720 smoothly. Lower the encoder's output to 720p.`);
  }
  if (stallsBad) sentences.push(`It stalled ${struggle.stallsInWindow} times; check this screen's network.`);
  return sentences;
}

/**
 * The mockup's Home/Screens `.struggle` box, in the app's own warn callout
 * classes — the exact ones the feed editor's own delay warning uses
 * (feed-editor.tsx), so the two surfaces read as one design rather than two
 * shades of amber. Every warning under a card's preview is drawn with it.
 */
function WarnBox({ children }: { children: ReactNode }) {
  return <p className="mx-3 mt-2 rounded-lg bg-warn-9/14 px-2.5 py-2 text-caption1 text-warn-11">{children}</p>;
}

/** A feed this screen is struggling to play. Its sentences are struggleSentences()'s. */
function ScreenStruggleBox({ struggle }: { struggle: ScreenStruggle }) {
  return (
    <WarnBox>
      <span className="font-semibold">Struggling with {struggle.feedName}.</span> {struggleSentences(struggle).join(" ")}
    </WarnBox>
  );
}

/** A pair's lagging episode reduced to what its card box says: the worst
 *  jitter buffer figure, in ms. From the EPISODE, never the live
 *  window, for the same reason ScreenStruggle is (see it). */
interface ScreenLag {
  feedId: string;
  feedName: string;
  holdingMs: number;
}

/**
 * The warn box for a feed this screen is holding delay for in its own browser.
 * The lead names how much; the sentence after says where to look, and claims
 * no more than the figures show (see LAGGING_ADVICE).
 */
function ScreenLagBox({ lag }: { lag: ScreenLag }) {
  return (
    <WarnBox>
      <span className="font-semibold">
        Holding {(lag.holdingMs / 1000).toFixed(1)} s of {lag.feedName} in its own buffer.
      </span>{" "}
      {LAGGING_ADVICE}
    </WarnBox>
  );
}

/**
 * The warn box for an output of a Mac output helper that is falling behind, under
 * the preview with the two above. The figures come from the output's own health
 * report, so it names the port, says what the report shows and what to check.
 */
function OutputStruggleBox({ struggle }: { struggle: OutputStruggle }) {
  return (
    <WarnBox>
      <span className="font-semibold">Struggling on {struggle.port}.</span> {outputStruggleSentences(struggle).join(" ")}
    </WarnBox>
  );
}

export interface OutputRowProps {
  output: Output;
  views: View[];
  /** Base origin for this display's URL — the configured public URL or the current origin. */
  baseUrl: string;
  /** Whether a live kiosk page is currently connected for this output. */
  online: boolean;
  /** This screen's own currently-struggling feeds — usually zero or one,
   *  more than one only for a layout with several Video widgets at once.
   *  Empty, never undefined, so the card never needs an extra branch for
   *  "no video state yet". */
  struggles: ScreenStruggle[];
  /** This screen's own currently-lagging feeds, the same way, from the
   *  pair's lagging episode. */
  lags: ScreenLag[];
  /** The output of a Mac output helper showing this screen, when it is falling
   *  behind. Absent otherwise, which is every screen with no such output. */
  outputStruggle?: OutputStruggle;
  canRemove: boolean;
  onRename: (name: string) => void;
  /** This display's icon tint, or undefined for the theme default. */
  iconColor?: string;
  /** Where this card's icon is stored — the view id for a control surface, so it
   *  is the same entry the sidebar tab uses; the output id otherwise. */
  iconKey: string;
  /** Where it was stored before that key moved, if it did. Undefined when the two
   *  are the same key. Read as a fallback, migrated on the next write. */
  legacyIconKey?: string;
  onSetView: (viewId: string | null, expectSurface?: ViewSurface) => void;
  /** Rename the view this screen is showing (not the screen). */
  onRenameView: (viewId: string, name: string) => void;
  /** The message groups that exist, and whether they have been read. The card
   *  draws the ones this screen is in as chips under its name; choosing them is
   *  the Screen settings panel's job. */
  messageGroups: MessageGroups;
  /** The panel follows the operator: a click on the card moves it to this screen. */
  panelOpen: boolean;
  /** Move the panel to this screen (also from the card's menu). */
  onSelect: () => void;
  /** This screen's panel is open: the card says which one it is for. */
  selected?: boolean;
  onRefresh: () => void;
  /** Ask, then remove the screen. */
  onRemove: () => void;
  /** Open the layout editor for this display's view. Absent when it has no
   *  free-form layout to edit (every kind except "custom"). */
  onEditLayout?: () => void;
  onRequestNewView: (surface: ViewSurface) => void;
}

/**
 * Where a screen's icon lives.
 *
 * A screen showing a CONTROL SURFACE is, to the operator, the same thing as the
 * console tab in the sidebar — so both use the view's key and there is one icon
 * between them. Anything else is a screen in its own right and keys by its id.
 */
export function iconKeyFor(output: { id: string; viewId?: string | null }, views: View[]): string {
  if (!output.viewId) return output.id;
  const view = views.find((v) => v.id === output.viewId);
  return view && viewSurface(view) === "console" ? view.id : output.id;
}

/**
 * Where this screen's icon is stored, where it USED to be, and the entry in hand.
 *
 * The key above MOVED for a console-surface screen — from the output id to the
 * view id — and moved with no fallback and no migration, so an operator's tint
 * reverted to the theme accent and the entry they had set was read by nothing.
 * The old key is still read, and the next write moves the value onto the new one
 * (see `IconTint`); reading may not save.
 *
 * A function rather than an expression in the card's props because it is asserted
 * on: the version that lived inline could only be checked by rendering the whole
 * section, so it was not checked at all.
 */
export function resolveIconEntry(
  output: { id: string; viewId?: string | null },
  views: View[],
  entries: Record<string, string> | undefined,
): { key: string; legacyKey?: string; value?: string } {
  const key = iconKeyFor(output, views);
  const legacyKey = key === output.id ? undefined : output.id;
  return { key, legacyKey, value: iconEntryAt(entries, key, legacyKey) };
}

/** A checkbox row in a view card's overflow menu: the checkmark column, then the label. */
function MenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={MENU_ITEM}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <DropdownMenu.ItemIndicator>
          <CheckIcon className="size-3.5 text-accent" />
        </DropdownMenu.ItemIndicator>
      </span>
      {children}
    </DropdownMenu.CheckboxItem>
  );
}

/** A card's name box: it reads as the card's title until it is focused for renaming. */
const CARD_NAME_INPUT = "h-auto flex-1 min-w-0 rounded-md border-0 bg-transparent px-1 -mx-1 py-0 text-callout font-semibold leading-tight text-fg focus:bg-fill focus:ring-0";

/** The `data-flash-id` of one screen's card, so a screen just made can be scrolled
 *  to and outlined (see flashTarget). */
export const screenFlashId = (outputId: string): string => `screen-${outputId}`;

/** The views a screen picker lists: Home left out, sorted by name. The cards and
 *  the Screen settings panel offer the same list, so it is built in one place. */
export function screenPickerViews(views: readonly View[]): View[] {
  return screensListViews(views).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Did a click land on one of the card's own controls: the view picker, Open, the
 * menu, the icon colour? Those keep doing their own job and do not also move the
 * panel. `data-retarget` marks the few controls that do both: the name, which
 * focuses for renaming, and the preview.
 *
 * A click inside something rendered in a portal (a menu, a dialog) is React-bubbled
 * to the card but is not in it, and is none of the card's business.
 */
export function landedOnOwnControl(e: { target: EventTarget; currentTarget: Element }): boolean {
  const target = e.target as Element;
  if (!e.currentTarget.contains(target)) return true;
  const control = target.closest("a, button, select, input, textarea, [role='menu'], [role='menuitem']");
  if (!control || !e.currentTarget.contains(control)) return false;
  return !control.matches("[data-retarget]");
}

/**
 * What makes a card selectable while the side panel follows the operator: a click
 * on it that is not on one of its own controls selects it, and the selected card
 * is ringed. Closed, the card is as it always was.
 */
function selectableCard(panelOpen: boolean, selected: boolean, onSelect: () => void) {
  return {
    onClick: (e: ReactMouseEvent<HTMLElement>) => { if (panelOpen && !landedOnOwnControl(e)) onSelect(); },
    className: cn(selected ? "border-accent ring-1 ring-inset ring-accent/55" : "border-line", panelOpen && "cursor-pointer"),
  };
}

/**
 * The card menu's hand-off of focus to the panel. The menu traps focus while it is
 * open, so the panel cannot take it until the menu has finished closing; without
 * this focus lands back on the card's trigger. `request` marks the item that opens
 * the panel, so every other item leaves focus where it belongs.
 */
function useMenuFocusHandoff() {
  const opening = useRef(false);
  return {
    request: () => { opening.current = true; },
    onCloseAutoFocus: (e: Event) => {
      if (!opening.current) return;
      e.preventDefault();
      opening.current = false;
      document.getElementById(SCREEN_PANEL_ID)?.focus({ preventScroll: true });
    },
  };
}

// One card per display: the name reads as a title, the View it shows is the one
// prominent control, and Open stays in reach. Refresh and Remove tuck into the
// overflow menu so they don't compete; everything that is a setting is in the panel.
export function OutputRow({ output, views, baseUrl, online, struggles, lags, outputStruggle, canRemove, iconColor, iconKey, legacyIconKey, onRename, onRenameView, onSetView, messageGroups, panelOpen, onSelect, selected, onRefresh, onRemove, onEditLayout, onRequestNewView }: OutputRowProps) {
  const name = useNameDraft(output.name, onRename);
  const assignedView = views.find((v) => v.id === output.viewId) ?? null;
  const [renamingView, setRenamingView] = useState(false);
  const [viewName, setViewName] = useState("");

  const { setNodeRef, style, dragA11y, listeners } = useSortableRow(output.id);

  // This screen's groups, in the config's order. An id the config no longer holds
  // (a group deleted since) names nothing and draws nothing; the server takes it
  // off the screen when the group is deleted.
  const screenGroups = messageGroups.groups.filter((g) => output.groups?.includes(g.id));

  const outputUrl = `${baseUrl}/${encodeURIComponent(output.id)}`;

  const [nameFocused, setNameFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const handoff = useMenuFocusHandoff();
  const card = selectableCard(panelOpen, selected ?? false, onSelect);

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-flash-id={screenFlashId(output.id)}
      onClick={card.onClick}
      className={cn("flex flex-col overflow-hidden rounded-xl border bg-surface shadow-[var(--su-shadow-1)]", card.className)}
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
          {/* Keyed by the VIEW when this screen shows a control surface, so the
              card and that console's tab in the sidebar are one entry. They used
              to be two — the card by output id, the tab by view id, with the tab
              preferring its own — so setting the icon on the card moved nothing
              if the tab had ever been set. One key, no precedence to reason
              about. A screen showing a wall-screen view keeps its own key: it is
              a screen, not a thing the sidebar lists. */}
          <IconTint itemKey={iconKey} legacyKey={legacyIconKey} icon={MonitorIcon} color={iconColor} label={output.name} />
        </span>
        <Input
          value={name.draft}
          onChange={(e: ChangeEvent<HTMLInputElement>) => name.setDraft(e.target.value)}
          onBlur={() => { setNameFocused(false); name.commit(); }}
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
          className={CARD_NAME_INPUT}
          aria-label="Display name"
          // A click here focuses the name for renaming AND moves the panel.
          data-retarget
        />
        {screenIsControlSurface(output, views) && (
          <Tooltip label="A control surface: controls on this screen are live">
            <span><Pill tone="accent">panel</Pill></span>
          </Tooltip>
        )}
        <Tooltip label={online ? "A screen is connected to this display" : "No screen is currently connected"}>
          <OnlineBadge online={online} />
        </Tooltip>

        {/* Actions only: opening, renaming the view, copying the address,
            refresh, and remove. Settings are in the Screen settings panel. The
            card face keeps what an operator changes while working — what it
            shows, and the way into its layout. */}
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
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className={menuContent()}
              onCloseAutoFocus={handoff.onCloseAutoFocus}
            >
              {/* Opens the SAME address the "Open" link below does. This used
                  to go through a handler that built the URL from
                  window.location.origin, while the link used `baseUrl` —
                  publicUrl when one is set. Two controls for one action, landing
                  on two different hosts the moment a friendly URL was
                  configured. The window is still named, so clicking twice
                  reuses the tab rather than stacking them up. */}
              <DropdownMenu.Item
                onSelect={() => window.open(outputUrl, `display-${output.id}`)}
                className={MENU_ITEM}
              >
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
                    else toast.error("Couldn't copy — open Screen settings to see the address");
                  });
                }}
                className={MENU_ITEM}
              >
                <CopyIcon className="size-3.5 text-fg-subtle" />
                Copy URL
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={onRefresh} className={MENU_ITEM}>
                <RefreshCwIcon className="size-3.5 text-fg-subtle" />
                Refresh display
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              {/* Everything that is a SETTING lives in the panel: the role, the
                  lock, the top bar, HLS, the message groups, the friendly link.
                  This menu is actions. */}
              <DropdownMenu.Item
                onSelect={() => {
                  handoff.request();
                  onSelect();
                }}
                className={MENU_ITEM}
              >
                <SlidersHorizontalIcon className="size-3.5 text-fg-subtle" />
                Screen settings…
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item
                onSelect={onRemove}
                disabled={!canRemove}
                className={MENU_ITEM_DANGER}
              >
                <TrashIcon className="size-3.5" />
                Remove display…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* The message groups this screen is in. Under the name, small: it is
          context for the screen, not something to work from. */}
      {screenGroups.length > 0 && (
        <ul data-testid="screen-groups" aria-label="Message groups" className="flex flex-wrap gap-1 px-3 pt-1.5">
          {screenGroups.map((g) => (
            <li key={g.id} className="rounded-full border border-line bg-fill px-2 py-0.5 text-caption2 text-fg-muted">
              {g.name}
            </li>
          ))}
        </ul>
      )}

      {/* A LIVE preview: the real kiosk renderers in an iframe, scaled. It only
          mounts once the card is on screen — eight iframes booting at once each
          fetch state and open a stream, which timed out the server on a real
          install with eight displays. */}
      <div className="pt-2">
        {output.viewId ? (
          // The preview IS the display, so clicking it opens the real thing in a
          // new tab - the same place the menu's "Open display" goes. An anchor
          // rather than an onClick so it behaves like a link: middle-click and
          // cmd-click open a tab, and the URL shows in the status bar on hover.
          // The preview iframe sets pointer-events:none, so the click lands here.
          <LazyPreview
            viewId={output.viewId}
            // This card IS a screen, so its preview speaks for that screen and
            // not merely for the View behind it. It is what makes the Top bar
            // switch in Screen settings visibly do something: the card loses
            // its bar too.
            outputId={output.id}
            onExpand={onEditLayout}
            expandLabel={`Edit what ${output.name} shows`}
            following={panelOpen ? { label: `Show settings for ${output.name}`, onOpenDisplay: () => window.open(outputUrl, `display-${output.id}`) } : undefined}
          />
        ) : (
          <div className="grid aspect-video place-items-center border-y border-dashed border-line text-caption1 text-fg-subtle">
            Nothing assigned
          </div>
        )}
      </div>

      {/* A screen currently struggling with a feed, and what to change — see
          ScreenStruggleBox's own comment. Under the preview, as the
          approved mockup's Home/Screens tab has it. Usually zero or one; a
          layout with several Video widgets can show more than one box. */}
      {struggles.map((s) => (
        <ScreenStruggleBox key={s.feedId} struggle={s} />
      ))}
      {/* A feed this screen is holding delay for in its own browser — see
          ScreenLagBox. Separate from the struggle box: a screen can be either
          or both, and each says something different to do. */}
      {lags.map((l) => (
        <ScreenLagBox key={l.feedId} lag={l} />
      ))}
      {outputStruggle && <OutputStruggleBox struggle={outputStruggle} />}

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
        {/* The sentinels open the new-view dialog for that kind of view, and the view
            made is assigned on the way back, rather than a sentinel id going to the
            server as a real value. Picking a view of the other kind than the screen
            shows asks first: the view is what makes the screen a control surface. */}
        <ViewPicker
          groups={viewGroups(views)}
          value={output.viewId ?? NONE}
          onChange={(value) => void chooseViewForScreen({ output, views, value, setView: onSetView, requestNewView: onRequestNewView })}
          noneLabel="— Unrouted —"
          placeholder="Pick a view"
          ariaLabel={`View on ${output.name}`}
          triggerClassName={cn(
            "h-7 w-auto min-w-0 max-w-[70%] truncate rounded-lg border-transparent px-2.5 text-footnote font-medium",
            output.viewId ? "bg-fill text-fg" : "bg-warn-9/15 text-warn-11",
          )}
        />
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

      {/* The machine showing this screen, when one is bound. Nothing when it is
          a browser tab somebody opened. */}
      <ScreenDevice outputId={output.id} name={output.name} videoMode={output.videoMode} />
    </div>
  );
}

// A view nothing is showing. Same card shape as a screen so the page has one
// visual vocabulary, but deliberately WITHOUT the screen affordances - no URL,
// no presence dot, no lock, no open-in-a-window - because it is not a screen.
// That absence is what distinguishes the two, rather than a grey wash.
function UnassignedViewCard({
  view,
  panelOpen,
  selected,
  onSelect,
  onRename,
  onDuplicate,
  onToggleSurface,
  onSetShowInSidebar,
  onRemove,
  onEditLayout,
}: {
  view: View;
  /** The panel follows the operator: a click on the card moves it to this view. */
  panelOpen: boolean;
  selected: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onToggleSurface: () => void;
  /** List this console in the sidebar, or keep it out. */
  onSetShowInSidebar: (show: boolean) => void;
  /** Ask, then delete the view. */
  onRemove: () => void;
  onEditLayout?: () => void;
}) {
  const name = useNameDraft(view.name, onRename);
  const handoff = useMenuFocusHandoff();
  const isControl = viewIsConsole(view);
  const card = selectableCard(panelOpen, selected, onSelect);

  return (
    <div
      onClick={card.onClick}
      className={cn("flex flex-col overflow-hidden rounded-xl border border-dashed bg-surface", card.className)}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <LayoutGridIcon className="size-4 shrink-0 text-accent" aria-hidden="true" />
        <Input
          value={name.draft}
          onChange={(e: ChangeEvent<HTMLInputElement>) => name.setDraft(e.target.value)}
          onBlur={name.commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          // A click here focuses the name for renaming AND moves the panel.
          data-retarget
          className={CARD_NAME_INPUT}
          aria-label="View name"
        />
        <Pill tone={isControl ? "accent" : "muted"}>{isControl ? "control surface" : "wall"}</Pill>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="touch-target shrink-0 rounded-md p-1 text-fg-subtle hover:bg-fill hover:text-fg" aria-label={`More actions for ${view.name}`}>
              <MoreVerticalIcon className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className={menuContent()}
              align="end"
              sideOffset={4}
              onCloseAutoFocus={handoff.onCloseAutoFocus}
            >
              <DropdownMenu.Item
                onSelect={() => {
                  handoff.request();
                  onSelect();
                }}
                className={MENU_ITEM}
              >
                <SlidersHorizontalIcon className="size-3.5 text-fg-subtle" />
                View settings…
              </DropdownMenu.Item>
              {/* Only a kind with something to operate can be a console. */}
              {viewCanBeControlSurface(view) && (
                <DropdownMenu.Item onSelect={onToggleSurface} className={MENU_ITEM}>
                  {isControl
                    ? <MonitorIcon className="size-3.5 text-fg-subtle" />
                    : <HandIcon className="size-3.5 text-fg-subtle" />}
                  {isControl ? "Make it a wall view" : "Make it a control surface"}
                </DropdownMenu.Item>
              )}
              {/* A console on no screen has no Screen settings panel to hold this
                  switch, so it is here. A screen's panel writes the same flag. */}
              {isControl && (
                <MenuCheckboxItem checked={viewShownInSidebar(view)} onCheckedChange={onSetShowInSidebar}>
                  Show in the sidebar
                </MenuCheckboxItem>
              )}
              <DropdownMenu.Item onSelect={onDuplicate} className={MENU_ITEM}>
                <CopyIcon className="size-3.5 text-fg-subtle" />
                Duplicate view
              </DropdownMenu.Item>
              <DropdownMenu.Item
                // Asked first, because deleting a view cannot be undone and this
                // item sits directly under "Duplicate view".
                onSelect={onRemove}
                className={MENU_ITEM_DANGER}
              >
                <TrashIcon className="size-3.5" />
                Delete view…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <div className="pt-2">
        <LazyPreview
          viewId={view.id}
          onExpand={onEditLayout}
          expandLabel={`Edit ${view.name}`}
          following={panelOpen ? { label: `Show settings for ${view.name}` } : undefined}
        />
      </div>

      <div className="px-3 py-2.5 text-footnote text-fg-muted">
        {isControl && viewShownInSidebar(view) ? "In the sidebar · on no screen" : "On no screen"}
      </div>
    </div>
  );
}

export function OutputsSection({
  stageState,
  handlers,
  onEditLayout,
  panelOpen,
  selected,
  onSelect,
  onAddScreen,
  onRequestNewView,
  onRemoveScreen,
  onDeleteView,
  serviceTypes = [],
  banner,
}: Pick<SectionProps, "stageState" | "handlers"> & {
  /** Something to say above the cards, under the hint: the Screens page's banner
   *  for screens found that are not set up. */
  banner?: ReactNode;
  /** The side panel is open and follows the operator: a click on a card moves it. */
  panelOpen: boolean;
  /** What the panel is on, so its card says so. Null when it is closed. */
  selected: PanelTarget | null;
  /** Move the panel to a screen or a view. Also opens it. */
  onSelect: (target: PanelTarget) => void;
  /** Open the panel in guided mode. Nothing is made until it finishes. */
  onAddScreen: () => void;
  /** A screen's picker asked for a new view of this kind. */
  onRequestNewView: (outputId: string, surface: ViewSurface) => void;
  /** Ask, then remove a screen. */
  onRemoveScreen: (outputId: string) => void;
  /** Ask, then delete a view. */
  onDeleteView: (viewId: string) => void;
  /** For a plan import's service type picker. Defaulted so the one other
   *  caller — none today — is not forced to thread it. */
  serviceTypes?: SectionProps["serviceTypes"];
  /** Open the layout editor for a view. Absent when there is nowhere to open. */
  onEditLayout?: (viewId: string) => void;
}) {
  const outputs = stageState.outputs ?? [];
  // Sorted by name. Manual view ordering used to exist and only ever sorted
  // THIS dropdown - nothing else read the order - so it was dropped in favour of
  // an order that needs no maintaining. See docs/design/app-shell-redesign.md.
  // Home is filtered out: it is the operator's front door, edited in its own
  // tab, and it has no geometry — see main/services/home-view.ts.
  const views = screenPickerViews(stageState.views ?? []);

  // The page's own New view button: a view for nobody in particular, so the dialog
  // asks what kind. (A screen's picker asks for one through onRequestNewView.)
  const [creatingView, setCreatingView] = useState(false);

  // A view no screen points at. Without a home these are unreachable: the only
  // way in was the Views list this page replaced.
  const assigned = new Set(outputs.map((o) => o.viewId).filter(Boolean));
  const unassigned = views.filter((v) => !assigned.has(v.id));
  // Prefer the configured public URL (DNS) so display links match what operators
  // actually browse to; fall back to the current origin.
  const baseUrl = stageState.publicUrl || window.location.origin;

  // Live per-display presence (Connected/Offline dot). The server broadcasts the
  // connected-output set on change; kiosk pages heartbeat to keep it fresh.
  const connected = useDisplayPresence();

  // Every screen's own struggling feeds, keyed by outputId — the same
  // change-driven video:state channel the Video feeds page and every Video
  // widget already subscribe to (use-video-state.ts), never a second fetch
  // path. Only the STRUGGLING entries with an episode to show: a screen
  // playing every feed cleanly gets no box at all, and `episode` is null
  // exactly then (see ScreenVideoHealth's own comment) — never read off the
  // live window fields, which dilute out from under a still-struggling pair.
  const video = useVideoState();
  // The same for an output of a Mac output helper: whether its own last health
  // report says it is falling behind, by the screen it shows.
  const { bound, health: outputHealth } = useDevices();
  const outputStruggles = struggleByScreen(bound, outputHealth);
  // The message groups, for the Groups menu and the chips. Live, so a group
  // renamed or deleted in Settings reaches an open Screens page.
  const messageGroups = useMessageGroups();
  const strugglesByOutput = new Map<string, ScreenStruggle[]>();
  const lagsByOutput = new Map<string, ScreenLag[]>();
  for (const health of video?.screens ?? []) {
    const feedName = video?.feeds.find((f) => f.id === health.feedId)?.name ?? health.feedId;
    if (health.struggling && health.episode) {
      const list = strugglesByOutput.get(health.outputId) ?? [];
      list.push({
        feedId: health.feedId,
        feedName,
        droppedInWindow: health.episode.droppedInWindow,
        decodedInWindow: health.episode.decodedInWindow,
        stallsInWindow: health.episode.stallsInWindow,
        width: health.episode.width,
        height: health.episode.height,
      });
      strugglesByOutput.set(health.outputId, list);
    }
    // Lagging reads its own episode the same way, for the same reason.
    if (health.lagging && health.laggingEpisode) {
      const list = lagsByOutput.get(health.outputId) ?? [];
      list.push({ feedId: health.feedId, feedName, holdingMs: health.laggingEpisode.jitterBufferMs });
      lagsByOutput.set(health.outputId, list);
    }
  }

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
    // No bottom runway here. The one page that renders this, Screens, ends in its
    // own pb-[50vh], and a second one in here pushed "Not set up yet" half a screen
    // below the buttons it follows.
    <div data-flash-id="displays-list" className="flex flex-col gap-4 pt-5 max-sm:pt-4">
      <p className="text-caption1 text-gray-9">
        Each one is a physical screen at its own address. Click one to see its settings.
      </p>

      {banner}

      <DndContext sensors={handlers.sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        {/* A GRID, not a column. Full-width rows made each card a page of its
            own and buried the thing the page is for - comparing screens at a
            glance. rectSortingStrategy is the grid-aware counterpart to the
            vertical strategy; the vertical one assumes a single column and
            computes the wrong drop target as soon as there are two. */}
        <SortableContext items={outputs.map((o) => o.id)} strategy={rectSortingStrategy}>
          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
            {outputs.map((output) => {
              // Once per row, not twice: it scans every view to answer, and the
              // colour and the glyph are the same question asked about the same
              // screen — they cannot be allowed to answer differently either.
              const icon = resolveIconEntry(output, stageState.views, stageState.iconColors);
              return (
              <OutputRow
                key={output.id}
                output={output}
                views={views}
                baseUrl={baseUrl}
                online={connected.has(output.id)}
                struggles={strugglesByOutput.get(output.id) ?? []}
                lags={lagsByOutput.get(output.id) ?? []}
                outputStruggle={outputStruggles.get(output.id)}
                canRemove={outputs.length > 1}
                iconColor={icon.value}
                iconKey={icon.key}
                legacyIconKey={icon.legacyKey}
                onRename={(name) => handlers.handleRenameOutput(output.id, name)}
                onRenameView={(viewId, name) => handlers.handleRenameView(viewId, name)}
                onSetView={(viewId, expectSurface) => handlers.handleSetOutputView(output.id, viewId, expectSurface)}
                messageGroups={messageGroups}
                panelOpen={panelOpen}
                onSelect={() => onSelect({ kind: "edit", outputId: output.id })}
                selected={selected?.kind === "edit" && selected.outputId === output.id}
                onRefresh={() => handlers.handleRefreshDisplay(output.id)}
                onRemove={() => onRemoveScreen(output.id)}
                onRequestNewView={(surface) => onRequestNewView(output.id, surface)}
                onEditLayout={
                  // ANY assigned view, not just a custom one. The comment here
                  // used to say the built-in kinds "would open an editor with
                  // nothing to edit" — which was simply wrong: a slots view's
                  // editor is where its slot set and column positions live, and
                  // a ServiceCue view's is where its column preset is chosen.
                  // Greying this out left no way to edit a mic board at all.
                  onEditLayout && output.viewId ? () => onEditLayout(output.viewId!) : undefined
                }
              />
              );
            })}
            {/* The add tile sits IN the grid. As a button under eight cards it
                was below the fold on the page where you would want it. */}
            <button
              type="button"
              onClick={onAddScreen}
              className="grid min-h-[190px] place-items-center rounded-xl border border-dashed border-line bg-transparent p-3 text-center text-footnote text-fg-muted transition-colors hover:border-line-strong hover:bg-fill"
            >
              <span>
                <b className="block font-semibold text-fg">+ Add a screen</b>
                Point a monitor at its address
              </span>
            </button>
          </div>
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
          <p className="text-caption2 text-fg-subtle">Built, but nothing is showing them.</p>
          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
            {unassigned.map((v) => (
              <UnassignedViewCard
                key={v.id}
                view={v}
                panelOpen={panelOpen}
                selected={selected?.kind === "view" && selected.viewId === v.id}
                onSelect={() => onSelect({ kind: "view", viewId: v.id })}
                onRename={(name) => handlers.handleRenameView(v.id, name)}
                onDuplicate={() => void handlers.handleDuplicateView(v.id)}
                onToggleSurface={() =>
                  handlers.handleSetViewSurface(v.id, viewIsConsole(v) ? "display" : "console")
                }
                onSetShowInSidebar={(show) => handlers.handleSetViewShowInSidebar(v.id, show)}
                onRemove={() => onDeleteView(v.id)}
                onEditLayout={onEditLayout ? () => onEditLayout(v.id) : undefined}
              />
            ))}
          </div>
        </div>
      )}

      <NewViewDialog
        handlers={handlers}
        open={creatingView}
        onOpenChange={setCreatingView}
        trigger={<span className="hidden" />}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="transparent" size="small" onClick={() => setCreatingView(true)}>
          <PlusIcon className="size-3.5 text-gray-9" />
          New view
        </Button>
        {/* Beside New view because an imported view IS a new view — it arrives
            where you would look for one. */}
        <ImportLayout serviceTypes={serviceTypes} currentServiceTypeId={stageState.serviceTypeId ?? null} />
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
    </div>
  );
}
