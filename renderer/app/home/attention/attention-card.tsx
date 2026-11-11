// Home's Needs attention: what is wrong right now, each problem one tap from its
// fix, and everything fine folded into one line.
//
// The card is a fixed box, on Home and on a layout alike: it never scrolls and
// never draws one thing over another. It measures the box it is in and shows as
// many WHOLE rows as fit, then "+N more"; the healthy line sits on its own line
// beneath, or drops out when there is no room; buttons shrink and then go as the
// box narrows; text truncates. See fit.ts for the arithmetic.

import { useContext, useState, type ReactNode, type SyntheticEvent } from "react";

import { AppLink } from "../../app-link";
import { flashTarget } from "../../flash";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/cn";
import { useElementSize } from "../../../lib/use-element-size";
import { useExpand } from "../../../main/expand-overlay";
import { pressCommand } from "../../../lib/command-answer";
import { errorMessage } from "@main/services/errors";
import type { HomeSnooze } from "@main/types/home-snoozes";
import { HomeEditing } from "../home-editing";
import { homeMode } from "../home-mode";
import { useTransientNote } from "../card-actions";
import { collectAttention } from "./collect";
import { anySourceKnown, healthyLine } from "./healthy";
import { RANK, partitionSnoozed } from "./snooze";
import type { AttentionFix, AttentionInput, AttentionItem } from "./types";
import {
  CLEAR_CAPTION_MIN_PX, CLEAR_HEALTHY_MIN_PX, CLEAR_TOGGLE_MIN_PX, HEADER_PX, MORE_PX, ROW_PX, STRIP_PX,
  buttonSize, buttonsFor, fitAttention, roomFor, type RowButtons,
} from "./fit";
import { useAttentionInput } from "./use-attention";
import { snoozeItem, thenRefresh, unsnoozeItem, useHomeSnoozes } from "./use-home-snoozes";

const DOT = { critical: "bg-danger-9", warn: "bg-warn-9" } as const;

function FixButton({ fix, onFailed, size }: { fix: AttentionFix; onFailed: (why: string) => void; size: "medium" | "small" }) {
  const [busy, setBusy] = useState(false);
  if (fix.route) {
    return (
      <Button asChild variant="accent" size={size}>
        <AppLink to={fix.route} onClick={() => fix.flash && flashTarget(fix.flash)}>
          {fix.label}
        </AppLink>
      </Button>
    );
  }
  const command = fix.command;
  return (
    <Button
      variant="accent"
      size={size}
      disabled={busy || !command}
      onClick={() => {
        if (!command) return;
        setBusy(true);
        void pressCommand(command).then((said) => {
          if (said !== null) onFailed(said);
          setBusy(false);
        });
      }}
    >
      {busy ? "Working…" : fix.label}
    </Button>
  );
}

/** One row, problem or snoozed, at the ONE height fit.ts counts a row as. Every
 *  row goes through this, so the arithmetic and the markup cannot disagree. */
function RowFrame({ children }: { children: ReactNode }) {
  return (
    <li
      className="flex items-center gap-3 overflow-hidden border-t border-line px-4 first:border-t-0"
      style={{ height: ROW_PX }}
    >
      {children}
    </li>
  );
}

function Row({
  item,
  buttons,
  onSnooze,
  onFailed,
}: {
  item: AttentionItem;
  /** "none" off Home: a wall or console draws the problem and nothing to press. */
  buttons: RowButtons;
  onSnooze: () => void;
  onFailed: (why: string) => void;
}) {
  const size = buttonSize(buttons);
  return (
    <RowFrame>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[item.severity])} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-fg">{item.title}</span>
        <span className="block truncate text-caption1 text-fg-subtle">{item.detail}</span>
      </span>
      {(buttons === "full" || buttons === "compact") && (
        <Button variant="filled" size={size} onClick={onSnooze} aria-label={`Snooze ${item.title}`}>
          Snooze
        </Button>
      )}
      {buttons !== "none" && <FixButton fix={item.fix} onFailed={onFailed} size={size} />}
    </RowFrame>
  );
}

function SnoozedRow({ item, buttons, onUnsnooze }: { item: AttentionItem; buttons: RowButtons; onUnsnooze: () => void }) {
  return (
    <RowFrame>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-fg-subtle" />
      <span className="min-w-0 flex-1 truncate text-body text-fg-muted">{item.title}</span>
      {buttons !== "none" && (
        <Button variant="filled" size={buttonSize(buttons)} onClick={onUnsnooze} aria-label={`Unsnooze ${item.title}`}>
          Unsnooze
        </Button>
      )}
    </RowFrame>
  );
}

