// Home's Needs attention: what is wrong right now, each problem one tap from its
// fix, and everything fine folded into one line.
//
// Home gives a card a tile, not a size to fit, so this lays out from the top and
// lets the tile's own background show below a short list instead of stretching
// over it. At the medium tile the list is three rows and "+N more", which
// expands in place and scrolls inside the tile; the expand overlay on Home
// (spec B) replaces that once it lands.

import { useEffect, useRef, useState } from "react";

import { AppLink } from "../../app-link";
import { flashTarget } from "../../flash";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/cn";
import { invoke } from "../../../lib/api";
import { errorMessage } from "@main/services/errors";
import type { HomeSnooze } from "@main/types/home-snoozes";
import { homeMode } from "../home-mode";
import { collectAttention } from "./collect";
import { healthyLine } from "./healthy";
import { partitionSnoozed } from "./snooze";
import type { AttentionFix, AttentionInput, AttentionItem } from "./types";
import { useAttentionInput } from "./use-attention";
import { snoozeItem, unsnoozeItem, useHomeSnoozes } from "./use-home-snoozes";

/** Rows shown before "+N more", at least. A taller tile shows as many as fit. */
const MIN_ROWS = 3;
/** One row's height, and the header and healthy line around the list, in CSS px. */
const ROW_PX = 52;
const CHROME_PX = 34 + 36;

const DOT = { critical: "bg-danger-9", warn: "bg-warn-9" } as const;

/** How many rows this tile can show without scrolling, watched as it resizes. */
function useRowLimit() {
  const ref = useRef<HTMLElement | null>(null);
  const [fit, setFit] = useState(MIN_ROWS);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setFit(Math.floor((el.clientHeight - CHROME_PX) / ROW_PX));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, limit: Math.max(MIN_ROWS, fit) };
}

function FixButton({ fix, onFailed }: { fix: AttentionFix; onFailed: (why: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (fix.route) {
    return (
      <Button asChild variant="accent">
        <AppLink to={fix.route} onClick={() => fix.flash && flashTarget(fix.flash)}>
          {fix.label}
        </AppLink>
      </Button>
    );
  }
  const action = fix.action;
  return (
    <Button
      variant="accent"
      disabled={busy || !action}
      onClick={() => {
        if (!action) return;
        setBusy(true);
        invoke<{ ok: boolean; detail: string }>("action:invoke", action)
          .then((r) => {
            if (!r.ok) onFailed(r.detail);
          })
          .catch((err: unknown) => onFailed(errorMessage(err)))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Working…" : fix.label}
    </Button>
  );
}

function Row({
  item,
  interactive,
  onSnooze,
  onFailed,
}: {
  item: AttentionItem;
  /** False off Home: a wall or console draws the problem and nothing to press. */
  interactive: boolean;
  onSnooze: () => void;
  onFailed: (why: string) => void;
}) {
  return (
    <li className="flex items-center gap-3 border-t border-line px-4 py-1.5 first:border-t-0">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[item.severity])} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-fg">{item.title}</span>
        <span className="block truncate text-caption1 text-fg-subtle">{item.detail}</span>
      </span>
      {interactive && (
        <>
          <Button variant="filled" onClick={onSnooze} aria-label={`Snooze ${item.title}`}>
            Snooze
          </Button>
          <FixButton fix={item.fix} onFailed={onFailed} />
        </>
      )}
    </li>
  );
}

function SnoozedRow({ item, onUnsnooze }: { item: AttentionItem; onUnsnooze: () => void }) {
  return (
    <li className="flex items-center gap-3 border-t border-line px-4 py-1.5 first:border-t-0">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-fg-subtle" />
      <span className="min-w-0 flex-1 truncate text-body text-fg-muted">{item.title}</span>
      <Button variant="filled" onClick={onUnsnooze} aria-label={`Unsnooze ${item.title}`}>
        Unsnooze
      </Button>
    </li>
  );
}

function HealthyDots({ healthy, bare, className }: { healthy: readonly string[]; bare?: boolean; className?: string }) {
  if (healthy.length === 0) return null;
  const dots = healthy.map((h) => (
    <span key={h} className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-live-9" />
      {h}
    </span>
  ));
  if (bare) return <>{dots}</>;
  return <p className={cn("flex flex-wrap gap-x-4 gap-y-1 text-footnote text-fg-muted", className)}>{dots}</p>;
}

function SnoozedToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="ml-auto text-caption1 text-fg-muted underline-offset-2 hover:text-fg hover:underline"
    >
      {open ? "Hide snoozed" : `Show ${count} snoozed`}
    </button>
  );
}

