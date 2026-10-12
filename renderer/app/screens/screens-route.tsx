// Screens — every physical screen, what it shows, and whether it is on.
//
// Views and Displays were separate tabs and the join between them lived in the
// operator's head. One card per screen answers both, with a LIVE preview of
// what that screen is actually rendering.
//
// The card is OutputsSection's OutputRow, extended — not a parallel
// implementation. A first pass here built its own card grid and immediately had
// fewer controls than the thing it sat above, plus a picker whose placeholder
// was a selectable empty value that the server rejected. Extending the one that
// already worked is why every control survived.
//
// The Views master list is gone: editing a view is its own route, so opening
// the editor no longer scrolls the page and shifts it out of reach.
//
// Everything that list used to own now lives on this page. Creating a view is
// "New view..." in a screen's picker (and a button below the grid); renaming,
// duplicating and deleting are on the view itself; a view no screen shows
// appears under "Views not on a screen" rather than being reachable only from a
// side panel. Manual view REORDERING was dropped on purpose: nothing read the
// order except that one dropdown, which now sorts by name.

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { OutputsSection } from "../../settings/sections/outputs-section";
import { ScreenPanelHost } from "./screen-panel-host";
import type { PanelDevice, PanelTarget } from "../../settings/sections/screen-settings-panel";
import { useStageSettings } from "../use-stage-settings";
import { UnclaimedScreens } from "./unclaimed-screens";

export function ScreensRoute() {
  const s = useStageSettings();
  const router = useRouter();
  // What the Screen settings panel is open on, if it is. Held HERE rather than in
  // the cards because two things outside the card grid open it: the Add a screen
  // tile and a waiting device's "Set up as a new screen".
  const [panel, setPanel] = useState<PanelTarget | null>(null);

  if (s.stageLoading || !s.stageState) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
      </div>
    );
  }

  const outputs = s.stageState.outputs ?? [];
  const newTarget = (device: PanelDevice | null): PanelTarget => ({
    kind: "new",
    device,
    // A device is named for itself, as it always was; an output of a Mac output
    // helper for the output, since all of a Mac's outputs share its hostname. A
    // screen from the Add tile
    // is left unnamed, and the server names it "Display N" from the id it gets:
    // a count of the screens here repeats a name once one has been removed, and
    // an id is never reused.
    defaultName: device ? device.name || device.hostname || "New screen" : "",
  });
  // A screen removed while its panel was open leaves nothing to show, and the
  // panel's column has to go with it: the panel draws nothing for a screen that
  // is gone, but its host would still hold a 400 px strip beside the cards.
  const open = panel?.kind === "edit" && !outputs.some((o) => o.id === panel.outputId) ? null : panel;

  return (
    <div className="pb-[50vh] max-sm:pb-24 lg:flex lg:items-start lg:gap-4">
      <div className="min-w-0 flex-1">
        <OutputsSection
          stageState={s.stageState}
          handlers={s.handlers}
          serviceTypes={s.serviceTypes}
          selectedOutputId={open?.kind === "edit" ? open.outputId : null}
          onOpenSettings={(outputId) => setPanel({ kind: "edit", outputId })}
          onAddScreen={() => setPanel(newTarget(null))}
          onEditLayout={(viewId) => {
            // Select it too, so the editor's slot state resolves against the right
            // view the moment it mounts.
            s.setSelectedViewId(viewId);
            router.navigate({ to: `/screens/${viewId}/edit` as never });
          }}
        />
        {/* Screens found on the network that are not set up yet. Here rather than
            on a tab of their own: this page exists BECAUSE Views and Displays used
            to be separate tabs, and a Kiosks tab recreated that split one level
            down. */}
        {/* Claiming "as a new screen" opens the panel instead of creating at once:
            a spare machine booting must not mint a screen nobody asked for, and a
            screen made in one click had no say in its role, its view or its name. */}
        <UnclaimedScreens outputs={outputs} onSetUpNew={(device) => setPanel(newTarget(device))} />
      </div>
      {open && (
        <ScreenPanelHost
          // A different screen, or a different device, is a different form.
          key={open.kind === "edit" ? open.outputId : `new:${open.device?.id ?? "add"}`}
          stageState={s.stageState}
          handlers={s.handlers}
          target={open}
          onClose={() => setPanel(null)}
          onOpenMessagingSettings={() => router.navigate({ to: "/settings/messages" as never })}
        />
      )}
    </div>
  );
}
