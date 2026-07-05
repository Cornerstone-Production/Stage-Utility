import { useState, useEffect, type ChangeEvent, type CSSProperties } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PlusIcon, TrashIcon, MonitorIcon, ExternalLinkIcon, GripVerticalIcon, RefreshCwIcon, LockIcon } from "lucide-react";
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
  isFirst: boolean;
  canRemove: boolean;
  onRename: (name: string) => void;
  onSetView: (viewId: string | null) => void;
  onSetLocked: (locked: boolean) => void;
  onOpenWindow: () => void;
  onRefresh: () => void;
  onRemove: () => void;
}

function OutputRow({ output, views, baseUrl, isFirst, canRemove, onRename, onSetView, onSetLocked, onOpenWindow, onRefresh, onRemove }: OutputRowProps) {
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
    <div ref={setNodeRef} style={style} className={`flex flex-col gap-1.5 py-2${isFirst ? "" : " border-t border-gray-a3"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing touch-none p-0.5 shrink-0"
          aria-label="Drag to reorder"
          tabIndex={-1}
        >
          <GripVerticalIcon className="size-4 text-gray-7" />
        </button>
        <MonitorIcon className="size-3.5 text-gray-9 shrink-0" />
        <Input
          value={editName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
          onBlur={handleBlur}
          className="flex-1 min-w-0"
          aria-label="Display name"
        />
        <Button variant="filled" size="small" onClick={onOpenWindow} aria-label={`Open window for ${output.name}`}>
          <ExternalLinkIcon className="size-3.5 text-gray-9" />
          Open window
        </Button>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={onRefresh}
          aria-label={`Refresh display ${output.name}`}
          title="Reload this display remotely"
        >
          <RefreshCwIcon className="size-3.5 text-gray-9" />
        </Button>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Remove display ${output.name}`}
        >
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>
      {/* View routing + URL hint */}
      <div className="ml-5 flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2">
        <span className="text-caption1 text-gray-9 shrink-0">Shows view:</span>
        <Select
          value={output.viewId ?? UNROUTED}
          onValueChange={(v: string) => onSetView(v === UNROUTED ? null : v)}
        >
          <SelectTrigger className="w-full sm:w-48 sm:shrink-0">
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
        <button
          type="button"
          className="text-left text-[11px] text-gray-a9 hover:text-gray-11 font-mono truncate transition-colors min-w-0"
          title="Click to copy URL"
          onClick={async () => { if (await copyText(outputUrl)) toast.success("URL copied"); else toast.error("Couldn't copy — select the URL manually"); }}
        >
          {outputUrl}
        </button>
        <label
          className="flex items-center gap-1.5 shrink-0 text-caption1 text-gray-9 sm:ml-auto cursor-pointer"
          title="Hide the settings/QR link and home logo on this display so a handed-out link can't navigate away"
        >
          <LockIcon className="size-3.5 text-gray-9" />
          <span>Locked</span>
          <Switch checked={output.locked ?? false} onCheckedChange={onSetLocked} aria-label={`Lock display ${output.name}`} />
        </label>
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
          <div className="flex flex-col">
            {outputs.map((output, idx) => (
              <OutputRow
                key={output.id}
                output={output}
                views={views}
                baseUrl={baseUrl}
                isFirst={idx === 0}
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
