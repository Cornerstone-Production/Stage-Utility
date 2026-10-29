// Saved layouts: the top bar's popover. One board per layout, recalled by board.
//
// RECALL FILLS THE EDITOR ONLY. It replaces that board's slots in the page's edit
// buffer and nothing reaches a screen until Save all. Saving a layout captures
// what the editor shows now, unsaved edits included, which is what "save this
// before I change it" means; it goes to the server as an import carrying the
// board it came from.

import { closestCenter, DndContext, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { BookmarkIcon, ChevronDownIcon, DownloadIcon, GripVerticalIcon, MoreHorizontalIcon, UploadIcon } from "lucide-react";
import { DropdownMenu, Popover as PopoverPrimitive } from "radix-ui";
import { useRef, useState, type ChangeEvent } from "react";

import {
  Button,
  Input,
  MENU_ITEM,
  MENU_ITEM_DANGER,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  confirm,
  menuContent,
  toast,
} from "../../components/ui";
import { invoke as ipc } from "../../lib/api";
import { useSortableRow } from "../../lib/use-sortable-row";
import { errorMessage } from "@main/services/errors";
import { plural } from "@main/services/plural";
import { QUERY_KEYS, useSlotPresets } from "../queries";
import { downloadJson, fileSlug } from "./download";
import { slotCount } from "./board-model";
import { freshSlotId } from "./slot-factory";
import type { MicSlots } from "./use-mic-slots";

function savedOn(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at) : "";
}

