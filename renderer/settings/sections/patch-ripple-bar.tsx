import { Switch } from "../../components/ui";
import { cn } from "../../lib/cn";
import type { RippleField, RippleCount } from "../../lib/patch-ripple";

export type Dir = PatchEndpoint["dir"];

export const RIPPLE_COUNTS: RippleCount[] = [2, 4, 6, 8, 10, 12, "end"];

// Which columns can ripple, per direction, and their chip label. Owner is appended
// only for sheets that use ownership bands (see showOwner).
const RIPPLE_FIELDS_IN: { field: RippleField; label: string }[] = [
  { field: "path", label: "From" },
  { field: "consoleChannel", label: "Console" },
  { field: "label", label: "Source" },
  { field: "mic", label: "Mic" },
  { field: "phantom", label: "48V" },
];
const RIPPLE_FIELDS_OUT: { field: RippleField; label: string }[] = [
  { field: "path", label: "To" },
  { field: "consoleChannel", label: "Console" },
  { field: "label", label: "Dest" },
  { field: "feedType", label: "Feed" },
];

export interface RippleState {
  on: boolean;
  count: RippleCount;
  fields: Record<RippleField, boolean>;
}

export const DEFAULT_RIPPLE: RippleState = {
  on: false,
  count: 8,
  fields: { path: true, consoleChannel: true, label: false, mic: false, phantom: false, feedType: false, owner: false },
};

/** The switch that arms ripple. Lives in the editor's second row, not in the table. */
export function RippleSwitch({ ripple, setRipple }: { ripple: RippleState; setRipple: (r: RippleState) => void }) {
  return (
    <label className="flex items-center gap-2 text-caption1 text-fg-muted">
      Ripple
      <Switch aria-label="Ripple" checked={ripple.on} onCheckedChange={(v) => setRipple({ ...ripple, on: v })} />
    </label>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-px text-caption1 tabular-nums transition-colors",
        pressed ? "border-accent bg-accent text-white" : "border-line-strong bg-surface-raised text-fg hover:bg-fill",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The armed-ripple options, drawn across the top of a rack card: how many
 * channels a fill reaches and which columns it fills. `fromRow` names the row
 * the next edit would start from, when focus is in this rack.
 *
 * Sticky within its card, so the options stay in reach down a 48-channel rack.
 * That needs the card to clip with `overflow-clip`, not `overflow-hidden`: the
 * latter makes the card a scroll container and the bar would stick to nothing.
 * `sm:-top-4` cancels the main pane's 16px top padding (sm:pt-4 in shell.tsx),
 * which sticky offsets are measured inside — at `top-0` the rows scroll through
 * that strip, visible above the bar.
 */
export function RippleBar({
  dir,
  ripple,
  setRipple,
  showOwner,
  fromRow,
}: {
  dir: Dir;
  ripple: RippleState;
  setRipple: (r: RippleState) => void;
  showOwner: boolean;
  fromRow: number | null;
}) {
  const base = dir === "in" ? RIPPLE_FIELDS_IN : RIPPLE_FIELDS_OUT;
  const fields = showOwner ? [...base, { field: "owner" as RippleField, label: "Owner" }] : base;
  return (
    <div
      role="group"
      aria-label="Ripple options"
      className="patch-print-hide sticky top-0 z-20 flex sm:-top-4 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-popover))] px-3 py-2 text-caption1 text-fg backdrop-blur-xl"
    >
      <b className="font-semibold">Ripple</b>
      {fromRow != null && <span className="text-fg-muted">from row {fromRow} ·</span>}
      <span className="text-fg-muted">Channels</span>
      {RIPPLE_COUNTS.map((c) => (
        <Chip key={String(c)} pressed={ripple.count === c} onClick={() => setRipple({ ...ripple, count: c })}>
          {c === "end" ? "To end" : c}
        </Chip>
      ))}
      <span className="ml-2 text-fg-muted">Fill</span>
      {fields.map(({ field, label }) => (
        <Chip key={field} pressed={ripple.fields[field]} onClick={() => setRipple({ ...ripple, fields: { ...ripple.fields, [field]: !ripple.fields[field] } })}>
          {label}
        </Chip>
      ))}
    </div>
  );
}
