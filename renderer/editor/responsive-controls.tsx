// Configuring how an object behaves when the window is not the design's shape.
//
// A model nothing can configure is a model nobody uses — this redesign has
// already produced three helpers that were written, tested, and reachable from
// no UI. These are the controls for renderer/main/responsive-layout.ts.

import { PinIcon } from "lucide-react";
import { Switch, InfoHint, NumberInput as UiNumberInput } from "../components/ui";
import { cn } from "../lib/cn";

type AnchorX = "left" | "right" | "center";
type AnchorY = "top" | "bottom" | "center";
export interface ResponsiveSettings {
  anchor?: { x?: AnchorX; y?: AnchorY };
  keepAspect?: boolean;
  minPx?: { w?: number; h?: number };
  maxPx?: { w?: number; h?: number };
}

const XS: AnchorX[] = ["left", "center", "right"];
const YS: AnchorY[] = ["top", "center", "bottom"];

/**
 * The nine-cell pin grid.
 *
 * A picture rather than two dropdowns: which edges are pinned is spatial
 * information, and a 3x3 grid is read at a glance where "x: right, y: bottom"
 * has to be translated.
 */
function PinGrid({
  value,
  onChange,
}: {
  value: { x?: AnchorX; y?: AnchorY } | undefined;
  onChange: (a: { x?: AnchorX; y?: AnchorY }) => void;
}) {
  const x = value?.x, y = value?.y;
  return (
    <div
      // shrink-0, and it is load-bearing. The hint beside this grid gets LONGER
      // the moment a cell is pinned — "Unpinned: scales with the window." becomes
      // "Holds its distance from that corner instead of drifting." — and as a
      // shrinkable flex item the grid gave up its width to make room, so clicking
      // a pin squashed the very control you had just clicked.
      className="inline-grid shrink-0 grid-cols-3 gap-0.5 rounded-md border border-line p-0.5"
      role="group"
      aria-label="Pin to edges"
    >
      {YS.map((ry) =>
        XS.map((rx) => {
          const on = x === rx && y === ry;
          const label = `Pin ${ry} ${rx}`;
          return (
            <button
              key={`${rx}-${ry}`}
              type="button"
              aria-label={label}
              aria-pressed={on}
              title={label}
              onClick={() =>
                // Clicking the active cell clears the pin, so there is a way back
                // to proportional without hunting for a reset.
                on ? onChange({}) : onChange({ x: rx, y: ry })
              }
              className={cn(
                "size-5 rounded-sm transition-colors",
                on ? "bg-accent" : "bg-fill hover:bg-fill-strong",
              )}
            />
          );
        }),
      )}
    </div>
  );
}

export function ResponsiveControls({
  settings,
  onChange,
}: {
  settings: ResponsiveSettings;
  onChange: (patch: ResponsiveSettings) => void;
}) {
  const anchored = !!(settings.anchor?.x || settings.anchor?.y);

  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 text-caption2 text-fg-muted">
        <PinIcon className="size-3" />
        On other window shapes
        <InfoHint className="shrink-0">
          How this object behaves when the window is not the shape you designed
          for. Everything here is off by default, and off means it scales with
          the window exactly as it always has.
        </InfoHint>
      </span>

      <div className="flex items-start gap-3">
        <PinGrid value={settings.anchor} onChange={(anchor) => onChange({ anchor })} />
        {/* min-w-0 so the sentence wraps instead of pushing at the grid. */}
        <span className="min-w-0 text-caption2 text-fg-subtle">
          {anchored
            ? "Holds its distance from that corner instead of drifting."
            : "Unpinned: scales with the window."}
        </span>
      </div>

      <label className="flex items-center justify-between gap-2">
        <span className="text-footnote text-fg">Keep its shape</span>
        <Switch
          checked={settings.keepAspect ?? false}
          onCheckedChange={(v: boolean) => onChange({ keepAspect: v })}
          aria-label="Keep its shape"
        />
      </label>

      {/* Real pixels, not fractions: the point of a limit is that it does not
          scale. A button below about 44px is not reliably tappable. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <label className="flex items-center justify-between gap-2">
          <span className="text-caption2 text-fg-muted">Min width</span>
          <UiNumberInput
            value={settings.minPx?.w ?? 0}
            min={0}
            max={4000}
            step={4}
            onChange={(v: number) => onChange({ minPx: { ...settings.minPx, w: v || undefined } })}
            aria-label="Minimum width in pixels"
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-caption2 text-fg-muted">Max width</span>
          <UiNumberInput
            value={settings.maxPx?.w ?? 0}
            min={0}
            max={4000}
            step={4}
            onChange={(v: number) => onChange({ maxPx: { ...settings.maxPx, w: v || undefined } })}
            aria-label="Maximum width in pixels"
          />
        </label>
      </div>
    </div>
  );
}