function PresetRow({
  preset,
  mic,
  saveBoardId,
  onRecall,
  onOverwrite,
  onRename,
  onDelete,
}: {
  preset: SlotPreset;
  mic: MicSlots;
  saveBoardId: string | null;
  onRecall: (preset: SlotPreset, boardId: string) => void;
  onOverwrite: (preset: SlotPreset) => void;
  onRename: (preset: SlotPreset, name: string) => void;
  onDelete: (preset: SlotPreset) => void;
}) {
  const { setNodeRef, style, attributes, listeners } = useSortableRow(preset.id);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(preset.name);
  const source = mic.boards.find((b) => b.id === preset.boardId);
  const into = source ?? mic.boards.find((b) => b.id === saveBoardId) ?? mic.boards[0];
  const saveName = mic.boards.find((b) => b.id === saveBoardId)?.name;

  function commit() {
    setRenaming(false);
    const name = draft.trim();
    if (name && name !== preset.name) onRename(preset, name);
    else setDraft(preset.name);
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 py-1.5" data-saved-layout={preset.id}>
      <button
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab p-0.5 active:cursor-grabbing touch-pan-y"
        aria-label={`Drag to reorder ${preset.name}`}
        tabIndex={-1}
      >
        <GripVerticalIcon className="size-4 text-gray-7" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        {renaming ? (
          <Input
            value={draft}
            autoFocus
            aria-label={`Rename ${preset.name}`}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setDraft(preset.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span className="truncate text-footnote font-medium text-fg">{preset.name}</span>
        )}
        <span className="truncate text-caption2 text-fg-subtle">
          {[source ? `from ${source.name}` : null, plural(slotCount(preset.slots), "slot"), savedOn(preset.createdAt) && `saved ${savedOn(preset.createdAt)}`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          variant="filled"
          size="small"
          className="rounded-r-none"
          disabled={!into}
          aria-label={`Recall ${preset.name}`}
          onClick={() => into && onRecall(preset, into.id)}
        >
          Recall into {into?.name ?? "a board"}
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button variant="filled" size="small" iconOnly className="rounded-l-none border-l border-line" aria-label={`Recall ${preset.name} into another board`}>
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className={menuContent()}>
              {mic.boards.map((b) => (
                <DropdownMenu.Item key={b.id} className={MENU_ITEM} onSelect={() => onRecall(preset, b.id)}>
                  Recall into {b.name}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="transparent" size="small" iconOnly aria-label={`More for ${preset.name}`}>
            <MoreHorizontalIcon className="size-4 text-fg-muted" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" className={menuContent()}>
            <DropdownMenu.Item className={MENU_ITEM} disabled={!saveName} onSelect={() => onOverwrite(preset)}>
              Overwrite with {saveName ?? "the current board"}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={MENU_ITEM}
              onSelect={() => {
                setDraft(preset.name);
                setRenaming(true);
              }}
            >
              Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => downloadJson(`${fileSlug(preset.name)}.slots.json`, { name: preset.name, slots: preset.slots })}>
              Export file
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Item className={MENU_ITEM_DANGER} onSelect={() => onDelete(preset)}>
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

export function SavedLayouts({
  mic,
  open,
  onOpenChange,
  boardId,
}: {
  mic: MicSlots;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The board the page is working in, for the Save picker to start on. */
  boardId: string | null;
}) {
  const qc = useQueryClient();
  const { data: presets = [] } = useSlotPresets();
  const [pickedBoard, setPickedBoard] = useState<string | null>(null);
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const saveBoard = mic.boards.find((b) => b.id === (pickedBoard ?? boardId))?.id ?? mic.boards[0]?.id ?? null;

  /** A write to the saved-layouts bank; the failure is said, and false returned. */
  async function bank(what: string, run: () => Promise<SlotPreset[]>): Promise<boolean> {
    try {
      qc.setQueryData(QUERY_KEYS.slotPresets, await run());
      return true;
    } catch (err) {
      toast.error(`Couldn't ${what}: ${errorMessage(err)}`);
      return false;
    }
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || !saveBoard) return;
    const slots = mic.boardsMap[saveBoard] ?? [];
    if (slots.length === 0) {
      toast.error("That board has no slots to save.");
      return;
    }
    if (await bank("save the layout", () => ipc<SlotPreset[]>("presets:import", { name: trimmed, slots, boardId: saveBoard }))) {
      setName("");
      toast.success(`Saved "${trimmed}".`);
    }
  }

  async function recall(preset: SlotPreset, target: string) {
    const boardName = mic.boards.find((b) => b.id === target)?.name ?? "the board";
    if (!(await mic.confirmReplace(target, `Recalling "${preset.name}" replaces ${boardName}'s layout in the editor.`))) return;
    // Fresh ids, so a layout recalled twice (or into two boards) never shares a slot.
    mic.replaceBoard(target, preset.slots.map((s) => ({ ...s, id: freshSlotId() })));
    onOpenChange(false);
    toast.info(`Recalled "${preset.name}" into ${boardName}. Save all puts it on the screens.`);
  }

  async function overwrite(preset: SlotPreset) {
    if (!saveBoard) return;
    const slots = mic.boardsMap[saveBoard] ?? [];
    const boardName = mic.boards.find((b) => b.id === saveBoard)?.name ?? "the board";
    if (!(await confirm({ title: "Overwrite saved layout?", message: `Overwrite "${preset.name}" with ${boardName} as the editor shows it?`, confirmLabel: "Overwrite" }))) return;
    await bank("overwrite the layout", () => ipc<SlotPreset[]>("presets:overwrite", { id: preset.id, slots }));
  }

  async function remove(preset: SlotPreset) {
    if (!(await confirm({ title: "Delete saved layout?", message: `Delete "${preset.name}"?`, confirmLabel: "Delete", destructive: true }))) return;
    await bank("delete the layout", () => ipc<SlotPreset[]>("presets:delete", { id: preset.id }));
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = presets.map((p) => p.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const reordered = arrayMove(ids, from, to);
    const byId = new Map(presets.map((p) => [p.id, p]));
    // Optimistic, and put back if the server refuses.
    const before = presets;
    qc.setQueryData(QUERY_KEYS.slotPresets, reordered.map((id) => byId.get(id)!));
    void bank("reorder the layouts", () => ipc<SlotPreset[]>("presets:reorder", { ids: reordered })).then((ok) => {
      if (!ok) qc.setQueryData(QUERY_KEYS.slotPresets, before);
    });
  }

  async function importFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    let parsed: { name?: string; slots?: Slot[] } | Slot[];
    try {
      parsed = JSON.parse(await file.text()) as typeof parsed;
    } catch (err) {
      toast.error(`Couldn't read that file: ${errorMessage(err)}`);
      return;
    }
    const slots = Array.isArray(parsed) ? parsed : parsed.slots;
    if (!Array.isArray(slots)) {
      toast.error("That file doesn't contain slots.");
      return;
    }
    const importedName = (!Array.isArray(parsed) && parsed.name) || file.name.replace(/\.slots\.json$|\.json$/i, "") || "Imported";
    await bank("import the layout", () => ipc<SlotPreset[]>("presets:import", { name: importedName, slots, ...(saveBoard ? { boardId: saveBoard } : {}) }));
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="filled" size="medium">
          <BookmarkIcon className="size-3.5 text-fg-muted" />
          Saved layouts
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          aria-label="Saved layouts"
          className="z-50 flex w-[34rem] max-w-[95vw] flex-col gap-2.5 rounded-lg border border-line-strong bg-popover p-3 text-footnote shadow-md"
        >
          <div className="flex items-center gap-2">
            <span className="text-fg-muted">Save</span>
            <Select value={saveBoard ?? undefined} onValueChange={setPickedBoard}>
              <SelectTrigger className="w-36" aria-label="Board to save"><SelectValue placeholder="a board" /></SelectTrigger>
              <SelectContent>
                {mic.boards.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="text-fg-muted">as</span>
            <Input
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder="Christmas Eve band"
              aria-label="Saved layout name"
              className="min-w-0 flex-1"
            />
            <Button variant="accent" size="small" disabled={!name.trim() || !saveBoard} onClick={() => void save()}>
              Save
            </Button>
          </div>
          <div className="h-px bg-line" />
          {presets.length > 0 ? (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={presets.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                <div className="flex max-h-72 flex-col overflow-y-auto">
                  {presets.map((p) => (
                    <PresetRow key={p.id} preset={p} mic={mic} saveBoardId={saveBoard} onRecall={(pr, b) => void recall(pr, b)} onOverwrite={(pr) => void overwrite(pr)} onRename={(pr, n) => void bank("rename the layout", () => ipc<SlotPreset[]>("presets:rename", { id: pr.id, name: n }))} onDelete={(pr) => void remove(pr)} />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <p className="text-caption1 text-fg-muted">No saved layouts yet. Save a board above, then recall it into any board later.</p>
          )}
          <div className="flex gap-3 text-caption1">
            <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => fileRef.current?.click()}>
              <UploadIcon className="size-3.5" />
              Import a file
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-accent hover:underline disabled:opacity-40"
              disabled={!saveBoard}
              onClick={() => {
                const board = mic.boards.find((b) => b.id === saveBoard);
                if (board) downloadJson(`${fileSlug(board.name)}.slots.json`, { name: board.name, slots: mic.boardsMap[board.id] ?? [] });
              }}
            >
              <DownloadIcon className="size-3.5" />
              Export the current board
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void importFile(e)} aria-hidden />
          </div>
          <p className="text-caption2 text-fg-subtle">Recall replaces that board in the editor only. Nothing reaches a screen until Save all.</p>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
