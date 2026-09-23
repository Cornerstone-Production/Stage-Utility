// saved-groups.tsx — the layout editor's library of reusable groups.
//
// Its own module so the library's read, and what the library says about it, can
// be driven in a test without mounting the whole editor: with no layout the
// editor opens every integration's channel, which is twenty routes of stub for
// a test about one of them.

import { useCallback, useEffect, useState } from "react";
import { DownloadIcon, Trash2Icon } from "lucide-react";

import { invoke } from "../lib/api";
import { Button } from "../components/ui";

export interface SavedGroups {
  groups: LayoutGroup[];
  /** A save or a delete answers with the whole new list; take it as read. */
  replace: (list: LayoutGroup[]) => void;
}

/** The library, read once when the editor opens. */
export function useSavedGroups(): SavedGroups {
  const [groups, setGroups] = useState<LayoutGroup[]>([]);
  useEffect(() => {
    invoke<LayoutGroup[]>("layoutGroups:list").then(setGroups).catch(() => setGroups([]));
  }, []);
  const replace = useCallback((list: LayoutGroup[]) => setGroups(list), []);
  return { groups, replace };
}

/** The "Saved groups" block of the editor's sidebar. Takes the hook's whole
 *  result rather than its pieces, so nothing the hook knows can be left behind
 *  at the call site. */
export function SavedGroupsLibrary({
  saved,
  onInsert,
  onDelete,
}: {
  saved: SavedGroups;
  onInsert: (g: LayoutGroup) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">Saved groups</span>
      {saved.groups.length === 0 ? (
        <span className="text-caption2 text-fg-muted">Select a container and use the package icon in the inspector to save it as a reusable group.</span>
      ) : (
        saved.groups.map((g) => (
          <div key={g.id} className="flex items-center gap-0.5 rounded-md px-2 py-1 hover:bg-fill">
            <span className="text-caption1 text-fg flex-1 min-w-0 truncate">{g.name}</span>
            <Button variant="transparent" size="small" iconOnly onClick={() => onInsert(g)} aria-label="Insert group" tooltip="Insert into this view">
              <DownloadIcon className="size-3.5 text-fg-muted" />
            </Button>
            <Button variant="transparent" size="small" iconOnly onClick={() => onDelete(g.id)} aria-label="Delete group">
              <Trash2Icon className="size-3.5 text-red-10" />
            </Button>
          </div>
        ))
      )}
    </div>
  );
}
