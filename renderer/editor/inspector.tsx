// The inspector: the right-hand panel, and a config editor per object type.
//
// The largest piece after the shell, and the one that grows every time an object
// type is added. It has nothing to do with the canvas beside it: it reads the
// selection and writes config and style back.

import { useState, useEffect } from "react";
import {
  
  Trash2Icon,
  CopyIcon,
  
  
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronsUpIcon,
  ChevronsDownIcon,
  Grid3x3Icon,
  
  
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  
  
  
  CornerLeftUpIcon,
  LockIcon,
  UnlockIcon,
  PackagePlusIcon,
  
  
} from "lucide-react";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  
  
  SelectValue,
  ButtonGroup,
  Switch,
  Separator,
  
  
  
  
  
  
  InfoHint,
  
} from "../components/ui";
import { loadProcessedAttachment } from "../main/layout-renderer";
import { MIN, clamp } from "../settings/sections/layout-geometry.js";
import { useSplState } from "../main/use-spl-state";
// The PICKER list, not the telemetry one. A channel on a receiver that is
// unreachable right now reports no telemetry, and binding a widget to it is
// exactly what somebody is doing while the gear is still in a case.
import { useWirelessChannels } from "../app/queries";
import { usePeopleCountState } from "../main/use-people-count-state";
import { useObsState } from "../main/use-obs-state";
import { useReaperState } from "../main/use-reaper-state";
import { useOscTargets } from "../main/use-osc-state";
import { useStageState } from "../main/use-stage-state";
import { usePlanItems } from "../main/use-plan-items";
import { usePropInstances } from "../main/use-dashboard-state";
import { useIntegrations } from "../main/use-integration-states";
import { screensListViews } from "@main/services/home-view";
import { formatClock } from "../lib/clock-format";
import {
  isKnownObjectType,
  isOfferableInEmbedPicker,
  objectRetired,
  
  
  defaultStyle,
  isStylingOnly,
  
  typeLabel,
  usesPropInstance,
} from "../main/layout-objects";
import { IDIOM_TYPES, DEFAULT_READOUT_ALIGN } from "@main/types/readout-types";
import { invoke } from "../lib/api";
import {
  Row, RowSwitch, RowText, RowNumber, RowToggle, RowSelect, AlignPad, Section, MoreControls,
  ImageConfig, NumberField, NumberInput, PixelField,
} from "./inspector-rows";
import { ResponsiveControls } from "./responsive-controls";
import { cn } from "../lib/cn";
import { ColorField } from "../components/ui/color-field";
import {
  SURFACES, TINTS, applySurface, applyTint, isCustomFill, matchTint, surfaceOf,
  type SurfaceKind,
} from "./object-surface";



const RECORDED_LATEST = "__latest__";

/** Inspector controls for the people-graph object: live vs. a recorded service,
 *  PCO markers, hover tooltip, and a kiosk-visible live/recorded toggle. */
function PeopleGraphInspector({ c, onConfig }: { c: Extract<LayoutObjectConfig, { type: "people-graph" }>; onConfig: (c: LayoutObjectConfig) => void }) {
  const source = c.source ?? "live";
  const [services, setServices] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (source !== "recorded") return;
    invoke<ServiceAttendance[]>("attendance:listHistory")
      .then((list) =>
        setServices(
          (list ?? [])
            .filter((s) => s.endedAt)
            .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
            .map((s) => {
              const d = new Date(s.startedAt);
              const when = `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${formatClock(d)}`;
              return { value: s.serviceKey, label: s.serviceTypeName ? `${when} — ${s.serviceTypeName}` : when };
            }),
        ),
      )
      .catch(() => setServices([]));
  }, [source]);

  return (
    <>
      <RowToggle
        label="Count"
        value={c.metric ?? "occupancy"}
        options={[{ value: "attendance", label: "Attendance" }, { value: "occupancy", label: "In room" }]}
        onChange={(v) => onConfig({ ...c, metric: v })}
      />
      <RowSwitch label="Show value" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
      {(c.showLabel ?? true) && (
        <RowText label="Label" value={c.label ?? ""} placeholder={c.metric === "attendance" ? "Attendance" : "In room"} onChange={(v) => onConfig({ ...c, label: v })} />
      )}
      <RowToggle
        label="Source"
        value={source}
        options={[{ value: "live", label: "Live" }, { value: "recorded", label: "Recorded" }]}
        onChange={(v) => onConfig({ ...c, source: v as "live" | "recorded" })}
      />
      {source === "recorded" && (
        <RowSelect
          label="Service"
          hint="Which past service's curve to show. 'Most recent' auto-follows the latest finished service."
          value={c.recordedServiceKey || RECORDED_LATEST}
          options={[{ value: RECORDED_LATEST, label: "Most recent" }, ...services]}
          onChange={(v) => onConfig({ ...c, recordedServiceKey: v === RECORDED_LATEST ? null : v })}
        />
      )}
      <RowSwitch label="Plan-item markers" hint="Overlay a dashed line + time where each PCO item started." checked={c.showMarkers ?? true} onChange={(v) => onConfig({ ...c, showMarkers: v })} />
      <RowSwitch label="Hover tooltip" hint="Show the value + time at the pointer." checked={c.showTooltip ?? true} onChange={(v) => onConfig({ ...c, showTooltip: v })} />
      <RowSwitch label="Kiosk live/recorded toggle" hint="Show an on-screen pill so a viewer can flip between live and the last recorded service." checked={c.kioskToggle ?? false} onChange={(v) => onConfig({ ...c, kioskToggle: v })} />
      <p className="text-caption2 text-fg-muted leading-snug">Live builds a rolling trend while the server runs; Recorded replays a finished service. Line color is the object's text color below.</p>
    </>
  );
}

/** Thin wrappers over the shared themed NumberInput (kept so existing call sites
 *  and PixelField don't change). */
const WEIGHTS = [300, 400, 500, 600, 700, 800];

/**
 * Binding + framing controls for a plan-attachment object: a filename match (so it
 * tracks the stage plot week to week), a picker of the current plan's files, the
 * PDF page, plus crop / trim / background recolor of the rendered image and a
 * "fit box to file" action. All framing acts on the rendered image, not the source
 * file in Planning Center.
 */
