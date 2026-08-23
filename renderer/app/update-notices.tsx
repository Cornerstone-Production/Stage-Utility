// Telling the operator about updates, wherever they happen to be.
//
// Mounted once in the shell rather than on the Advanced page, because both of
// these are things you should hear about while doing something else. Advanced is
// where you go to ACT on an update; it is not where you find out there is one.

import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";
import { Button, DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogDescription, toast } from "../components/ui";
import { cn } from "../lib/cn";
import type { JustUpdated } from "@main/services/update-notices-store";
import type { UpdateNoticePayload } from "@main/services/update/announce";

/** Breaking earns a colour. The rest are quiet by design — if every heading
 *  shouts, the one that matters does not. */
const SECTION_TONE: Record<string, string> = {
  Breaking: "bg-danger-9",
  New: "bg-accent",
  Changed: "bg-accent",
  Improved: "bg-accent",
  Fixed: "bg-warn-9",
};

export function UpdateNotices() {
  const [justUpdated, setJustUpdated] = useState<JustUpdated | null>(null);
  const [dismissing, setDismissing] = useState(false);

  // The toast. Delivery is what spends the announcement, so simply being here
  // and subscribed is what makes it "seen".
  useEffect(() => onNotification(
    "update:notice",
    (p) => {
      const { tag, count } = p as UpdateNoticePayload;
      const what = count > 1 ? `${count} updates are available` : `${tag} is available`;
      toast.info(`${what} — Advanced to install`);
    },
  ), []);

  // The release dialog. Fetched once on mount: it is a fact the server holds,
  // not an event, so a client that connects a week later still sees it.
  useEffect(() => {
    void invoke<{ justUpdated: JustUpdated | null }>("update:notices")
      .then((r) => setJustUpdated(r.justUpdated))
      // A notice that cannot be fetched is not worth interrupting anybody over,
      // and there is no operator action that would help.
      .catch(() => {});
  }, []);

  async function dismiss(): Promise<void> {
    setDismissing(true);
    try {
      await invoke("update:dismissNotice", {});
      setJustUpdated(null);
    } catch {
      // Leave it on screen: better a dialog that will not close than one that
      // closes and comes back on the next load.
      setDismissing(false);
    }
  }

  if (!justUpdated) return null;
  const { version, fromVersion, notes, lines, intro } = justUpdated;

  return (
    <DialogRoot open onOpenChange={(open: boolean) => { if (!open) void dismiss(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Updated to {version}</DialogTitle>
          {fromVersion && <DialogDescription>From {fromVersion}</DialogDescription>}
        </DialogHeader>

        <div className="mt-4 flex max-h-[52vh] flex-col gap-3 overflow-y-auto">
          {/* The release's own opening words, above the lists.
              A section heading answers "what changed"; this answers "what does
              that mean for me" — whether there is a manual step, whether the
              config came across, where a page went. It only exists because
              somebody wrote it for this release, so when it is absent nothing
              is drawn rather than an empty box. Paragraphs are split on blank
              lines; the parser has already stripped the markdown. */}
          {intro && (
            <div className="flex shrink-0 flex-col gap-2 rounded-lg border border-line bg-fill/50 px-3 py-2.5">
              {intro.split(/\n{2,}/).map((para, i) => (
                <p key={i} className="text-footnote leading-relaxed text-fg-muted">{para}</p>
              ))}
            </div>
          )}

          {notes.map((s) => (
            // shrink-0: these are flex children of a scrolling column, and a
            // flex child shrinks by default. Without it every section was
            // squashed to fit the box and `overflow-hidden` clipped the rest —
            // a four-section release rendered as four headings with one bullet
            // each, and no scrollbar to suggest anything was missing.
            <div key={s.section} className="shrink-0 overflow-hidden rounded-lg border border-line">
              <div className="flex items-center gap-2 bg-fill px-3 py-2">
                <span aria-hidden="true" className={cn("size-1.5 rounded-sm", SECTION_TONE[s.section] ?? "bg-accent")} />
                <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">{s.section}</span>
              </div>
              <ul className="flex list-disc flex-col gap-1.5 py-2.5 pl-8 pr-3">
                {s.lines.map((l, i) => <li key={i} className="text-footnote text-fg-muted">{l}</li>)}
              </ul>
            </div>
          ))}

          {/* A checkout's changelog is commit subjects, which carry no sections. */}
          {notes.length === 0 && lines.length > 0 && (
            <ul className="flex shrink-0 list-disc flex-col gap-1.5 rounded-lg border border-line py-2.5 pl-8 pr-3">
              {lines.map((l, i) => <li key={i} className="text-footnote text-fg-muted">{l}</li>)}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="accent" size="small" onClick={() => void dismiss()} disabled={dismissing}>
            Dismiss
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
