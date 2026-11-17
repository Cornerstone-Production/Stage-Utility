// The Mic slots page's top bar: which plan, which side of it, and the two things
// that act on everything at once.

import { MoreHorizontalIcon, SparklesIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";

import { Button, ButtonGroup, MENU_ITEM, menuContent } from "../../components/ui";
import { PlanSwitcher } from "../../settings/sections/plan-switcher";
import { namedType } from "../../settings/sections/slots-target-pill";
import { useInAppLink } from "../../lib/use-search-param";
import { CopyFromDialog } from "./board-dialogs";
import { ShowSwitch } from "./photo-themes/photo-themes-panel";
import { themePhotosReason } from "./photo-themes/theme-photos-reason";
import type { PhotoPlan, PhotoThemes } from "./photo-themes/use-photo-themes";
import { SavedLayouts } from "./saved-layouts";
import type { MicSlots } from "./use-mic-slots";

export function TopBar({
  mic,
  savedOpen,
  onSavedOpen,
  savedBoardId,
  photos,
  photoPlan,
  photoPanelOpen,
  onPhotoPanel,
}: {
  mic: MicSlots;
  savedOpen: boolean;
  onSavedOpen: (open: boolean) => void;
  savedBoardId: string | null;
  photos: PhotoThemes;
  /** The plan Theme photos would be for; null on a Default, or with no plan. */
  photoPlan: PhotoPlan | null;
  photoPanelOpen: boolean;
  onPhotoPanel: (open: boolean) => void;
}) {
  const [copyAll, setCopyAll] = useState(false);
  const goInApp = useInAppLink();
  const photoReason = themePhotosReason({ hasServiceType: !!mic.serviceTypeId, hasPlan: mic.hasPlan, side: mic.side, connection: photos.state?.connection });
  const photoPanelShown = photoPanelOpen && !photoReason;
  const noType = !mic.serviceTypeId;
  const planActions = mic.hasPlan && mic.hasOverride && mic.side === "plan";
  const typeLabel = mic.typeName ? `${mic.typeName} default` : "Default";
  return (
    <>
    {/* The shell pads its scroller by 1rem from sm up, and a sticky bar holds at the
        padding edge rather than the scroller's: the bar cancels that padding, so
        nothing scrolls visibly above it. */}
    <div className="sticky top-0 z-20 -mx-2 flex flex-wrap items-center gap-2.5 border-b border-line bg-bg px-2 py-2 max-sm:-mx-3 max-sm:px-3 sm:-top-4 sm:-mt-4 sm:pt-6">
      <PlanSwitcher disabled={noType} />
      <span className="h-[22px] w-px bg-line" />
      <ButtonGroup role="group" aria-label="Which layouts to edit">
        <Button
          variant={mic.side === "default" ? "accent" : "filled"}
          size="small"
          aria-pressed={mic.side === "default"}
          disabled={noType}
          title="The layout this service type comes back to every week"
          onClick={() => void mic.setSide("default")}
        >
          {typeLabel}
        </Button>
        <Button
          variant={mic.side === "plan" ? "accent" : "filled"}
          size="small"
          aria-pressed={mic.side === "plan"}
          disabled={noType || !mic.hasPlan}
          title={mic.hasPlan ? "Layouts for this plan only: the next plan goes back to the default" : "No plan is selected, so there is nothing to make an exception for"}
          onClick={() => void mic.setSide("plan")}
        >
          {mic.label} only
          {mic.hasOverride && (
            <span className="ml-1 rounded bg-black/25 px-1 text-caption2 font-semibold" data-mic-edited="true">EDITED</span>
          )}
        </Button>
      </ButtonGroup>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="transparent" size="small" iconOnly aria-label="Plan board actions" disabled={noType}>
            <MoreHorizontalIcon className="size-4 text-fg-muted" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" className={menuContent("min-w-52")}>
            {/* Plan side only: from Default, unsaved edits are the default's, and
                a revert or promote would discard them or be undone by them. */}
            <DropdownMenu.Item className={MENU_ITEM} disabled={!planActions} onSelect={() => void mic.revertPlan()}>
              Revert {mic.label} to {namedType(mic.typeName)} default
            </DropdownMenu.Item>
            <DropdownMenu.Item className={MENU_ITEM} disabled={!planActions} onSelect={() => void mic.promotePlan()}>
              Set {mic.label} as {namedType(mic.typeName)} default
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Item className={MENU_ITEM} disabled={mic.boards.length === 0} onSelect={() => setCopyAll(true)}>
              Copy every board from another plan or service type…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Button
        variant={photoPanelShown ? "soft" : "filled"}
        size="small"
        data-theme-photos-button
        aria-pressed={photoPanelShown}
        aria-describedby={photoReason ? "theme-photos-reason" : undefined}
        disabled={!!photoReason}
        tooltip={photoReason?.why ?? ""}
        onClick={() => onPhotoPanel(!photoPanelShown)}
      >
        <SparklesIcon className="size-3.5" />
        Theme photos
      </Button>
      {/* With the sheet open its header carries the switch: both would wrap the bar. */}
      {photoPlan && !photoReason && !photoPanelShown && photos.hasApproved && <ShowSwitch choice={photos.choice} plan={photoPlan} photos={photos} />}
      <span className="flex-1" />
      {mic.dirty && (
        <>
          <span className="text-caption1 text-fg-muted" data-mic-unsaved="true">Unsaved changes</span>
          <Button variant="transparent" size="small" disabled={mic.saving} onClick={() => void mic.discard()}>
            Discard
          </Button>
        </>
      )}
      <SavedLayouts mic={mic} open={savedOpen} onOpenChange={onSavedOpen} boardId={savedBoardId} />
      <Button variant="accent" size="medium" disabled={!mic.dirty || mic.saving} onClick={() => void mic.saveAll()}>
        {mic.saving ? "Saving…" : "Save all"}
      </Button>
      {copyAll && (
        <CopyFromDialog
          title="Copy every board"
          description={`Copies a layout onto every board for ${mic.hasPlan && mic.side === "plan" ? mic.label : `${namedType(mic.typeName)} default`}. Each board keeps its own columns and charger width.`}
          boards={[]}
          onClose={() => setCopyAll(false)}
          onCopy={(from, sourceName) => mic.copyIntoAll(from, sourceName)}
        />
      )}
    </div>
    {photoReason && (
      <p
        id="theme-photos-reason"
        role="note"
        data-theme-photos-reason
        className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg bg-fill px-3 py-2 text-caption1 text-fg-muted"
      >
        <SparklesIcon className="size-3.5 flex-none" aria-hidden />
        <span>Theme photos is off. {photoReason.why}.</span>
        {photoReason.fix === "integrations" && (
          <a href="/settings/integrations" onClick={(e) => goInApp(e, { to: "/settings/integrations" })} className="font-semibold text-accent underline">
            Open Integrations
          </a>
        )}
        {photoReason.fix === "plan" && (
          <button type="button" className="font-semibold text-accent underline" onClick={() => void mic.setSide("plan")}>
            Switch to this plan
          </button>
        )}
      </p>
    )}
    </>
  );
}
