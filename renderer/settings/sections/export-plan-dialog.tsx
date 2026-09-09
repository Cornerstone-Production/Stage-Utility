// Exporting one service type's setup.
//
// A checklist over the plan export, and a plain anchor to download it. An
// anchor, not a fetch-and-blob: the browser takes the filename from
// Content-Disposition and middle-click behaves — the same reason the layout
// editor's Export is one.
//
// The counts come from /api/plans/export/preview, which is the export code path
// with everything on. Nothing here counts anything itself, so what the dialog
// promises and what the file holds cannot drift apart.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, Loader2Icon } from "lucide-react";

import { invoke } from "../../lib/api";
import { errorMessage } from "@main/services/errors";
import type { PlanExportPreview } from "@main/services/plan-export";
import type { ServiceTypeDTO } from "@main/types/pco";
import {
  Button,
  ButtonGroup,
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Switch,
} from "../../components/ui";

/** The query string the Download anchor points at — the checklist, verbatim. */
export function planExportHref(
  serviceTypeId: string,
  choices: { slots: "type" | "all"; patch: boolean; presets: boolean },
): string {
  const q = new URLSearchParams({
    serviceTypeId,
    slots: choices.slots,
    patch: choices.patch ? "1" : "0",
    presets: choices.presets ? "1" : "0",
  });
  return `/api/plans/export?${q}`;
}

export function ExportPlanDialog({
  open,
  onOpenChange,
  serviceTypes,
  defaultServiceTypeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The types this machine offers — the allowlist, or all of them when it is
   *  empty. Decided by the caller, which already computes it for the page. */
  serviceTypes: ServiceTypeDTO[];
  defaultServiceTypeId: string | null;
}) {
  const [chosen, setChosen] = useState(defaultServiceTypeId ?? serviceTypes[0]?.id ?? "");
  const [slots, setSlots] = useState<"type" | "all">("type");
  const [patch, setPatch] = useState(true);
  const [presets, setPresets] = useState(false);

  // The scope is IN the key: the counts differ between the two, so flipping the
  // segmented control has to refetch. Left out, the boards and rows line sat
  // still while the file the Download link points at grew.
  const preview = useQuery({
    queryKey: ["plans:exportPreview", chosen, slots],
    queryFn: () => invoke<PlanExportPreview>("plans:exportPreview", { serviceTypeId: chosen, slots }),
    enabled: open && !!chosen,
    retry: false,
  });

  const data = preview.data;
  const hasPatch = (data?.patchVariants.length ?? 0) > 0;
  // Nothing to download, and the server would answer 400 — the anchor must not
  // navigate to an error page.
  const ready = !!data && !preview.isFetching && !preview.error;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            Export {data?.serviceTypeName ?? serviceTypes.find((t) => t.id === chosen)?.name ?? "plan"}
          </DialogTitle>
          <DialogDescription>
            A file you can bring into another Stage Utility. It adds to what is there; it never
            replaces the other machine&apos;s setup. Hardware bindings stay behind and are listed for
            re-pointing on import.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Row label="Service type">
            <Select value={chosen} onValueChange={setChosen} disabled={serviceTypes.length === 0}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder={serviceTypes.length === 0 ? "No types found" : "Select…"} />
              </SelectTrigger>
              <SelectContent>
                {serviceTypes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          {preview.isPending && (
            <p className="text-caption1 text-fg-subtle">
              <Loader2Icon className="mr-1.5 inline size-3.5 animate-spin" />
              Working out what is in it…
            </p>
          )}

          {!!preview.error && (
            <p role="alert" className="rounded-lg border border-danger-9/40 bg-danger-9/10 px-3 py-2 text-footnote text-danger-11">
              {errorMessage(preview.error)}
            </p>
          )}

          {data && (
            <div className="overflow-hidden rounded-lg border border-line">
              <Line
                label="Views and layouts"
                sub="the boards, and anything they embed"
                tag={`${data.views}`}
              />
              <Line
                label="Mic slots"
                sub={`${data.boards} board${data.boards === 1 ? "" : "s"}, ${data.rows} row${data.rows === 1 ? "" : "s"}`}
              >
                <ButtonGroup role="group" aria-label="Which service types' boards travel">
                  <Button
                    variant={slots === "type" ? "accent" : "filled"}
                    aria-pressed={slots === "type"}
                    size="small"
                    onClick={() => setSlots("type")}
                  >
                    This type only
                  </Button>
                  <Button
                    variant={slots === "all" ? "accent" : "filled"}
                    aria-pressed={slots === "all"}
                    size="small"
                    onClick={() => setSlots("all")}
                  >
                    Every type on those views
                  </Button>
                </ButtonGroup>
              </Line>
              <Line
                label="Patch sheet variant"
                sub={hasPatch
                  ? data.patchVariants.map((p) => `${p.sheetName}: ${p.variantName}`).join(" · ")
                  : "none assigned"}
              >
                <Switch
                  checked={hasPatch && patch}
                  disabled={!hasPatch}
                  onCheckedChange={setPatch}
                  aria-label="Include the patch sheet variant"
                />
              </Line>
              <Line
                label="Slot presets"
                sub={`${data.presets} saved arrangement${data.presets === 1 ? "" : "s"} — global, not this type's`}
              >
                <Switch
                  checked={presets}
                  disabled={data.presets === 0}
                  onCheckedChange={setPresets}
                  aria-label="Include the slot presets"
                />
              </Line>
              <Line
                label="ScriptView layouts"
                sub="the column presets these views use"
                tag={`${data.scriptviewLayouts}`}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="transparent" size="small">Cancel</Button>
          </DialogClose>
          {ready ? (
            <Button variant="accent" size="small" asChild>
              <a
                href={planExportHref(chosen, { slots, patch: hasPatch && patch, presets })}
                download
                data-testid="plan-export-download"
                onClick={() => onOpenChange(false)}
              >
                <DownloadIcon className="size-3.5" /> Download
              </a>
            </Button>
          ) : (
            // A disabled ANCHOR is still clickable, so the not-ready state is a
            // button instead: a Download that navigates to a 400 is worse than
            // one that is plainly not offered yet.
            <Button variant="accent" size="small" disabled>
              <DownloadIcon className="size-3.5" /> Download
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-footnote text-fg">{label}</span>
      {children}
    </div>
  );
}

function Line({ label, sub, tag, children }: {
  label: string; sub?: string; tag?: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="block text-footnote text-fg">{label}</span>
        {sub && <span className="block truncate text-caption2 text-fg-subtle">{sub}</span>}
      </span>
      {tag && (
        <span className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-caption2 text-fg-subtle">
          {tag}
        </span>
      )}
      {children}
    </div>
  );
}
