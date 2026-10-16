import { useState } from "react";
import { useResyncOn } from "./use-resync-on";

/**
 * The draft behind a name field that saves when it is left.
 *
 * `draft` is what is typed; it follows `stored` when that changes elsewhere (a
 * rename from another window, a duplicate, an import), and only then, so what is
 * being typed is never clobbered. `commit` is the field's blur: a changed,
 * non-empty name goes to `onRename` trimmed, and anything else puts the stored
 * name back. An emptied field is restored rather than saved as nothing.
 */
export function useNameDraft(
  stored: string,
  onRename: (name: string) => void,
): { draft: string; setDraft: (draft: string) => void; commit: () => void } {
  const [draft, setDraft] = useState(stored);
  useResyncOn([stored], () => setDraft(stored));

  function commit(): void {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== stored) onRename(trimmed);
    else setDraft(stored);
  }

  return { draft, setDraft, commit };
}
