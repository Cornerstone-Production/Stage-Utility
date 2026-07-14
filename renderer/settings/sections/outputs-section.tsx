import { useState, useEffect, type ChangeEvent, type CSSProperties } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DropdownMenu } from "radix-ui";
import { PlusIcon, TrashIcon, MonitorIcon, ExternalLinkIcon, GripVerticalIcon, RefreshCwIcon, LockIcon, MoreVerticalIcon, CopyIcon } from "lucide-react";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Switch,
  toast,
} from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import type { SectionProps } from "../types";

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
  canRemove: boolean;
  onRename: (name: string) => void;
  onSetView: (viewId: string | null) => void;
  onSetLocked: (locked: boolean) => void;
  onOpenWindow: () => void;
  onRefresh: () => void;
  onRemove: () => void;
}

// One card per display: the name reads as a title, the View it shows is the one
// prominent control, Open + Lock stay in reach, and the URL sits quietly in the
// footer. Refresh/Remove tuck into the overflow menu so they don't compete.
function OutputRow({ output, views, baseUrl, canRemove, onRename, onSetView, onSetLocked, onOpenWindow, onRefresh, onRemove }: OutputRowProps) {
  const [editName, setEditName] = useState(output.name);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: output.id,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  useEffect(() => {
    setEditName(output.name);
  }, [output.name]);

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
      <div className="flex items-center gap-2.5 px-3 pt-2.5">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing touch-none shrink-0 text-gray-7 hover:text-gray-9 transition-colors"
          aria-label="Drag to reorder"
          tabIndex={-1}
        >
          <GripVerticalIcon className="size-4" />
        </button>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <MonitorIcon className="size-4" />
        </span>
        <Input
          value={editName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
          onBlur={handleBlur}
          className="h-8 flex-1 min-w-0 rounded-md border-0 bg-transparent px-1 -mx-1 text-callout font-semibold text-fg focus:bg-fill focus:ring-0"
          aria-label="Display name"
        />
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
              className="z-50 min-w-44 rounded-md border border-line-strong bg-popover p-1 shadow-md backdrop-blur-xl"
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

      {/* Shows → View: the one prominent control */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">
          Shows
        </span>
        <Select value={output.viewId ?? UNROUTED} onValueChange={(v: string) => onSetView(v === UNROUTED ? null : v)}>
          <SelectTrigger className="h-9 flex-1 text-body">
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
      <div className="flex items-center gap-3 px-3 pb-2.5">
        <Button variant="filled" size="small" onClick={onOpenWindow} aria-label={`Open window for ${output.name}`}>
          <ExternalLinkIcon className="size-3.5 text-gray-9" />
          Open window
        </Button>
        <label
          className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-caption1 text-fg-muted"
          title="Hide the settings/QR link and home logo on this display so a handed-out link can't navigate away"
        >
          <LockIcon className="size-3.5" />
          <span>Locked</span>
          <Switch checked={output.locked ?? false} onCheckedChange={onSetLocked} aria-label={`Lock display ${output.name}`} />
        </label>
      </div>

      {/* Footer: the display URL, quiet — click to copy */}
      <button
        type="button"
        className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left transition-colors hover:bg-fill"
        title="Click to copy URL"
        onClick={async () => { if (await copyText(outputUrl)) toast.success("URL copied"); else toast.error("Couldn't copy — select the URL manually"); }}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-caption2 text-fg-subtle">{outputUrl}</span>
        <CopyIcon className="size-3.5 shrink-0 text-fg-subtle" />
      </button>
    </div>
  );
}

export function OutputsSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
  const outputs = stageState.outputs ?? [];
  const views = stageState.views ?? [];
  // Prefer the configured public URL (DNS) so display links match what operators
  // actually browse to; fall back to the current origin.
  const baseUrl = stageState.publicUrl || window.location.origin;

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
    <div className="px-5 max-sm:px-3 flex flex-col gap-4 pt-5 max-sm:pt-4 pb-[50vh]">
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
                canRemove={outputs.length > 1}
                onRename={(name) => handlers.handleRenameOutput(output.id, name)}
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
            title="Reload every connected display remotely"
          >
            <RefreshCwIcon className="size-3.5 text-gray-9" />
            Refresh all
          </Button>
        )}
      </div>
    </div>
  );
}
