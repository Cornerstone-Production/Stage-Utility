// The sidebar in Customize mode: the same sections and rows, made editable in
// place.
//
// Rows here are NOT buttons. Outside the mode a row is a <button> that
// navigates, and the × and the grip would be a button inside a button: invalid
// markup whose outer control swallows the click (console-rail-icon.tsx carries
// that scar). In the mode a row does not navigate, so it is a plain element that
// drags, with real buttons inside it.
//
// The drag itself lives in use-rail-drag.ts, under the provider the tray shares;
// this file registers what can be dragged and draws the caret where it says.
//
// Rows and headings carry DRAGGABLE (drag-parts.tsx): in the mode the list is
// taller than a phone, and a finger has to be able to scroll it, so a touch drag
// starts only after a still hold.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ChevronRightIcon, GripVerticalIcon, ImageIcon, LockIcon, PaletteIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";

import { LOCKED_PAGE, type SidebarSection } from "@main/services/sidebar-arrangement";
import { BrandLogo } from "../components/brand-logo";
import { DropdownMenu } from "radix-ui";
import { MENU_ITEM, menuContent } from "../components/ui";
import { MAX_APP_NAME } from "@main/services/app-name";
import { useSidebarChrome } from "../components/ui/sidebar";
import { cn } from "../lib/cn";
import { useStageState } from "../main/use-stage-state";
import { BRANDING_HREF, REPLACE_LOGO_HREF } from "../settings/sections/branding-links";
import { useCustomize } from "./customize-mode";
import { Caret, DRAGGABLE } from "./drag-parts";
import type { RailDrag } from "./rail-drop";
import type { Destination } from "./destinations";
import { setBranding } from "./set-branding";
import { removedSectionMessage, removeSection, renameSection } from "./sidebar-edits";

const X_BUTTON =
  "grid size-5 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-fg-muted " +
  "transition-opacity duration-(--motion-instant) hover:border-danger-11 hover:text-danger-11 focus-visible:opacity-100 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** On a control inside a draggable row or heading: a press there is the
 *  control's, and must not start the drag the sensors would read from it. */
const stopDrag = (e: { stopPropagation: () => void }) => e.stopPropagation();
const NO_DRAG = { onPointerDown: stopDrag, onMouseDown: stopDrag, onTouchStart: stopDrag };

/** A row's grip: one 14 px column shared with the headings. */
function Grip() {
  return (
    <span aria-hidden="true" className="grid size-3.5 shrink-0 place-items-center text-fg-subtle">
      <GripVerticalIcon className="size-3.5" />
    </span>
  );
}

export function RailEditor({
  byId,
  marksFor,
}: {
  byId: ReadonlyMap<string, Destination>;
  marksFor: (d: Destination) => { badge?: ReactNode; ariaLabel?: string };
}) {
  const customize = useCustomize();
  const { resolved, aim, listRef } = customize;
  const [renaming, setRenaming] = useState<string | null>(null);

  /** The name field opens on the new section once it has saved: a refused one is
   *  not there to name. */
  async function addNew() {
    const id = await customize.addSection();
    if (id) setRenaming(id);
  }

  return (
    <>
      <BrandEditor />
      <div ref={listRef} className="relative flex flex-col gap-0.5 px-2 pt-0.5 pb-3">
        {resolved.sections.map((section) => (
          <SectionEditor
            key={section.id}
            section={section}
            byId={byId}
            marksFor={marksFor}
            renaming={renaming === section.id}
            onRename={() => setRenaming(section.id)}
            onRenamed={(label) => {
              setRenaming(null);
              if (label !== null) customize.apply((r) => renameSection(r, section.id, label));
            }}
          />
        ))}
        <button
          type="button"
          data-rail-add
          onClick={() => void addNew()}
          className="mt-3.5 flex h-8 items-center gap-2 rounded-lg border border-dashed border-line-strong px-2.5 text-[12.5px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <PlusIcon className="size-3.5" />
          New section
        </button>
        {aim.caretY !== null && <Caret along="column" at={aim.caretY} />}
      </div>
    </>
  );
}

