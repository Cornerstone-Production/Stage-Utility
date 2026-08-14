// The per-view editor: name, kind-specific settings, and the layout editor for
// a custom view.
//
// Was the detail pane of a master-detail Views screen. That screen is gone -
// Screens now owns the list of views, on the cards that use them - but the
// EDITOR is the feature, not the list around it, so it moved here rather than
// being deleted with its old shell.

import { useEffect, useState, type ChangeEvent } from "react";
import { TrashIcon, CopyIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Separator,
  UnsavedBanner,
  confirm,
} from "../../components/ui";
import { invoke } from "../../lib/api";
import type { SectionProps } from "../types";
import { SlotEditor } from "./slots-section";
import { LayoutEditor } from "./layout-editor";
import { ViewPreview } from "./view-preview";
import { KIND_LABELS, KIND_ORDER } from "./new-view-dialog";

const PREVIEW_ASPECTS = [
  { id: "16:9", label: "16:9 · landscape", ratio: 16 / 9 },
  { id: "9:16", label: "9:16 · portrait", ratio: 9 / 16 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "21:9", label: "21:9 · ultrawide", ratio: 21 / 9 },
];

/** Sentinel for the ScriptView column picker's "all columns" choice. */
const ALL_COLUMNS = "__all__";

export function ViewDetail({
  view,
  startEditing,
  stageState,
  wirelessChannels,
  teamPositions,
  localSlots,
  slotsDirty,
  isSavingSlots,
  resolvedDraftSlots,
  slotPresets,
  layoutTemplates,
  canDelete,
  handlers,
}: Pick<
  SectionProps,
  "stageState" | "wirelessChannels" | "teamPositions" | "localSlots" | "slotsDirty" | "isSavingSlots" | "resolvedDraftSlots" | "slotPresets" | "layoutTemplates" | "handlers"
> & { view: View; canDelete: boolean; startEditing?: boolean }) {
  // Parent remounts this component on view change (key={view.id}), so local
  // field state initializes fresh per view.
  const [editName, setEditName] = useState(view.name);
  // The layout revision THIS editing session started from. Deliberately not read
  // off the live `view` prop at save time: that updates the moment anyone else
  // saves, so every save would look up to date and the conflict check would
  // never fire. Advanced only by our own saves.
  const [sessionRev, setSessionRev] = useState(view.layoutRev ?? 0);
  const [editorEpoch, setEditorEpoch] = useState(0);
  // Preview aspect ratio — shapes the thumbnail to match the target monitor
  // (default 16:9, e.g. a 37″ 4K panel). Editor-only; doesn't affect the kiosk.
  const [previewAspect, setPreviewAspect] = useState<number>(16 / 9);
  // The ScriptView column presets, for a "script" View's Columns picker. Fetched
  // here rather than threaded through SectionProps: only this branch needs them,
  // and they change when someone edits a preset in the ScriptView section.
  const [scriptViewLayouts, setScriptViewLayouts] = useState<ScriptViewLayout[]>([]);
  useEffect(() => {
    if (view.kind !== "script") return;
    invoke<ScriptViewLayout[]>("scriptview:listLayouts")
      .then((l) => setScriptViewLayouts([...l].sort((a, b) => a.order - b.order)))
      .catch(() => setScriptViewLayouts([]));
  }, [view.kind]);

  function handleNameBlur() {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== view.name) handlers.handleRenameView(view.id, trimmed);
    else setEditName(view.name);
  }

  const slotViews = (stageState.views ?? []).filter((v) => v.kind === "slots" && v.id !== view.id);

  return (
    // Custom views fill the available height so the editor fits without page scroll;
    // other kinds keep their natural height and let the page scroll (long slot lists).
    <div className={cn("flex flex-col gap-5", view.kind === "custom" && "flex-1 min-h-0")}>
      {/* Unsaved-slots banner — the preview below shows the draft live; this makes
          clear it isn't saved yet and offers Save / Discard. (Custom views get
          their own banner inside the layout editor.) */}
      {view.kind === "slots" && slotsDirty && (
        <UnsavedBanner
          saving={isSavingSlots}
          onSave={() => void handlers.saveSlots()}
          onDiscard={handlers.discardSlots}
        />
      )}

      {/* Header: name + kind dropdown + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={editName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
          onBlur={handleNameBlur}
          className="flex-1 min-w-0 max-sm:basis-full text-headline font-semibold text-fg"
          aria-label="View name"
        />
        <Select value={view.kind} onValueChange={(k: string) => handlers.handleSetViewKind(view.id, k as ViewKind)}>
          <SelectTrigger className="w-36 shrink-0" aria-label="View type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_ORDER.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="filled" size="small" onClick={() => handlers.handleDuplicateView(view.id)}>
          <CopyIcon className="size-3.5 text-fg-muted" />
          Duplicate
        </Button>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={async () => {
            // Name the outputs that would lose their content. Deleting a view is
            // not recoverable, and a custom view can be a lot of layout work.
            const usedBy = (stageState.outputs ?? [])
              .filter((o) => o.viewId === view.id)
              .map((o) => o.name || o.id);
            const inUse =
              usedBy.length > 0
                ? ` It is currently shown on ${usedBy.join(", ")}, which will have no view assigned.`
                : "";
            const ok = await confirm({
              title: `Delete "${view.name}"?`,
              message: `This cannot be undone.${inUse}`,
              confirmLabel: "Delete view",
              destructive: true,
            });
            if (ok) await handlers.handleRemoveView(view.id);
          }}
          disabled={!canDelete}
          aria-label="Delete view"
        >
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>

      {/* Custom views get the visual editor (its canvas doubles as the preview);
          all other kinds get the read-only live preview. */}
      {view.kind === "custom" ? (
        <div className="flex-1 min-h-0">
          <LayoutEditor
            // Remounting on `editorEpoch` restarts the editor on whatever layout
            // is in state — used when a conflict is resolved by keeping the other
            // version, so the canvas stops showing edits that were thrown away.
            key={`${view.id}:${editorEpoch}`}
            view={view}
            startEditing={startEditing}
            slotsViews={(stageState.views ?? []).filter((v) => v.kind === "slots")}
            templates={layoutTemplates}
            onSave={async (layout) => {
              const r = await handlers.handleSetViewLayout(view.id, layout, sessionRev);
              setSessionRev(r.rev);
              if (r.discarded) setEditorEpoch((e) => e + 1);
            }}
            onSaveTemplate={handlers.handleSaveLayoutTemplate}
            onUpdateTemplate={handlers.handleUpdateLayoutTemplate}
            onDeleteTemplate={handlers.handleDeleteLayoutTemplate}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-caption1 text-fg-muted">Preview shape</span>
            <Select value={String(previewAspect)} onValueChange={(v: string) => setPreviewAspect(Number(v))}>
              <SelectTrigger className="w-full sm:w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PREVIEW_ASPECTS.map((a) => (
                  <SelectItem key={a.id} value={String(a.ratio)}>{a.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ViewPreview
            viewId={view.id}
            aspect={previewAspect}
            draftSlots={view.kind === "slots" && slotsDirty ? resolvedDraftSlots : null}
          />
        </div>
      )}

      {/* Slots-kind content editor */}
      {view.kind === "slots" ? (
        <>
          <Separator />
          {slotViews.length > 0 && (
            <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-caption1 text-fg-muted shrink-0">Copy slots from:</span>
              <Select
                value=""
                onValueChange={(fromId: string) => {
                  if (fromId) handlers.handleCopySlots(view.id, fromId);
                }}
              >
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue placeholder="Another view…" />
                </SelectTrigger>
                <SelectContent>
                  {slotViews.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <SlotEditor
            view={view}
            wirelessChannels={wirelessChannels}
            teamPositions={teamPositions}
            localSlots={localSlots}
            slotsDirty={slotsDirty}
            isSavingSlots={isSavingSlots}
            slotPresets={slotPresets}
            handlers={handlers}
          />
        </>
      ) : view.kind === "custom" ? null : view.kind === "script" ? (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <div className="flex flex-col">
              <span className="text-caption1 text-fg">Columns</span>
              <span className="text-caption2 text-fg-muted">
                The same saved column sets the ScriptView pages use, so a department's columns are
                defined once and a display and a browser tab cannot disagree about them.
              </span>
            </div>
            <Select
              value={view.scriptViewLayoutId ?? ALL_COLUMNS}
              onValueChange={(v: string) =>
                void invoke("views:setScriptViewLayout", {
                  id: view.id,
                  scriptViewLayoutId: v === ALL_COLUMNS ? null : v,
                })
              }
            >
              <SelectTrigger className="w-full sm:w-64" aria-label="Columns"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_COLUMNS}>All columns</SelectItem>
                {scriptViewLayouts.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-caption2 text-fg-muted">
            The Script view renders the active plan's rundown — the same table as the ScriptView
            pages, following whichever plan the app is set to. Max SPL per item lives on the
            SPL rundown view.
          </p>
        </>
      ) : (
        <p className="text-caption1 text-fg-muted">
          {KIND_LABELS[view.kind]} views render a fixed layout from live Planning Center / ProPresenter
          data — there's nothing to configure here yet besides the name.
        </p>
      )}
    </div>
  );
}