/** A failed action, in words, on one line that ends in an ellipsis. `className`
 *  places it: it stands in for a line that is already there, so it never adds one. */
function FailureNote({ note, className }: { note: string; className: string }) {
  return (
    <p role="alert" className={cn("min-w-0 truncate text-danger-11", className)}>
      {note}
    </p>
  );
}

/** The healthy entries, on ONE line that ends in an ellipsis rather than wrapping
 *  into whatever is beneath it. */
function HealthyDots({ healthy, className }: { healthy: readonly string[]; className?: string }) {
  if (healthy.length === 0) return null;
  return (
    <span className={cn("min-w-0 flex-1 truncate", className)}>
      {healthy.map((h) => (
        <span key={h} className="mr-4 inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-live-9" />
          {h}
        </span>
      ))}
    </span>
  );
}

function SnoozedToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="ml-auto shrink-0 whitespace-nowrap text-caption1 text-fg-muted underline-offset-2 hover:text-fg hover:underline"
    >
      {open ? "Hide snoozed" : `Show ${count} snoozed`}
    </button>
  );
}

/** The widget, over an input already assembled. Split from the hooks so a test can draw any state. */
export function AttentionView({
  input,
  snoozes,
  snoozesKnown = true,
  interactive,
  onSnooze,
  onUnsnooze,
}: {
  input: AttentionInput;
  snoozes: readonly HomeSnooze[];
  /** Whether Home's snooze list has answered. Until it has, nothing is shown as a
   *  problem: a snoozed item would flash (red edge and all) before it is hidden. */
  snoozesKnown?: boolean;
  /** Home's own page, where controls fire. On a wall or console the card is
   *  wrapped in pointer-events-none, so a button there would only be a lie:
   *  rows draw without Snooze, a fix or Show snoozed. */
  interactive: boolean;
  onSnooze: (item: AttentionItem) => Promise<unknown>;
  onUnsnooze: (key: string) => Promise<unknown>;
}) {
  // The snoozed list, when open: every item's key and how bad it was as it opened.
  const [openedOver, setOpenedOver] = useState<ReadonlyMap<string, number> | null>(null);
  // The overlay's own toggle: opening the snoozed list there must not change what
  // the card behind it shows.
  const [overlaySnoozed, setOverlaySnoozed] = useState(false);
  // The same overlay the Screens card opens (main/expand-overlay.tsx), opened from
  // "+N more" instead of a corner button. Gated as ExpandableTile gates it:
  // interactive surfaces only, so a wall gets a plain count as it gets no expand
  // control on any card, and not while Home is being arranged. The section is
  // the tile, so the panel grows out of the card as Screens' does.
  const editing = useContext(HomeEditing);
  const expandable = interactive && !editing;
  const { tileRef, overlay, open, controlRef } = useExpand<HTMLElement>(expandable);
  // 0x0 until measured, which fit.ts reads as "not measured": a default, not nothing.
  const size = useElementSize(tileRef);
  // A failure, a fix's or a snooze's, clears itself as a failed Start does on the
  // recording tile. It is drawn in the header line, never on a line of its own:
  // a box with room for one row has none to spare, and a note that took a row's
  // place hid the row and "+N more" until something else succeeded.
  const [note, showNote] = useTransientNote();

  const items = collectAttention(input);
  const { shown, snoozed } = snoozesKnown ? partitionSnoozed(items, snoozes) : { shown: [], snoozed: [] };
  const checking = !snoozesKnown || !anySourceKnown(input);
  const healthy = healthyLine(input, items);

  const buttons: RowButtons = interactive ? buttonsFor(size.w) : "none";
  // A problem ARRIVING closes the snoozed list: a look at what was put aside must
  // not hide a fresh problem behind it with only the ring to say it is there.
  // Arriving is a problem shown now that is new since the list opened, or worse
  // than it was then: a showing warn that turned critical, or a snoozed one that
  // got worse than its snooze (which can only be up). An Unsnooze brings a row
  // back no worse than it was, so it is not arriving and the list stays open.
  // Nothing left snoozed closes the list too, so it cannot spring open by itself
  // the next time something is snoozed. Adjusted during render, as useExpand
  // closes its panel.
  const arrived = (i: AttentionItem) => {
    const was = openedOver?.get(i.key);
    return was === undefined || RANK[i.severity] > was;
  };
  const stale = openedOver !== null && (snoozed.length === 0 || shown.some(arrived));
  if (stale) setOpenedOver(null);
  const toggleSnoozed = () =>
    setOpenedOver((o) => (o ? null : new Map(items.map((i) => [i.key, RANK[i.severity]]))));
  // OPEN, the snoozed list REPLACES the problems rather than joining them. One
  // list and one budget: appended after the problems it was the first thing a
  // full box cut, so "Show 1 snoozed" opened nothing. Its Hide is in the header,
  // the one part drawn at every height: in the strip, a box with no room for the
  // strip beside a row left the list open with no way back.
  const snoozedOpen = interactive && openedOver !== null && !stale && snoozed.length > 0;
  const rowsWanted = snoozedOpen ? snoozed.length : shown.length;
  const wantStrip = healthy.length > 0 || (interactive && snoozed.length > 0 && !snoozedOpen);
  const fit = fitAttention(size.h, rowsWanted, wantStrip);
  const visibleShown = snoozedOpen ? [] : shown.slice(0, fit.rows);
  const visibleSnoozed = snoozedOpen ? snoozed.slice(0, fit.rows) : [];
  const hidden = rowsWanted - fit.rows;
  const worst = shown.some((i) => i.severity === "critical") ? "critical" : "warn";
  const listed = shown.length > 0 || snoozedOpen;

  // The overlay opens on what the card was showing: "+N more" under the snoozed
  // list is a count of snoozed rows, and opening onto the problems with the
  // snoozed list collapsed showed none of them.
  const openFull = () => {
    setOverlaySnoozed(snoozedOpen);
    open();
  };

  const run = (p: Promise<unknown>, what: string) =>
    p.catch((err: unknown) => showNote(`Could not ${what}: ${errorMessage(err)}`));

  const renderRow = (item: AttentionItem, at: RowButtons) => (
    <Row
      key={item.key}
      item={item}
      buttons={at}
      onSnooze={() => void run(onSnooze(item), `snooze ${item.title}`)}
      onFailed={(why) => showNote(`${item.fix.label} failed: ${why}`)}
    />
  );
  const snoozedRow = (item: AttentionItem, at: RowButtons) => (
    <SnoozedRow
      key={item.key}
      item={item}
      buttons={at}
      onUnsnooze={() => void run(onUnsnooze(item.key), `unsnooze ${item.title}`)}
    />
  );

  // A portal's events still bubble through the React tree, so a press inside the
  // overlay would reach Home's card wrapper (its long-press and right-click menu).
  // The DOM says where the event really was; see Expandable in expandable-tile.tsx.
  const keepInPanel = (e: SyntheticEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.target as Node)) e.stopPropagation();
  };

  // EVERY problem at full size, and the snoozed list: the overlay is not a widget
  // box, so it scrolls and nothing is cut.
  const fullList = () => (
    <div className="h-full overflow-y-auto">
      <ul>{shown.map((item) => renderRow(item, "full"))}</ul>
      {note && (
        <p role="alert" className="border-t border-line px-4 py-2 text-caption1 text-danger-11">
          {note}
        </p>
      )}
      {snoozed.length > 0 && (
        <div className="border-t border-line px-4 py-2 text-footnote">
          <SnoozedToggle count={snoozed.length} open={overlaySnoozed} onToggle={() => setOverlaySnoozed((v) => !v)} />
        </div>
      )}
      {overlaySnoozed && snoozed.length > 0 && (
        <ul className="border-t border-line">{snoozed.map((item) => snoozedRow(item, "full"))}</ul>
      )}
    </div>
  );

  // The box is `overflow-hidden` and every part below has the fixed height fit.ts
  // counted, so nothing scrolls and nothing can be drawn over anything else.
  return (
    <section
      ref={tileRef}
      aria-label="Needs attention"
      className="relative flex h-full w-full flex-col overflow-hidden"
      data-attention={shown.length > 0 ? worst : "clear"}
      onPointerDown={keepInPanel}
      onPointerMove={keepInPanel}
      onPointerUp={keepInPanel}
      onPointerCancel={keepInPanel}
      onContextMenu={keepInPanel}
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
      {listed && (
        <>
          <div className="flex shrink-0 items-center gap-2 overflow-hidden px-4" style={{ height: HEADER_PX }}>
            <h2
              className={cn(
                "flex min-w-0 items-center gap-2 whitespace-nowrap text-caption2 font-semibold uppercase tracking-wider text-fg-subtle",
                // While a note is showing it takes the title's place; the count
                // is still in the rows and "+N more" beneath.
                note && "sr-only",
              )}
            >
              {snoozedOpen ? (
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-fg-subtle" />
              ) : (
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[worst])} />
              )}
              <span className="truncate">
                {snoozedOpen ? `Snoozed · ${snoozed.length}` : `Needs attention · ${shown.length}`}
              </span>
            </h2>
            {note && <FailureNote note={note} className="flex-1 text-caption1" />}
            {snoozedOpen && <SnoozedToggle count={snoozed.length} open onToggle={toggleSnoozed} />}
          </div>
          <ul className="shrink-0">
            {visibleShown.map((item) => renderRow(item, buttons))}
            {visibleSnoozed.map((item) => snoozedRow(item, buttons))}
          </ul>
        </>
      )}
      {!listed && (
        // All clear: a tile in its own right, captioned and headlined the way the
        // cards beside it are, with what is healthy beneath as the line of dots.
        // A box too short for all three drops the line, then the caption.
        <div
          className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden px-4"
        >
          {roomFor(size.h, CLEAR_CAPTION_MIN_PX) && (
            <h2 className={cn("truncate text-caption2 font-semibold uppercase tracking-wider text-fg-subtle", note && "sr-only")}>
              Needs attention
            </h2>
          )}
          {/* In the caption's place and at its type size, so the tile does not move
              while it shows; a box with no room for the caption has none for it
              either, and only a screen reader hears it there. */}
          {note && (
            <FailureNote note={note} className={roomFor(size.h, CLEAR_CAPTION_MIN_PX) ? "text-caption2" : "sr-only"} />
          )}
          <p className="mt-0.5 flex items-center gap-2 text-title2 font-medium text-fg">
            {!checking && <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-live-9" />}
            <span className="truncate">{checking ? "Checking…" : "All clear"}</span>
          </p>
          {roomFor(size.h, CLEAR_HEALTHY_MIN_PX) && healthy.length > 0 && (
            <p className="mt-1.5 flex text-footnote text-fg-muted">
              <HealthyDots healthy={healthy} />
            </p>
          )}
          {interactive && snoozed.length > 0 && roomFor(size.h, CLEAR_TOGGLE_MIN_PX) && (
            <div className="flex">
              <SnoozedToggle count={snoozed.length} open={false} onToggle={toggleSnoozed} />
            </div>
          )}
        </div>
      )}
      {hidden > 0 && fit.rows > 0 && (
        expandable ? (
          <button
            ref={controlRef}
            type="button"
            onClick={openFull}
            aria-haspopup="dialog"
            className="flex w-full shrink-0 items-center border-t border-line px-4 text-left text-caption1 text-fg-muted hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            style={{ height: MORE_PX }}
          >
            +{hidden} more
          </button>
        ) : (
          <p
            className="flex shrink-0 items-center border-t border-line px-4 text-caption1 text-fg-subtle"
            style={{ height: MORE_PX }}
          >
            +{hidden} more
          </p>
        )
      )}

      {listed && fit.strip && (
        // The healthy line, on a line of its own at the foot of the box. It is a
        // row of the budget, not an overlay: fit.ts only keeps it when it fits.
        <div
          className="mt-auto flex shrink-0 items-center gap-x-4 overflow-hidden whitespace-nowrap border-t border-line bg-fill/50 px-4 text-footnote text-fg-muted"
          style={{ height: STRIP_PX }}
        >
          <HealthyDots healthy={healthy} />
          {healthy.length > 0 && <span className="shrink-0 text-fg-subtle">all else healthy</span>}
          {interactive && snoozed.length > 0 && !snoozedOpen && (
            <SnoozedToggle count={snoozed.length} open={false} onToggle={toggleSnoozed} />
          )}
        </div>
      )}
      {overlay(fullList, "Needs attention")}
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
      snoozesKnown={snoozes.known}
      interactive={interactive}
      onSnooze={(item) => thenRefresh(snoozeItem(item.key, item.severity), snoozes.refresh)}
      onUnsnooze={(key) => thenRefresh(unsnoozeItem(key), snoozes.refresh)}
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
