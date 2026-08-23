// tag-picker.tsx — pick signage tags, and name a new one without leaving.
//
// There is no page for administering tags, which is the point: they are assigned
// where the work is. That only holds if a tag can be CREATED there too —
// otherwise "put this screen in a new set" still means going somewhere else to
// make the set first, and the page we deleted grows back as a detour.
//
// Naming happens inline rather than through window.prompt(). A prompt is a
// browser dialog wearing the browser's clothes, it cannot be styled to look like
// the app it interrupts, and some contexts refuse to show one at all — which
// would be a "New tag…" button that silently did nothing.

import { useState } from "react";
import { PlusIcon } from "lucide-react";
import type { SignageGroup } from "@main/types/signage";

import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { Input } from "../../components/ui/input";
import { MultiSelect } from "../../components/ui/multi-select";

/** Past this many, the picker gets a search field. */
const SEARCHABLE_FROM = 8;

export function TagPicker({
  groups,
  selected,
  onChange,
  onCreate,
  onRename,
  onDelete,
  placeholder = "No tags",
  summary,
  className,
}: {
  groups: SignageGroup[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Make a tag and return its id. Null when it could not be made. */
  onCreate: (name: string) => Promise<string | null>;
  /**
   * Rename and delete a tag, from a right-click on its row.
   *
   * Here because the list of options IS the list of tags, and with the Groups
   * page gone there is nowhere else that lists them. Optional: a picker that
   * cannot offer these simply does not, rather than showing a menu that fails.
   */
  onRename?: (id: string, name: string) => Promise<void>;
  onDelete?: (group: SignageGroup) => Promise<void>;
  placeholder?: string;
  summary?: string;
  className?: string;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  /** The tag being renamed in place, if any. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const id = await onCreate(trimmed);
      // Selected straight away. Making a tag from inside a picker and then
      // having to find and tick it is the detour this exists to remove.
      if (id) onChange([...selected, id]);
      setName("");
      setNaming(false);
    } finally {
      setBusy(false);
    }
  };

  const commitRename = async (id: string, next: string) => {
    setRenamingId(null);
    const trimmed = next.trim();
    const current = groups.find((g) => g.id === id);
    if (!trimmed || !current || trimmed === current.name || !onRename) return;
    await onRename(id, trimmed);
  };

  const menuFor = (id: string): ContextMenuItem[] => {
    const g = groups.find((x) => x.id === id);
    if (!g) return [];
    return [
      ...(onRename ? [{ label: "Rename…", onSelect: () => setRenamingId(id) }] : []),
      ...(onRename && onDelete ? [{ separator: true }] : []),
      ...(onDelete
        ? [{ label: "Delete tag", danger: true, onSelect: () => void onDelete(g) }]
        : []),
    ];
  };

  return (
    <>
    <MultiSelect
      options={groups.map((g) => ({ value: g.id, label: g.name }))}
      selected={selected}
      onChange={onChange}
      placeholder={placeholder}
      summary={summary}
      className={className}
      searchable={groups.length > SEARCHABLE_FROM}
      onOptionContextMenu={
        onRename || onDelete
          ? (value, e) => setMenu({ x: e.clientX, y: e.clientY, items: menuFor(value) })
          : undefined
      }
      footer={
        naming ? (
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name the tag"
            aria-label="Name the new tag"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                // Stop here rather than letting the popover close as well: the
                // first Escape means "not this tag", not "not this picker".
                e.stopPropagation();
                setNaming(false);
                setName("");
              }
            }}
            // Committed on blur too, so clicking away from a typed name keeps it
            // rather than throwing it out.
            onBlur={() => void create()}
            className="h-7 text-footnote"
          />
        ) : renamingId ? (
          <Input
            autoFocus
            defaultValue={groups.find((g) => g.id === renamingId)?.name ?? ""}
            aria-label="Rename the tag"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename(renamingId, e.currentTarget.value);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setRenamingId(null);
              }
            }}
            onBlur={(e) => void commitRename(renamingId, e.currentTarget.value)}
            className="h-7 text-footnote"
          />
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-footnote text-accent outline-none hover:bg-fill focus-visible:bg-fill"
          >
            <PlusIcon className="size-3.5" />
            New tag…
          </button>
        )
      }
    />
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
