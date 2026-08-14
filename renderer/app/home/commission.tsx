// "Use this screen as a display" — the display picker's actual job.
//
// `/` used to answer "which display is this screen?" for a freshly-pointed
// monitor. Home takes that URL because opening the app happens weekly while
// commissioning a screen happens a few times a year — so the rare case moves
// here, one extra click, and stays discoverable by sitting on the page everyone
// lands on.
//
// What came across from the picker, and why:
//   - the per-display icon tints. They are set from Screens and keyed by
//     display id; dropping them would silently discard a colour an operator
//     chose.
//   - the empty-slot brand mark, which is what a waiting monitor showed.
// What did not: the tool tiles for ScriptView, Baptisms, Patch and History.
// Those are rail destinations now, and a second list of the same links is the
// duplication this redesign exists to remove.

import { ChevronRightIcon, MonitorIcon } from "lucide-react";
import { Collapsible } from "../../components/ui";
import { BrandLogo } from "../../components/brand-logo";

export interface CommissionTarget {
  id: string;
  name: string;
  /** The operator's chosen tint, or the theme accent when they picked none. */
  color: string;
}

/** Pure, so the tint fallback is testable without rendering. */
export function commissionTargets(state: StageState): CommissionTarget[] {
  return (state.outputs ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    color: state.iconColors?.[o.id] || "var(--su-accent)",
  }));
}

export function Commission({ state }: { state: StageState }) {
  const targets = commissionTargets(state);
  const centerLogo = state.emptySlotLogo ?? state.appLogo;

  return (
    <section className="rounded-xl border border-line bg-surface overflow-hidden">
      <Collapsible
        label="Use this screen as a display"
        summary="point a monitor here, then pick which display it is"
        headerClassName="px-4 py-3"
      >
        <div className="flex flex-col items-center gap-5 px-4 pb-5 pt-1">
          {centerLogo && (
            <BrandLogo
              logo={centerLogo}
              monochrome
              className="text-fg-faint shrink-0"
              style={{ width: "clamp(3rem,10vmin,6rem)", height: "clamp(3rem,10vmin,6rem)" }}
            />
          )}

          {targets.length === 0 ? (
            <p className="text-body text-fg-subtle">No displays configured yet.</p>
          ) : (
            <div className="flex flex-col gap-2 w-full max-w-xs">
              <span className="text-caption2 font-medium uppercase tracking-wider text-fg-subtle text-center select-none">
                Select a display
              </span>
              {targets.map((t) => (
                // A full navigation, not a router Link: this turns the browser
                // INTO that display, leaving the operator app behind. That is
                // the whole point of the action.
                <a
                  key={t.id}
                  href={`/${t.id}`}
                  className="flex items-center gap-3 rounded-xl border border-line bg-bg px-4 py-3 transition-colors hover:bg-fill"
                >
                  <MonitorIcon className="size-5 shrink-0" style={{ color: t.color }} />
                  <span className="text-body font-medium text-fg truncate">{t.name}</span>
                  <ChevronRightIcon className="size-4 text-fg-subtle ml-auto shrink-0" />
                </a>
              ))}
            </div>
          )}
        </div>
      </Collapsible>
    </section>
  );
}
