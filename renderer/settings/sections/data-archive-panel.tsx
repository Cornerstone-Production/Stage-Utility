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

import { errorMessage } from "@main/services/errors";
import { DownloadIcon, UploadIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

import {
  Button,
  ButtonGroup,
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
  label?: string | null;
}

/** What to do with a service that is here already but recorded differently.
 *  Keeping what this machine has is always the default. */
type Choice = "skip" | "merge" | "replace";

interface ImportPlan {
  newServices: ServiceMeta[];
  identicalServices: ServiceMeta[];
  differingServices: ServiceMeta[];
  newBaptismSessions: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CHOICES: { id: Choice; label: string; hint: string }[] = [
  {
    id: "skip",
    label: "Keep mine",
    hint: "Leave every one of them exactly as this machine recorded it. Nothing changes.",
  },
  {
    id: "merge",
    label: "Merge",
    hint: "Fill in what this machine is missing — items and samples it never recorded. Nothing it already has is changed.",
  },
  {
    id: "replace",
    label: "Replace mine",
    hint: "Discard this machine's version of each and take the archive's instead.",
  },
];

/** A glance at which services disagree, without a row each. At fifty the list is
 *  the noise, not the information — the dates that matter are the first few. */
function summarise(services: ServiceMeta[]): string {
  const shown = services.slice(0, 3).map((s) => (s.label ? `${s.serviceDate} (${s.label})` : s.serviceDate));
  const rest = services.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

export function DataArchivePanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; plan: ImportPlan } | null>(null);
  const [choice, setChoice] = useState<Choice>("skip");
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
      setChoice("skip"); // keeping what is here is always the default

    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await fetch("/api/archive/import", {
        method: "POST",
        headers: { "X-Archive-Mode": choice },
        body: await pending.file.arrayBuffer(),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Import failed.");
      const parts = [
        body.added.length > 0 && `added ${plural(body.added.length, "service")}`,
        body.merged.length > 0 && `merged ${body.merged.length}`,
        body.replaced.length > 0 && `replaced ${body.replaced.length}`,
      ].filter(Boolean);
      // A raw-file failure does not abort the import — the summary records are
      // already applied — but it must not read as a clean success either. On a
      // full card every raw write fails and the samples behind these services are
      // simply absent, which nothing else would ever tell the operator.
      const failed: { file: string; reason: string }[] = body.rawFilesFailed ?? [];
      if (failed.length > 0) {
        toast.error(
          `Import finished, but ${plural(failed.length, "raw sample file")} could not be written ` +
            `(${failed[0].reason}). The services are here; their samples are not. Check disk space, ` +
            `then import again — keep the file.`,
        );
      } else {
        toast.success(
          parts.length === 0
            ? "Nothing changed — everything in that file was already here."
            : `Import done: ${parts.join(", ")}.`,
        );
      }
      setPending(null);
      setChoice("skip");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const fresh = pending?.plan.newServices.length ?? 0;
  const identical = pending?.plan.identicalServices.length ?? 0;
  const differing = pending?.plan.differingServices ?? [];
  const affected = choice === "skip" ? 0 : differing.length;
  const willChange = fresh + affected;

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
            <div className="mt-2 flex flex-col gap-3 rounded-xl border border-gray-5 bg-gray-2 p-3">
              <span className="text-caption1 font-medium text-gray-12">{pending.file.name}</span>

              <span className="text-caption2 text-gray-9">
                {fresh > 0
                  ? `${plural(fresh, "service")} would be added.`
                  : "No services in that file are new to this machine."}
                {identical > 0 && ` ${plural(identical, "service")} already here and unchanged.`}
                {pending.plan.newBaptismSessions > 0 &&
                  ` ${plural(pending.plan.newBaptismSessions, "baptism session")} would be added.`}
              </span>

              {/* The only case worth a decision: here already, but the two copies
                  disagree. One choice covers all of them — a control per service is
                  unreadable the moment a year's worth disagrees, and picking
                  individually across fifty is not a thing anyone wants to do. */}
              {differing.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-caption2 text-amber-11">
                    {plural(differing.length, "service")} here already but recorded differently in
                    that file.
                  </span>
                  <span className="text-caption2 text-gray-11">{summarise(differing)}</span>
                  <ButtonGroup className="self-start">
                    {CHOICES.map(({ id, label, hint }) => (
                      <Button
                        key={id}
                        variant={choice === id ? "accent" : "filled"}
                        size="small"
                        disabled={busy}
                        title={hint}
                        onClick={() => setChoice(id)}
                      >
                        {label}
                      </Button>
                    ))}
                  </ButtonGroup>
                  <span className="text-caption2 text-gray-9">
                    {CHOICES.find((c) => c.id === choice)?.hint}
                  </span>
                </div>
              )}

              <div className="flex gap-2">
                {willChange > 0 && (
                  <Button variant="accent" size="small" onClick={runImport} disabled={busy}>
                    {[
                      fresh > 0 && `Add ${fresh}`,
                      affected > 0 && `${choice === "merge" ? "merge" : "replace"} ${affected}`,
                    ]
                      .filter(Boolean)
                      .join(", ")
                      .replace(/^./, (c) => c.toUpperCase())}
                  </Button>
                )}
                <Button variant="transparent" size="small" onClick={() => setPending(null)} disabled={busy}>
                  {willChange > 0 ? "Cancel" : "Close"}
                </Button>
              </div>
            </div>
          )}
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}
