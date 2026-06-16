import { useState, useEffect, type ChangeEvent } from "react";
import { PlusIcon, TrashIcon, MonitorIcon, ExternalLinkIcon } from "lucide-react";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  toast,
} from "../../components/ui";
import type { SectionProps } from "../types";

const KIND_LABELS: Record<DisplayKind, string> = {
  slots: "Slots",
  dashboard: "Dashboard",
  stage: "Stage",
  transcription: "Captions",
};
const KIND_ORDER: DisplayKind[] = ["slots", "dashboard", "stage", "transcription"];

interface DisplayRowProps {
  display: DisplayInfo;
  isFirst: boolean;
  canRemove: boolean;
  onRename: (name: string) => void;
  onSetKind: (kind: DisplayKind) => void;
  onOpenWindow: () => void;
  onRemove: () => void;
}

function DisplayRow({ display, isFirst, canRemove, onRename, onSetKind, onOpenWindow, onRemove }: DisplayRowProps) {
  const [editName, setEditName] = useState(display.name);

  useEffect(() => {
    setEditName(display.name);
  }, [display.name]);

  function handleBlur() {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== display.name) {
      onRename(trimmed);
    } else {
      setEditName(display.name);
    }
  }

  const displayUrl = `${window.location.origin}/${encodeURIComponent(display.id)}`;

  return (
    <div className={`flex flex-col gap-1.5 py-2${isFirst ? "" : " border-t border-gray-a3"}`}>
      <div className="flex items-center gap-2">
        <MonitorIcon className="size-3.5 text-gray-9 shrink-0" />
        <Input
          value={editName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
          onBlur={handleBlur}
          className="flex-1 min-w-0"
          aria-label="Display name"
        />
        <Button
          variant="filled"
          size="small"
          onClick={onOpenWindow}
          aria-label={`Open window for ${display.name}`}
        >
          <ExternalLinkIcon className="size-3.5 text-gray-9" />
          Open window
        </Button>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Remove display ${display.name}`}
        >
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>
      {/* Kind picker + URL hint */}
      <div className="ml-5 flex items-center gap-2">
        <Select
          value={display.kind ?? "slots"}
          onValueChange={(v: string) => {
            if (v !== (display.kind ?? "slots")) onSetKind(v as DisplayKind);
          }}
        >
          <SelectTrigger className="w-36 shrink-0">
            <SelectValue placeholder="Display type…" />
          </SelectTrigger>
          <SelectContent>
            {KIND_ORDER.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          className="text-left text-[11px] text-gray-a9 hover:text-gray-11 font-mono truncate transition-colors min-w-0"
          title="Click to copy URL"
          onClick={() => navigator.clipboard.writeText(displayUrl).then(() => toast.success("URL copied"))}
        >
          {displayUrl}
        </button>
      </div>
    </div>
  );
}

export function DisplaysSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
  return (
    <div className="px-5 flex flex-col gap-4 py-5">
      <p className="text-caption1 text-gray-9">
        Each display runs in its own kiosk window with its own slot set. All displays share the same
        plan and PCO data.
      </p>

      <div className="flex flex-col">
        {(stageState.displays ?? []).map((display, idx) => (
          <DisplayRow
            key={display.id}
            display={display}
            isFirst={idx === 0}
            canRemove={(stageState.displays?.length ?? 1) > 1}
            onRename={(name) => handlers.handleRenameDisplay(display.id, name)}
            onSetKind={(kind) => handlers.handleSetDisplayKind(display.id, kind)}
            onOpenWindow={() => handlers.handleOpenDisplayWindow(display.id)}
            onRemove={() => handlers.handleRemoveDisplay(display.id)}
          />
        ))}
      </div>

      <Button variant="filled" size="small" onClick={handlers.handleAddDisplay} className="self-start">
        <PlusIcon className="size-3.5 text-gray-9" />
        Add display
      </Button>
    </div>
  );
}
