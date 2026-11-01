// What a Home card shows when it fills the page.
//
// Each body reads the SAME context the tile reads, plus whatever only an open
// panel needs. The second half is subscribed here rather than in useLayoutData:
// a body mounts when the panel opens and unmounts when it closes, so the
// rundown is fetched when somebody asks to see it and not for every Home that
// merely has a timer on it.

import type { ReactNode } from "react";

import type { Output } from "@main/types/views";
import type { PlanItemDTO } from "@main/types/pco";
import type { ServiceTimelineItem } from "@main/types/history";
import type { DeviceStatus } from "@main/types/devices";

import type { LayoutRenderCtx } from "../../../main/layout-renderer";
import { rfBarsGlyph, runtimeText } from "../../../main/layout-renderer";
import { usePlanItemsStatus } from "../../../main/use-plan-items";
import { useServiceTimeline } from "../../../main/use-service-timeline";
import { fmtDuration } from "../../../main/pco-timer";
import { ErrorNote } from "../../../components/ui/error-note";
import { cn } from "../../../lib/cn";
import { splitByPresence } from "../readiness";
import { RecentServicesCard } from "../cards";

export interface BodyProps {
  ctx: LayoutRenderCtx;
}

type Tone = "ok" | "warn" | "bad";

const DOT: Record<Tone, string> = {
  ok: "bg-live-9",
  warn: "bg-warn-9",
  bad: "bg-danger-9",
};

/** A scrollable column of rows. The panel is a fixed box; a long list scrolls
 *  inside it rather than growing past the screen. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-y-auto px-4 py-2">{children}</div>;
}

function Row({
  tone,
  lead,
  title,
  sub,
  trail,
  current = false,
}: {
  tone?: Tone;
  lead?: ReactNode;
  title: string;
  sub?: string | null;
  trail?: ReactNode;
  current?: boolean;
}) {
  return (
    <div
      data-row=""
      aria-current={current ? "true" : undefined}
      className={cn(
        "flex items-center gap-3 border-t border-line px-1 py-2.5 first:border-t-0",
        current && "-mx-3 rounded-md border-transparent bg-accent/10 px-4",
      )}
    >
      {lead != null && <span className="w-10 shrink-0 font-mono text-caption1 tabular-nums text-fg-subtle">{lead}</span>}
      {tone && <span className={cn("size-2 shrink-0 rounded-full", DOT[tone])} aria-hidden />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-callout font-medium">{title}</div>
        {sub && <div className="truncate text-caption1 text-fg-subtle">{sub}</div>}
      </div>
      {trail != null && <span className="shrink-0 font-mono text-callout tabular-nums">{trail}</span>}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-callout text-fg-subtle">{children}</p>;
}

// ── Wireless ────────────────────────────────────────────────────────────────

/** Low enough that somebody has to move: the same line the tile's colour uses. */
const LOW_BATTERY_PCT = 20;

/** One channel, judged. Exported for the test: the rule is what an operator
 *  reads off the dot, and it must not live only inside markup. */
export function wirelessRow(d: DeviceStatus): { tone: Tone; sub: string; trail: string } {
  if (!d.online) return { tone: "warn", sub: "offline", trail: "off" };
  const left = runtimeText(d.batteryMinutes);
  const parts = [
    d.muted === true ? "muted" : null,
    left ? `${left} left` : null,
    d.rfBars != null ? `RF ${rfBarsGlyph(d.rfBars)}` : null,
    d.interference ? "RF interference" : null,
  ].filter((p): p is string => !!p);
  const low = d.battery != null && d.battery < LOW_BATTERY_PCT;
  return {
    tone: low ? "bad" : d.muted === true || d.interference ? "warn" : "ok",
    sub: parts.join("  "),
    trail: d.battery != null ? `${d.battery}%` : "—",
  };
}

export function WirelessBody({ ctx }: BodyProps) {
  if (ctx.wireless.length === 0) return <Empty>No wireless channels reported.</Empty>;
  return (
    <Rows>
      {ctx.wireless.map((d) => {
        const r = wirelessRow(d);
        return <Row key={d.channelId} tone={r.tone} title={d.name ?? d.channelId} sub={r.sub} trail={r.trail} />;
      })}
    </Rows>
  );
}

// ── Screens ─────────────────────────────────────────────────────────────────

export function ScreensBody({ ctx }: BodyProps) {
  const outputs: readonly Output[] = ctx.state.outputs ?? [];
  if (outputs.length === 0) return <Empty>No screens yet.</Empty>;
  const views = ctx.state.views ?? [];
  const online = new Set(splitByPresence(outputs, ctx.onlineOutputIds).online.map((o) => o.id));
  return (
    <Rows>
      {outputs.map((o) => {
        const view = o.viewId ? (views.find((v) => v.id === o.viewId)?.name ?? "Unknown view") : "Nothing routed";
        // Presence has not answered: say nothing about it rather than offline.
        const state = !ctx.onlineKnown ? null : online.has(o.id) ? "online" : "offline";
        return (
          <Row
            key={o.id}
            tone={state === "online" ? "ok" : state === "offline" ? "bad" : undefined}
            title={o.name}
            sub={view}
            trail={state ?? "—"}
          />
        );
      })}
    </Rows>
  );
}

// ── Rundown ─────────────────────────────────────────────────────────────────

/** Planned length the way the rundown prints it. Zero is "unset" in PCO. */
function plannedText(it: PlanItemDTO): string | null {
  return it.lengthSec > 0 ? fmtDuration(it.lengthSec) : null;
}

/** Planned against actual for one item, once it has an actual. */
export function rundownTrail(
  it: PlanItemDTO,
  ran: ServiceTimelineItem | undefined,
  isCurrent: boolean,
): string {
  const planned = plannedText(it);
  if (isCurrent) return planned ? `now · ${planned}` : "now";
  if (ran?.actualDurationSec == null) return planned ?? "";
  const actual = fmtDuration(ran.actualDurationSec);
  return planned ? `${actual} / ${planned}` : actual;
}

export function RundownBody({ ctx }: BodyProps) {
  const plan = usePlanItemsStatus(true);
  const timeline = useServiceTimeline(true);
  if (plan.failed && !plan.value) return <ErrorNote className="m-4">Couldn't load the plan.</ErrorNote>;
  if (!plan.value) return <Empty>{plan.known ? "No service plan." : "Loading the plan."}</Empty>;
  if (plan.value.items.length === 0) return <Empty>No service plan.</Empty>;
  const currentId = ctx.pcoLive?.currentItemId ?? null;
  const ran = new Map((timeline?.items ?? []).map((t) => [t.itemId, t]));
  return (
    <Rows>
      {plan.value.items.map((it) =>
        it.itemType === "header" ? (
          <div key={it.id} className="px-1 pb-1 pt-3 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            {it.title}
          </div>
        ) : (
          <Row
            key={it.id}
            title={it.title}
            current={it.id === currentId}
            trail={rundownTrail(it, ran.get(it.id), it.id === currentId)}
          />
        ),
      )}
    </Rows>
  );
}

// ── Recent services ─────────────────────────────────────────────────────────

/** The same card Home draws, given the whole panel: its chart appears once the
 *  box is tall enough to hold one, so this is the chart with its readout as
 *  History draws it, not a second implementation of it. */
export function AttendanceBody({ ctx }: BodyProps) {
  return <RecentServicesCard state={ctx.state} inPanel />;
}
