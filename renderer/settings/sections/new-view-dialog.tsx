// Creating a view: name, kind, and - for a custom view - a starting template.
//
// Extracted from ViewsSection so it has ONE implementation. It is reached from
// two places that both want the same three questions: the view picker on a
// screen card ("New view..."), and the Views-not-on-a-screen section. A second
// copy of this form is how the two would drift, and the template step is the
// part that would quietly go missing - it is the only way to get the Dashboard
// and Confidence Monitor starting layouts.

import { useState, type ChangeEvent, type ReactNode } from "react";

import { Dialog, Input, Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "../../components/ui";
import { dashboardTemplate, confidenceMonitorTemplate } from "./layout-editor";
import type { SectionHandlers } from "../types";

// Copied verbatim from the list this replaces. Retyping it from memory dropped
// "stage" and "spl-rundown" - two view kinds that would then have been
// uncreatable, with nothing failing to say so.
const KIND_LABELS: Record<ViewKind, string> = {
  slots: "Mic Slots",
  dashboard: "Dashboard",
  stage: "Stage",
  transcription: "Transcription",
  custom: "Custom Layout",
  script: "Script",
  "spl-rundown": "SPL Rundown",
};
const KIND_ORDER: ViewKind[] = ["slots", "dashboard", "stage", "transcription", "script", "spl-rundown", "custom"];

type StartFrom = "blank" | "dashboard" | "confidence";

export function NewViewDialog({
  handlers,
  trigger,
  open,
  onOpenChange,
  onCreated,
}: {
  handlers: SectionHandlers;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called with the new view's id, so a caller can assign or open it. */
  onCreated?: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ViewKind>("slots");
  const [startFrom, setStartFrom] = useState<StartFrom>("blank");

  return (
    <Dialog
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      title="New view"
      description="Pick what this view shows. You can change the type later."
      confirmLabel="Create"
      confirmDisabled={false}
      onConfirm={async () => {
        const id = await handlers.handleAddView(name.trim(), kind);
        if (id && kind === "custom" && startFrom !== "blank") {
          const objects = startFrom === "dashboard" ? dashboardTemplate() : confidenceMonitorTemplate();
          await handlers.handleSetViewLayout(id, {
            version: 1,
            canvas: { width: 1920, height: 1080, background: null },
            objects,
          });
        }
        setName("");
        setKind("slots");
        setStartFrom("blank");
        if (id) onCreated?.(id);
      }}
    >
      <div className="flex flex-col gap-3">
        <Input
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          placeholder="View name (e.g. Main Mic Slots)"
          className="text-fg"
          autoFocus
        />
        <Select value={kind} onValueChange={(v: string) => setKind(v as ViewKind)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_ORDER.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {kind === "custom" && (
          <label className="flex flex-col gap-1.5">
            <span className="text-caption2 text-fg-subtle">Start from</span>
            <Select value={startFrom} onValueChange={(v: string) => setStartFrom(v as StartFrom)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blank">Blank canvas</SelectItem>
                <SelectItem value="dashboard">Dashboard template</SelectItem>
                <SelectItem value="confidence">Confidence Monitor template</SelectItem>
              </SelectContent>
            </Select>
          </label>
        )}
      </div>
    </Dialog>
  );
}

export { KIND_LABELS, KIND_ORDER };