/** The widget, over an input already assembled. Split from the hooks so a test can draw any state. */
export function AttentionView({
  input,
  snoozes,
  interactive,
  onSnooze,
  onUnsnooze,
}: {
  input: AttentionInput;
  snoozes: readonly HomeSnooze[];
  /** Home's own page, where controls fire. On a wall or console the card is
   *  wrapped in pointer-events-none, so a button there would only be a lie:
   *  rows draw without Snooze, a fix, a "+N more" toggle or Show snoozed. */
  interactive: boolean;
  onSnooze: (item: AttentionItem) => Promise<unknown>;
  onUnsnooze: (key: string) => Promise<unknown>;
}) {
  const { ref, limit } = useRowLimit();
  const [expanded, setExpanded] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const items = collectAttention(input);
  const { shown, snoozed } = partitionSnoozed(items, snoozes);
  const healthy = healthyLine(input, items);

  const visible = expanded && interactive ? shown : shown.slice(0, limit);
  const hidden = shown.length - visible.length;
  const worst = shown.some((i) => i.severity === "critical") ? "critical" : "warn";

  const run = (p: Promise<unknown>, what: string) =>
    p.then(() => setFailure(null)).catch((err: unknown) => setFailure(`Could not ${what}: ${errorMessage(err)}`));

  return (
    <section
      ref={ref}
      aria-label="Needs attention"
      className="relative h-full w-full overflow-y-auto"
      data-attention={shown.length > 0 ? worst : "clear"}
    >
      {shown.length > 0 && (
        // The tile's own frame is Home's to draw; this ring is the mood on top of it.
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 rounded-xl border-2",
            worst === "critical" ? "border-danger-9/70" : "border-warn-9/60",
          )}
        />
      )}
      {shown.length > 0 && (
        <>
          <h2 className="flex items-center gap-2 px-4 pb-1 pt-2.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            <span aria-hidden="true" className={cn("size-2 rounded-full", DOT[worst])} />
            Needs attention · {shown.length}
          </h2>
          <ul>
            {visible.map((item) => (
              <Row
                key={item.key}
                item={item}
                interactive={interactive}
                onSnooze={() => void run(onSnooze(item), "snooze that")}
                onFailed={(why) => setFailure(`${item.fix.label} failed: ${why}`)}
              />
            ))}
          </ul>
          {hidden > 0 && !interactive && (
            <p className="border-t border-line px-4 py-1.5 text-caption1 text-fg-subtle">+{hidden} more</p>
          )}
          {hidden > 0 && interactive && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full border-t border-line px-4 py-1.5 text-left text-caption1 text-fg-muted hover:bg-fill"
            >
              +{hidden} more
            </button>
          )}
          {interactive && expanded && shown.length > limit && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="w-full border-t border-line px-4 py-1.5 text-left text-caption1 text-fg-muted hover:bg-fill"
            >
              Show fewer
            </button>
          )}
        </>
      )}

      {failure && (
        <p role="alert" className="border-t border-line px-4 py-2 text-caption1 text-danger-11">
          {failure}
        </p>
      )}

      {shown.length === 0 ? (
        // All clear: a tile in its own right, captioned and headlined the way the
        // cards beside it are, with what is healthy beneath as the line of dots.
        <div className="flex min-h-full flex-col justify-center px-4 py-3">
          <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">Needs attention</h2>
          <p className="mt-0.5 flex items-center gap-2 text-title2 font-medium text-fg">
            {healthy.length > 0 && <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-live-9" />}
            {healthy.length > 0 ? "All clear" : "Checking…"}
          </p>
          <HealthyDots healthy={healthy} className="mt-1.5" />
          {interactive && snoozed.length > 0 && (
            <SnoozedToggle count={snoozed.length} open={showSnoozed} onToggle={() => setShowSnoozed((v) => !v)} />
          )}
        </div>
      ) : (
        // Pinned to the foot of the tile: where the list is longer than the tile,
        // it scrolls beneath this, so the healthy line is never the part clipped.
        // The opaque ground is the tile's own, so rows do not show through the tint.
        <div className="sticky bottom-0 bg-surface">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-fill/50 px-4 py-2 text-footnote text-fg-muted">
            <HealthyDots healthy={healthy} bare />
            {healthy.length > 0 && <span className="ml-auto text-fg-subtle">all else healthy</span>}
            {interactive && snoozed.length > 0 && (
              <SnoozedToggle count={snoozed.length} open={showSnoozed} onToggle={() => setShowSnoozed((v) => !v)} />
            )}
          </div>
        </div>
      )}

      {interactive && showSnoozed && snoozed.length > 0 && (
        <ul className="border-t border-line">
          {snoozed.map((item) => (
            <SnoozedRow
              key={item.key}
              item={item}
              onUnsnooze={() => void run(onUnsnooze(item.key), "unsnooze that")}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function AttentionBody({
  mood,
  now,
  state,
  pcoLive,
  interactive,
}: {
  interactive: boolean;
  mood: "live" | "idle";
  now: number;
  state: StageState;
  pcoLive: PcoLiveDTO | null;
}) {
  const input = useAttentionInput({ mood, now, state, pcoLive });
  const snoozes = useHomeSnoozes();
  return (
    <AttentionView
      input={input}
      snoozes={snoozes.value?.snoozes ?? []}
      interactive={interactive}
      onSnooze={(item) => snoozeItem(item.key, item.severity).then(snoozes.refresh)}
      onUnsnooze={(key) => unsnoozeItem(key).then(snoozes.refresh)}
    />
  );
}

/**
 * The card. Draws nothing until Home knows its mood: severity depends on it, and
 * a card that guessed would shout "critical" and then correct itself.
 */
export function AttentionCard({
  state,
  now,
  pcoLive,
  pcoLiveKnown,
  secondsToStart,
  interactive,
}: {
  /** True on Home itself; see AttentionView. */
  interactive: boolean;
  state: StageState;
  now: number;
  pcoLive: PcoLiveDTO | null;
  pcoLiveKnown: boolean;
  secondsToStart: number | null;
}) {
  const mood = homeMode(pcoLiveKnown, pcoLive, secondsToStart);
  if (mood === "unknown") return null;
  return <AttentionBody mood={mood} now={now} state={state} pcoLive={pcoLive} interactive={interactive} />;
}