function SectionEditor({
  section,
  byId,
  marksFor,
  renaming,
  onRename,
  onRenamed,
}: {
  section: SidebarSection;
  byId: ReadonlyMap<string, Destination>;
  marksFor: (d: Destination) => { badge?: ReactNode; ariaLabel?: string };
  renaming: boolean;
  onRename: () => void;
  /** The new name, or null when the rename was abandoned. */
  onRenamed: (label: string | null) => void;
}) {
  const { apply, drag, aim } = useCustomize();
  // A phone has no hover, so its × buttons are always shown.
  const { isMobile: alwaysShowX } = useSidebarChrome();
  const litDz = aim.dz === section.id;
  const { setNodeRef: headRef, attributes: headAttributes, listeners: headListeners } = useDraggable({ id: `head:${section.id}`, data: { kind: "head", id: section.id } satisfies RailDrag });
  const movingThis = drag?.kind === "head" && drag.id === section.id;
  const rows = section.members.map((id) => byId.get(id)).filter((d): d is Destination => d !== undefined);
  return (
    <div className={cn("flex flex-col gap-0.5", movingThis && "opacity-35")}>
      {section.kind !== "top" && (
        <div
          ref={headRef}
          {...headAttributes}
          {...headListeners}
          role="group"
          aria-label={`${section.label} section`}
          data-rail-item="head"
          data-section={section.id}
          className={cn(DRAGGABLE, "group mt-3.5 mb-0.5 flex h-[26px] items-center gap-2 rounded-md pl-1 pr-2 text-[10px] font-medium uppercase leading-3 tracking-[0.07em] text-fg-muted hover:bg-fill")}
        >
          <Grip />
          {renaming ? (
            <RenameField initial={section.label} onDone={onRenamed} />
          ) : (
            <button
              type="button"
              onClick={onRename}
              {...NO_DRAG}
              title="Rename"
              className="-ml-1 min-w-0 flex-1 cursor-text truncate rounded px-1 py-[3px] text-left uppercase tracking-[inherit] hover:bg-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {section.label}
            </button>
          )}
          {section.kind === "consoles" ? (
            <span title="New consoles appear here" className="rounded px-[5px] py-0.5 text-[9.5px] normal-case tracking-[0.04em] bg-fill text-fg-muted">
              Automatic
            </span>
          ) : (
            <button
              type="button"
              aria-label={`Remove section ${section.label}`}
              onClick={() => apply((r) => removeSection(r, section.id), removedSectionMessage(section), true)}
              {...NO_DRAG}
              className={cn(X_BUTTON, alwaysShowX ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
            >
              <XIcon className="size-[11px]" strokeWidth={2.2} />
            </button>
          )}
        </div>
      )}
      {rows.map((d) => (
        <RowEditor key={d.id} d={d} {...marksFor(d)} section={section.id} />
      ))}
      {section.kind !== "top" && rows.length === 0 && (
        <div
          data-rail-item="dz"
          data-section={section.id}
          className={cn(
            "my-0.5 grid h-[34px] place-items-center rounded-lg border border-dashed text-[12px]",
            litDz ? "border-accent bg-accent-soft text-accent" : "border-line-strong text-fg-subtle",
          )}
        >
          {section.kind === "consoles" ? "New consoles appear here" : "Drag pages here"}
        </div>
      )}
    </div>
  );
}

function RowEditor({
  d,
  badge,
  ariaLabel,
  section,
}: {
  d: Destination;
  badge?: ReactNode;
  ariaLabel?: string;
  section: string;
}) {
  const customize = useCustomize();
  const { isMobile: alwaysShowX } = useSidebarChrome();
  const dragging = customize.drag?.kind === "row" && customize.drag.id === d.id;
  const { setNodeRef, attributes, listeners } = useDraggable({ id: `row:${d.id}`, data: { kind: "row", id: d.id } satisfies RailDrag });
  const locked = d.id === LOCKED_PAGE;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="listitem"
      aria-label={ariaLabel ?? d.label}
      data-rail-item="row"
      data-section={section}
      data-id={d.id}
      className={cn(
        DRAGGABLE,
        "group relative flex h-[34px] items-center gap-2 rounded-lg pl-1 pr-2 text-[13.5px] font-medium text-fg hover:bg-fill",
        dragging && "opacity-35",
      )}
    >
      <Grip />
      <span className="size-4 shrink-0 text-fg-muted">{d.icon}</span>
      <span className="min-w-0 flex-1 truncate">{d.label}</span>
      {badge && <span aria-hidden="true">{badge}</span>}
      {locked ? (
        <span title="Advanced stays in the sidebar: it carries update and server warnings" className="grid size-5 place-items-center text-fg-subtle">
          <LockIcon className="size-3" />
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Hide ${d.label}`}
          onClick={() => customize.hide(d.id, d.label)}
          {...NO_DRAG}
          className={cn(X_BUTTON, alwaysShowX ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
        >
          <XIcon className="size-[11px]" strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}

/** A heading's name, edited in place. Enter or leaving saves; Escape abandons. */
function RenameField({ initial, onDone }: { initial: string; onDone: (label: string | null) => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  function finish(label: string | null) {
    if (finished.current) return;
    finished.current = true;
    onDone(label);
  }
  return (
    <input
      ref={ref}
      value={text}
      maxLength={40}
      aria-label="Section name"
      onChange={(e) => setText(e.target.value)}
      {...NO_DRAG}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(text);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(text)}
      className="-ml-1 h-[22px] min-w-0 flex-1 rounded border border-focus bg-surface px-[5px] text-[11px] font-medium uppercase leading-none tracking-[0.04em] text-fg focus:outline-none"
    />
  );
}

/**
 * The app name and logo, edited where they are drawn. The name IS Branding's
 * App name, saved by the same handler; the logo's menu opens Branding's own
 * picker and sets its Recolor setting. Accent colour stays in Branding.
 */
function BrandEditor() {
  const { state } = useStageState();
  const queryClient = useQueryClient();
  const router = useRouter();
  const customize = useCustomize();
  const saved = state?.appName ?? "Stage Utility";
  const [name, setName] = useState(saved);
  const editing = useRef(false);

  // Follow the saved name while the field is not being typed in: a change made
  // on Branding, or in another browser, shows here.
  useEffect(() => {
    if (!editing.current) setName(saved);
  }, [saved]);

  async function commitName() {
    editing.current = false;
    const trimmed = name.trim();
    if (!trimmed || trimmed === saved) {
      setName(saved);
      return;
    }
    // As Branding's own field does: a refused save puts the saved name back,
    // rather than leaving a name in the field that the app does not have.
    if (!(await setBranding(queryClient, { name: trimmed }))) setName(saved);
  }

  function goToBranding(href: string) {
    customize.done();
    router.history.push(href);
  }

  const mono = state?.appLogoMonochrome ?? true;
  return (
    <div className="relative flex min-h-[54px] items-center gap-2.5 px-3 pt-3 pb-2.5">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Logo options"
            className="relative grid size-7 shrink-0 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {state?.appLogo ? (
              <BrandLogo logo={state.appLogo} monochrome={mono} className="size-7 rounded-md text-fg" />
            ) : (
              <span className="size-7 rounded-md bg-accent" />
            )}
            <span className="absolute -right-[5px] -bottom-[5px] grid size-4 place-items-center rounded-full border border-line-strong bg-surface text-fg">
              <PencilIcon className="size-[9px]" strokeWidth={2.2} />
            </span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} className={cn(menuContent(), "w-60")}>
            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => goToBranding(REPLACE_LOGO_HREF)}>
              <ImageIcon className="size-3.5 text-fg-muted" />
              Replace logo…
            </DropdownMenu.Item>
            <RecolorItem
              on={mono}
              hasIcon={!!state?.appIcon192}
              onNeedsBranding={() => goToBranding(BRANDING_HREF)}
            />
            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => goToBranding(BRANDING_HREF)}>
              <ChevronRightIcon className="size-3.5 text-fg-muted" />
              Open Branding
            </DropdownMenu.Item>
            <p className="mx-2 mt-1 mb-0.5 text-[11.5px] leading-[15px] text-fg-subtle">
              The name and logo are the Branding settings, edited here too.
            </p>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <input
        aria-label="App name"
        value={name}
        maxLength={MAX_APP_NAME}
        onChange={(e) => {
          editing.current = true;
          setName(e.target.value);
        }}
        onBlur={() => void commitName()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            editing.current = false;
            setName(saved);
          }
        }}
        className="-ml-1.5 h-[30px] min-w-0 flex-1 rounded-md border border-dashed border-line-strong bg-field px-1.5 text-[16px] font-semibold tracking-[-0.01em] text-fg focus:border-solid focus:border-focus focus:outline-none"
      />
    </div>
  );
}

/**
 * Branding's Recolor setting. With no home-screen icon it is one field, written
 * here as Branding writes it. Once an icon exists, Branding's switch also redraws
 * the icon in the same save, and that drawing lives on the Branding page: so
 * here it hands over to Branding rather than save a second, diverging way that
 * would leave the icon in the old colouring. Stays open when toggled, as a
 * menu's checkbox does.
 */
function RecolorItem({ on, hasIcon, onNeedsBranding }: { on: boolean; hasIcon: boolean; onNeedsBranding: () => void }) {
  const queryClient = useQueryClient();
  return (
    <DropdownMenu.CheckboxItem
      className={MENU_ITEM}
      checked={on}
      aria-label="Recolor logo to match theme"
      onSelect={(e) => {
        if (!hasIcon) e.preventDefault();
      }}
      onCheckedChange={(v) => {
        if (hasIcon) onNeedsBranding();
        else void setBranding(queryClient, { monochrome: v });
      }}
    >
      <PaletteIcon className="size-3.5 text-fg-muted" />
      <span className="flex-1">Recolor to match theme</span>
      <span
        aria-hidden="true"
        className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-fill-hover")}
      >
        <span className={cn("absolute top-0.5 left-0.5 size-3 rounded-full bg-surface shadow-(--su-shadow-1) transition-transform", on && "translate-x-3")} />
      </span>
    </DropdownMenu.CheckboxItem>
  );
}
