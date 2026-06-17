import { useState, useEffect, useCallback, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  UndoIcon,
  Trash2Icon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  Grid3x3Icon,
  SaveIcon,
  DownloadIcon,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
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
  Dialog,
} from "../../components/ui";
import { ObjectContent, boxStyle, useLayoutData, type LayoutRenderCtx } from "../../main/layout-renderer";

// ── object metadata ──────────────────────────────────────────────────────────

const TYPE_LABELS: Record<LayoutObjectType, string> = {
  text: "Text",
  clock: "Clock",
  "countdown-timer": "Countdown timer",
  "current-slide-text": "Current slide",
  "next-slide-text": "Next slide",
  "current-slide-notes": "Slide notes",
  "slide-thumbnail": "Slide image",
  "section-chip": "Section chip",
  "slots-grid": "Mic slots",
  "transcript-strip": "Captions",
  "brand-logo": "Logo",
  "ndi-video": "NDI video",
  image: "Image",
  shape: "Shape",
};
const PALETTE: LayoutObjectType[] = [
  "text", "clock", "countdown-timer", "current-slide-text", "next-slide-text",
  "current-slide-notes", "slide-thumbnail", "section-chip", "slots-grid",
  "transcript-strip", "brand-logo", "ndi-video", "image", "shape",
];

function defaultConfig(type: LayoutObjectType): LayoutObjectConfig {
  switch (type) {
    case "text": return { type: "text", text: "Text" };
    case "clock": return { type: "clock", showSeconds: true, format: "12h" };
    case "section-chip": return { type: "section-chip", which: "current" };
    case "slots-grid": return { type: "slots-grid", sourceViewId: null };
    case "transcript-strip": return { type: "transcript-strip", mode: "latest", maxLines: 3 };
    case "brand-logo": return { type: "brand-logo", useEmptySlotLogo: false };
    case "image": return { type: "image", src: "" };
    case "shape": return { type: "shape", shape: "rect" };
    default: return { type } as LayoutObjectConfig;
  }
}

function defaultStyle(type: LayoutObjectType): LayoutStyle {
  if (type === "shape") return { background: "#3b82f6", opacity: 1 };
  if (type === "ndi-video" || type === "slide-thumbnail" || type === "image" || type === "brand-logo") return {};
  return { fontSize: 0.06, fontWeight: 500, color: "#ffffff", textAlign: "center", vAlign: "middle" };
}

function makeObject(type: LayoutObjectType, zTop: number): LayoutObject {
  return {
    id: crypto.randomUUID(),
    x: 0.35, y: 0.42, w: 0.3, h: 0.16,
    z: zTop + 1,
    config: defaultConfig(type),
    style: defaultStyle(type),
  };
}

const GRID = 48; // snap steps across the canvas
const MIN = 0.03;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const snap = (v: number, on: boolean) => (on ? Math.round(v * GRID) / GRID : v);

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function handleCursor(h: Handle): string {
  if (h === "n" || h === "s") return "ns-resize";
  if (h === "e" || h === "w") return "ew-resize";
  if (h === "nw" || h === "se") return "nwse-resize";
  return "nesw-resize";
}

function applyResize(start: LayoutObject, h: Handle, dx: number, dy: number): Pick<LayoutObject, "x" | "y" | "w" | "h"> {
  let { x, y, w, h: hh } = start;
  if (h.includes("e")) w = start.w + dx;
  if (h.includes("s")) hh = start.h + dy;
  if (h.includes("w")) { x = start.x + dx; w = start.w - dx; }
  if (h.includes("n")) { y = start.y + dy; hh = start.h - dy; }
  if (w < MIN) { if (h.includes("w")) x = start.x + start.w - MIN; w = MIN; }
  if (hh < MIN) { if (h.includes("n")) y = start.y + start.h - MIN; hh = MIN; }
  x = clamp(x, 0, 1 - w);
  y = clamp(y, 0, 1 - hh);
  w = Math.min(w, 1 - x);
  hh = Math.min(hh, 1 - y);
  return { x, y, w, h: hh };
}

// ── canvas with interactive overlay ──────────────────────────────────────────

interface DragState {
  id: string;
  mode: "move" | Handle;
  start: LayoutObject;
  px: number;
  py: number;
}

