// The View settings mode of the side panel: everything about a view as a thing in
// its own right. What it is (a wall view or a control surface) is set here and
// nowhere else; a screen takes its role from the view it shows.
//
// Reached from a view's card, from "View settings" on a screen, and from a chip
// in another view's "Shown on".

import { useState } from "react";

import { Button } from "../../components/ui";
import { useResyncOn } from "../../lib/use-resync-on";
import { viewCanBeControlSurface, viewShownInSidebar, viewSurface, type ViewSurface } from "@main/types/views";
import { SURFACE_COPY } from "../screen-role-confirm";
import { ChoiceCard, DangerButton, NameInput, PanelFooter, Section, SidebarRow } from "./screen-panel-parts";
import type { PanelTarget, ScreenPanelActions } from "./screen-settings-panel";

/** What the view body does to the outside world. */
export type ViewPanelActions = Pick<
  ScreenPanelActions,
  "onRenameView" | "onSetViewSurface" | "onSetShowInSidebar" | "onSelect" | "onEditLayout" | "onDuplicateView" | "onDeleteView"
>;

export function ViewBody({ view, outputs, actions }: { view: View; outputs: Output[]; actions: ViewPanelActions }) {
  const surface = viewSurface(view);
  const shownOn = outputs.filter((o) => o.viewId === view.id);
  const canBeControl = viewCanBeControlSurface(view);

  const [name, setName] = useState(view.name);
  useResyncOn([view.name], () => setName(view.name));
  function commitName() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== view.name) actions.onRenameView(view.id, trimmed);
    else setName(view.name);
  }
  /** Switching what a view is changes every screen showing it, so a view that is
   *  on screens goes through the confirm that names them (setViewRole). */
  function choose(to: ViewSurface) {
    if (to !== surface) actions.onSetViewSurface(view.id, to);
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-[18px] pb-[18px] pt-1.5">
        <Section title="Name">
          <NameInput id="view-name" label="View name" value={name} onChange={setName} onCommit={commitName} />
        </Section>

        <Section title="What this view is">
          <div role="group" aria-label="What this view is" className="grid grid-cols-2 gap-2">
            <ChoiceCard
              title="Wall view"
              hint={SURFACE_COPY.display.card}
              pressed={surface === "display"}
              onChoose={() => choose("display")}
            />
            <ChoiceCard
              title={SURFACE_COPY.console.title}
              hint={SURFACE_COPY.console.card}
              pressed={surface === "console"}
              disabled={!canBeControl}
              onChoose={() => choose("console")}
            />
          </div>
          {!canBeControl && (
            <p className="mt-1.5 text-caption1 text-fg-subtle">
              Only a custom layout can be a control surface: a calendar has no buttons to press.
            </p>
          )}
          {surface === "console" && (
            <SidebarRow
              checked={viewShownInSidebar(view)}
              onChange={(on) => actions.onSetShowInSidebar(view.id, on)}
              help="Operators open it from Consoles in the app."
            />
          )}
        </Section>

        <Section title="Shown on">
          {shownOn.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {shownOn.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => actions.onSelect({ kind: "edit", outputId: o.id } satisfies PanelTarget)}
                    className="rounded-full border border-line-strong bg-fill px-2.5 py-0.5 text-caption1 text-fg transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {o.name}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-caption1 text-fg-subtle">
                {surface === "console" ? "Buttons work on each of these." : "Read-only on each of these."} Click one to jump to it.
              </p>
            </>
          ) : (
            <p className="text-caption1 text-fg-subtle">
              No screen shows it. Pick it from a screen's view picker to put it on one.
            </p>
          )}
        </Section>

        <Section title="Layout">
          <div className="flex flex-wrap gap-2">
            {canBeControl && (
              <Button type="button" variant="accent" size="medium" onClick={() => actions.onEditLayout(view.id)}>
                Edit layout
              </Button>
            )}
            <Button
              type="button"
              variant="filled"
              size="medium"
              className="border border-line-strong"
              onClick={() => actions.onDuplicateView(view.id)}
            >
              Duplicate
            </Button>
          </div>
        </Section>
      </div>
      <PanelFooter hint="Changes save as you make them.">
        <DangerButton onClick={() => actions.onDeleteView(view.id)}>Delete view…</DangerButton>
      </PanelFooter>
    </>
  );
}
