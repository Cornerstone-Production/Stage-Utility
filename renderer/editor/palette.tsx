// The widget palette: every object as a card you can drag onto the canvas.
//
// A SECOND door, not a replacement. The Add-object dropdown in the toolbar keeps
// working exactly as it did, and so do dragging, resizing and marquee selection.
// The palette exists because a dropdown of 41 names in 13 groups is a list you
// read, and a wall of cards with a line of description each is something you
// browse — different jobs, and an operator who knows what they want should not
// have to browse.
//
// Icons and accents live here rather than on the object spec: they are how the
// palette PRESENTS a type, not part of what the type is. The spec carries the
// label, group and blurb, which every surface needs.

import {
  BoxIcon, SquareIcon, ImageIcon, SparklesIcon, TypeIcon, ClockIcon, TimerIcon,
  TagIcon, ListIcon, ListOrderedIcon, GaugeIcon, PaperclipIcon, MonitorIcon,
  CaptionsIcon, FileTextIcon, ImagePlayIcon, PercentIcon, LayoutGridIcon,
  RadioIcon, SignalIcon, BatteryChargingIcon, AudioLinesIcon, MicIcon,
  UsersIcon, TrendingUpIcon, LayoutPanelTopIcon, DropletIcon, VideoIcon,
  DiscIcon, CircleDotIcon, PlugIcon, SendIcon, TvIcon, ZapIcon,
  SkipForwardIcon, StickyNoteIcon, CheckSquareIcon, FrameIcon, CastIcon,
  type LucideIcon,
} from "lucide-react";

import { LAYOUT_OBJECTS, PALETTE_GROUP_ORDER, type PaletteGroup } from "../main/layout-objects";
import { cn } from "../lib/cn";

/** Icon per type. A full Record so a new object cannot appear as a blank tile. */
const ICONS: Record<LayoutObjectType, LucideIcon> = {
  container: BoxIcon,
  shape: SquareIcon,
  image: ImageIcon,
  "brand-logo": SparklesIcon,
  text: TypeIcon,
  clock: ClockIcon,
  "countdown-timer": TimerIcon,
  "section-chip": TagIcon,
  "current-service-item": ListIcon,
  "next-service-item": SkipForwardIcon,
  "service-order": ListOrderedIcon,
  "service-pacing": GaugeIcon,
  "plan-attachment": PaperclipIcon,
  "pp-timer": TimerIcon,
  "current-slide-text": MonitorIcon,
  "next-slide-text": CaptionsIcon,
  "current-slide-notes": FileTextIcon,
  "slide-thumbnail": ImagePlayIcon,
  "slide-progress": PercentIcon,
  "slots-grid": LayoutGridIcon,
  "wireless-channel": RadioIcon,
  "wireless-summary": SignalIcon,
  "charger-battery": BatteryChargingIcon,
  "spl-meter": AudioLinesIcon,
  "transcript-strip": MicIcon,
  "people-counter": UsersIcon,
  "people-graph": TrendingUpIcon,
  "people-panel": LayoutPanelTopIcon,
  "baptism-timer": DropletIcon,
  "obs-status": VideoIcon,
  "reaper-status": DiscIcon,
  "record-status": CircleDotIcon,
  "integration-status": PlugIcon,
  "osc-button": SendIcon,
  "rosstalk-button": TvIcon,
  "action-button": ZapIcon,
  "live-controls": SkipForwardIcon,
  notes: StickyNoteIcon,
  checklist: CheckSquareIcon,
  "view-embed": FrameIcon,
  "ndi-video": CastIcon,
  "home-readiness": CheckSquareIcon,
  "home-next-service": ListIcon,
};

/**
 * Accent per GROUP, not per type.
 *
 * Thirteen colours to maintain rather than forty-one, and the colour means
 * something: it is the group. This is editor chrome — it tints the icon tile so
 * a type can be found in a long list. It never reaches a display, where the cull
 * left widgets with a plain outline and no colour at all.
 */
