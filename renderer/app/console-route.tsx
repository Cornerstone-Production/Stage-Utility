// A console, in the operator shell.
//
// Phase 3 gave a View a surface but gave a console nowhere to be: it rendered
// only on a panel Output, which meant the one surface built for the operator was
// the one the operator could not open. This is that place.
//
// The console renders through the SAME renderer a screen uses, so what is here
// is what a panel shows. The only difference is the context: `shell` means
// controls fire, drill-down works, and the layout can be edited in place.

import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
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
  // Editing lives in component state, NOT the URL: entering edit mode must not
  // create a history entry, or Back would step through edit toggles instead of
  // leaving the console.
  const [editing, setEditing] = useState(false);
  const [sessionRev, setSessionRev] = useState<number | undefined>(undefined);
  const [editorEpoch, setEditorEpoch] = useState(0);

  const view = s.stageState?.views?.find((v) => v.id === viewId) ?? null;

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
    <div className="flex h-full min-h-0 flex-col">
      {editable && (
        <div className="flex shrink-0 items-center justify-end gap-2 py-2">
          <Button variant="filled" size="small" onClick={() => setEditing(true)}>
            <PencilIcon className="size-3.5 text-fg-muted" />
            Edit this console
          </Button>
        </div>
      )}
      {/* The live console. `shell` context: controls fire, drill-down works. */}
      <div className="min-h-0 flex-1">
        {view.layout ? (
          <LayoutRenderer
            layout={view.layout}
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
    </div>
  );
}
