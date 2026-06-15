import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "../../components/ui";

// On-screen crop square and the exported (square) resolution.
const VIEWPORT = 224;
const OUTPUT = 256;
const MAX_ZOOM = 4; // relative to the "cover" scale

interface LogoCropperProps {
  /** Data URL of the image to crop (the ORIGINAL upload). */
  src: string;
  /** Saved transform to restore when re-editing (retains zoom/position). */
  initial?: { scale: number; x: number; y: number } | null;
  onCancel: () => void;
  /** Returns the rendered crop plus the source + transform to persist. */
  onSave: (result: {
    logo: string;
    original: string;
    crop: { scale: number; x: number; y: number };
  }) => void;
}

/**
 * Pan + zoom an uploaded image within a square viewport and export a square
 * PNG, so logos of any size/aspect ratio fit cleanly in the sidebar and kiosk.
 *
 * `offset` is the image's top-left position in viewport pixels; `scale` is
 * displayed-pixels per source-pixel. Both are clamped so the image always
 * covers the viewport (no empty corners).
 */
export function LogoCropper({ src, initial, onCancel, onSave }: LogoCropperProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [minScale, setMinScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const w = img.naturalWidth || 300;
      const h = img.naturalHeight || 300;
      const cover = Math.max(VIEWPORT / w, VIEWPORT / h);
      setNat({ w, h });
      setMinScale(cover);
      // Restore the saved transform when re-editing; otherwise center at cover.
      // `cover` is the minimum, so a saved (larger) scale lets the user zoom back out.
      const s = initial ? Math.max(cover, initial.scale) : cover;
      const o = initial
        ? { x: Math.min(0, Math.max(VIEWPORT - w * s, initial.x)), y: Math.min(0, Math.max(VIEWPORT - h * s, initial.y)) }
        : { x: (VIEWPORT - w * s) / 2, y: (VIEWPORT - h * s) / 2 };
      setScale(s);
      setOffset(o);
    };
    img.src = src;
  }, [src, initial]);

  function clamp(o: { x: number; y: number }, s: number, dims: { w: number; h: number }) {
    return {
      x: Math.min(0, Math.max(VIEWPORT - dims.w * s, o.x)),
      y: Math.min(0, Math.max(VIEWPORT - dims.h * s, o.y)),
    };
  }

  function onZoom(next: number) {
    if (!nat) return;
    const ns = Math.max(minScale, Math.min(minScale * MAX_ZOOM, next));
    // Zoom about the viewport center so the focal point stays put.
    setOffset((prev) =>
      clamp(
        {
          x: VIEWPORT / 2 - (VIEWPORT / 2 - prev.x) * (ns / scale),
          y: VIEWPORT / 2 - (VIEWPORT / 2 - prev.y) * (ns / scale),
        },
        ns,
        nat,
      ),
    );
    setScale(ns);
  }

  function onPointerDown(e: ReactPointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (!drag.current || !nat) return;
    setOffset(
      clamp(
        { x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) },
        scale,
        nat,
      ),
    );
  }

  function onPointerUp() {
    drag.current = null;
  }

  function save() {
    const img = imgRef.current;
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // The viewport maps onto a square source region of the image.
    const sSize = VIEWPORT / scale;
    ctx.drawImage(img, -offset.x / scale, -offset.y / scale, sSize, sSize, 0, 0, OUTPUT, OUTPUT);
    onSave({
      logo: canvas.toDataURL("image/png"),
      original: src,
      crop: { scale, x: offset.x, y: offset.y },
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-a4 bg-gray-a2 p-4">
      <span className="text-caption1 text-gray-11 font-medium">Position &amp; zoom your logo</span>
      <div className="flex items-start gap-4 flex-wrap">
        <div
          className="relative rounded-md overflow-hidden bg-gray-3 touch-none cursor-grab active:cursor-grabbing shrink-0"
          style={{ width: VIEWPORT, height: VIEWPORT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {nat && (
            <img
              src={src}
              alt=""
              draggable={false}
              className="absolute select-none max-w-none"
              style={{ width: nat.w * scale, height: nat.h * scale, left: offset.x, top: offset.y }}
            />
          )}
          <div className="absolute inset-0 ring-1 ring-inset ring-white/10 rounded-md pointer-events-none" />
        </div>

        <div className="flex flex-col gap-3 flex-1 min-w-[180px]">
          <label className="flex flex-col gap-1">
            <span className="text-caption1 text-gray-9">Zoom</span>
            <input
              type="range"
              min={minScale}
              max={minScale * MAX_ZOOM}
              step={(minScale * MAX_ZOOM) / 100}
              value={scale}
              onChange={(e) => onZoom(parseFloat(e.target.value))}
              aria-label="Zoom"
            />
          </label>
          <p className="text-caption2 text-gray-9">
            Drag the image to reposition. The square area is what gets saved.
          </p>
          <div className="flex items-center gap-2 mt-1">
            <Button variant="accent" size="small" onClick={save}>
              Save logo
            </Button>
            <Button variant="transparent" size="small" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
