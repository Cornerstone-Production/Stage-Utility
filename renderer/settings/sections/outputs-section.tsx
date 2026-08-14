import { errorMessage } from "@main/services/errors";
import { useState, useEffect, type ChangeEvent, type CSSProperties } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DropdownMenu } from "radix-ui";
import { PlusIcon, TrashIcon, MonitorIcon, ExternalLinkIcon, GripVerticalIcon, RefreshCwIcon, LockIcon, LockOpenIcon, MoreVerticalIcon, CopyIcon, LinkIcon } from "lucide-react";
import { LazyPreview } from "./lazy-preview";
import { cn } from "../../lib/cn";

/** Shared menu-item styling, so the six actions cannot drift apart. */
const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-fg outline-none data-[highlighted]:bg-fill";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  toast,
} from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { IconTint } from "../../components/icon-tint";
import { invoke, onNotification } from "../../lib/api";
import type { SectionProps } from "../types";
import { useResyncOn } from "@renderer/lib/use-resync-on";

const KIND_LABELS: Record<ViewKind, string> = {
  slots: "Mic Slots",
  dashboard: "Dashboard",
  stage: "Stage",
  transcription: "Transcription",
  custom: "Custom Layout",
  script: "Script",
  "spl-rundown": "SPL Rundown",
};

const UNROUTED = "__none__";

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
  onSetLocked: (locked: boolean) => void;
  onOpenWindow: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  /** Open the layout editor for this display's view. Absent when it has no
   *  free-form layout to edit (every kind except "custom"). */
  onEditLayout?: () => void;
}

