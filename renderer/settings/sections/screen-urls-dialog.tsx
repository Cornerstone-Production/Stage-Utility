// Where a screen can be reached, edited in one place.
//
// This used to be an accordion inside the screen card, which meant a thing you
// edit occasionally changed the height of a thing you glance at constantly.
//
// The slug now saves on an explicit Save rather than on blur. That is not a
// preference: closing a dialog blurs the field, so a blur-save would race the
// unmount and a slug the server REFUSED would look accepted because the dialog
// is already gone. The server is the authority on what a slug may be — a
// reserved word like "history" does not error, it silently serves that page
// instead of the display — so the refusal has to stay on screen.

import { useState, type ChangeEvent, type FormEvent } from "react";
import { CopyIcon } from "lucide-react";

import { Button, DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogDescription, Input, toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { errorMessage } from "@main/services/errors";
import { useResyncOn } from "../../lib/use-resync-on";

export function ScreenUrlsDialog({
  open,
  onOpenChange,
  outputName,
  outputUrl,
  baseUrl,
  slug,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outputName: string;
  /** The permanent URL. Never changes, so it is read-only here. */
  outputUrl: string;
  baseUrl: string;
  slug: string;
  /** Rejects with the server's reason, which is shown without closing. */
  onSave: (slug: string) => Promise<void>;
}) {
  const [value, setValue] = useState(slug);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reopening after a discard, or another client renaming it, must not leave the
  // field holding an edit that was never saved.
  useResyncOn([slug, open], () => {
    setValue(slug);
    setError(null);
  });

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    const next = value.trim().toLowerCase();
    if (next === slug) { onOpenChange(false); return; }
    setBusy(true);
    try {
      await onSave(next);
      onOpenChange(false);
    } catch (err) {
      // Stays open, holding the reason. This is the whole point of Save.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>URLs for {outputName}</DialogTitle>
          <DialogDescription>Where this screen can be reached.</DialogDescription>
        </DialogHeader>

        {/* A form, so Enter saves and the dialog needs no mouse. */}
        <form onSubmit={(e) => void save(e)} className="mt-4 flex flex-col gap-4">
          <div>
            <span className="mb-1.5 block text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
              Permanent URL
            </span>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg border border-line bg-fill px-3 py-2 text-left"
              onClick={async () => { if (await copyText(outputUrl)) toast.success("URL copied"); }}
              aria-label="Copy URL"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-caption2 text-fg-muted">{outputUrl}</span>
              <CopyIcon className="size-3.5 shrink-0 text-fg-subtle" />
            </button>
          </div>

          <div>
            <label
              htmlFor="screen-slug"
              className="mb-1.5 block text-caption2 font-semibold uppercase tracking-wider text-fg-subtle"
            >
              Friendly link — optional
            </label>
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-caption2 text-fg-faint">{baseUrl}/</span>
              <Input
                id="screen-slug"
                value={value}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
                placeholder="optional"
                autoComplete="off"
                className="h-8 min-w-0 flex-1 font-mono text-caption2"
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="rounded-lg border border-danger-9/40 bg-danger-9/10 px-3 py-2 text-footnote text-danger-11">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            {/* Cancel discards: the stored slug is untouched until Save. */}
            <Button type="button" variant="transparent" size="small" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" size="small" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
