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
  onSnooze,
  onFailed,
}: {
  item: AttentionItem;
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
      <Button variant="filled" onClick={onSnooze} aria-label={`Snooze ${item.title}`}>
        Snooze
      </Button>
      <FixButton fix={item.fix} onFailed={onFailed} />
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

/** The widget, over an input already assembled. Split from the hooks so a test can draw any state. */
export function AttentionView({
  input,
  snoozes,
  onSnooze,
  onUnsnooze,
}: {
  input: AttentionInput;
  snoozes: readonly import("@main/types/home-snoozes").HomeSnooze[];
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

  const visible = expanded ? shown : shown.slice(0, limit);
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
                onSnooze={() => void run(onSnooze(item), "snooze that")}
                onFailed={(why) => setFailure(`${item.fix.label} failed: ${why}`)}
              />
            ))}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full border-t border-line px-4 py-1.5 text-left text-caption1 text-fg-muted hover:bg-fill"
            >
              +{hidden} more
            </button>
          )}
          {expanded && shown.length > limit && (
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

      {/* Pinned to the foot of the tile: where the list is longer than the tile,
          it scrolls beneath this, and the healthy line (and the Show snoozed
          switch) are never the part that is clipped. The opaque ground is the
          tile's own, so the rows do not show through the tint above it. */}
      <div className="sticky bottom-0 bg-surface">
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-footnote text-fg-muted",
          shown.length > 0 && "border-t border-line bg-fill/50",
        )}
      >
        {healthy.length === 0 && shown.length === 0 && snoozed.length === 0 && <span>Checking…</span>}
        {healthy.map((h) => (
          <span key={h} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-live-9" />
            {h}
          </span>
        ))}
        {healthy.length > 0 && (
          <span className="ml-auto text-fg-subtle">
            {shown.length > 0 ? "all else healthy" : "nothing needs attention"}
          </span>
        )}
        {snoozed.length > 0 && (
          <button
            type="button"
            onClick={() => setShowSnoozed((v) => !v)}
            aria-expanded={showSnoozed}
            className="ml-auto text-caption1 text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          >
            {showSnoozed ? "Hide snoozed" : `Show ${snoozed.length} snoozed`}
          </button>
        )}
      </div>
      </div>

      {showSnoozed && snoozed.length > 0 && (
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
}: {
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
}: {
  state: StageState;
  now: number;
  pcoLive: PcoLiveDTO | null;
  pcoLiveKnown: boolean;
  secondsToStart: number | null;
}) {
  const mood = homeMode(pcoLiveKnown, pcoLive, secondsToStart);
  if (mood === "unknown") return null;
  return <AttentionBody mood={mood} now={now} state={state} pcoLive={pcoLive} />;
}
