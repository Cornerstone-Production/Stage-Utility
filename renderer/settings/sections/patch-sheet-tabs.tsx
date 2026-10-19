import { useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { MENU_ITEM, MENU_ITEM_DANGER, menuContent } from "../../components/ui";
import { cn } from "../../lib/cn";

const TAB = "shrink-0 py-2 font-medium text-footnote transition-colors";

/**
 * The sheet tabs (Analog / Dante / WSG / …): an underline marks the active one,
 * and the active tab carries the menu for what can be done to it — Rename and
 * Delete. "+" adds a sheet.
 *
 * Rename edits the tab's own label in place and commits on Enter or blur; Escape
 * keeps the old name. An empty name is not a name, so it keeps the old one too.
 */
export function SheetTabs({
  sheets,
  activeId,
  onSwitch,
  onAdd,
  onRename,
  onDelete,
}: {
  sheets: { id: string; name: string }[];
  activeId: string;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  // True while the tab's name is an input. The menu closes by handing focus back
  // to its trigger, which is wrong for a rename: its onCloseAutoFocus checks this
  // and sends focus to the input instead.
  const renamingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startRename(id: string, current: string) {
    renamingRef.current = true;
    setDraftName(current);
    setRenamingId(id);
  }
  function finishRename(commit: boolean, current: string) {
    renamingRef.current = false;
    setRenamingId(null);
    const name = draftName.trim();
    if (commit && name && name !== current) onRename(name);
  }

  return (
    <div role="tablist" aria-label="Patch sheets" className="flex min-w-0 flex-wrap items-center gap-1">
      {sheets.map((s) =>
        s.id === activeId ? (
          <div key={s.id} className="-mb-px flex shrink-0 items-center border-b-2 border-accent">
            {renamingId === s.id ? (
              <input
                ref={inputRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => finishRename(true, s.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") finishRename(true, s.name);
                  else if (e.key === "Escape") finishRename(false, s.name);
                }}
                aria-label="Sheet name"
                className="my-1 ml-2 h-7 w-36 rounded-md border border-focus bg-field px-2 text-footnote font-medium text-fg outline-none"
              />
            ) : (
              <button type="button" role="tab" aria-selected="true" className={cn(TAB, "pl-3 pr-1.5 text-fg")}>
                {s.name}
              </button>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label={`Rename or delete ${s.name}`}
                  className="mr-2 flex size-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-fill hover:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-focus"
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className={menuContent()}
                  onCloseAutoFocus={(e) => {
                    if (!renamingRef.current) return;
                    // Focus the input HERE, after the menu is gone: focused any
                    // earlier, the open menu's focus trap takes it straight back.
                    e.preventDefault();
                    inputRef.current?.focus();
                    inputRef.current?.select();
                  }}
                >
                  <DropdownMenu.Item onSelect={() => startRename(s.id, s.name)} className={MENU_ITEM}>
                    <PencilIcon className="size-3.5 text-fg-subtle" />
                    Rename
                  </DropdownMenu.Item>
                  {/* The last sheet cannot go: the file always holds at least one. */}
                  <DropdownMenu.Item onSelect={onDelete} disabled={sheets.length <= 1} className={MENU_ITEM_DANGER}>
                    <Trash2Icon className="size-3.5" />
                    Delete sheet…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        ) : (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected="false"
            onClick={() => onSwitch(s.id)}
            className={cn(TAB, "-mb-px border-b-2 border-transparent px-3 text-fg-muted hover:text-fg")}
          >
            {s.name}
          </button>
        ),
      )}
      <button type="button" onClick={onAdd} className={cn(TAB, "touch-target -mb-px border-b-2 border-transparent px-3 text-fg-subtle hover:text-fg")} aria-label="Add sheet">
        <PlusIcon className="size-4" />
      </button>
    </div>
  );
}
