// signage-screen-row.tsx — a signage screen on the Screens page, compactly.
//
// Deliberately NOT the full card the other screens get. A signage screen already
// appears on the Now board, where it has a live preview of what it is playing
// and the tags it carries — and that is the right home for both, because that
// page is about what is playing. Showing the same thing here was the same screen
// twice on two tabs, and twice the preview iframes: each one is a real kiosk page
// holding its own event stream, and a building with a dozen signage screens was
// paying for that on a page about cabling.
//
// What is left is what only Screens can answer: is it online, which machine is
// showing it, what URL to point a browser at, and how the panel is mounted.

import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { MENU_CONTENT, MENU_ITEM, RotationMenu } from "./rotation-menu";
import { ExternalLinkIcon, MoreVerticalIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import type { Output } from "@main/types/stage";
import { screenRotation } from "@main/types/views";

import { Input } from "../../components/ui/input";
import { Tooltip } from "../../components/ui/tooltip";
import { confirm } from "../../components/ui/confirm-dialog";
import { ScreenDevice } from "../../app/screens/screen-device";
import { ScreenSignageGroups } from "../../app/screens/screen-signage-groups";


export function SignageScreenRow({
  output,
  baseUrl,
  online,
  onRename,
  onSetRotation,
  onOpenWindow,
  onRefresh,
  onRemove,
}: {
  output: Output;
  baseUrl: string;
  online: boolean;
  onRename: (name: string) => void;
  onSetRotation: (rotation: 0 | 90 | 180 | 270) => Promise<void>;
  onOpenWindow: () => void;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const url = `${baseUrl}/${output.slug || output.id}`;
  const rotation = screenRotation(output);

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-raised px-3 py-2">
      <Tooltip label={online ? "Connected" : "Not connected"}>
        <span
          className={
            online
              ? "size-2 shrink-0 rounded-full bg-live-9"
              : "size-2 shrink-0 rounded-full bg-fill-active"
          }
          aria-label={online ? "Connected" : "Not connected"}
        />
      </Tooltip>

      {renaming ? (
        <Input
          autoFocus
          defaultValue={output.name}
          className="h-7 max-w-56 text-footnote"
          onBlur={(e) => {
            setRenaming(false);
            const name = e.currentTarget.value.trim();
            if (name && name !== output.name) onRename(name);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <button
          onClick={() => setRenaming(true)}
          className="min-w-0 truncate text-left text-footnote font-medium text-fg hover:underline"
          title={`${output.name} — click to rename`}
        >
          {output.name}
        </button>
      )}

      {rotation !== 0 ? (
        <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-caption2 text-fg-subtle">
          {rotation}°
        </span>
      ) : null}

      {/* The machine showing it, when one is bound. Nothing when it is a browser
          tab somebody opened. */}
      <ScreenDevice outputId={output.id} name={output.name} compact />

      {/* Tags, which is the one content thing that belongs here: it is how you
          say what a NEW screen is part of without going to another tab. What it
          is PLAYING is on the Now board, where there is a preview to go with it. */}
      <ScreenSignageGroups outputId={output.id} isSignage compact />

      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="ml-auto flex shrink-0 items-center gap-1 text-caption1 text-accent hover:underline"
      >
        Open
        <ExternalLinkIcon className="size-3" />
      </a>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={`More for ${output.name}`}
          className="shrink-0 rounded p-1 text-fg-subtle transition-colors hover:bg-fill hover:text-fg"
        >
          <MoreVerticalIcon className="size-3.5" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT}>
            <RotationMenu rotation={rotation} onSet={(deg) => void onSetRotation(deg)} />
            <DropdownMenu.Item onSelect={onOpenWindow} className={MENU_ITEM}>
              <ExternalLinkIcon className="size-3.5 text-fg-subtle" />
              Open in a window
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={onRefresh} className={MENU_ITEM}>
              <RefreshCwIcon className="size-3.5 text-fg-subtle" />
              Reload it
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Item
              onSelect={() =>
                void (async () => {
                  const ok = await confirm({
                    title: `Remove ${output.name}?`,
                    message:
                      "The screen goes. Its tags lose it, and any machine bound to it returns to the holding screen.",
                    confirmLabel: "Remove",
                    destructive: true,
                  });
                  if (ok) onRemove();
                })()
              }
              className={`${MENU_ITEM} text-red-11`}
            >
              <TrashIcon className="size-3.5" />
              Remove
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
