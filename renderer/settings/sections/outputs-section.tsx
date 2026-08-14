import { errorMessage } from "@main/services/errors";
import { useState, useEffect, type ChangeEvent, type CSSProperties } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DropdownMenu } from "radix-ui";
import { PlusIcon, TrashIcon, MonitorIcon, ExternalLinkIcon, GripVerticalIcon, RefreshCwIcon, LockIcon, LockOpenIcon, MoreVerticalIcon, CopyIcon } from "lucide-react";
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
import { cn } from "../../lib/cn";
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
}

// One card per display: the name reads as a title, the View it shows is the one
// prominent control, Open + Lock stay in reach, and the URL sits quietly in the
// footer. Refresh/Remove tuck into the overflow menu so they don't compete.
function OutputRow({ output, views, baseUrl, online, canRemove, iconColor, onRename, onSetSlug, onSetView, onSetLocked, onOpenWindow, onRefresh, onRemove }: OutputRowProps) {
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--su-shadow-1)]"
    >
      {/* Header: drag handle + display icon + editable name + overflow menu */}
      <div className="flex items-center gap-2.5 px-3 pt-2">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing touch-pan-y shrink-0 text-gray-7 hover:text-gray-9 transition-colors"
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
          <span
            className="flex shrink-0 items-center gap-1.5 text-caption2 text-fg-muted" aria-label={online ? "A screen is connected to this display" : "No screen is currently connected"}>
            <span className={`size-2 rounded-full ${online ? "bg-ok-9" : "bg-fg-faint"}`} />
            {online ? "Connected" : "Offline"}
          </span>
        </Tooltip>
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
              className="z-50 min-w-max rounded-md border border-line-strong bg-popover p-1 shadow-md backdrop-blur-xl"
            >
              <DropdownMenu.Item
                onSelect={onRefresh}
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-fg outline-none data-[highlighted]:bg-fill"
              >
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

      {/* Shows → View. Sized like every other select in the app: an oversized
          trigger here (17px in a 36px control, against 13px/28px elsewhere) made
          the whole tab read as a different scale. The card layout and the "Shows"
          label already identify it as the primary control. */}
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">
          Shows
        </span>
        <Select value={output.viewId ?? UNROUTED} onValueChange={(v: string) => onSetView(v === UNROUTED ? null : v)}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Pick a view…" />
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
      </div>

      {/* Primary action + lock */}
      <div className="flex items-center gap-3 px-3 pb-2">
        <Button variant="filled" size="small" onClick={onOpenWindow} aria-label={`Open window for ${output.name}`}>
          <ExternalLinkIcon className="size-3.5 text-gray-9" />
          Open window
        </Button>
        {/* The padlock is the state, so a separate switch beside it said the same
            thing twice. Closed and accented = locked, open and muted = not. */}
        <Tooltip label="Hide the settings/QR link and home logo on this display so a handed-out link can't navigate away">
          <button
            type="button"
            onClick={() => onSetLocked(!(output.locked ?? false))}
            aria-pressed={output.locked ?? false}
            aria-label={`${output.locked ? "Unlock" : "Lock"} display ${output.name}`}
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-caption1 transition-colors",
              output.locked
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-line text-fg-muted hover:bg-fill hover:text-fg",
            )}
          >
            {output.locked ? <LockIcon className="size-3.5" /> : <LockOpenIcon className="size-3.5" />}
            <span>{output.locked ? "Locked" : "Unlocked"}</span>
          </button>
        </Tooltip>
      </div>

      {/* Footer: the permanent URL, quiet — click to copy */}
      <Tooltip label="Copy URL">
        <button
          type="button"
          className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left transition-colors hover:bg-fill"
          onClick={async () => { if (await copyText(outputUrl)) toast.success("URL copied"); else toast.error("Couldn't copy — select the URL manually"); }} aria-label="Copy URL">
          <span className="min-w-0 flex-1 truncate font-mono text-caption2 text-fg-subtle">{outputUrl}</span>
          <CopyIcon className="size-3.5 shrink-0 text-fg-subtle" />
        </button>
      </Tooltip>

      {/* Optional friendly URL. The address above never changes, so anything
          already pointed at it — a Pi, a bookmark, a printed QR — keeps working
          whatever is typed here. */}
      <div className="flex items-center gap-2 border-t border-line px-3 py-2">
        {/* Mono throughout: the label butting against a mono URL in the UI face
            read as two different things stuck together, and the row above this one
            is all mono. */}
        <span className="shrink-0 font-mono text-caption2 text-fg-faint">Also at</span>
        <span className="shrink-0 font-mono text-caption2 text-fg-subtle">{baseUrl}/</span>
        <Input
          value={editSlug}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditSlug(e.target.value)}
          onBlur={handleSlugBlur}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="optional"
          aria-label={`Custom URL for ${output.name}`}
          className="h-7 min-w-0 flex-1 font-mono text-caption2"
        />
        {slugError && (
          <span className="shrink-0 text-caption2 text-red-10" role="alert">{slugError}</span>
        )}
      </div>
    </div>
  );
}

export function OutputsSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
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
        <SortableContext items={outputs.map((o) => o.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-3">
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
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="filled" size="small" onClick={handlers.handleAddOutput}>
          <PlusIcon className="size-3.5 text-gray-9" />
          Add display
        </Button>
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
