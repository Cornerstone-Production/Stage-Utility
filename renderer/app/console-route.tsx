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

export function ConsoleRoute() {
  const { viewId } = useParams({ strict: false }) as { viewId?: string };
  const s = useStageSettings();
  const router = useRouter();
  // Editing lives in component state, NOT the URL: entering edit mode must not
  // create a history entry, or Back would step through edit toggles instead of
  // leaving the console.
  const [editing, setEditing] = useState(false);
  const [sessionRev, setSessionRev] = useState<number | undefined>(undefined);
  const [editorEpoch, setEditorEpoch] = useState(0);

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
    // The full editor, on the same route. Conflict handling is REUSED unchanged:
    // sessionRev carries the revision the editor opened, so a save built on a
    // layout someone else has since replaced is refused rather than silently
    // overwriting their work. Remounting on editorEpoch restarts the canvas when
    // a conflict is resolved by keeping the other version.
    return (
      <div className="h-full min-h-0 pt-3">
        <LayoutEditor
          key={`${view.id}:${editorEpoch}`}
          view={view}
          startEditing
          slotsViews={(s.stageState.views ?? []).filter((v) => v.kind === "slots")}
          templates={s.layoutTemplates}
          onSave={async (layout) => {
            const r = await s.handlers.handleSetViewLayout(view.id, layout, sessionRev);
            setSessionRev(r.rev);
            if (r.discarded) setEditorEpoch((e) => e + 1);
          }}
          onSaveTemplate={s.handlers.handleSaveLayoutTemplate}
          onUpdateTemplate={s.handlers.handleUpdateLayoutTemplate}
          onDeleteTemplate={s.handlers.handleDeleteLayoutTemplate}
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
    <div className="group relative flex h-full min-h-0 flex-col -mx-5 max-sm:-mx-3">
      {/* The live console. `shell` context: controls fire, drill-down works.
          `ground="app"` so the canvas is the same material as the page. */}
      <div className="min-h-0 flex-1">
        {view.layout ? (
          <LayoutRenderer
            layout={view.layout}
            ndiSource={view.ndiSource ?? null}
            interactive={capabilityLive("shell", "control")}
            surface="console"
            ground="app"
          />
        ) : (
          <EmptyState
            title="Nothing on this console yet"
            hint="Add objects to it, and they will appear here and on any panel showing it."
          />
        )}
      </div>

      {/* Over the canvas, not above it. A row of its own pushed the console down
          and framed it, which is the framing this page was trying to lose. It is
          quiet until the pointer is here, because a console is a thing you
          operate far more often than a thing you edit. */}
      {editable && (
        // group-hover, from the CONSOLE, not hover on the button's own wrapper:
        // that only revealed it while pointing at something invisible, so the
        // button could never be found in the first place. Always visible where
        // there is no hover at all.
        <div className="absolute right-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <Button variant="filled" size="small" onClick={() => setEditing(true)}>
            <PencilIcon className="size-3.5 text-fg-muted" />
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}
