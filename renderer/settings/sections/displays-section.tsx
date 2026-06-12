import { useState, useEffect, type ChangeEvent } from "react";
import { PlusIcon, TrashIcon, MonitorIcon, ExternalLinkIcon } from "lucide-react";
import { Button, Input, toast } from "../../components/ui";
import type { SectionProps } from "../types";

interface DisplayRowProps {
  display: DisplayInfo;
  isFirst: boolean;
  canRemove: boolean;
  onRename: (name: string) => void;
  onOpenWindow: () => void;
  onRemove: () => void;
}

function DisplayRow({ display, isFirst, canRemove, onRename, onOpenWindow, onRemove }: DisplayRowProps) {
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

  const displayUrl = `${window.location.origin}/?display=${encodeURIComponent(display.id)}`;

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
      {/* URL hint — click to copy */}
      <button
        type="button"
        className="ml-5 text-left text-[11px] text-gray-a9 hover:text-gray-11 font-mono truncate transition-colors"
        title="Click to copy URL"
        onClick={() => navigator.clipboard.writeText(displayUrl).then(() => toast.success("URL copied"))}
      >
        {displayUrl}
      </button>
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
