// What's new: the running release's notes, reopened read-only from the Updates card.
//
// The after-update dialog is shown once and gone at Dismiss. This is the way
// back to the same notes, at any time: the same body (ReleaseNotesBody), titled
// for the version running, with Close in place of Dismiss. Closing it does
// nothing on the server. Dismiss is the after-update dialog's acknowledgement,
// and a dialog that spent it from here would hide that one from whoever has not
// seen it yet.
//
// The notes are read when the button is pressed and at no other time: on most
// presses the server answers from what it kept, and only an install with
// nothing kept goes to GitHub for them.

import { useRef, useState } from "react";

import { releasePageUrl } from "@main/services/github-repo";
import { releaseTagOf } from "@main/services/release-tags";
import type { RunningNotes } from "@main/services/update/running-notes";
import { invoke } from "../../lib/api";
import { useFailedReads } from "../../lib/use-failed-reads";
import { ReleaseNotesBody } from "../../app/update-notices";
import { Button, DialogClose, DialogContent, DialogHeader, DialogRoot, DialogTitle, DialogTrigger } from "../../components/ui";

/** How long an answer may take before the loading line is drawn. Kept notes
 *  answer well inside it, so the line appears only for a fetch from GitHub
 *  rather than flashing on every press. */
const LOADING_LINE_AFTER_MS = 150;

type View = { state: "loading"; slow: boolean } | { state: "answered"; answer: RunningNotes };

export function WhatsNewButton({ version }: { version: string }) {
  const [view, setView] = useState<View>({ state: "loading", slow: false });
  // Which press the answer on its way belongs to. Closing bumps it, so an
  // answer arriving after the dialog closed, or after a newer press, is dropped.
  const press = useRef(0);
  // Logs a failed request on [updater], once per run of failures. The server
  // logs every failure it answers; this is the one it never saw.
  const { fail, clear } = useFailedReads<"notes">("updater");

  function load(): void {
    const mine = ++press.current;
    setView({ state: "loading", slow: false });
    const timer = setTimeout(() => {
      if (press.current === mine) setView((v) => (v.state === "loading" ? { state: "loading", slow: true } : v));
    }, LOADING_LINE_AFTER_MS);
    invoke<RunningNotes>("update:releaseNotes")
      .then((answer) => {
        clear("notes");
        if (press.current === mine) setView({ state: "answered", answer });
      })
      // The request itself failed: the server is unreachable or answered an
      // error, so there is no answer to draw. The dialog says what it would say
      // for any failure, never an empty body, and the release link names the
      // running release only when the version names one.
      .catch((err: unknown) => {
        fail("notes", "the release notes for What's new", err);
        if (press.current === mine) {
          setView({
            state: "answered",
            answer: { ok: false, version, releaseUrl: releasePageUrl(releaseTagOf(version)), reason: "the request failed" },
          });
        }
      })
      .finally(() => clearTimeout(timer));
  }

  function onOpenChange(open: boolean): void {
    if (open) load();
    else press.current++;
  }

  return (
    <DialogRoot onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="soft" size="small">What's new</Button>
      </DialogTrigger>
      <DialogContent
        className="max-w-lg"
        // Radix focuses the first tabbable thing on open. The body is still
        // loading then and holds nothing tabbable, so that is the foot Close in
        // every state, the not-loaded one with its link included (tested).
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>
            What's new in <span className="font-mono">{version}</span>
          </DialogTitle>
        </DialogHeader>

        {view.state === "loading" ? (
          view.slow ? (
            <p role="status" className="flex items-center gap-2 text-footnote text-fg-muted">
              <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-fg-muted" />
              Loading the release notes…
            </p>
          ) : null
        ) : view.answer.ok ? (
          <ReleaseNotesBody notes={view.answer.notes} lines={view.answer.lines} intro={view.answer.intro} />
        ) : (
          <p className="text-footnote text-fg-muted">
            The release notes could not be loaded.{" "}
            <a
              href={view.answer.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xs text-accent underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Release page
            </a>
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <DialogClose asChild>
            <Button variant="filled" size="small">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
