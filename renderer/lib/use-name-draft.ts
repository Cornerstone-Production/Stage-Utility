import { useState } from "react";
import { useLatestRef } from "./use-latest-ref";
import { useResyncOn } from "./use-resync-on";

/**
 * What a rename answers. `false` means the save was refused (the caller has said
 * why, usually in a toast) and the field goes back to the stored name. Anything
 * else, including nothing at all, leaves the field as typed.
 */
export type RenameResult = void | boolean | Promise<void | boolean>;

/**
 * The draft behind a name field that saves when it is left.
 *
 * `draft` is what is typed; it follows `stored` when that changes elsewhere (a
 * rename from another window, a duplicate, an import), and only then, so what is
 * being typed is never clobbered. `commit` is the field's blur: a changed,
 * non-empty name goes to `onRename` trimmed, and anything else puts the stored
 * name back. An emptied field is restored rather than saved as nothing.
 *
 * A refused save puts the stored name back too. Nothing else would: the stored
 * name did not change, so the resync above never fires, and the field would show
 * a name the app does not have until the page was reloaded. If the operator has
 * typed again by the time the refusal lands, that typing is kept.
 */
export function useNameDraft(
  stored: string,
  onRename: (name: string) => RenameResult,
): { draft: string; setDraft: (draft: string) => void; commit: () => void } {
  const [draft, setDraft] = useState(stored);
  useResyncOn([stored], () => setDraft(stored));
  // Read when the answer lands, which is renders after the commit.
  const storedNow = useLatestRef(stored);

  function commit(): void {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === stored) {
      setDraft(stored);
      return;
    }
    const sent = draft;
    const restore = () => setDraft((now) => (now === sent ? storedNow.current : now));
    void Promise.resolve(onRename(trimmed)).then(
      (ok) => {
        if (ok === false) restore();
      },
      (err: unknown) => {
        // A rename that throws was not saved either. Put the name back and
        // rethrow: the callers here toast and answer false rather than throw, so
        // a throw is a bug, and it stays as loud as it was.
        restore();
        throw err;
      },
    );
  }

  return { draft, setDraft, commit };
}
