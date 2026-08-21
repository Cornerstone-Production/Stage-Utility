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

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button, DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogDescription, Input, toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
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
  // The dialog's own element, for copyText's fallback path.
  //
  // Prod is plain HTTP, so navigator.clipboard does not exist and copyText falls
  // back to a textarea plus execCommand. A Radix dialog traps focus, so a
  // textarea mounted on document.body loses focus and its selection before the
  // copy runs — and copies nothing, silently. Mounting it INSIDE the dialog is
  // what keeps both, which is why copyText takes a container at all.
  const contentRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(slug);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The button confirms for itself as well as raising a toast: the toast is
  // across the screen, and the thing you clicked should say it worked.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(id);
  }, [copied]);

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
      <DialogContent ref={contentRef} className="max-w-md">
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
              className={cn(
                "group flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                // It had no hover and no press state at all, so the one control
                // on the row did not read as a control.
                "border-line bg-fill hover:border-line-strong hover:bg-fill-active",
                "active:scale-[0.995] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              )}
              onClick={async () => {
                if (await copyText(outputUrl, contentRef.current)) {
                  setCopied(true);
                  toast.success("URL copied");
                } else {
                  toast.error("Could not copy — select the URL and copy it by hand");
                }
              }}
              aria-label="Copy URL"
            >
              {/* WRAPS. This was `truncate`, which hid the end of exactly the
                  string the row exists to show — a long slug or a DNS name
                  disappeared mid-word, and it is the one thing here that must
                  never be abbreviated. */}
              <span className="min-w-0 flex-1 break-all font-mono text-caption2 text-fg-muted">{outputUrl}</span>
              {copied ? (
                <CheckIcon className="size-3.5 shrink-0 text-live-11" />
              ) : (
                <CopyIcon className="size-3.5 shrink-0 text-fg-subtle group-hover:text-fg-muted" />
              )}
            </button>
          </div>

          <div>
            <label
              htmlFor="screen-slug"
              className="mb-1.5 block text-caption2 font-semibold uppercase tracking-wider text-fg-subtle"
            >
              Friendly link — optional
            </label>
            {/* Stacked, not inline. The prefix is a full origin — on a phone it
                took the whole row and squeezed the field down to about four
                characters, which is not a field you can type a word into. */}
            <span className="mb-1 block truncate font-mono text-caption2 text-fg-faint">
              {baseUrl}/
            </span>
            <Input
              id="screen-slug"
              value={value}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
              placeholder="optional"
              autoComplete="off"
              className="h-9 w-full font-mono text-caption2"
            />
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
