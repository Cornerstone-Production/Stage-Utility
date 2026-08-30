// A console, in the operator shell.
//
// Phase 3 gave a View a surface but gave a console nowhere to be: it rendered
// only on a panel Output, which meant the one surface built for the operator was
// the one the operator could not open. This is that place.
//
// The console renders through the SAME renderer a screen uses, so what is here
// is what a panel shows. The only difference is the context: `shell` means
// controls fire, drill-down works, and the layout can be edited in place.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
import { HOME_VIEW_ID } from "@main/services/home-view";
import { LayoutRenderer } from "../main/layout-renderer";
import { useStageSettings } from "./use-stage-settings";
import { capabilityLive } from "../main/render-context";
import { canEditInPlace } from "../editor/can-edit";
import { LayoutEditor } from "../editor/layout-editor";
import { Button, EmptyState } from "../components/ui";
import { AppLink } from "./app-link";
import { cn } from "../lib/cn";

/** How close to the top-right corner the pointer has to be for Edit to appear.
 *  Wide enough to find without aiming, small enough that it is never a surprise
 *  in the middle of the console. */
const CORNER_RADIUS_PX = 180;

export function ConsoleRoute() {
  const { viewId } = useParams({ strict: false }) as { viewId?: string };
  const s = useStageSettings();
  const router = useRouter();
  // Editing lives in component state, NOT the URL: entering edit mode must not
  // create a history entry, or Back would step through edit toggles instead of
  // leaving the console.
  //
  // It records WHICH console is being edited rather than a bare yes/no. Switching
  // console tabs is a param change on this same route, so React keeps this
  // component mounted and a boolean stayed true — every other console then opened
  // straight into the editor, and the only way back to a live console was to
  // leave for Home and return.
  const [editingFor, setEditingFor] = useState<string | null>(null);
  const [nearCorner, setNearCorner] = useState(false);
  const editing = !!viewId && editingFor === viewId;

  const view = s.stageState?.views?.find((v) => v.id === viewId) ?? null;

  // Home is a console view, so it matched this route and /consoles/home rendered
  // its cards on a canvas — the exact editor Phase 7 replaced. It has its own
  // tab, and this URL was never advertised, so it goes there.
  const isHome = viewId === HOME_VIEW_ID;
  useEffect(() => {
    if (isHome) router.navigate({ to: "/", replace: true });
  }, [isHome, router]);
  if (isHome) return null;

  if (!s.stageState) return null;
  if (!view) {
    return (
      <EmptyState
        title="That console is gone"
        hint="It may have been deleted or renamed. Screens lists everything that exists."
        action={
          <AppLink to="/screens" className="text-footnote text-accent hover:underline">
            Open Screens
          </AppLink>
        }
      />
    );
  }

  const editable = canEditInPlace(view, "shell");

  if (editing && editable) {
    return (
      <div className="h-full min-h-0 pt-3">
        <ConsoleEditor
          // Keyed by the view, so the save-conflict state below belongs to the
          // console it was read from. Carried across a tab switch it would send
          // one console's revision as another's, and a save built on nobody's
          // layout is exactly what that revision exists to refuse.
          key={view.id}
          view={view}
          settings={s}
          onExit={() => setEditingFor(null)}
        />
      </div>
    );
  }

  return (
    // FULL BLEED. The shell gutters its content, so the console sat inset with a
    // hard edge on all four sides — a slab of stage-black in the middle of a
    // themed page, which is what made it read as an embedded viewer rather than
    // a page of the app. The negative margins cancel that gutter so the console
    // simply IS the content area.
    <div
      className="relative flex h-full min-h-0 flex-col -mx-5 max-sm:-mx-3"
      // Proximity, not a hover region. A region big enough to aim at is also a
      // region that swallows every click inside it, and the top-right corner of
      // a console is a perfectly reasonable place to put a control. This watches
      // the distance instead, so nothing is covered until the button is actually
      // there to be pressed.
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const dx = r.right - e.clientX;
        const dy = e.clientY - r.top;
        setNearCorner(Math.hypot(Math.max(0, dx), Math.max(0, dy)) < CORNER_RADIUS_PX);
      }}
      onPointerLeave={() => setNearCorner(false)}
    >
      {/* The live console. `shell` context: controls fire, drill-down works.
          The canvas brings its own ground — see LayoutRenderer. */}
      <div className="min-h-0 flex-1">
        {view.layout ? (
          <LayoutRenderer
            layout={view.layout}
            viewId={view.id}
            ndiSource={view.ndiSource ?? null}
            interactive={capabilityLive("shell", "control")}
            surface="console"
          />
        ) : (
          <EmptyState
            title="Nothing on this console yet"
            hint="Add objects to it, and they will appear here and on any panel showing it."
          />
        )}
      </div>

      {/* Over the canvas, not above it. A row of its own pushed the console down
          and framed it, which is the framing this page was trying to lose. */}
      {editable && (
        // Shown near the CORNER, not from anywhere on the console: a button
        // appearing under the pointer wherever the operator happens to be
        // working — mid-drag on a fader — is the thing being fixed.
        //
        // Always visible where there is no hover at all, and while focused, so a
        // touch screen and a keyboard both keep a way in.
        <div className="pointer-events-none absolute right-3 top-3">
          <span
            className={cn(
              "inline-block rounded-md transition-opacity",
              // Nothing to click through while it is hidden, and a real target
              // the moment it is not.
              nearCorner ? "pointer-events-auto opacity-100" : "opacity-0",
              "focus-within:pointer-events-auto focus-within:opacity-100",
              "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
              // Its OWN ground, because the console's is not the page's. In light
              // mode the page is #f7f8fa and the console canvas is #0a0a0a, so a
              // button wearing the page's tokens came out near-black text on
              // near-black — measured at about 1.1:1, which is what "unreadable"
              // meant. The popover ground is the app's floating surface: it
              // carries its own contrast in both themes, over anything.
              "border border-line-strong bg-popover/95 shadow-lg backdrop-blur-xl",
            )}
          >
            <Button variant="transparent" size="small" onClick={() => setEditingFor(view.id)}>
              <PencilIcon className="size-3.5" />
              Edit
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The editor, as a console's content.
 *
 * Its own component so `key={view.id}` resets everything it holds when the
 * operator moves to another console — the revision it opened on above all.
 */
function ConsoleEditor({
  view,
  settings,
  onExit,
}: {
  view: View;
  settings: ReturnType<typeof useStageSettings>;
  onExit: () => void;
}) {
  // sessionRev carries the revision the editor opened, so a save built on a
  // layout someone else has since replaced is refused rather than silently
  // overwriting their work. Remounting on editorEpoch restarts the canvas when a
  // conflict is resolved by keeping the other version.
  const [sessionRev, setSessionRev] = useState<number | undefined>(undefined);
  const [editorEpoch, setEditorEpoch] = useState(0);
  return (
    <LayoutEditor
      key={`${view.id}:${editorEpoch}`}
      view={view}
      startEditing
      // Done returns the operator to the live console. Without it the editor
      // dropped into its own preview and the console never came back.
      onExit={onExit}
      slotsViews={(settings.stageState?.views ?? []).filter((v) => v.kind === "slots")}
      templates={settings.layoutTemplates}
      onSave={async (layout) => {
        const r = await settings.handlers.handleSetViewLayout(view.id, layout, sessionRev);
        setSessionRev(r.rev);
        if (r.discarded) setEditorEpoch((e) => e + 1);
      }}
      onSaveTemplate={settings.handlers.handleSaveLayoutTemplate}
      onUpdateTemplate={settings.handlers.handleUpdateLayoutTemplate}
      onDeleteTemplate={settings.handlers.handleDeleteLayoutTemplate}
    />
  );
}
