// screen-menu.tsx — the things you do TO a signage screen, rather than to what
// it is playing.
//
// These lived on the Screens tab, on a compact row that showed every signage
// screen a second time. That was the redundancy: the same screens, twice, with
// two preview iframes each — and each preview is a real kiosk page holding its
// own event stream.
//
// So the row is gone and its actions moved here, onto the card that already
// shows what the screen is playing. Nothing was dropped: rename, rotation, open
// in a window, reload and remove are all still here, which is the whole of what
// that row offered.

import { DropdownMenu } from "radix-ui";
import { ExternalLinkIcon, MoreVerticalIcon, PencilIcon, RefreshCwIcon, TrashIcon } from "lucide-react";

import type { Output, ScreenRotation } from "@main/types/views";

import { MENU_CONTENT, MENU_ITEM, RotationMenu } from "../../components/ui/rotation-menu";
import { confirm } from "../../components/ui/confirm-dialog";
import { errorMessage } from "@main/services/errors";
import { invoke } from "../../lib/api";
import { screenRotation } from "@main/types/views";
import { toast } from "../../components/ui/toast";

export function ScreenMenu({
  output,
  onChanged,
}: {
  output: Output;
  /** Re-read after anything that changes the screen list. */
  onChanged: () => Promise<void>;
}) {
  /** Run one action, say what went wrong, and re-read either way. */
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      // Said out loud. A rename that silently failed reads as the field not
      // taking, and the operator tries again rather than reporting it.
      toast.error(errorMessage(err));
    } finally {
      await onChanged();
    }
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`${output.name} options`}
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle outline-none transition-colors hover:bg-fill hover:text-fg data-[state=open]:bg-fill"
      >
        <MoreVerticalIcon className="size-3.5" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT}>
          <DropdownMenu.Item
            className={MENU_ITEM}
            onSelect={() => {
              // A prompt, matching what the Screens row did. An inline field
              // here would be a second editing mode on a card that already has
              // a tag picker and a preview.
              const name = window.prompt("Rename this screen", output.name)?.trim();
              if (name && name !== output.name) {
                void act(() => invoke("outputs:rename", { id: output.id, name }));
              }
            }}
          >
            <PencilIcon className="size-3.5 text-fg-subtle" />
            Rename…
          </DropdownMenu.Item>

          <RotationMenu
            rotation={screenRotation(output) as ScreenRotation}
            onSet={(deg) => void act(() => invoke("outputs:setRotation", { id: output.id, rotation: deg }))}
          />

          <DropdownMenu.Item
            className={MENU_ITEM}
            // window.open, NOT the `outputs:openWindow` channel — that is an
            // Electron-era opener the web build does not use, and dispatching it
            // would have quietly done nothing. The same thing the Screens row
            // did, which went through handleOpenOutputWindow.
            onSelect={() =>
              window.open(
                `${window.location.origin}/${encodeURIComponent(output.id)}`,
                `display-${output.id}`,
              )
            }
          >
            <ExternalLinkIcon className="size-3.5 text-fg-subtle" />
            Open in a window
          </DropdownMenu.Item>

          <DropdownMenu.Item
            className={MENU_ITEM}
            onSelect={() => void invoke("displays:refresh", { id: output.id })}
          >
            <RefreshCwIcon className="size-3.5 text-fg-subtle" />
            Reload it
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="my-1 h-px bg-line" />

          <DropdownMenu.Item
            className={`${MENU_ITEM} text-red-11`}
            onSelect={() =>
              void (async () => {
                const ok = await confirm({
                  title: `Remove ${output.name}?`,
                  message:
                    "The screen goes. Its tags lose it, and any machine bound to it returns to the holding screen.",
                  confirmLabel: "Remove",
                  destructive: true,
                });
                if (ok) await act(() => invoke("outputs:remove", { id: output.id }));
              })()
            }
          >
            <TrashIcon className="size-3.5" />
            Remove
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