function EditorCanvas({
  canvas, objects, selectedId, gridOn, ctx, ndiSource,
  onSelect, onGeom, onCommitStart,
}: {
  canvas: LayoutCanvas;
  objects: LayoutObject[];
  selectedId: string | null;
  gridOn: boolean;
  ctx: Omit<LayoutRenderCtx, "H" | "ndiSource">;
  ndiSource: string | null;
  onSelect: (id: string | null) => void;
  onGeom: (id: string, geom: Pick<LayoutObject, "x" | "y" | "w" | "h">) => void;
  onCommitStart: () => void;
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!box) return;
    const m = () => setSize({ w: box.clientWidth, h: box.clientHeight });
    m();
    const ro = new ResizeObserver(m);
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);

  const scale = size.w ? size.w / canvas.width : 0;
  const [drag, setDrag] = useState<DragState | null>(null);

  // Window-level move/up while dragging.
  useEffect(() => {
    if (!drag || !box) return;
    const onMove = (e: globalThis.PointerEvent) => {
      const dx = (e.clientX - drag.px) / box.clientWidth;
      const dy = (e.clientY - drag.py) / box.clientHeight;
      if (drag.mode === "move") {
        const x = clamp(snap(drag.start.x + dx, gridOn), 0, 1 - drag.start.w);
        const y = clamp(snap(drag.start.y + dy, gridOn), 0, 1 - drag.start.h);
        onGeom(drag.id, { x, y, w: drag.start.w, h: drag.start.h });
      } else {
        const g = applyResize(drag.start, drag.mode, dx, dy);
        onGeom(drag.id, {
          x: snap(g.x, gridOn), y: snap(g.y, gridOn),
          w: snap(g.w, gridOn), h: snap(g.h, gridOn),
        });
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, box, gridOn, onGeom]);

  function startDrag(e: ReactPointerEvent, o: LayoutObject, mode: "move" | Handle) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(o.id);
    onCommitStart();
    setDrag({ id: o.id, mode, start: o, px: e.clientX, py: e.clientY });
  }

  const sorted = [...objects].sort((a, b) => a.z - b.z);
  const fullCtx: LayoutRenderCtx = { ...ctx, H: canvas.height, ndiSource };

  const gridBg: CSSProperties = gridOn
    ? {
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
        backgroundSize: `${100 / GRID}% ${100 / GRID}%`,
      }
    : {};

  return (
    <div
      ref={setBox}
      className="relative w-full overflow-hidden rounded-xl border border-gray-a4 select-none"
      style={{ aspectRatio: `${canvas.width} / ${canvas.height}`, background: canvas.background ?? "#000", ...gridBg }}
      onPointerDown={() => onSelect(null)}
    >
      {/* Scaled content layer (visual only) */}
      {scale > 0 && (
        <div
          style={{
            width: canvas.width, height: canvas.height,
            transform: `scale(${scale})`, transformOrigin: "top left",
            position: "absolute", top: 0, left: 0, pointerEvents: "none",
          }}
        >
          {sorted.map((o) => (
            <div
              key={o.id}
              style={{
                position: "absolute",
                left: o.x * canvas.width, top: o.y * canvas.height,
                width: o.w * canvas.width, height: o.h * canvas.height,
                opacity: o.hidden ? 0.25 : 1,
                ...boxStyle(o, canvas.height),
              }}
            >
              <ObjectContent o={o} ctx={fullCtx} />
            </div>
          ))}
        </div>
      )}

      {/* Interaction overlay (rendered px) */}
      <div className="absolute inset-0">
        {sorted.map((o) => {
          const sel = o.id === selectedId;
          return (
            <div
              key={o.id}
              onPointerDown={(e) => startDrag(e, o, "move")}
              className="absolute"
              style={{
                left: `${o.x * 100}%`, top: `${o.y * 100}%`,
                width: `${o.w * 100}%`, height: `${o.h * 100}%`,
                cursor: "move",
                outline: sel ? "2px solid #3b82f6" : "1px solid rgba(125,170,255,0.55)",
                outlineOffset: 0,
                boxShadow: sel ? "0 0 0 1px rgba(0,0,0,0.4)" : "0 0 0 1px rgba(0,0,0,0.35)",
              }}
            >
              {/* Name tag so objects are easy to tell apart */}
              <span
                style={{
                  position: "absolute", top: 0, left: 0, transform: "translateY(-100%)",
                  fontSize: 10, lineHeight: "14px", padding: "0 5px", maxWidth: "100%",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  background: sel ? "#3b82f6" : "rgba(125,170,255,0.55)", color: "#fff",
                  borderRadius: "4px 4px 0 0", pointerEvents: "none",
                }}
              >
                {TYPE_LABELS[o.config.type]}
              </span>
              {sel &&
                HANDLES.map((h) => {
                  const pos: CSSProperties = { position: "absolute", width: 9, height: 9, background: "#3b82f6", borderRadius: 2 };
                  if (h.includes("n")) pos.top = -5;
                  if (h.includes("s")) pos.bottom = -5;
                  if (h.includes("w")) pos.left = -5;
                  if (h.includes("e")) pos.right = -5;
                  if (h === "n" || h === "s") { pos.left = "calc(50% - 4.5px)"; }
                  if (h === "e" || h === "w") { pos.top = "calc(50% - 4.5px)"; }
                  return (
                    <div
                      key={h}
                      onPointerDown={(e) => startDrag(e, o, h)}
                      style={{ ...pos, cursor: handleCursor(h) }}
                    />
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── small inspector row helpers ──────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-caption2 text-gray-9 w-20 shrink-0">{label}</span>
      <div className="flex-1 min-w-0 flex items-center gap-1">{children}</div>
    </div>
  );
}

const NO_SPINNER =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0";

function NumberInput({ value, onChange, step = 0.01, min, max }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <Input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      max={max}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className={`text-gray-12 tabular-nums ${NO_SPINNER}`}
    />
  );
}

/** X/Y/W/H field shown as whole design-canvas pixels (stored as a 0..1 fraction). */
function PixelField({ label, value, dim, onChange }: { label: string; value: number; dim: number; onChange: (frac: number) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-caption2 text-gray-9 w-3.5 shrink-0">{label}</span>
      <div className="relative flex-1 min-w-0">
        <Input
          type="number"
          value={Math.round((Number.isFinite(value) ? value : 0) * dim)}
          step={1}
          min={0}
          max={dim}
          onChange={(e) => onChange((parseFloat(e.target.value) || 0) / dim)}
          className={`text-gray-12 tabular-nums pr-6 ${NO_SPINNER}`}
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-caption2 text-gray-8 pointer-events-none">px</span>
      </div>
    </label>
  );
}

// ── main editor ──────────────────────────────────────────────────────────────

export function LayoutEditor({
  view,
  slotsViews,
  templates,
  onSave,
  onSaveTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
}: {
  view: View;
  slotsViews: View[];
  templates: LayoutTemplate[];
  onSave: (layout: LayoutDTO) => Promise<void>;
  onSaveTemplate: (name: string, layout: LayoutDTO) => Promise<void>;
  onUpdateTemplate: (id: string, patch: { name?: string; layout?: LayoutDTO }) => Promise<void>;
  onDeleteTemplate: (id: string) => Promise<void>;
}) {
  const data = useLayoutData();
  const initial = view.layout ?? { version: 1 as const, canvas: { width: 1920, height: 1080, background: "#080810" }, objects: [] };
  const [canvas] = useState<LayoutCanvas>(initial.canvas);
  const [objects, setObjects] = useState<LayoutObject[]>(initial.objects);
  const [selectedId, setSelectedId] = useState<string | null>(initial.objects[0]?.id ?? null);
  const [history, setHistory] = useState<LayoutObject[][]>([]);
  const [dirty, setDirty] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tplName, setTplName] = useState("");

  const currentLayout = (): LayoutDTO => ({ version: 1, canvas, objects });
  function loadTemplate(t: LayoutTemplate) {
    pushHistory();
    setObjects(t.layout.objects.map((o) => ({ ...o, id: crypto.randomUUID() })));
    setSelectedId(null);
    setDirty(true);
  }

  const selected = objects.find((o) => o.id === selectedId) ?? null;
  const zTop = objects.reduce((m, o) => Math.max(m, o.z), 0);

  const pushHistory = useCallback(() => {
    setHistory((h) => [...h.slice(-49), objects]);
    setDirty(true);
  }, [objects]);

  function update(id: string, patch: Partial<LayoutObject>) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }
  function updateStyle(id: string, patch: Partial<LayoutStyle>) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, style: { ...o.style, ...patch } } : o)));
  }
  function updateConfig(id: string, config: LayoutObjectConfig) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, config } : o)));
  }
  // Geometry updates during a drag don't each push history (startDrag already did).
  const onGeom = useCallback((id: string, geom: Pick<LayoutObject, "x" | "y" | "w" | "h">) => {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, ...geom } : o)));
    setDirty(true);
  }, []);

  function addObject(type: LayoutObjectType) {
    pushHistory();
    const o = makeObject(type, zTop);
    setObjects((prev) => [...prev, o]);
    setSelectedId(o.id);
  }
  function removeObject(id: string) {
    pushHistory();
    setObjects((prev) => prev.filter((o) => o.id !== id));
    if (selectedId === id) setSelectedId(null);
  }
  function duplicateObject(id: string) {
    const src = objects.find((o) => o.id === id);
    if (!src) return;
    pushHistory();
    const copy: LayoutObject = { ...src, id: crypto.randomUUID(), x: clamp(src.x + 0.03, 0, 1 - src.w), y: clamp(src.y + 0.03, 0, 1 - src.h), z: zTop + 1 };
    setObjects((prev) => [...prev, copy]);
    setSelectedId(copy.id);
  }
  function reorder(id: string, dir: "front" | "back" | "up" | "down") {
    pushHistory();
    setObjects((prev) => {
      const sorted = [...prev].sort((a, b) => a.z - b.z);
      const idx = sorted.findIndex((o) => o.id === id);
      if (idx === -1) return prev;
      if (dir === "front") sorted.push(sorted.splice(idx, 1)[0]);
      else if (dir === "back") sorted.unshift(sorted.splice(idx, 1)[0]);
      else if (dir === "up" && idx < sorted.length - 1) [sorted[idx], sorted[idx + 1]] = [sorted[idx + 1], sorted[idx]];
      else if (dir === "down" && idx > 0) [sorted[idx], sorted[idx - 1]] = [sorted[idx - 1], sorted[idx]];
      return sorted.map((o, i) => ({ ...o, z: i + 1 }));
    });
  }
  function undo() {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setObjects(prev);
      setDirty(true);
      return h.slice(0, -1);
    });
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({ version: 1, canvas, objects });
      setDirty(false);
      setHistory([]);
    } finally {
      setSaving(false);
    }
  }

  // commit-before-edit wrapper for inspector edits
  function withHistory<T extends unknown[]>(fn: (...a: T) => void) {
    return (...a: T) => { pushHistory(); fn(...a); };
  }

  const layersDesc = [...objects].sort((a, b) => b.z - a.z);

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <Select value="" onValueChange={(t: string) => addObject(t as LayoutObjectType)}>
          <SelectTrigger className="w-40"><SelectValue placeholder="+ Add object" /></SelectTrigger>
          <SelectContent>
            {PALETTE.map((t) => (
              <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant={gridOn ? "accent" : "filled"} size="small" onClick={() => setGridOn((v) => !v)} aria-label="Toggle snap grid">
          <Grid3x3Icon className="size-3.5" /> Grid
        </Button>
        <Button variant="filled" size="small" onClick={undo} disabled={history.length === 0}>
          <UndoIcon className="size-3.5" /> Undo
        </Button>

        {templates.length > 0 && (
          <Select
            value=""
            onValueChange={(id: string) => { const t = templates.find((x) => x.id === id); if (t) loadTemplate(t); }}
          >
            <SelectTrigger className="w-40"><SelectValue placeholder="Load layout…" /></SelectTrigger>
            <SelectContent>
              {templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Dialog
          trigger={<Button variant="filled" size="small"><SaveIcon className="size-3.5" /> Save as layout</Button>}
          title="Save layout to library"
          description="Save this design by name so you can reuse it on other custom displays."
          confirmLabel="Save"
          confirmDisabled={tplName.trim().length === 0}
          onConfirm={async () => { await onSaveTemplate(tplName.trim(), currentLayout()); setTplName(""); }}
        >
          <Input
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
            placeholder="Layout name (e.g. Lyrics + Timer)"
            className="text-gray-12"
            autoFocus
          />
        </Dialog>

        <div className="flex-1" />
        {dirty && (
          <Button variant="accent" size="small" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save layout"}
          </Button>
        )}
      </div>

      <div className="flex gap-3 max-lg:flex-col">
        {/* Canvas */}
        <div className="flex-1 min-w-0">
          {data.state ? (
            <EditorCanvas
              canvas={canvas}
              objects={objects}
              selectedId={selectedId}
              gridOn={gridOn}
              ctx={{ ...data, state: data.state }}
              ndiSource={view.ndiSource ?? null}
              onSelect={setSelectedId}
              onGeom={onGeom}
              onCommitStart={pushHistory}
            />
          ) : (
            <div
              className="w-full rounded-xl border border-gray-a4 flex items-center justify-center text-gray-7"
              style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
            >
              Loading…
            </div>
          )}
        </div>

        {/* Side panel: layers + inspector */}
        <div className="w-64 shrink-0 flex flex-col gap-3">
          {/* Layers */}
          <div className="flex flex-col gap-1">
            <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">Layers</span>
            {layersDesc.length === 0 && <span className="text-caption2 text-gray-7">No objects yet — add one above.</span>}
            {layersDesc.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setSelectedId(o.id)}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-left ${o.id === selectedId ? "bg-gray-a4" : "hover:bg-gray-a3"}`}
              >
                <span className="text-caption1 text-gray-12 flex-1 min-w-0 truncate">{TYPE_LABELS[o.config.type]}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); pushHistory(); update(o.id, { hidden: !o.hidden }); }}
                  className="text-gray-9 hover:text-gray-12"
                  aria-label={o.hidden ? "Show" : "Hide"}
                >
                  {o.hidden ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                </span>
              </button>
            ))}
          </div>

          {selected && (
            <>
              <Separator />
              <Inspector
                key={selected.id}
                o={selected}
                canvas={canvas}
                slotsViews={slotsViews}
                onGeom={(g) => { /* numeric position edits */ pushHistory(); update(selected.id, g); }}
                onStyle={withHistory((patch: Partial<LayoutStyle>) => updateStyle(selected.id, patch))}
                onConfig={withHistory((config: LayoutObjectConfig) => updateConfig(selected.id, config))}
                onReorder={(d) => reorder(selected.id, d)}
                onDuplicate={() => duplicateObject(selected.id)}
                onRemove={() => removeObject(selected.id)}
              />
            </>
          )}

          {/* Saved layout library */}
          {templates.length > 0 && (
            <>
              <Separator />
              <div className="flex flex-col gap-1">
                <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">Saved layouts</span>
                {templates.map((t) => (
                  <div key={t.id} className="flex items-center gap-0.5 rounded-md px-2 py-1 hover:bg-gray-a3">
                    <span className="text-caption1 text-gray-12 flex-1 min-w-0 truncate">{t.name}</span>
                    <Button variant="transparent" size="small" iconOnly onClick={() => loadTemplate(t)} aria-label="Load into editor" title="Load into editor">
                      <DownloadIcon className="size-3.5 text-gray-9" />
                    </Button>
                    <Button variant="transparent" size="small" iconOnly onClick={() => onUpdateTemplate(t.id, { layout: currentLayout() })} aria-label="Overwrite with current" title="Overwrite with current layout">
                      <SaveIcon className="size-3.5 text-gray-9" />
                    </Button>
                    <Button variant="transparent" size="small" iconOnly onClick={() => onDeleteTemplate(t.id)} aria-label="Delete layout">
                      <Trash2Icon className="size-3.5 text-red-10" />
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── inspector ────────────────────────────────────────────────────────────────

const WEIGHTS = [300, 400, 500, 600, 700, 800];

function Inspector({
  o, canvas, slotsViews, onGeom, onStyle, onConfig, onReorder, onDuplicate, onRemove,
}: {
  o: LayoutObject;
  canvas: LayoutCanvas;
  slotsViews: View[];
  onGeom: (g: Partial<Pick<LayoutObject, "x" | "y" | "w" | "h">>) => void;
  onStyle: (patch: Partial<LayoutStyle>) => void;
  onConfig: (config: LayoutObjectConfig) => void;
  onReorder: (d: "front" | "back" | "up" | "down") => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const s = o.style ?? {};
  const c = o.config;
  const isText = !["shape", "ndi-video", "slide-thumbnail", "image", "brand-logo", "slots-grid"].includes(c.type);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1">
        <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9 flex-1">{TYPE_LABELS[c.type]}</span>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("up")} aria-label="Bring forward"><ChevronUpIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("down")} aria-label="Send backward"><ChevronDownIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={onDuplicate} aria-label="Duplicate"><CopyIcon className="size-3.5 text-gray-9" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={onRemove} aria-label="Delete"><Trash2Icon className="size-3.5 text-red-10" /></Button>
      </div>

      {/* Binding */}
      {c.type === "text" && (
        <Row label="Text"><Input value={c.text} onChange={(e) => onConfig({ type: "text", text: e.target.value })} className="text-gray-12" /></Row>
      )}
      {c.type === "clock" && (
        <>
          <Row label="Format">
            <ButtonGroup>
              <Button variant={c.format !== "24h" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, format: "12h" })}>12h</Button>
              <Button variant={c.format === "24h" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, format: "24h" })}>24h</Button>
            </ButtonGroup>
          </Row>
          <Row label="Seconds"><Switch checked={c.showSeconds ?? true} onCheckedChange={(v) => onConfig({ ...c, showSeconds: v })} /></Row>
        </>
      )}
      {c.type === "section-chip" && (
        <Row label="Which">
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
      {c.type === "transcript-strip" && (
        <>
          <Row label="Mode">
            <ButtonGroup>
              <Button variant={c.mode === "latest" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, mode: "latest" })}>Latest</Button>
              <Button variant={c.mode === "rolling" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, mode: "rolling" })}>Rolling</Button>
            </ButtonGroup>
          </Row>
          {c.mode === "rolling" && (
            <Row label="Lines"><NumberInput value={c.maxLines ?? 3} step={1} min={1} max={10} onChange={(v) => onConfig({ ...c, maxLines: Math.round(v) })} /></Row>
          )}
        </>
      )}
      {c.type === "slots-grid" && (
        <Row label="Source">
          <Select value={c.sourceViewId ?? ""} onValueChange={(v: string) => onConfig({ type: "slots-grid", sourceViewId: v || null })}>
            <SelectTrigger><SelectValue placeholder="Mic-slots view…" /></SelectTrigger>
            <SelectContent>
              {slotsViews.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
      )}
      {c.type === "image" && (
        <Row label="URL"><Input value={c.src} onChange={(e) => onConfig({ type: "image", src: e.target.value })} placeholder="https://… or data:" className="text-gray-12" /></Row>
      )}
      {c.type === "shape" && (
        <Row label="Shape">
          <ButtonGroup>
            <Button variant={c.shape === "rect" ? "accent" : "filled"} size="small" onClick={() => onConfig({ type: "shape", shape: "rect" })}>Rect</Button>
            <Button variant={c.shape === "ellipse" ? "accent" : "filled"} size="small" onClick={() => onConfig({ type: "shape", shape: "ellipse" })}>Ellipse</Button>
          </ButtonGroup>
        </Row>
      )}
      {c.type === "brand-logo" && (
        <Row label="Empty logo"><Switch checked={c.useEmptySlotLogo ?? false} onCheckedChange={(v) => onConfig({ type: "brand-logo", useEmptySlotLogo: v })} /></Row>
      )}

      <Separator />

      {/* Style */}
      {isText && (
        <>
          <Row label="Font size"><NumberInput value={s.fontSize ?? 0.05} step={0.005} min={0.01} max={0.5} onChange={(v) => onStyle({ fontSize: v })} /></Row>
          <Row label="Weight">
            <Select value={String(s.fontWeight ?? 400)} onValueChange={(v: string) => onStyle({ fontWeight: parseInt(v, 10) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{WEIGHTS.map((w) => <SelectItem key={w} value={String(w)}>{w}</SelectItem>)}</SelectContent>
            </Select>
          </Row>
          <Row label="Color"><input type="color" value={s.color ?? "#ffffff"} onChange={(e) => onStyle({ color: e.target.value })} className="w-9 h-7 rounded cursor-pointer border border-gray-a4 bg-transparent" /></Row>
          <Row label="Align">
            <ButtonGroup>
              {(["left", "center", "right"] as const).map((a) => (
                <Button key={a} variant={(s.textAlign ?? "center") === a ? "accent" : "filled"} size="small" onClick={() => onStyle({ textAlign: a })}>{a[0].toUpperCase()}</Button>
              ))}
            </ButtonGroup>
          </Row>
          <Row label="V-align">
            <ButtonGroup>
              {(["top", "middle", "bottom"] as const).map((a) => (
                <Button key={a} variant={(s.vAlign ?? "middle") === a ? "accent" : "filled"} size="small" onClick={() => onStyle({ vAlign: a })}>{a[0].toUpperCase()}</Button>
              ))}
            </ButtonGroup>
          </Row>
          <Row label="Uppercase"><Switch checked={s.uppercase ?? false} onCheckedChange={(v) => onStyle({ uppercase: v })} /></Row>
          <Row label="Shadow"><NumberInput value={s.textShadow ?? 0} step={0.1} min={0} max={1} onChange={(v) => onStyle({ textShadow: v })} /></Row>
          <Row label="Max lines"><NumberInput value={s.lineClamp ?? 0} step={1} min={0} max={10} onChange={(v) => onStyle({ lineClamp: v > 0 ? Math.round(v) : null })} /></Row>
        </>
      )}
      <Row label="Fill"><input type="color" value={s.background ?? "#000000"} onChange={(e) => onStyle({ background: e.target.value })} className="w-9 h-7 rounded cursor-pointer border border-gray-a4 bg-transparent" />
        <Button variant="transparent" size="small" onClick={() => onStyle({ background: null })}>Clear</Button>
      </Row>
      <Row label="Opacity"><NumberInput value={s.opacity ?? 1} step={0.05} min={0} max={1} onChange={(v) => onStyle({ opacity: v })} /></Row>
      <Row label="Radius"><NumberInput value={s.cornerRadius ?? 0} step={0.005} min={0} max={0.5} onChange={(v) => onStyle({ cornerRadius: v })} /></Row>
      <Row label="Padding"><NumberInput value={s.padding ?? 0} step={0.005} min={0} max={0.3} onChange={(v) => onStyle({ padding: v })} /></Row>
      <Row label="Border">
        <input
          type="color"
          value={s.borderColor ?? "#3b82f6"}
          onChange={(e) => onStyle({ borderColor: e.target.value })}
          className="w-9 h-7 rounded cursor-pointer border border-gray-a4 bg-transparent"
          aria-label="Border color"
        />
        <NumberInput value={s.borderWidth ?? 0} step={0.002} min={0} max={0.05} onChange={(v) => onStyle({ borderWidth: v, borderColor: s.borderColor ?? "#3b82f6" })} />
        {(s.borderWidth ?? 0) > 0 && (
          <Button variant="transparent" size="small" onClick={() => onStyle({ borderWidth: 0 })}>Off</Button>
        )}
      </Row>

      <Separator />

      {/* Align to canvas */}
      <Row label="Align">
        <ButtonGroup>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: 0 })} aria-label="Align left" title="Align left"><AlignStartVertical className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: (1 - o.w) / 2 })} aria-label="Center horizontally" title="Center horizontally"><AlignCenterVertical className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: 1 - o.w })} aria-label="Align right" title="Align right"><AlignEndVertical className="size-3.5" /></Button>
        </ButtonGroup>
        <ButtonGroup>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: 0 })} aria-label="Align top" title="Align top"><AlignStartHorizontal className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: (1 - o.h) / 2 })} aria-label="Center vertically" title="Center vertically"><AlignCenterHorizontal className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: 1 - o.h })} aria-label="Align bottom" title="Align bottom"><AlignEndHorizontal className="size-3.5" /></Button>
        </ButtonGroup>
      </Row>

      {/* Position & size in design-canvas pixels */}
      <span className="text-caption2 text-gray-9">Position &amp; size ({canvas.width}×{canvas.height})</span>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <PixelField label="X" value={o.x} dim={canvas.width} onChange={(v) => onGeom({ x: clamp(v, 0, 1 - o.w) })} />
        <PixelField label="Y" value={o.y} dim={canvas.height} onChange={(v) => onGeom({ y: clamp(v, 0, 1 - o.h) })} />
        <PixelField label="W" value={o.w} dim={canvas.width} onChange={(v) => onGeom({ w: clamp(v, MIN, 1 - o.x) })} />
        <PixelField label="H" value={o.h} dim={canvas.height} onChange={(v) => onGeom({ h: clamp(v, MIN, 1 - o.y) })} />
      </div>
    </div>
  );
}