// One card per display: the name reads as a title, the View it shows is the one
// prominent control, Open + Lock stay in reach, and the URL sits quietly in the
// footer. Refresh/Remove tuck into the overflow menu so they don't compete.
function OutputRow({ output, views, baseUrl, online, canRemove, iconColor, onRename, onSetSlug, onSetView, onSetLocked, onOpenWindow, onRefresh, onRemove, onEditLayout }: OutputRowProps) {
  const [editName, setEditName] = useState(output.name);
  const [editSlug, setEditSlug] = useState(output.slug ?? "");
  const [slugError, setSlugError] = useState<string | null>(null);

  // The server is the authority on what a slug may be — a reserved page like
  // "history" wouldn't error at request time, it would silently render that page
  // instead of the display. So save, and show whatever reason comes back.
  async function handleSlugBlur() {
    const next = editSlug.trim().toLowerCase();
    if (next === (output.slug ?? "")) { setSlugError(null); return; }
    try {
      await onSetSlug(next);
      setSlugError(null);
      setEditSlug(next);
    } catch (err) {
      setSlugError(errorMessage(err));
      setEditSlug(output.slug ?? "");
    }
  }
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: output.id,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  useResyncOn([output.name], () => {
    setEditName(output.name);
  });

  useResyncOn([output.slug], () => {
    setEditSlug(output.slug ?? "");
  });

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
  const [showSlug, setShowSlug] = useState(false);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--su-shadow-1)]"
    >
      {/* Header: drag handle + tinted icon + editable name + status + overflow */}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing touch-pan-y shrink-0 text-fg-faint hover:text-fg-muted transition-colors"
          aria-label="Drag to reorder"
          tabIndex={-1}
        >
          <GripVerticalIcon className="size-4" />
        </button>
        <IconTint itemKey={output.id} icon={MonitorIcon} color={iconColor} label={output.name} />
        <Input
          value={editName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
          onBlur={handleBlur}
          className="h-auto flex-1 min-w-0 rounded-md border-0 bg-transparent px-1 -mx-1 py-0 text-callout font-semibold leading-tight text-fg focus:bg-fill focus:ring-0"
          aria-label="Display name"
        />
        <Tooltip label={online ? "A screen is connected to this display" : "No screen is currently connected"}>
          <span className="flex shrink-0 items-center gap-1.5 text-caption2 text-fg-muted">
            <span className={`size-2 rounded-full ${online ? "bg-ok-9" : "bg-fg-faint"}`} />
            {online ? "Online" : "Offline"}
          </span>
        </Tooltip>

        {/* Everything set-once lives here: opening, locking, the URLs, refresh
            and remove. The card face keeps only what an operator changes while
            working — what it shows, and the way into its layout. */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
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
              className="z-50 min-w-48 rounded-md border border-line-strong bg-popover p-1 shadow-md backdrop-blur-xl"
            >
              <DropdownMenu.Item onSelect={onOpenWindow} className={MENU_ITEM}>
                <ExternalLinkIcon className="size-3.5 text-fg-subtle" />
                Open display
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => onSetLocked(!(output.locked ?? false))}
                className={MENU_ITEM}
              >
                {output.locked ? <LockIcon className="size-3.5 text-accent" /> : <LockOpenIcon className="size-3.5 text-fg-subtle" />}
                {output.locked ? "Unlock display" : "Lock display"}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={async () => {
                  if (await copyText(outputUrl)) toast.success("URL copied");
                  else toast.error("Couldn't copy — open the menu again and use Friendly URL to see it");
                }}
                className={MENU_ITEM}
              >
                <CopyIcon className="size-3.5 text-fg-subtle" />
                Copy URL
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={(e) => { e.preventDefault(); setShowSlug((v) => !v); }}
                className={MENU_ITEM}
              >
                <LinkIcon className="size-3.5 text-fg-subtle" />
                {showSlug ? "Hide URLs" : "URLs & friendly link"}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item onSelect={onRefresh} className={MENU_ITEM}>
                <RefreshCwIcon className="size-3.5 text-fg-subtle" />
                Refresh display
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={onRemove}
                disabled={!canRemove}
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-red-11 outline-none data-[highlighted]:bg-red-a3 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
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
          <LazyPreview viewId={output.viewId} />
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
        <Select value={output.viewId ?? UNROUTED} onValueChange={(v: string) => onSetView(v === UNROUTED ? null : v)}>
          <SelectTrigger
            className={cn(
              "h-7 w-auto min-w-0 max-w-[62%] rounded-lg border-transparent px-2.5 text-footnote font-medium",
              output.viewId ? "bg-fill text-fg" : "bg-warn-3 text-warn-11",
            )}
          >
            <SelectValue placeholder="Pick a view" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNROUTED}>— Unrouted —</SelectItem>
            {views.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} · {KIND_LABELS[v.kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip label={onEditLayout ? "Edit this view's layout" : "Only a custom view has a layout to edit"}>
          <button
            type="button"
            onClick={onEditLayout}
            disabled={!onEditLayout}
            className="shrink-0 text-footnote text-accent transition-opacity hover:underline disabled:text-fg-faint disabled:no-underline disabled:opacity-60"
          >
            Edit layout
          </button>
        </Tooltip>
      </div>

      {/* Revealed from the menu. The permanent address never changes, so a Pi, a
          bookmark or a printed QR keeps working whatever is typed here. */}
      {showSlug && (
        <div className="border-t border-line px-3 py-2 flex flex-col gap-1.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={async () => { if (await copyText(outputUrl)) toast.success("URL copied"); }}
            aria-label="Copy URL"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-caption2 text-fg-subtle">{outputUrl}</span>
            <CopyIcon className="size-3.5 shrink-0 text-fg-subtle" />
          </button>
          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-caption2 text-fg-faint">Also at {baseUrl}/</span>
            <Input
              value={editSlug}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEditSlug(e.target.value)}
              onBlur={handleSlugBlur}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder="optional"
              aria-label={`Custom URL for ${output.name}`}
              className="h-7 min-w-0 flex-1 font-mono text-caption2"
            />
          </div>
          {slugError && <span className="text-caption2 text-red-10" role="alert">{slugError}</span>}
        </div>
      )}
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
  const views = stageState.views ?? [];
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
    <div data-flash-id="displays-list" className="px-5 max-sm:px-3 flex flex-col gap-4 pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      <p className="text-caption1 text-gray-9">
        Each display is a physical screen at its own URL. Point it at a <span className="font-medium">View</span>{" "}
        (built under the Views tab) to choose what it shows — and many screens can share one View, so you
        change content in one place.
      </p>

      <DndContext sensors={handlers.sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        {/* A GRID, not a column. Full-width rows made each card a page of its
            own and buried the thing the page is for - comparing screens at a
            glance. rectSortingStrategy is the grid-aware counterpart to the
            vertical strategy; the vertical one assumes a single column and
            computes the wrong drop target as soon as there are two. */}
        <SortableContext items={outputs.map((o) => o.id)} strategy={rectSortingStrategy}>
          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
            {outputs.map((output) => (
              <OutputRow
                key={output.id}
                output={output}
                views={views}
                baseUrl={baseUrl}
                online={connected.has(output.id)}
                canRemove={outputs.length > 1}
                iconColor={stageState.iconColors?.[output.id]}
                onRename={(name) => handlers.handleRenameOutput(output.id, name)}
                onSetSlug={(slug) => invoke("outputs:setSlug", { id: output.id, slug })}
                onSetView={(viewId) => handlers.handleSetOutputView(output.id, viewId)}
                onSetLocked={(locked) => handlers.handleSetOutputLocked(output.id, locked)}
                onOpenWindow={() => handlers.handleOpenOutputWindow(output.id)}
                onRefresh={() => handlers.handleRefreshDisplay(output.id)}
                onRemove={() => handlers.handleRemoveOutput(output.id)}
                onEditLayout={
                  // Only a custom-kind view has a free-form layout; the built-in
                  // kinds would open an editor with nothing to edit.
                  onEditLayout && output.viewId &&
                  stageState.views?.find((v) => v.id === output.viewId)?.kind === "custom"
                    ? () => onEditLayout(output.viewId!)
                    : undefined
                }
              />
            ))}
            {/* The add tile sits IN the grid. As a button under eight cards it
                was below the fold on the page where you would want it. */}
            <button
              type="button"
              onClick={handlers.handleAddOutput}
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
                then pick which display it is
              </span>
            </button>
          </div>
        </SortableContext>
      </DndContext>

      <div className="flex flex-wrap items-center gap-2">
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