const GROUP_ACCENT: Record<PaletteGroup, string> = {
  Layout: "var(--gray-9)",
  "Text & time": "var(--amber-9)",
  "PCO / service": "var(--green-9)",
  ProPresenter: "var(--blue-9)",
  "Mics & RF": "var(--red-9)",
  "Audio (SPL)": "var(--red-9)",
  Transcription: "var(--blue-9)",
  People: "var(--green-9)",
  Baptisms: "var(--blue-9)",
  OBS: "var(--gray-9)",
  REAPER: "var(--gray-9)",
  Control: "var(--amber-9)",
  Status: "var(--gray-9)",
};

export interface PaletteProps {
  /** Types to offer. The caller filters (hide-unconfigured, superseded types). */
  types: LayoutObjectType[];
  /** Adding by click, for anyone who would rather not drag. */
  onAdd: (t: LayoutObjectType) => void;
  /** A drag has begun; the canvas listens for the drop. */
  onDragStart: (t: LayoutObjectType) => void;
  onDragEnd: () => void;
  /** Types whose integration is not set up — dimmed, still usable. */
  dimmed?: Set<LayoutObjectType>;
  /** Hide types whose integration is not set up. Lives here rather than on the
   *  toolbar: a filter belongs beside the list it filters, and the toolbar had
   *  three controls all answering "what can I add?". */
  hideUnconfigured?: boolean;
  onToggleHideUnconfigured?: () => void;
}

export function Palette({ types, onAdd, onDragStart, onDragEnd, dimmed, hideUnconfigured, onToggleHideUnconfigured }: PaletteProps) {
  const byGroup = PALETTE_GROUP_ORDER.map((g) => ({
    group: g,
    items: types.filter((t) => LAYOUT_OBJECTS[t]?.group === g),
  })).filter((s) => s.items.length > 0);

  if (byGroup.length === 0) {
    return (
      <p className="p-3 text-caption2 text-fg-subtle">
        Nothing matches the current filter.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 p-1">
      {onToggleHideUnconfigured && (
        <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-caption2 text-fg-muted">
          <input
            type="checkbox"
            checked={hideUnconfigured ?? false}
            onChange={onToggleHideUnconfigured}
            className="size-3.5 accent-[var(--su-accent)]"
          />
          Hide widgets whose integration is not set up
        </label>
      )}
      {byGroup.map(({ group, items }) => (
        <div key={group}>
          <p className="px-2 pb-1 pt-2 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            {group}
          </p>
          {items.map((t) => {
            const spec = LAYOUT_OBJECTS[t];
            const Icon = ICONS[t];
            return (
              <button
                key={t}
                type="button"
                draggable
                // Click adds, drag places. Both reach the same code, so a
                // keyboard user is not stuck with a gesture they cannot make.
                onClick={() => onAdd(t)}
                onDragStart={(e) => {
                  // Firefox refuses to start a drag without data on the transfer.
                  e.dataTransfer.setData("text/plain", t);
                  e.dataTransfer.effectAllowed = "copy";
                  onDragStart(t);
                }}
                onDragEnd={onDragEnd}
                title={spec.blurb}
                className={cn(
                  "flex w-full cursor-grab items-start gap-2.5 rounded-md px-2 py-1.5 text-left",
                  "transition-colors duration-(--motion-instant) hover:bg-fill active:cursor-grabbing",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                  dimmed?.has(t) && "opacity-50",
                )}
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md"
                  style={{
                    background: `color-mix(in srgb, ${GROUP_ACCENT[spec.group ?? "Layout"]} 18%, transparent)`,
                    color: GROUP_ACCENT[spec.group ?? "Layout"],
                  }}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-footnote font-medium leading-tight text-fg">
                    {spec.label}
                  </span>
                  <span className="block text-caption2 leading-snug text-fg-subtle">
                    {spec.blurb}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
