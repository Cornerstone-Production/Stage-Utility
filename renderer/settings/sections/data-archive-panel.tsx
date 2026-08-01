// data-archive-panel.tsx — download / restore everything the app has recorded.
//
// Sits beside Backup & restore, which does the other half: that one restores how
// the app is set up, this one restores what it recorded. They are one click apart,
// so the wording carries the distinction the layout does not.
//
// Import is deliberately two steps. Choosing a file only inspects it and reports
// what would happen; the button appears after. A confirmation dialog would be
// dismissed unread, where "3 new, 41 already here" makes an archive from the wrong
// box obvious while it is still a click away.

import { DownloadIcon, UploadIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

import {
  Button,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldSet,
  toast,
} from "../../components/ui";

interface ServiceMeta {
  serviceKey: string;
  serviceDate: string;
}

interface ImportPlan {
  newServices: ServiceMeta[];
  presentServices: ServiceMeta[];
  newBaptismSessions: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function DataArchivePanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; plan: ImportPlan } | null>(null);
  const [busy, setBusy] = useState(false);

  function download() {
    window.location.assign("/api/archive/export");
  }

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setBusy(true);
    setPending(null);
    try {
      const res = await fetch("/api/archive/inspect", { method: "POST", body: await file.arrayBuffer() });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Could not read that archive.");
      setPending({ file, plan: body as ImportPlan });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await fetch("/api/archive/import", { method: "POST", body: await pending.file.arrayBuffer() });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Import failed.");
      const added = body.added.length as number;
      toast.success(
        added === 0
          ? "Nothing to add — every service in that file was already here."
          : `Added ${plural(added, "service")}, left ${body.skipped.length} already here alone.`,
      );
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const fresh = pending?.plan.newServices.length ?? 0;

  return (
    <FieldSet flat>
      <FieldGroup>
        <Field orientation="vertical">
          {/* No FieldLabel: the collapsible header above already says "Data archive",
              and repeating it two lines apart reads as a duplication bug. */}
          <FieldContent>
            <FieldDescription>
              Everything the app has recorded — service history, SPL readings, attendance and
              baptism timings, plus the raw samples behind them. Use it to move your history onto
              a rebuilt machine. This is not Backup &amp; restore above: that one covers how the
              app is set up, this one covers what it recorded. Services recorded before this
              version kept only their summaries, so those carry no raw samples.
            </FieldDescription>
          </FieldContent>

          <div className="flex flex-wrap gap-2">
            <Button variant="filled" size="small" onClick={download} disabled={busy}>
              <DownloadIcon className="size-3.5 text-gray-9" /> Download archive
            </Button>
            <Button variant="filled" size="small" onClick={() => fileRef.current?.click()} disabled={busy}>
              <UploadIcon className="size-3.5 text-gray-9" /> Choose an archive
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/zip,.zip"
              className="hidden"
              onChange={onPick}
            />
          </div>

          {pending && (
            <div className="mt-2 flex flex-col gap-2 rounded-xl border border-gray-5 bg-gray-2 p-3">
              <span className="text-caption1 font-medium text-gray-12">{pending.file.name}</span>
              <span className="text-caption2 text-gray-9">
                {fresh > 0
                  ? `${plural(fresh, "service")} would be added.`
                  : "No services in that file are new to this machine."}{" "}
                {pending.plan.presentServices.length > 0 &&
                  `${plural(pending.plan.presentServices.length, "service")} already here and will be left alone.`}
                {pending.plan.newBaptismSessions > 0 &&
                  ` ${plural(pending.plan.newBaptismSessions, "baptism session")} would be added.`}
              </span>
              <div className="flex gap-2">
                {fresh > 0 && (
                  <Button variant="accent" size="small" onClick={runImport} disabled={busy}>
                    Import {plural(fresh, "service")}
                  </Button>
                )}
                <Button variant="transparent" size="small" onClick={() => setPending(null)} disabled={busy}>
                  {fresh > 0 ? "Cancel" : "Close"}
                </Button>
              </div>
            </div>
          )}
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}
