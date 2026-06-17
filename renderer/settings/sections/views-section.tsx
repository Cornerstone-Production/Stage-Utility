import { useState, type ChangeEvent, type CSSProperties } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PlusIcon, TrashIcon, CopyIcon, VideoIcon, GripVerticalIcon } from "lucide-react";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Separator,
  Dialog,
} from "../../components/ui";
import type { SectionProps } from "../types";
import { SlotEditor } from "./slots-section";
import { ViewPreview } from "./view-preview";

const KIND_LABELS: Record<ViewKind, string> = {
  slots: "Mic Slots",
  dashboard: "Dashboard",
  stage: "Stage",
  transcription: "Captions",
};
const KIND_ORDER: ViewKind[] = ["slots", "dashboard", "stage", "transcription"];

// ---- sortable master-list item ----------------------------------------------

function SortableViewItem({
  view,
  selected,
  onSelect,
}: {
  view: View;
  selected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: view.id,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1 rounded-lg pr-1 transition-colors ${
        selected ? "bg-gray-a4" : "hover:bg-gray-a3"
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing touch-none py-2 pl-2 shrink-0"
        aria-label="Drag to reorder"
        tabIndex={-1}
      >
        <GripVerticalIcon className="size-4 text-gray-7" />
      </button>
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-col items-start gap-0.5 py-2 pr-2 text-left flex-1 min-w-0"
      >
        <span className="text-body text-gray-12 truncate w-full">{view.name}</span>
        <span className="text-caption2 text-gray-9">{KIND_LABELS[view.kind]}</span>
      </button>
    </div>
  );
}

// ---- detail editor for one View ---------------------------------------------

function ViewDetail({
  view,
  stageState,
  wirelessChannels,
  teamPositions,
  localSlots,
  slotsDirty,
  isSavingSlots,
  canDelete,
  handlers,
}: Pick<
  SectionProps,
  "stageState" | "wirelessChannels" | "teamPositions" | "localSlots" | "slotsDirty" | "isSavingSlots" | "handlers"
> & { view: View; canDelete: boolean }) {
  // Parent remounts this component on view change (key={view.id}), so local
  // field state initializes fresh per view.
  const [editName, setEditName] = useState(view.name);
  const [editNdi, setEditNdi] = useState(view.ndiSource ?? "");

  function handleNameBlur() {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== view.name) handlers.handleRenameView(view.id, trimmed);
    else setEditName(view.name);
  }

  function handleNdiBlur() {
    const trimmed = editNdi.trim();
    if (trimmed !== (view.ndiSource ?? "")) handlers.handleSetViewNdiSource(view.id, trimmed || null);
  }

  const slotViews = (stageState.views ?? []).filter((v) => v.kind === "slots" && v.id !== view.id);

  return (
    <div className="flex flex-col gap-5">
      {/* Header: name + kind dropdown + actions */}
      <div className="flex items-center gap-2">
        <Input
          value={editName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
          onBlur={handleNameBlur}
          className="flex-1 min-w-0 text-headline font-semibold text-gray-12"
          aria-label="View name"
        />
        <Select value={view.kind} onValueChange={(k: string) => handlers.handleSetViewKind(view.id, k as ViewKind)}>
          <SelectTrigger className="w-36 shrink-0" aria-label="View type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_ORDER.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="filled" size="small" onClick={() => handlers.handleDuplicateView(view.id)}>
          <CopyIcon className="size-3.5 text-gray-9" />
          Duplicate
        </Button>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={() => handlers.handleRemoveView(view.id)}
          disabled={!canDelete}
          aria-label="Delete view"
        >
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>

      {/* Live preview */}
      <ViewPreview viewId={view.id} />

      {/* NDI source (native Apple client only) */}
      <div className="flex items-center gap-2">
        <VideoIcon className="size-3.5 text-gray-9 shrink-0" />
        <Input
          value={editNdi}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditNdi(e.target.value)}
          onBlur={handleNdiBlur}
          placeholder="NDI source name (optional, native app only)"
          className="flex-1 min-w-0 text-gray-12"
          aria-label="NDI source name"
        />
      </div>

      {/* Slots-kind content editor */}
      {view.kind === "slots" ? (
        <>
          <Separator />
          {slotViews.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-caption1 text-gray-9 shrink-0">Copy slots from:</span>
              <Select
                value=""
                onValueChange={(fromId: string) => {
                  if (fromId) handlers.handleCopySlots(view.id, fromId);
                }}
              >
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Another view…" />
                </SelectTrigger>
                <SelectContent>
                  {slotViews.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <SlotEditor
            wirelessChannels={wirelessChannels}
            teamPositions={teamPositions}
            localSlots={localSlots}
            slotsDirty={slotsDirty}
            isSavingSlots={isSavingSlots}
            handlers={handlers}
          />
        </>
      ) : (
        <p className="text-caption1 text-gray-9">
          {KIND_LABELS[view.kind]} views render a fixed layout from live Planning Center / ProPresenter
          data — there's nothing to configure here yet besides the name and NDI source.
        </p>
      )}
    </div>
  );
}

// ---- Views section (master-detail) ------------------------------------------

export function ViewsSection({
  stageState,
  wirelessChannels,
  teamPositions,
  selectedViewId,
  setSelectedViewId,
  localSlots,
  slotsDirty,
  isSavingSlots,
  handlers,
}: Pick<
  SectionProps,
  | "stageState"
  | "wirelessChannels"
  | "teamPositions"
  | "selectedViewId"
  | "setSelectedViewId"
  | "localSlots"
  | "slotsDirty"
  | "isSavingSlots"
  | "handlers"
>) {
  const views = stageState.views ?? [];
  const selected = views.find((v) => v.id === selectedViewId) ?? views[0] ?? null;

  // Create-view dialog state
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<ViewKind>("slots");

  function handleViewDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = views.map((v) => v.id);
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    handlers.handleReorderViews(arrayMove(ids, oldIndex, newIndex));
  }

  return (
    <div className="px-5 flex gap-5 py-5 h-full min-h-0">
      {/* Master list */}
      <div className="flex flex-col gap-1 w-52 shrink-0">
        <DndContext sensors={handlers.sensors} collisionDetection={closestCenter} onDragEnd={handleViewDragEnd}>
          <SortableContext items={views.map((v) => v.id)} strategy={verticalListSortingStrategy}>
            {views.map((v) => (
              <SortableViewItem
                key={v.id}
                view={v}
                selected={v.id === selected?.id}
                onSelect={() => setSelectedViewId(v.id)}
              />
            ))}
          </SortableContext>
        </DndContext>

        <Dialog
          trigger={
            <Button variant="filled" size="small" className="mt-1 self-start">
              <PlusIcon className="size-3.5 text-gray-9" />
              Add view
            </Button>
          }
          title="New view"
          description="Pick what this view shows. You can change the type later."
          confirmLabel="Create"
          confirmDisabled={false}
          onConfirm={async () => {
            await handlers.handleAddView(newName.trim(), newKind);
            setNewName("");
            setNewKind("slots");
          }}
        >
          <div className="flex flex-col gap-3">
            <Input
              value={newName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
              placeholder="View name (e.g. Main Mic Slots)"
              className="text-gray-12"
              autoFocus
            />
            <Select value={newKind} onValueChange={(v: string) => setNewKind(v as ViewKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_ORDER.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Dialog>
      </div>

      {/* Detail */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <ViewDetail
            key={selected.id}
            view={selected}
            stageState={stageState}
            wirelessChannels={wirelessChannels}
            teamPositions={teamPositions}
            localSlots={localSlots}
            slotsDirty={slotsDirty}
            isSavingSlots={isSavingSlots}
            canDelete={views.length > 1}
            handlers={handlers}
          />
        ) : (
          <p className="text-caption1 text-gray-9">No views yet — create one to get started.</p>
        )}
      </div>
    </div>
  );
}