function PlanAttachmentConfig({
  c,
  onConfig,
  o,
  canvas,
  onGeom,
}: {
  c: Extract<LayoutObjectConfig, { type: "plan-attachment" }>;
  onConfig: (config: LayoutObjectConfig) => void;
  o: LayoutObject;
  canvas: LayoutCanvas;
  onGeom: (g: Partial<Pick<LayoutObject, "x" | "y" | "w" | "h" | "anchor" | "keepAspect" | "minPx" | "maxPx">>) => void;
}) {
  const [files, setFiles] = useState<PcoAttachmentDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fitting, setFitting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/pco/attachments")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: PcoAttachmentDTO[]) => {
        if (!cancelled) {
          setFiles(Array.isArray(list) ? list : []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hide audio stems / raw media — a stage plot is a document (PDF/image).
  const pickable = files.filter((f) => {
    const ct = (f.contentType ?? "").toLowerCase();
    return !ct.startsWith("audio") && ct !== "application/octet-stream";
  });

  const crop = c.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const setCrop = (side: "top" | "right" | "bottom" | "left", pct: number) =>
    onConfig({ ...c, crop: { ...crop, [side]: clamp(pct, 0, 95) / 100 } });

  // Resize the object box to match the rendered (cropped/trimmed) content aspect,
  // keeping the top-left anchor so there's no letterboxing.
  async function fitBoxToFile() {
    setFitting(true);
    try {
      const r = await loadProcessedAttachment(c.match ?? "stage plot", {
        page: c.page ?? 1,
        crop: c.crop,
        trim: c.trim,
        background: c.background,
      });
      if (r && r !== "empty" && r.height > 0) {
        const aspect = r.width / r.height; // w:h of the image in px
        const newH = (o.w * canvas.width) / aspect / canvas.height;
        onGeom({ h: clamp(newH, 0.03, 1 - o.y) });
      }
    } finally {
      setFitting(false);
    }
  }

  return (
    <>
      <Row label="Match" hint="Substring of the PCO attachment's filename to show (e.g. 'stage plot'). It auto-picks any matching PDF/image on the live plan, so it keeps working each week if you name files consistently.">
        <Input
          value={c.match ?? "stage plot"}
          onChange={(e) => onConfig({ ...c, match: e.target.value })}
          placeholder="filename contains…"
          className="text-fg"
        />
      </Row>
      {pickable.length > 0 && (
        <Row label="Current plan">
          <Select value="" onValueChange={(v: string) => onConfig({ ...c, match: v })}>
            <SelectTrigger><SelectValue placeholder="Pick a file…" /></SelectTrigger>
            <SelectContent>
              {pickable.map((f) => (
                <SelectItem key={f.id} value={f.filename}>
                  {f.filename}{f.sourceLabel ? ` — ${f.sourceLabel}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}
      {loaded && pickable.length === 0 && (
        <p className="text-caption2 text-fg-muted leading-snug">
          No documents on the current plan (or PCO isn’t connected). The match still
          applies whenever a plan with a matching file goes live.
        </p>
      )}
      <Row label="PDF page">
        <NumberInput value={c.page ?? 1} step={1} min={1} max={99} onChange={(v) => onConfig({ ...c, page: Math.round(v) })} />
      </Row>

      <Separator />

      <Row label="Trim white">
        <Switch checked={c.trim ?? false} onCheckedChange={(v) => onConfig({ ...c, trim: v })} />
      </Row>
      <Row label="Background">
        {/* Hand-rolled, so it sat outside the two-or-fewer rule and truncated
            in a narrow panel like every other three-word group did. */}
        <Select
          value={c.background ?? "keep"}
          onValueChange={(v: string) => onConfig({ ...c, background: v as typeof c.background })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="keep">Keep</SelectItem>
            <SelectItem value="black">Black</SelectItem>
            <SelectItem value="transparent">Clear</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Crop %">
        <div className="grid grid-cols-2 gap-1 flex-1 @max-[248px]/insp:w-full">
          <NumberInput value={Math.round((crop.top ?? 0) * 100)} step={1} min={0} max={95} onChange={(v) => setCrop("top", v)} />
          <NumberInput value={Math.round((crop.bottom ?? 0) * 100)} step={1} min={0} max={95} onChange={(v) => setCrop("bottom", v)} />
          <NumberInput value={Math.round((crop.left ?? 0) * 100)} step={1} min={0} max={95} onChange={(v) => setCrop("left", v)} />
          <NumberInput value={Math.round((crop.right ?? 0) * 100)} step={1} min={0} max={95} onChange={(v) => setCrop("right", v)} />
        </div>
      </Row>
      <p className="text-caption2 text-fg-muted -mt-1">Top · Bottom · Left · Right</p>
      <Button variant="filled" size="small" onClick={fitBoxToFile} disabled={fitting}>
        {fitting ? "Fitting…" : "Fit box to file"}
      </Button>
    </>
  );
}

/** Object types fed by ProPresenter — they get the per-object instance picker. */
export function Inspector({
  o, canvas, parentW, parentH, nested, locked, slotsViews, onGeom, onStyle, onResetLook, onConfig, onReorder, onDuplicate, onRemove, onReparentOut, onToggleLock, onSaveGroup, onSnapToGrid,
}: {
  o: LayoutObject;
  canvas: LayoutCanvas;
  /** Design-px size of this object's parent box (the canvas for top-level). */
  parentW: number;
  parentH: number;
  /** True when this object lives inside a container. */
  nested: boolean;
  /** True when this object — or an ancestor container — is locked. */
  locked: boolean;
  slotsViews: View[];
  onGeom: (g: Partial<Pick<LayoutObject, "x" | "y" | "w" | "h" | "anchor" | "keepAspect" | "minPx" | "maxPx">>) => void;
  onStyle: (patch: Partial<LayoutStyle>) => void;
  /** Replace the style with the type's default. Not a patch: a merge cannot clear
   *  a field, so a patch-based reset would leave the tuning it means to undo. */
  onResetLook: () => void;
  onConfig: (config: LayoutObjectConfig) => void;
  onReorder: (d: "front" | "back" | "up" | "down") => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onReparentOut: () => void;
  onToggleLock: () => void;
  /** Save this object (typically a container) to the reusable group library. */
  onSaveGroup: () => void;
  /** Snap this object's existing position + size onto the grid. */
  onSnapToGrid: () => void;
}) {
  const s = o.style ?? {};
  const c = o.config;
  const chargerBays = useStageState().state?.chargerBays ?? [];
  const spl = useSplState();
  const { data: wirelessChannels = [] } = useWirelessChannels();
  const obs = useObsState();
  const reaper = useReaperState();
  const peopleCount = usePeopleCountState();
  const oscTargets = useOscTargets();
  // RossTalk targets + command catalogue for the rosstalk-button inspector. Loaded
  // once here rather than per-object; both are small and change rarely.
  const [rosstalkTargets, setRosstalkTargets] = useState<RossTalkTarget[]>([]);
  const [rosstalkCommands, setRosstalkCommands] = useState<
    { id: string; label: string; family: string; params: RossTalkParam[]; help?: string }[]
  >([]);
  useEffect(() => {
    void invoke<{ targets: RossTalkTarget[] }>("rosstalk:targets")
      .then((r) => setRosstalkTargets(r.targets))
      .catch(() => {});
    void invoke<{ id: string; label: string; family: string; params: RossTalkParam[]; help?: string }[]>(
      "rosstalk:commands",
    )
      .then(setRosstalkCommands)
      .catch(() => {});
  }, []);
  const planItems = usePlanItems();
  const propInstances = usePropInstances();
  const integrationsSnap = useIntegrations();
  const captionChannels = Object.keys(useStageState().state?.captionChannelColors ?? {});
  // Home excluded: its stored geometry is meaningless (it is a card list, not a
  // canvas), so embedding it would draw four cards stacked at whatever filler
  // coordinates happen to be in the file.
  const embedViews = screensListViews(useStageState().state?.views ?? []);
  const isText = !["shape", "container", "ndi-video", "slide-thumbnail", "image", "plan-attachment", "brand-logo", "slots-grid"].includes(c.type);
  // Style sizes are stored as fractions of canvas HEIGHT; show them as px (rounded
  // to 1 decimal so they read as whole numbers but still allow fine values).
  const pxOf = (frac: number | undefined, dflt: number) => Math.round((frac ?? dflt) * canvas.height * 10) / 10;

  return (
    <div className="flex flex-col gap-2.5">
      {/* The object's own toolbar wraps rather than pushing the panel wider:
          eight icon buttons and a type name do not fit a narrow inspector on
          one line, and a row that cannot wrap is a row that clips. */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted flex-1 min-w-0 truncate">{typeLabel(c.type)}</span>
        {c.type === "container" && (
          <Button variant="transparent" size="small" iconOnly onClick={onSaveGroup} aria-label="Save as group"><PackagePlusIcon className="size-3.5 text-fg-muted" /></Button>
        )}
        <Button variant="transparent" size="small" iconOnly disabled={locked} onClick={onSnapToGrid} aria-label="Snap to grid" tooltip="Snap position + size to the grid"><Grid3x3Icon className="size-3.5 text-fg-muted" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={onToggleLock} aria-label={o.locked ? "Unlock" : "Lock"}>
          {o.locked ? <LockIcon className="size-3.5 text-amber-10" /> : <UnlockIcon className="size-3.5 text-fg-muted" />}
        </Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("front")} aria-label="Bring to front" tooltip="Bring to front"><ChevronsUpIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("up")} aria-label="Bring forward" tooltip="Bring forward"><ChevronUpIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("down")} aria-label="Send backward" tooltip="Send backward"><ChevronDownIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("back")} aria-label="Send to back" tooltip="Send to back"><ChevronsDownIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={onDuplicate} aria-label="Duplicate"><CopyIcon className="size-3.5 text-fg-muted" /></Button>
        <Button variant="transparent" size="small" iconOnly disabled={locked} onClick={onRemove} aria-label="Delete"><Trash2Icon className={`size-3.5 ${locked ? "text-fg-subtle" : "text-red-10"}`} /></Button>
      </div>

      {nested && (
        <Button variant="filled" size="small" onClick={onReparentOut}>
          <CornerLeftUpIcon className="size-3.5" /> Move out of container
        </Button>
      )}

      {/* ProPresenter instance picker — only when >1 instance is configured
          (two-auditorium setups); otherwise everything reads the primary. */}
      {usesPropInstance(c.type) && propInstances && propInstances.list.length > 1 && (
        <RowSelect
          label="ProPresenter"
          hint="Which ProPresenter machine this object reads from — for multi-auditorium setups. Defaults to the primary instance; pick another to point this object at a second room's ProPresenter."
          value={(c as { propresenterInstanceId?: string | null }).propresenterInstanceId ?? "default"}
          options={propInstances.list.map((i) => ({ value: i.id, label: i.name }))}
          onChange={(v) => onConfig({ ...c, propresenterInstanceId: v === "default" ? null : v } as LayoutObjectConfig)}
        />
      )}

      {/* WHAT THIS OBJECT SHOWS. Everything from here to the Look separator is
          the object's own settings — its caption, what it is bound to, how it
          reads. It was the top of one flat column with no heading at all, which
          is why "which of these thirty rows is about the data" was a question
          you had to answer by reading them. */}
      <Section label="Content" className="[&:has(+div:empty)]:hidden" />
      {/* Wrapped so the heading above can hide itself when this is empty.
          20 of the 50 object types carry no settings of their own — a bare
          CONTENT heading with nothing under it says an object has settings it
          does not have. :empty is exact here: a false branch renders no node. */}
      <div className="flex flex-col gap-2.5 empty:hidden">

      {/* The line above the value. New readouts arrive with one — a bare 0:04:12
          does not say what it is counting to — and this is how it is changed or
          cleared. Emptying it removes the caption entirely; a default nobody can
          switch off would be worse than no default. */}
      {"caption" in c && (
        <RowText
          label="Caption"
          value={(c as { caption?: string | null }).caption ?? ""}
          placeholder="none"
          onChange={(v) => onConfig({ ...c, caption: v.trim() ? v : null } as LayoutObjectConfig)}
        />
      )}

      {/* Binding */}
      {c.type === "text" && (
        <RowText label="Text" value={c.text} onChange={(v) => onConfig({ type: "text", text: v })} />
      )}
      {c.type === "clock" && (
        <>
          <RowToggle
            label="Format"
            value={c.format === "24h" ? "24h" : "12h"}
            options={[{ value: "12h", label: "12h" }, { value: "24h", label: "24h" }]}
            onChange={(v) => onConfig({ ...c, format: v })}
          />
          <RowSwitch label="Seconds" checked={c.showSeconds ?? true} onChange={(v) => onConfig({ ...c, showSeconds: v })} />
          {c.format !== "24h" && (
            <RowSwitch label="AM / PM" checked={c.showMeridiem ?? true} onChange={(v) => onConfig({ ...c, showMeridiem: v })} />
          )}
        </>
      )}
      {c.type === "section-chip" && (
        <Row label="Which" hint="Which ProPresenter section to show. Current/Next follow the presentation's sections; Next section skips arrangement breaks to the next actual song/item.">
          <Select value={c.which} onValueChange={(v: string) => onConfig({ type: "section-chip", which: v as "current" | "next" | "nextArrangement" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="current">Current</SelectItem>
              <SelectItem value="next">Next</SelectItem>
              <SelectItem value="nextArrangement">Next section</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      )}
      {c.type === "pp-timer" && (
        <>
          <RowText
            label="Timer name"
            hint="Exact name of a timer running INSIDE ProPresenter — distinct from the PCO countdown. Leave blank to show the first timer ProPresenter reports."
            value={c.timerName ?? ""}
            placeholder="First timer"
            onChange={(v) => onConfig({ ...c, timerName: v.trim() || null })}
          />
          <RowSwitch label="Color on overrun" checked={c.warnStates ?? true} onChange={(v) => onConfig({ ...c, warnStates: v })} />
          <RowSwitch label="Show timer name" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          <RowSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
        </>
      )}
      {c.type === "slide-progress" && (
        <>
          <RowToggle
            label="Display"
            value={c.display ?? "fraction"}
            options={[
              { value: "fraction", label: "3 / 12" },
              { value: "remaining", label: "Left" },
              { value: "percent", label: "%" },
              { value: "bar", label: "Bar" },
            ]}
            onChange={(v) => onConfig({ ...c, display: v })}
          />
          {(c.display ?? "fraction") !== "bar" && (
            <RowSwitch label="Show 'slides' label" checked={c.showLabel ?? false} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          )}
        </>
      )}
      {(() => {
        // A retired type: still rendered so an old layout keeps working, out of
        // the palette so no new ones appear, with the conversion one click away.
        // Deliberately NOT automatic — the replacement renders a different table,
        // and silently changing what is on a stage monitor is not an upgrade.
        const retired = objectRetired(c.type);
        if (!retired) return null;
        const scriptViews = (embedViews ?? []).filter((v) => v.kind === "script");
        return (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-a5 bg-amber-a2 p-3">
            <span className="text-caption1 text-fg">This object has been replaced</span>
            <span className="text-caption2 text-fg-muted">{retired.why}</span>
            <span className="text-caption2 text-fg-muted">
              It is not a like-for-like swap, so read this first: the replacement
              scrolls rather than shrinking to fit, and <strong>Fit to height</strong>,{" "}
              <strong>Scroll</strong> and the note-category picker do not carry over.
              Its columns come from the Script view's preset instead. Set the object's
              font size afterwards — nothing auto-fits it now.
            </span>
            <Button
              variant="filled"
              size="small"
              className="self-start"
              onClick={() =>
                onConfig({
                  type: "view-embed",
                  // Only auto-pick when there is no ambiguity; otherwise leave it
                  // for the picker rather than guessing which view was meant.
                  viewId: scriptViews.length === 1 ? scriptViews[0].id : null,
                  showHeader: false,
                } as LayoutObjectConfig)
              }
            >
              Convert to Embedded view
            </Button>
            {scriptViews.length === 0 && (
              <span className="text-caption2 text-fg-subtle">
                Make a Script view first and this will have something to point at.
              </span>
            )}
          </div>
        );
      })()}
      {c.type === "view-embed" && (() => {
        // Both the picker and the renderer ask the same function — see
        // isEmbeddableViewKind. Custom never appears, which IS the recursion
        // guard; other kinds appear but say why they do not render yet.
        const embeddable = (embedViews ?? []).filter((v) => isOfferableInEmbedPicker(v.kind));
        return embeddable.length === 0 ? (
          <p className="text-caption2 text-fg-muted">
            No embeddable views yet — make a Script view first, then point this at it.
          </p>
        ) : (
          <RowSelect
            label="View"
            hint="Renders that view's content here, natively. Script views work today; other kinds are being converted."
            value={c.viewId ?? ""}
            options={[{ value: "", label: "None" }, ...embeddable.map((v) => ({ value: v.id, label: `${v.name} (${v.kind})` }))]}
            onChange={(v) => onConfig({ ...c, viewId: v || null })}
          />
        );
      })()}
      {c.type === "view-embed" && c.viewId && (
        <RowSwitch
          label="Show the view's header"
          checked={c.showHeader ?? false}
          onChange={(v) => onConfig({ ...c, showHeader: v })}
        />
      )}
      {c.type === "view-embed" && c.viewId && (
        <RowSwitch
          label="Follow the live item"
          hint="Scrolls the rundown to keep Planning Center's live item on screen, so a service that runs past the bottom of the box does not need anyone to touch the display. Only ever scrolls this object, never the rest of the layout. Turn off for a box parked on the top of the plan."
          checked={c.autoScroll ?? true}
          onChange={(v) => onConfig({ ...c, autoScroll: v })}
        />
      )}
      {c.type === "service-order" && (
        <>
          <RowToggle
            label="Scroll"
            hint="Follow live: the list auto-scrolls to keep the on-air item in view. Static: the list stays put (the operator scrolls it)."
            value={c.scroll ?? "auto"}
            options={[{ value: "auto", label: "Follow live" }, { value: "static", label: "Static" }]}
            onChange={(v) => onConfig({ ...c, scroll: v })}
          />
          <RowSwitch label="Fit to height" checked={c.autoFit ?? true} onChange={(v) => onConfig({ ...c, autoFit: v })} />
          <RowSwitch label="Highlight live" checked={c.highlightLive ?? true} onChange={(v) => onConfig({ ...c, highlightLive: v })} />
          <RowSwitch label="Show length" checked={c.showLength ?? false} onChange={(v) => onConfig({ ...c, showLength: v })} />
          {(() => {
            const present = planItems?.noteCategories ?? [];
            if (present.length === 0) {
              return <span className="text-caption2 text-fg-muted">Note categories appear once a plan with notes is loaded.</span>;
            }
            // null/undefined = all shown; otherwise the explicit subset.
            const shown = c.noteCategories == null ? present : present.filter((k) => c.noteCategories!.includes(k));
            const toggle = (k: string) => {
              const next = shown.includes(k) ? shown.filter((x) => x !== k) : [...shown, k];
              onConfig({ ...c, noteCategories: next });
            };
            return (
              <div className="flex flex-col gap-1">
                <span className="text-caption2 text-fg-muted">Notes shown</span>
                <div className="flex flex-wrap gap-1.5">
                  {present.map((k) => {
                    const on = shown.includes(k);
                    return (
                      <button
                        key={k}
                        onClick={() => toggle(k)}
                        className={`rounded-full border px-2.5 py-1 text-caption2 transition-colors ${on ? "border-accent/50 bg-accent/12 text-accent" : "border-line-strong bg-fill text-fg-muted hover:bg-fill-hover"}`}
                      >
                        {k}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </>
      )}
      {c.type === "transcript-strip" && (
        <>
          <RowToggle
            label="Mode"
            value={c.mode}
            options={[{ value: "latest", label: "Latest" }, { value: "rolling", label: "Rolling" }]}
            onChange={(v) => onConfig({ ...c, mode: v })}
          />
          {c.mode === "rolling" && (
            <RowNumber label="Lines" value={c.maxLines ?? 3} step={1} min={1} max={10} onChange={(v) => onConfig({ ...c, maxLines: Math.round(v) })} />
          )}
          {captionChannels.length === 0 ? (
            <span className="text-caption2 text-fg-muted">Channels appear here once captions arrive — toggle any to hide.</span>
          ) : (() => {
            const hidden = c.hideChannels ?? [];
            const toggle = (ch: string) => {
              const next = hidden.includes(ch) ? hidden.filter((x) => x !== ch) : [...hidden, ch];
              onConfig({ ...c, hideChannels: next.length ? next : undefined });
            };
            return (
              <div className="flex flex-col gap-1">
                <span className="text-caption2 text-fg-muted">Channels shown</span>
                <div className="flex flex-wrap gap-1.5">
                  {captionChannels.map((ch) => {
                    const on = !hidden.includes(ch);
                    return (
                      <button
                        key={ch}
                        onClick={() => toggle(ch)}
                        className={`rounded-full border px-2.5 py-1 text-caption2 transition-colors ${on ? "border-accent/50 bg-accent/12 text-accent" : "border-line-strong bg-fill text-fg-muted hover:bg-fill-hover"}`}
                      >
                        {ch}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </>
      )}
      {c.type === "integration-status" && (() => {
        const states = integrationsSnap.states;
        return (
          <>
            <Row label="Integration" hint="Which integration's connection status to show. First available shows any that's online; pick a specific one to lock this object to it.">
              <Select value={c.integrationId ?? ""} onValueChange={(v: string) => onConfig({ ...c, integrationId: v || null })}>
                <SelectTrigger><SelectValue placeholder={states.length ? "First available" : "No integrations"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">First available</SelectItem>
                  {states.map((st) => <SelectItem key={st.id} value={st.id}>{integrationsSnap.labels[st.id] ?? st.id}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <RowSwitch label="Show label" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
            {(c.showLabel ?? true) && (
              <RowText label="Label" value={c.label ?? ""} placeholder="integration name" onChange={(v) => onConfig({ ...c, label: v })} />
            )}
          </>
        );
      })()}
      {c.type === "wireless-summary" && (
        <>
          <RowSwitch label="Online count" checked={c.showOnline ?? true} onChange={(v) => onConfig({ ...c, showOnline: v })} />
          <RowSwitch label="Lowest battery" checked={c.showBattery ?? true} onChange={(v) => onConfig({ ...c, showBattery: v })} />
          <RowSwitch label="Time remaining" hint="The shortest runtime left across the fleet — the pack that runs out first. Only gear that reports a runtime counts; a dash means none does." checked={c.showRuntime ?? false} onChange={(v) => onConfig({ ...c, showRuntime: v })} />
          <RowSwitch label="Show label" checked={c.showLabel ?? false} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          {(c.showLabel ?? false) && (
            <RowText label="Label" value={c.label ?? ""} placeholder="Mics" onChange={(v) => onConfig({ ...c, label: v })} />
          )}
        </>
      )}
      {c.type === "wireless-channel" && (() => {
        // Mics and IEM packs only. A charger bay has no RF and no frequency, so
        // binding this widget to one draws a dash for ever — and the picker was
        // offering twenty-four of them against twelve real channels. Charger
        // battery is the widget for bays.
        const rfChannels = wirelessChannels.filter((d) => d.deviceType !== "charger");
        return (
        <>
          <Row label="Channel" hint="Which wireless channel this tile shows. Auto uses the first one detected. Charger bays are not listed — use the Charger battery widget for those.">
            <Select value={c.channelId ?? ""} onValueChange={(v: string) => onConfig({ ...c, channelId: v || null })}>
              <SelectTrigger><SelectValue placeholder={rfChannels.length ? "Auto (first)" : "No channels detected"} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">Auto (first)</SelectItem>
                {rfChannels.map((d) => <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
          <RowSwitch label="RF signal" checked={c.show?.rf ?? true} onChange={(v) => onConfig({ ...c, show: { ...c.show, rf: v } })} />
          <RowSwitch label="Battery %" checked={c.show?.battery ?? true} onChange={(v) => onConfig({ ...c, show: { ...c.show, battery: v } })} />
          <RowSwitch label="Time remaining" hint="Runtime left on the pack, the way Wireless Workbench shows it. Turn Battery % off to make it the headline figure. Shure AD and ULX-D report it; a dash means this receiver does not." checked={c.show?.runtime ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, runtime: v } })} />
          <RowSwitch label="Frequency" checked={c.show?.frequency ?? true} onChange={(v) => onConfig({ ...c, show: { ...c.show, frequency: v } })} />
          <RowSwitch label="Audio level" checked={c.show?.audio ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, audio: v } })} />
          <RowSwitch label="Show channel name" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
        </>
        );
      })()}
      {c.type === "service-pacing" && (
        <>
          <div className="px-1 pb-1 text-xs text-fg-subtle">
            Shows how far ahead or behind the whole schedule the service is running right now — carries over slippage from earlier items and grows live if the current item runs long. Needs a service-timeline recording.
          </div>
          <Row label="Ahead color">
            <div className="flex items-center gap-2">
              <ColorField label="Ahead colour" allowAlpha={false} value={c.aheadColor ?? "#30a46c"} onChange={(v) => onConfig({ ...c, aheadColor: v })} />
              {c.aheadColor != null && <button type="button" className="text-xs text-fg-subtle hover:text-fg" onClick={() => onConfig({ ...c, aheadColor: null })}>Reset</button>}
            </div>
          </Row>
          <Row label="Behind color">
            <div className="flex items-center gap-2">
              <ColorField label="Behind colour" allowAlpha={false} value={c.behindColor ?? "#e5484d"} onChange={(v) => onConfig({ ...c, behindColor: v })} />
              {c.behindColor != null && <button type="button" className="text-xs text-fg-subtle hover:text-fg" onClick={() => onConfig({ ...c, behindColor: null })}>Reset</button>}
            </div>
          </Row>
          <RowSwitch label="Show ahead/behind label" checked={c.showLabel ?? false} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          <RowSwitch label="Show dash when idle" checked={!(c.hideWhenIdle ?? false)} onChange={(v) => onConfig({ ...c, hideWhenIdle: !v })} />
        </>
      )}
      {c.type === "slots-grid" && (() => {
        const isInline = (c.source ?? "view") === "inline";
        return (
          <>
            <Row label="Source">
              <Select value={isInline ? "inline" : "view"} onValueChange={(v: string) => onConfig({ ...c, source: v === "inline" ? "inline" : "view" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inline">Define here</SelectItem>
                  <SelectItem value="view">Embed a view</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            {isInline ? (
              <p className="text-caption2 text-fg-muted leading-snug">Edit this grid's slots below the canvas.</p>
            ) : (
              <Row label="View">
                <Select value={c.sourceViewId ?? ""} onValueChange={(v: string) => onConfig({ ...c, source: "view", sourceViewId: v || null })}>
                  <SelectTrigger><SelectValue placeholder="Mic-slots view…" /></SelectTrigger>
                  <SelectContent>
                    {slotsViews.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Row>
            )}
          </>
        );
      })()}
      {c.type === "charger-battery" && (
        <>
          <RowSwitch label="Battery %" checked={c.show.battery ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, battery: v } })} />
          <RowSwitch label="Charging" checked={c.show.charging ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, charging: v } })} />
          <RowSwitch label="Cycles" checked={c.show.cycles ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, cycles: v } })} />
          <RowSwitch label="Health" checked={c.show.health ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, health: v } })} />
          <RowSwitch label="Temp" checked={c.show.temp ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, temp: v } })} />
          <div className="flex flex-col gap-1.5 pt-1">
            <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">Bays</span>
            {c.bays.map((b, i) => {
              const bay = chargerBays.find((x) => x.id === b.id);
              const placeholder = bay ? `${bay.connectionName ?? `Charger ${bay.chargerIndex}`} · Bay ${bay.bay}` : "Bay";
              return (
                <div key={b.id} className="flex items-center gap-1.5">
                  <Input
                    value={b.label ?? ""}
                    placeholder={placeholder}
                    onChange={(e) => {
                      const label = e.target.value;
                      onConfig({ ...c, bays: c.bays.map((x, j) => (j === i ? { ...x, label: label || undefined } : x)) });
                    }}
                    className="text-fg flex-1"
                  />
                  <Button variant="transparent" size="small" iconOnly onClick={() => onConfig({ ...c, bays: c.bays.filter((_, j) => j !== i) })} aria-label="Remove bay"><Trash2Icon className="size-3.5 text-red-10" /></Button>
                </div>
              );
            })}
            <Select value="" onValueChange={(id: string) => { if (id) onConfig({ ...c, bays: [...c.bays, { id }] }); }}>
              <SelectTrigger><SelectValue placeholder={chargerBays.length ? "Add bay…" : "No charger bays detected"} /></SelectTrigger>
              <SelectContent>
                {chargerBays.filter((bay) => !c.bays.some((b) => b.id === bay.id)).map((bay) => (
                  <SelectItem key={bay.id} value={bay.id}>{`${bay.connectionName ?? `Charger ${bay.chargerIndex}`} · Bay ${bay.bay}${bay.battery != null ? ` (${bay.battery}%)` : ""}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}
      {c.type === "spl-meter" && (() => {
        const meters = spl?.meters ?? {};
        const meterIds = Object.keys(meters);
        // Union of metric keys across all meters so the picker is usable even
        // before the selected channel has reported a reading.
        const metricKeys = Array.from(
          new Set(meterIds.flatMap((id) => Object.keys(meters[id].metrics))),
        );
        const t = c.thresholds;
        return (
          <>
            <Row label="Meter" hint="Which Smaart SPL meter/channel to read. Auto uses the first one detected — pick a specific device/channel if Smaart exposes more than one.">
              <Select value={c.meterId ?? ""} onValueChange={(v: string) => onConfig({ ...c, meterId: v || null })}>
                <SelectTrigger><SelectValue placeholder={meterIds.length ? "Auto (first)" : "No meters detected"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Auto (first)</SelectItem>
                  {meterIds.map((id) => (
                    <SelectItem key={id} value={id}>{`${meters[id].deviceName} · ${meters[id].channelName}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Metric" hint="Which value from the meter to display (e.g. an SPL weighting/response like A-Slow or C-Fast, or Leq). Auto shows the meter's default. Options fill in once Smaart is reporting.">
              <Select value={c.metricKey ?? ""} onValueChange={(v: string) => onConfig({ ...c, metricKey: v || null })}>
                <SelectTrigger><SelectValue placeholder={metricKeys.length ? "Auto" : "No data yet"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Auto</SelectItem>
                  {metricKeys.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <RowSwitch label="Show metric name" checked={c.showLabel ?? false} onChange={(v) => onConfig({ ...c, showLabel: v })} />
            <RowSwitch label="Peak hold" hint="Also show the highest reading seen, held on screen — useful for catching transient peaks during loud moments." checked={c.peakHold ?? false} onChange={(v) => onConfig({ ...c, peakHold: v })} />
            <RowSwitch label="Color thresholds" checked={!!t} onChange={(v) => onConfig({ ...c, thresholds: v ? { amber: 95, red: 100 } : null })} />
            {t && (
              <>
                <RowNumber label="Amber ≥ (dB)" value={t.amber} step={1} min={0} max={140} onChange={(v) => onConfig({ ...c, thresholds: { ...t, amber: Math.round(v) } })} />
                <RowNumber label="Red ≥ (dB)" value={t.red} step={1} min={0} max={140} onChange={(v) => onConfig({ ...c, thresholds: { ...t, red: Math.round(v) } })} />
              </>
            )}
          </>
        );
      })()}
      {c.type === "record-status" && (
        <>
          <RowSelect
            label="Recorder"
            hint="Any = red whenever either OBS or REAPER is recording"
            value={c.source ?? "any"}
            options={[
              { value: "any", label: "Any recorder" },
              { value: "obs", label: "OBS only" },
              { value: "reaper", label: "REAPER only" },
            ]}
            onChange={(v) => onConfig({ ...c, source: v as "any" | "obs" | "reaper" })}
          />
          <RowText label="Recording text" value={c.recordingText ?? ""} placeholder="RECORDING" onChange={(v) => onConfig({ ...c, recordingText: v })} />
          <RowText label="Idle text" value={c.idleText ?? ""} placeholder="STANDBY" onChange={(v) => onConfig({ ...c, idleText: v })} />
          <RowText label="Offline text" value={c.offlineText ?? ""} placeholder="NO RECORDER" onChange={(v) => onConfig({ ...c, offlineText: v })} />
          <RowSwitch label="Fill red while recording" checked={c.fillWhenRecording ?? true} onChange={(v) => onConfig({ ...c, fillWhenRecording: v })} />
          <RowSwitch label="Hide when idle" hint="Pure tally light — nothing on screen unless recording" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
        </>
      )}

      {c.type === "obs-status" && (() => {
        const mode = c.mode ?? "recording";
        const liveLabel = !obs?.connected
          ? "Not connected"
          : (mode === "streaming" ? obs.streaming : mode === "virtualcam" ? obs.virtualCam : obs.recording)
            ? "Active now"
            : "Connected · idle";
        const activePlaceholder = mode === "streaming" ? "OBS: Streaming" : mode === "virtualcam" ? "OBS: Virtual Cam" : "OBS: Recording";
        const idlePlaceholder = mode === "streaming" ? "OBS: Stream off" : mode === "virtualcam" ? "OBS: Cam off" : "OBS: Standby";
        return (
          <>
            <Row label="Show">
              <Select value={mode} onValueChange={(v: string) => onConfig({ ...c, mode: v as "recording" | "streaming" | "virtualcam" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="recording">Recording</SelectItem>
                  <SelectItem value="streaming">Streaming</SelectItem>
                  <SelectItem value="virtualcam">Virtual camera</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="OBS"><span className="text-caption2 text-fg-muted">{liveLabel}</span></Row>
            <RowText label="Active text" value={c.recordingText ?? ""} placeholder={activePlaceholder} onChange={(v) => onConfig({ ...c, recordingText: v })} />
            <RowText label="Idle text" value={c.idleText ?? ""} placeholder={idlePlaceholder} onChange={(v) => onConfig({ ...c, idleText: v })} />
            <RowText label="Offline text" value={c.offlineText ?? ""} placeholder="OBS: Offline" onChange={(v) => onConfig({ ...c, offlineText: v })} />
            <RowSwitch label="Fill red when active" checked={c.fillWhenRecording ?? true} onChange={(v) => onConfig({ ...c, fillWhenRecording: v })} />
            {mode === "recording" && (
              <RowSwitch label="Show timecode" checked={c.showTimecode ?? false} onChange={(v) => onConfig({ ...c, showTimecode: v })} />
            )}
            <RowSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
          </>
        );
      })()}
      {(c.type === "stream-status" || c.type === "home-streaming" || c.type === "home-streaming-resi" || c.type === "home-streaming-youtube") && (
        <>
          {/* The same three switches obs-status offers, because these are the
              same widget pointed at a different source. Only the general one
              asks WHICH platform — the per-platform objects already answered. */}
          {c.type === "stream-status" && (
            <RowSelect
              label="Platform"
              hint="Which platform to report. Any answers every one at once — live if anything is going out."
              value={c.platform ?? "any"}
              options={[
                { value: "any", label: "Any platform" },
                { value: "resi", label: "Resi" },
                { value: "youtube", label: "YouTube" },
              ]}
              onChange={(v) => onConfig({ ...c, platform: v as "any" | "resi" | "youtube" })}
            />
          )}
          <RowSwitch
            label="Fill green when live"
            hint="Off colours the word. On paints the whole widget — a signal that carries across a room."
            checked={c.fillWhenLive ?? true}
            onChange={(v) => onConfig({ ...c, fillWhenLive: v })}
          />
          <RowSwitch
            label="Show elapsed"
            hint="Off shows just LIVE. Some platforms cannot say when a stream started, and there the elapsed time is measured from when this app first saw it."
            checked={c.showElapsed ?? true}
            onChange={(v) => onConfig({ ...c, showElapsed: v })}
          />
          <RowSwitch
            label="Hide when idle"
            hint="A tally light: nothing on screen at all unless something is going out."
            checked={c.hideWhenIdle ?? false}
            onChange={(v) => onConfig({ ...c, hideWhenIdle: v })}
          />
        </>
      )}
      {c.type === "reaper-status" && (() => {
        const liveLabel = !reaper?.connected
          ? "Not connected"
          : reaper.recording
            ? "Recording now"
            : "Connected · idle";
        return (
          <>
            <Row label="REAPER"><span className="text-caption2 text-fg-muted">{liveLabel}</span></Row>
            <RowText label="Recording text" value={c.recordingText ?? ""} placeholder="REAPER: Recording" onChange={(v) => onConfig({ ...c, recordingText: v })} />
            <RowText label="Idle text" value={c.idleText ?? ""} placeholder="REAPER: Standby" onChange={(v) => onConfig({ ...c, idleText: v })} />
            <RowText label="Offline text" value={c.offlineText ?? ""} placeholder="REAPER: Offline" onChange={(v) => onConfig({ ...c, offlineText: v })} />
            <RowSwitch label="Fill red when recording" checked={c.fillWhenRecording ?? true} onChange={(v) => onConfig({ ...c, fillWhenRecording: v })} />
            <RowSwitch label="Show position" checked={c.showPosition ?? false} onChange={(v) => onConfig({ ...c, showPosition: v })} />
            <RowSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
          </>
        );
      })()}
      {c.type === "countdown-timer" && (
        <>
          <RowSwitch label="Amber warning" checked={c.warnSeconds != null} onChange={(v) => onConfig({ ...c, warnSeconds: v ? 60 : undefined })} />
          {c.warnSeconds != null && (
            <RowNumber label="Warn at (s)" value={c.warnSeconds} step={5} min={0} max={3600} onChange={(v) => onConfig({ ...c, warnSeconds: Math.round(v) })} />
          )}
          <RowSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
        </>
      )}
      {c.type === "rosstalk-button" && (() => {
        const target = rosstalkTargets.find((t) => t.id === c.targetId) ?? null;
        const family = target?.config.family ?? "carbonite";
        // Only ever offer commands for THIS target's family — a Carbonite XPT sent
        // to an Ultrix is a different command entirely.
        const commands = rosstalkCommands.filter((cmd) => cmd.family === family);
        const command = commands.find((cmd) => cmd.id === c.commandId) ?? null;
        return (
          <>
            <RowSelect
              label="Target"
              value={c.targetId ?? ""}
              options={[
                { value: "", label: "Pick a target…" },
                ...rosstalkTargets.map((t) => ({
                  value: t.id,
                  label: `${t.name} (${t.config.family ?? "carbonite"})`,
                })),
              ]}
              onChange={(v) => onConfig({ ...c, targetId: v || null, commandId: null, params: {} })}
            />
            <RowSelect
              label="Command"
              hint={target ? undefined : "Pick a target first"}
              value={c.commandId ?? ""}
              options={[
                { value: "", label: "Pick a command…" },
                ...commands.map((cmd) => ({ value: cmd.id, label: cmd.label })),
              ]}
              onChange={(v) => onConfig({ ...c, commandId: v || null, params: {} })}
            />
            {command?.params.map((p) =>
              p.type === "number" ? (
                <RowNumber
                  key={p.key}
                  label={p.label}
                  hint={p.help}
                  value={Number(c.params[p.key] ?? p.min ?? 0)}
                  min={p.min}
                  max={p.max}
                  onChange={(n) => onConfig({ ...c, params: { ...c.params, [p.key]: n } })}
                />
              ) : p.type === "enum" ? (
                <RowSelect
                  key={p.key}
                  label={p.label}
                  hint={p.help}
                  value={String(c.params[p.key] ?? "")}
                  options={(p.options ?? []).map((o) => ({ value: o, label: o }))}
                  onChange={(v) => onConfig({ ...c, params: { ...c.params, [p.key]: v } })}
                />
              ) : (
                <RowText
                  key={p.key}
                  label={p.label}
                  hint={p.help}
                  value={String(c.params[p.key] ?? "")}
                  onChange={(v) => onConfig({ ...c, params: { ...c.params, [p.key]: v } })}
                />
              ),
            )}
            <RowText label="Label" value={c.label} onChange={(v) => onConfig({ ...c, label: v })} />
          </>
        );
      })()}

      {c.type === "osc-button" && (() => {
        const oc = c; // narrowed osc-button config (preserved into nested fns)
        const args = oc.args ?? [];
        const fb = oc.feedback ?? null;
        function setArg(i: number, patch: Partial<OscArg>) {
          const next = args.map((a, idx) => (idx === i ? { ...a, ...patch } : a));
          onConfig({ ...oc, args: next });
        }
        return (
          <>
            <Row label="Target" hint="The OSC device this button sends to — mixer, lighting board, etc. Set these up under Integrations → OSC.">
              <Select value={c.targetId ?? ""} onValueChange={(v: string) => onConfig({ ...c, targetId: v || null })}>
                <SelectTrigger><SelectValue placeholder={oscTargets.length ? "Select target" : "No OSC targets"} /></SelectTrigger>
                <SelectContent>
                  {oscTargets.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <RowText label="Label" value={c.label ?? ""} placeholder="Button" onChange={(v) => onConfig({ ...c, label: v })} />
            <RowText label="Address" hint="The OSC path to send when tapped, e.g. /ch/01/mix/on — copy it from your device's OSC documentation. No spaces." value={c.address} placeholder="/ch/01/mix/on" onChange={(v) => onConfig({ ...c, address: v })} />
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1 text-caption2 font-semibold uppercase tracking-wider text-fg-muted">
                Arguments
                <InfoHint>
                  Values sent with the OSC message, in order. Pick each type — int (whole number), float
                  (decimal), string (text), or true/false (booleans, no value needed). Many on/off commands
                  need one int of 1 or 0; leave empty if your command takes none.
                </InfoHint>
              </span>
              {args.map((a, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Select value={a.type} onValueChange={(v: string) => setArg(i, { type: v as OscArg["type"] })}>
                    <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="i">int</SelectItem>
                      <SelectItem value="f">float</SelectItem>
                      <SelectItem value="s">string</SelectItem>
                      <SelectItem value="T">true</SelectItem>
                      <SelectItem value="F">false</SelectItem>
                    </SelectContent>
                  </Select>
                  {a.type !== "T" && a.type !== "F" && (
                    <Input value={String(a.value ?? "")} onChange={(e) => setArg(i, { value: e.target.value })} placeholder="value" className="flex-1 min-w-0 text-fg" />
                  )}
                  <Button variant="transparent" size="small" iconOnly onClick={() => onConfig({ ...c, args: args.filter((_, idx) => idx !== i) })} aria-label="Remove argument"><Trash2Icon className="size-3.5 text-fg-muted" /></Button>
                </div>
              ))}
              <Button variant="transparent" size="small" className="self-start" onClick={() => onConfig({ ...c, args: [...args, { type: "i", value: "1" }] })}>Add argument</Button>
            </div>
            <RowSwitch label="Feedback" hint="Reflect the device's state on the button: watch a return OSC address and recolor the button when its value matches (e.g. light up when the channel is live)." checked={!!fb} onChange={(v) => onConfig({ ...c, feedback: v ? { address: c.address || "/", equals: 1 } : null })} />
            {fb && (
              <>
                <RowText label="Watch address" value={fb.address} placeholder="/ch/01/mix/on" onChange={(v) => onConfig({ ...c, feedback: { ...fb, address: v } })} />
                <RowText label="Active when =" value={String(fb.equals ?? "")} placeholder="1 (blank = any truthy)" onChange={(v) => onConfig({ ...c, feedback: { ...fb, equals: v } })} />
                <RowText label="Active color" value={fb.activeColor ?? ""} placeholder="var(--red-9)" onChange={(v) => onConfig({ ...c, feedback: { ...fb, activeColor: v } })} />
              </>
            )}
          </>
        );
      })()}
      {c.type === "people-counter" && (() => {
        const zones = peopleCount?.zones ?? [];
        const metric = c.metric ?? "attendance";
        const perZone = metric === "attendance" || metric === "occupancy";
        const labelHint: Record<string, string> = { attendance: "people", occupancy: "in room", peak: "peak", min: "low", avg: "average" };
        return (
          <>
            <Row label="Count">
              <Select
                value={metric}
                onValueChange={(v: string) => {
                  const m = v as NonNullable<typeof c.metric>;
                  // peak/min/avg are building-wide only — drop any zone selection.
                  onConfig({ ...c, metric: m, zoneId: m === "attendance" || m === "occupancy" ? c.zoneId : null });
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="occupancy">In room (now)</SelectItem>
                  <SelectItem value="peak">Peak attendance (today)</SelectItem>
                  <SelectItem value="min">Lowest attendance (today)</SelectItem>
                  <SelectItem value="avg">Avg attendance (today)</SelectItem>
                  <SelectItem value="servicePeak">Peak in room (this service)</SelectItem>
                  <SelectItem value="servicePeakAttendance">Peak attendance (this service)</SelectItem>
                  <SelectItem value="serviceAttendance">Total entries (this service)</SelectItem>
                  <SelectItem value="attendance">Total entries (day)</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            {perZone ? (
              <Row label="Zone">
                <Select value={c.zoneId ?? ""} onValueChange={(v: string) => onConfig({ ...c, zoneId: v || null })}>
                  <SelectTrigger><SelectValue placeholder={zones.length ? "Building total" : "No zones detected"} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Building total</SelectItem>
                    {zones.map((z) => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Row>
            ) : (
              <p className="text-caption2 text-fg-muted leading-snug">Peak, low and average are building-wide (today), from the occupancy sensor.</p>
            )}
            <RowSwitch label="Show label" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
            {(c.showLabel ?? true) && (
              <RowText label="Label" value={c.label ?? ""} placeholder={labelHint[metric]} onChange={(v) => onConfig({ ...c, label: v })} />
            )}
          </>
        );
      })()}
      {c.type === "people-graph" && <PeopleGraphInspector c={c} onConfig={onConfig} />}
      {c.type === "people-panel" && (() => {
        const ORDER = ["occupancy", "servicePeak", "peak", "servicePeakAttendance", "serviceAttendance", "attendance", "capacity", "avg", "avgService", "vsAverage", "min"] as const;
        const LABEL: Record<string, string> = { occupancy: "In room", peak: "Peak att.", servicePeak: "Peak in room (svc)", servicePeakAttendance: "Peak att. (svc)", serviceAttendance: "Entries (svc)", attendance: "Entries (day)", capacity: "% capacity", avg: "Avg att.", avgService: "Avg / service", vsAverage: "vs average", min: "Lowest att." };
        const HINT: Record<string, string> = {
          occupancy: "People currently in the room right now (entries minus exits).",
          peak: "Peak attendance — the highest number of people in the room today.",
          servicePeak: "Highest number in the room during THIS service — resets each service, unlike the day-wide peak.",
          servicePeakAttendance: "Highest cumulative entries during THIS service — resets each service.",
          serviceAttendance: "Total entries THIS service — cumulative door count (double-counts re-entries), reset per service.",
          attendance: "Total entries today across ALL services — cumulative door count, double-counts re-entries.",
          capacity: "In-room now as a percentage of the configured building capacity.",
          avg: "Average attendance (in-room) across today.",
          avgService: "Average peak attendance across your past recorded services (a typical-service baseline).",
          vsAverage: "How this service's peak attendance compares to your typical service.",
          min: "Lowest attendance (in-room) during the current or most-recent live service — the 'floor'.",
        };
        const cur = c.metrics ?? ["occupancy", "peak", "attendance"];
        const toggle = (k: (typeof ORDER)[number], on: boolean) => {
          const set = new Set<string>(cur);
          if (on) set.add(k);
          else set.delete(k);
          onConfig({ ...c, metrics: ORDER.filter((x) => set.has(x)) });
        };
        return (
          <>
            <p className="text-caption2 text-fg-muted leading-snug">Building-wide people metrics, shown side by side. Toggle each:</p>
            {ORDER.map((k) => (
              <RowSwitch key={k} label={LABEL[k]} hint={HINT[k]} checked={cur.includes(k)} onChange={(v) => toggle(k, v)} />
            ))}
            <RowToggle
              label="Layout"
              value={c.orientation ?? "row"}
              options={[{ value: "row", label: "Row" }, { value: "column", label: "Stacked" }]}
              onChange={(v) => onConfig({ ...c, orientation: v as "row" | "column" })}
            />
            <RowSwitch label="Show labels" checked={c.showLabels ?? true} onChange={(v) => onConfig({ ...c, showLabels: v })} />
          </>
        );
      })()}
      {c.type === "baptism-timer" && (
        <>
          <Row label="Show">
            <Select value={c.field ?? "live"} onValueChange={(v: string) => onConfig({ ...c, field: v as NonNullable<typeof c.field> })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="live">Live (running clock)</SelectItem>
                <SelectItem value="count">Count baptized</SelectItem>
                <SelectItem value="total">Total time</SelectItem>
                <SelectItem value="average">Average per person</SelectItem>
                <SelectItem value="last">Last person</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <RowSwitch label="Show label" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          {(c.showLabel ?? true) && (
            <RowText label="Label" value={c.label ?? ""} placeholder="(auto)" onChange={(v) => onConfig({ ...c, label: v })} />
          )}
          <p className="text-caption2 text-fg-muted leading-snug">Driven by the Baptisms tab. &ldquo;Live&rdquo; ticks the current testimony/baptism; others summarize the session.</p>
        </>
      )}
      {c.type === "image" && (
        <ImageConfig src={c.src} onChange={(v) => onConfig({ type: "image", src: v })} />
      )}
      {c.type === "plan-attachment" && (
        <PlanAttachmentConfig c={c} onConfig={onConfig} o={o} canvas={canvas} onGeom={onGeom} />
      )}
      {c.type === "shape" && (
        <RowToggle
          label="Shape"
          value={c.shape}
          options={[{ value: "rect", label: "Rect" }, { value: "ellipse", label: "Ellipse" }]}
          onChange={(v) => onConfig({ type: "shape", shape: v })}
        />
      )}
      {c.type === "brand-logo" && (
        <RowSwitch label="Empty logo" checked={c.useEmptySlotLogo ?? false} onChange={(v) => onConfig({ type: "brand-logo", useEmptySlotLogo: v })} />
      )}
      {isStylingOnly(c.type) && (
        <p className="text-caption2 text-fg-muted leading-snug">Updates automatically — no options. Use the styling controls below.</p>
      )}
      {/* An object this build cannot render — almost always a layout restored from
          a NEWER version. Say so plainly and leave it alone: it renders as nothing
          on the display, and deleting it here would throw away work that the
          version it came from can still use. */}
      {!isKnownObjectType(c.type) && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-a5 bg-amber-a2 p-3">
          <span className="text-caption1 text-fg">This version can&apos;t show this object</span>
          <span className="text-caption2 text-fg-muted">
            The layout asks for <code>{c.type}</code>, which this build does not have — usually
            because the layout was saved by a newer version and restored here. It stays in the
            layout and renders as nothing; update this server and it will come back.
          </span>
          <span className="text-caption2 text-fg-muted">
            Leave it in place unless you are sure: deleting it here removes it for the newer
            version too.
          </span>
        </div>
      )}
      </div>

      <Separator />

      <Section label="Look" />

      {/* SURFACE and TINT, separately — they are independent questions, and the
          single list that mixed them (Glass, Glass·Green, Glass·Red, …) was both
          longer and less capable: it had no way to ask for a tinted Solid. */}
      <Row label="Surface" hint="What the widget sits on. None draws no card at all; Glass is translucent, so the screen shows through; Solid is an opaque card with a shadow; Outline is a hairline and nothing behind it.">
        <Select
          value={surfaceOf(s)}
          onValueChange={(v: string) => onStyle(applySurface(s, v as SurfaceKind))}
        >
          {/* No placeholder: every style IS one of the four, so there is nothing
              for the trigger to fall back to. "Custom" was never an entry in
              this list and has no business being what it reads. */}
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {SURFACES.map((x) => <SelectItem key={x.value} value={x.value}>{x.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Row>
      {/* ONE colour row, not a Tint row and a Fill row that both wrote the same
          field and disagreed about it. The swatches are the quick answers and
          the picker is any other, so what an object is filled with is asked and
          shown in one place. Named for what it does on THIS surface: Solid IS
          its colour, the others are washed with one. */}
      <Row
        label={surfaceOf(s) === "solid" ? "Fill" : "Tint"}
        hint="The colour on this surface. The swatches are washes made for a dark stage canvas; the picker takes any colour. On Glass they stay see-through, so tinted glass is still glass."
      >
        <div role="group" aria-label="Tint" className="flex items-center gap-1.5 flex-wrap">
          {TINTS.map((t) => {
            // "No tint" is not lit by a hand-picked colour: that is a colour,
            // and the slash would be claiming the object has none.
            const on = matchTint(s) === t.value && !(t.value === "none" && isCustomFill(s));
            return (
              <button
                key={t.value}
                type="button"
                aria-label={t.label}
                aria-pressed={on}
                title={t.label}
                onClick={() => onStyle(applyTint(s, t.value))}
                className={cn(
                  // A hairline, not a coloured ring: these are near-blacks, and
                  // on a dark panel an unbordered one has no edge at all. It is
                  // neutral so the circle still reads as one colour.
                  "flex size-6 items-center justify-center rounded-full border border-line-strong transition-transform",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                  on ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "hover:scale-110",
                )}
                style={{ background: t.swatch ?? "transparent" }}
              >
                {/* "No tint" is a slash rather than an empty circle, which would
                    read as a colour nobody could name. */}
                {t.value === "none" && (
                  <span aria-hidden="true" className="block h-px w-full rotate-45 bg-fg-subtle" />
                )}
              </button>
            );
          })}
          {/* Any other colour, in the same row and the same size as the presets
              — it is the same question. Drawn as a colour wheel rather than a
              sixth swatch: a native colour input shows its current value, and
              mirroring the tint made a subtle wash look like a neon dot sitting
              among the near-blacks. It shows a colour only once one is chosen. */}
          <span className="relative inline-flex size-6">
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-0 rounded-full border",
                isCustomFill(s) ? "border-accent ring-2 ring-accent ring-offset-1 ring-offset-bg" : "border-line-strong",
              )}
              style={
                isCustomFill(s)
                  ? { background: s.background ?? "transparent" }
                  : { background: "conic-gradient(#ef4444,#f59e0b,#84cc16,#22d3ee,#6366f1,#ec4899,#ef4444)", opacity: 0.55 }
              }
            />
            {/* The app's picker, laid over the wheel dot: the dot is the
                affordance, the picker is the panel. Opacity is offered here —
                a ground is exactly where a translucent colour belongs, and the
                native control could never express one. */}
            <ColorField
              label="Custom colour"
              value={s.background ?? "#000000"}
              onChange={(v) => onStyle({ background: v })}
              className="absolute inset-0 [&>button]:size-6 [&>button]:rounded-full [&>button]:border-0 [&>button]:bg-transparent [&>button]:opacity-0"
            />
          </span>
        </div>
      </Row>

      {/* Style */}
      {isText && (
        <>

          {/* Fall back to THIS type's own default, not a blanket 0.05. An object
              whose default differs (an embedded view starts at 0.016) otherwise
              reported a size it was not rendering at, so the first nudge of the
              stepper jumped it to a number it had never been. */}
          <Row label="Font size"><NumberField value={pxOf(s.fontSize, defaultStyle(c.type).fontSize ?? 0.05)} step={1} min={1} max={Math.round(0.5 * canvas.height)} suffix="px" onChange={(px) => onStyle({ fontSize: px / canvas.height })} /></Row>
          <Row label="Weight">
            <Select value={String(s.fontWeight ?? 400)} onValueChange={(v: string) => onStyle({ fontWeight: parseInt(v, 10) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{WEIGHTS.map((w) => <SelectItem key={w} value={String(w)}>{w}</SelectItem>)}</SelectContent>
            </Select>
          </Row>
          {/* Text, so no opacity: a translucent word over a wall is not a
              softer word, it is a harder one to read. */}
          <Row label="Color"><ColorField label="Text colour" allowAlpha={false} value={s.color ?? "#ffffff"} onChange={(v) => onStyle({ color: v })} /></Row>
          {/* One pad, not two rows of lettered buttons. What reads as active has
              to be the alignment the object will actually RENDER at, not a
              hard-coded guess: a readout with nothing stored aligns left, and
              lighting centre would say it is centred while it sits left — the
              first click would then appear to do nothing. */}
          <Row label="Align">
            <AlignPad
              h={s.textAlign ?? (IDIOM_TYPES.has(c.type) ? DEFAULT_READOUT_ALIGN : "center")}
              v={s.vAlign ?? "middle"}
              onChange={onStyle}
            />
          </Row>
        </>
      )}

      <Row label="Radius"><NumberField value={pxOf(s.cornerRadius, 0)} step={1} min={0} max={Math.round(0.5 * canvas.height)} suffix="px" onChange={(px) => onStyle({ cornerRadius: px / canvas.height })} /></Row>
      <Row label="Border">
        <ColorField
          label="Border colour"
          value={s.borderColor ?? "#ffffff"}
          onChange={(v) => onStyle({ borderColor: v, borderWidth: s.borderWidth ?? 0 })}
        />
        <NumberField
          value={Math.round((s.borderWidth ?? 0) * canvas.height)}
          step={1}
          min={0}
          max={40}
          suffix="px"
          onChange={(px) => onStyle({ borderWidth: px / canvas.height, borderColor: s.borderColor ?? "#ffffff" })}
        />
      </Row>

      {/* Uppercase is what is left of the "more" drawer.
          Elevation, opacity, padding, text shadow and max lines are GONE — not
          hidden. They were five ways to make a widget look slightly wrong: a
          shadow under a card on a black wall is invisible, an opacity below one
          is a legibility bug waiting for a service, and the stored padding was
          the thing that made small widgets clip, because the readout draws its
          own. Anything an object needs at a size is the composition's job, not
          five sliders'. */}
      {isText && (
        <MoreControls>
          <Row label="Uppercase"><Switch checked={s.uppercase ?? false} onCheckedChange={(v) => onStyle({ uppercase: v })} /></Row>
        </MoreControls>
      )}

      {/* The way back. Every other control here adds to the styling; without this
          the only route out of a look you have tuned into a corner is to delete
          the object and start again, which loses its position and settings too. */}
      <Row
        label="Reset"
        hint="Put this object's look back to the default for its type. Its position, size, settings and behaviour on other window shapes are left alone — and it can be undone."
      >
        <Button variant="filled" size="small" onClick={onResetLook}>
          Reset to default look
        </Button>
      </Row>

      <Separator />

      <Section label="Place" />

      {/* Align within the parent (canvas for top-level, container box if nested) */}
      <Row label="Align">
        <ButtonGroup>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: 0 })} aria-label="Align left" tooltip="Align left"><AlignStartVertical className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: (1 - o.w) / 2 })} aria-label="Center horizontally" tooltip="Center horizontally"><AlignCenterVertical className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: 1 - o.w })} aria-label="Align right" tooltip="Align right"><AlignEndVertical className="size-3.5" /></Button>
        </ButtonGroup>
        <ButtonGroup>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: 0 })} aria-label="Align top" tooltip="Align top"><AlignStartHorizontal className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: (1 - o.h) / 2 })} aria-label="Center vertically" tooltip="Center vertically"><AlignCenterHorizontal className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: 1 - o.h })} aria-label="Align bottom" tooltip="Align bottom"><AlignEndHorizontal className="size-3.5" /></Button>
        </ButtonGroup>
      </Row>

      {/* Position & size in design-px of the parent box (canvas for top-level) */}
      <span className="text-caption2 text-fg-muted">
        Position &amp; size ({Math.round(parentW)}×{Math.round(parentH)}{nested ? " · in container" : ""})
      </span>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 @max-[248px]/insp:grid-cols-1">
        <PixelField label="X" value={o.x} dim={parentW} onChange={(v) => onGeom({ x: clamp(v, 0, 1 - o.w) })} />
        <PixelField label="Y" value={o.y} dim={parentH} onChange={(v) => onGeom({ y: clamp(v, 0, 1 - o.h) })} />
        <PixelField label="W" value={o.w} dim={parentW} onChange={(v) => onGeom({ w: clamp(v, MIN, 1 - o.x) })} />
        <PixelField label="H" value={o.h} dim={parentH} onChange={(v) => onGeom({ h: clamp(v, MIN, 1 - o.y) })} />
      </div>

      {/* How this object behaves when the window is not the design's shape.
          Sits with position and size because that is what it modifies. */}
      <ResponsiveControls
        settings={{ anchor: o.anchor, keepAspect: o.keepAspect, minPx: o.minPx, maxPx: o.maxPx }}
        onChange={(patch) => onGeom(patch)}
      />
    </div>
  );
}

