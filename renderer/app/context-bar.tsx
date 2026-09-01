// Live service state, above every operator surface.
//
// The state is not new - use-dashboard-state already carries it - but until now
// it existed only on whichever View happened to render it, so /patch could not
// tell a service was live. Hoisting it here is what makes separate pages read as
// one program.
//
// The timer maths is NOT reimplemented here. computePcoTimer already mirrors
// PCO's semantics (counts down to the service start pre-service, down each
// item's length while live, negative on overrun, up for an item with no set
// length) and fmtDuration already formats it. The dashboard and the stage
// display use the same pair; a third copy would be a third place for the same
// bug.
//
// WHICH items appear, in what order, and where the left/right split falls are
// all the operator's, and all live in bar-items.ts. This file renders them.
//
// ON A DESKTOP THIS STRIP IS ALSO THE PAGE HEADER. The name of the page sits at
// its head and the route's own controls at its tail, so a desktop page carries
// one band of chrome instead of two. Neither is a bar item and neither is
// configurable — see page-title.tsx for why that distinction is what keeps the
// ladder's promises intact. Below 640px both are hidden and the phone's own top
// bar carries them, exactly as it always has.

import { useEffect, useState } from "react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useDashboardState } from "../main/use-dashboard-state";
import { computePcoTimer, fmtDuration } from "../main/pco-timer";
import { cn } from "../lib/cn";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { ContextMenu, type ContextMenuItem } from "../components/ui/context-menu";
import { BarConfigurator } from "./bar-configurator";
import {
  BAR_PROSE_ITEMS,
  BAR_SPACE,
  BAR_SPACER,
  barRowsFor,
  isProseItem,
  type BarItemId,
  type BarRowId,
} from "./bar-items";
import { useBarFit } from "./bar-fit";
import { useIsMobile } from "../lib/use-media-query";
import { recordIndicator, recorders, streamingStat, streamers } from "./recording-status";
import { useObsState } from "../main/use-obs-state";
import { useReaperState } from "../main/use-reaper-state";
import { useIntegrations } from "../main/use-integration-states";
import { useResiState, useYouTubeState } from "../main/use-stream-state";
import { DisconnectedPopover } from "./disconnected-popover";
import { PageActionsEnd, PageTitle } from "./page-title";
import type { ActivePage } from "./active-page";
import { clockParts } from "../lib/clock-format";
import {
  CalendarIcon,
  CircleDotIcon,
  CircleOffIcon,
  ListIcon,
  PlugZapIcon,
  RadioOffIcon,
  RadioTowerIcon,
  TagIcon,
  UnplugIcon,
  type LucideIcon,
} from "lucide-react";
import { useScoresState } from "../main/use-scores-state";
import {
  ScoreActivityHost,
  ScoreCapsule,
  capsuleView,
  scoredSide,
} from "./score-activity";
import { prefersReducedMotion } from "../lib/use-slide-on-move";

/** Everything an item needs to render. Gathered by `useBarContext`. */
export interface BarItemContext {
  state: StageState | null | undefined;
  bar: ContextBarState;
  now: number;
  obs: ReturnType<typeof useObsState>;
  reaper: ReturnType<typeof useReaperState>;
  integrations: ReturnType<typeof useIntegrations>;
  resi: StreamStatusDTO | null;
  youtube: StreamStatusDTO | null;
  scores: ScoresStatusDTO | null;
  /** True while this is the configurator's inert preview strip. Items that are
   *  interactive in the bar render as plain readings in there. */
  preview?: boolean;
}

export interface ContextBarState {
  isLive: boolean;
  isOver: boolean;
  /** The live item's title, or the pre-service label. */
  itemTitle: string | null;
  /** Formatted countdown, or null when nothing is live. */
  timerText: string | null;
}

/**
 * The bar's derived state. Pure, so it is testable without rendering.
 *
 * `skewMs` is `Date.parse(pcoLive.serverNow) - Date.now()` from the last
 * pco:live - the server sends serverNow for exactly this. A laptop whose clock
 * has drifted otherwise runs a timer that disagrees with the one on the wall.
 */
export function contextBarState(
  pcoLive: PcoLiveDTO | null,
  now: number,
  skewMs: number,
): ContextBarState {
  const timer = computePcoTimer(pcoLive, now, skewMs);
  if (!timer) return { isLive: false, isOver: false, itemTitle: null, timerText: null };
  return {
    // LIVE means an ITEM is running, not merely that there is something to count.
    // This was `true` for any timer at all, so a service two days away — which
    // produces a perfectly good pre-service countdown — lit the green LIVE badge
    // above every page. The bar was simultaneously saying "starts in 2d 0h" and
    // "live", and only one of those can be true.
    isLive: timer.mode === "item",
    isOver: timer.over,
    itemTitle: timer.label,
    timerText: fmtDuration(timer.seconds),
  };
}

/** Everything the items read, gathered once.
 *
 *  A hook rather than props so the configurator's preview can render the SAME
 *  items from the SAME live data — a preview fed placeholder values would not be
 *  a preview of anything. */
export function useBarContext(): BarItemContext {
  const { state, pcoLive } = useDashboardState();
  // Shared with the layout objects that show the same facts - hooks, not
  // components, so a compact strip and a canvas box stay separate presentations.
  const obs = useObsState();
  const reaper = useReaperState();
  const integrations = useIntegrations();
  const resi = useResiState();
  const youtube = useYouTubeState();
  const scores = useScoresState();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    // Cleanup is load-bearing: the operator app is a persistent shell, so an
    // interval that outlives its component runs for the whole service.
    return () => clearInterval(id);
  }, []);

  // Skew between this client and the server, recomputed whenever a pco:live
  // arrives. Same pattern as dashboard-view.tsx.
  const [skewMs, setSkewMs] = useState(0);
  useResyncOn([pcoLive?.serverNow], () => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  });

  const bar = contextBarState(pcoLive, now, skewMs);
  return { state, bar, now, obs, reaper, integrations, resi, youtube, scores };
}

/** The strip's own layout. Shared with the configurator's preview, so a bar that
 *  looks right there looks right above the page.
 *
 *  No bottom rule and no separate surface: it sits on the content background, so
 *  the page reads as one plane rather than a stack of bordered strips.
 *
 *  ONE ROW AT EVERY WIDTH. It used to wrap below 640px and scroll above it, and
 *  both were wrong for the same reason from opposite directions: the wrap spent
 *  a second band of the screen with the least of it to spare, and the scroll put
 *  "6 disconnected" past the right edge — an alert you have to swipe sideways to
 *  find is not an alert. It gives up words instead, in a fixed order, and never
 *  gives up a number. See bar-fit.ts.
 *
 *  The gap and the edge padding live in `.context-strip` rather than in these
 *  utilities because the ladder tightens both at level 2, and a rung that has to
 *  out-specify a Tailwind class to do it is a rung that stops working the day
 *  somebody reorders the class list. */
export const BAR_STRIP_CLASS = "context-strip flex items-center h-11";

/** One item's box in the strip.
 *
 *  shrink-0 on EVERY item. With min-w-0 they squeezed past their own content on
 *  a phone and printed over each other. Prose items opt back into shrinking at
 *  the floor, and only there — see `.bar-prose`. */
/*  items-BASELINE, not items-center. An item mixes sizes — the 11px "LIVE"
 *  beside 13px prose beside a 13px mono timer — and centring aligns their
 *  BOXES, which puts their baselines at `22 + (ascent - descent) / 2`. That
 *  term moves with the font size, so LIVE sat half a pixel above the words
 *  either side of it: one whole device pixel on a Retina screen, and enough
 *  to read as crooked on a strip whose whole job is to be scanned.
 *
 *  Anything with no text of its own has no baseline, and flex would align its
 *  bottom margin edge to the text baseline instead — so the live dot and the
 *  item glyphs centre themselves, which is where they belonged all along. */
export const BAR_ITEM_CLASS = "bar-item flex items-baseline gap-2.5 shrink-0";

/**
 * A flexible space: it draws nothing and eats the slack.
 *
 * It is a flex item at every width now that the bar is always one row. It used
 * to be hidden below 640px, where a wrapped bar gave it a whole line's remainder
 * to eat and it pushed the next item onto a line of its own.
 */
export function BarSpacerEl({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block flex-1", className)} />;
}

/**
 * A fixed gap: a deliberate break between two groups.
 *
 * Geometry lives in styles.css under `.bar-space`, because it needs a sibling
 * selector that a utility class cannot express — see the comment there for why
 * two of them in a row would otherwise fail to add up.
 *
 * Unlike the flexible spacer this DOES show on a wrapped phone bar: it is the
 * same width at any screen size, which is the whole reason to reach for it.
 */
export const BAR_SPACE_CLASS = "bar-space";

export function BarSpaceEl({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block", BAR_SPACE_CLASS, className)} />;
}

/**
 * The rows of a strip, rendered the way the bar renders them.
 *
 * ONE loop, used by the bar itself, by the configurator's off-screen probe, and
 * by anything else that has to lay a strip out. Shared so a probe cannot lay out
 * differently from the bar it speaks for: the fit floor is expressed as
 * `.bar-item:has(> .bar-prose)`, so anything inserted between an item's box and
 * its prose in one copy — even a `display: contents` span, which changes no
 * layout — stops that item being allowed to shrink, and the two copies land on
 * different rungs for the same arrangement. A first pass did exactly that, and
 * the probe reported an arrangement 2px too long that in the real bar fits.
 *
 * `preview` is the only thing the copies ever legitimately differed on: items
 * that are interactive in the bar render as plain readings in the configurator.
 */
export function BarStripRows({
  rows,
  ctx,
  preview = false,
}: {
  rows: readonly BarRowId[];
  ctx: BarItemContext;
  preview?: boolean;
}) {
  const itemCtx = preview ? { ...ctx, preview: true } : ctx;
  return (
    <>
      {rows.map((id, i) => {
        if (id === BAR_SPACER) return <BarSpacerEl key={`${id}-${i}`} />;
        if (id === BAR_SPACE) return <BarSpaceEl key={`${id}-${i}`} />;
        const content = renderBarItem(id, itemCtx);
        // An item that renders nothing is DROPPED, not wrapped in an empty span.
        // The strip is a flex row with a column gap, and gap is charged between
        // items whatever their width — so a zero-width span would leave a doubled
        // gap exactly where the capsule used to be, which is the stray hole this
        // whole change was meant to remove.
        if (content === null) return null;
        return (
          // The name goes on the ITEM's own box, not on a wrapper inside it —
          // see the floor rule above.
          <span
            key={id}
            className={BAR_ITEM_CLASS}
            data-prose={isProseItem(id) ? BAR_PROSE_ITEMS[id] : undefined}
          >
            {content}
          </span>
        );
      })}
    </>
  );
}

/**
 * `active` is PASSED IN, never resolved here.
 *
 * The shell resolves the active page once and hands the same answer to this
 * strip and to the mobile top bar. Two resolutions is precisely how the header
 * and the bar came to disagree about what page you were on — see active-page.ts
 * — and merging them into one row is no reason to make a third.
 */
export function ContextBar({ active }: { active: ActivePage | null }) {
  const ctx = useBarContext();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [configuring, setConfiguring] = useState(false);
  // The phone reads its own set, chosen independently. `useIsMobile` is the
  // app's ONE definition of a phone — the same one the sidebar becomes a drawer
  // at — rather than a second threshold that could disagree with it.
  const isMobile = useIsMobile();
  const { ref: stripRef } = useBarFit<HTMLElement>();

  // Rendered once each, in the operator's order. An item with nothing to report
  // says so rather than vanishing — with ONE deliberate exception, the score
  // capsule, which is invisible unless a followed game is actually in play. See
  // BarItem.canBeEmpty for why that one is different from the other seven.
  //
  // Items used to return null when idle across the board, which was quieter and
  // wrong: the bar reflowed as the state changed. Integration health appeared
  // only once something broke, so its arrival moved everything beside it;
  // between services the whole right-hand group was absent and the bar packed
  // left. An operator cannot learn where to look on a strip that rearranges
  // itself.
  const rows = barRowsFor(ctx.state?.barItems, ctx.state?.barMobileItems, isMobile);

  const menuItems: ContextMenuItem[] = [
    { label: "Configure bar…", onSelect: () => setConfiguring(true) },
  ];

  function openMenu(e: ReactMouseEvent) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  return (
    <>
      <header ref={stripRef} className={cn("shrink-0", BAR_STRIP_CLASS)} onContextMenu={openMenu}>
        {/* FIRST CHILD, so the name sits where the header's h1 sat — the strip's
            20px inset is the same one the header used, so nothing moved
            sideways when the band went. It is also the only shrinkable element
            on the row, which is what makes it the first thing to give way. */}
        <PageTitle active={active} />
        <BarStripRows rows={rows} ctx={ctx} />
        {/* LAST CHILD, so the controls sit at the right edge where the header
            put them. `visibleBarItems` guarantees the rows carry at least one
            flexible spacer, so there is always something between the operator's
            last reading and these. */}
        <PageActionsEnd active={active} />
      </header>

      {/* The panel belongs to the ITEM: a bar without the capsule has no panel to
          grow out of, and mounting it anyway would give the page a document-wide
          pointerdown listener nothing can ever open. */}
      {rows.includes("scores") && (
        <ScoreActivityHost scores={ctx.scores} />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      <BarConfigurator open={configuring} onOpenChange={setConfiguring} />
    </>
  );
}

/**
 * An item with nothing to report.
 *
 * One component so the resting treatment is stated once. It is the thing most
 * likely to be revisited — whether idle should be grey at all was the question
 * this change turned on — and three hand-written copies is three chances for it
 * to end up meaning three different things.
 */
function Idle({ glyph: Glyph, children }: { glyph: LucideIcon; children: ReactNode }) {
  return (
    <>
      {/* The mark that stands in for the word from level 2 down. It is the item's
          OWN icon — the one it answers to in the configurator — when the item is
          set up and resting, and the negated form of that icon when the item has
          nothing to speak for. Two marks per item rather than one, because
          "Off air" and "No stream" are different facts and a rung that meant to
          take a word would have taken the difference. One sentence learns the
          whole vocabulary: the icon means resting, the icon struck through means
          it is not there. */}
      <Glyph aria-hidden="true" className="bar-glyph size-3.5 self-center text-fg-subtle" />
      {/* CLIPPED OUT OF THE LAYOUT, not removed. `display: none` would take the
          word out of the accessibility tree too, and the icon replacing it has
          no accessible name of its own — so a screen reader would lose the
          reading entirely at exactly the width where a sighted reader keeps it. */}
      <span className="bar-drop-2 text-footnote text-fg-subtle">{children}</span>
    </>
  );
}

/**
 * Which integrations the health item speaks for, and which of those are down.
 *
 * Exported because the rule is the whole item: two exclusions, each of which was
 * a bar that complained forever about something that was not wrong.
 *
 *  - NOT SET UP is not disconnected, it is absent. Counting it makes the bar
 *    permanently complain about gear this church does not own.
 *  - INBOUND is not dialable. Companion's module connects to us, so having no
 *    client attached is a listener's resting state — counting it would report a
 *    problem every week nobody plugs in a Stream Deck.
 */
export function integrationHealth(states: readonly IntegrationState[] | undefined): {
  setUp: IntegrationState[];
  down: IntegrationState[];
} {
  const setUp = (states ?? []).filter((i) => i.enabled && i.configured !== false && !i.inbound);
  return { setUp, down: setUp.filter((i) => i.connection === "error" || i.connection === "disconnected") };
}

/**
 * One item's contents. NEVER null: see the loop above.
 *
 * Exported for the guard that holds that promise — the idle branches are easy
 * to drop, and dropping one brings back a bar that rearranges itself.
 */
export function renderBarItem(id: BarItemId, ctx: BarItemContext): ReactNode {
  const { state, bar, now, obs, reaper, integrations, resi, youtube } = ctx;
  switch (id) {
    case "clock": {
      // THE SECONDS ARE THE ONE PLACE THE LADDER TOUCHES DIGITS, and it is worth
      // naming rather than burying: level 1 hides ":55". It is not the same act
      // as hiding a count — the reading survives at lower precision, the way
      // "3d 3h" is already the timer's reading without its minutes — and this
      // strip's clock is wall time, not the instrument anybody times a service
      // with. That is the timer, three items along, which keeps every character
      // at every rung.
      //
      // Split by Intl rather than by cutting the string: in 12h the day period
      // FOLLOWS the seconds, so "3:20:55 PM" is not a prefix plus a suffix.
      const t = clockParts(now, { seconds: true });
      return (
        <span className="text-footnote font-mono tabular-nums text-fg-muted">
          {t.head}
          <span className="bar-drop-1">{t.seconds}</span>
          {t.tail}
        </span>
      );
    }

    case "service-type":
      // IT SURVIVES EVERY RUNG, and that is a deliberate reversal. While this
      // reading lived inside the plan item it was a QUALIFIER of it — the one
      // thing on the strip that is the same every week — so level 1 clipped it
      // and left the plan title behind. That was only ever defensible because
      // nobody had chosen it: it came along with the plan title, and the ladder
      // was shortening one item, not dropping one.
      //
      // As its own item it is something the operator put there. Clipping the
      // only reading it has is dropping it — the row still renders, so the
      // no-reflow guards stay green, but it renders to zero width and the strip
      // still charges it a gap. A hole exactly where a reading used to be, which
      // is the one thing the ladder may never do.
      //
      // So it gives way the way the other prose does, at the floor and only
      // there, with an ellipsis to say a word went. And the operator who wants
      // it gone from a narrow screen has a better instrument than a rung: the
      // phone's own set, which can simply not carry it.
      return state?.serviceTypeName ? (
        <span className="bar-prose text-footnote text-fg-muted truncate">
          {state.serviceTypeName}
        </span>
      ) : (
        <Idle glyph={TagIcon}>No service type</Idle>
      );

    case "plan":
      // Just the plan title now. With no plan loaded this is the same kind of
      // fact as "No item" beside it — a resting reading, not an absence — so it
      // takes the same treatment and becomes the item's own mark at level 2.
      return state?.planTitle ? (
        <span className="bar-prose text-footnote text-fg truncate">{state.planTitle}</span>
      ) : (
        <Idle glyph={CalendarIcon}>No plan</Idle>
      );

    case "current-item":
      // What PCO says is happening NOW, so between services the honest reading
      // is that nothing is — not an absent item.
      return bar.isLive && bar.itemTitle ? (
        <span className="bar-prose text-footnote text-fg-muted truncate max-w-56">
          {bar.itemTitle}
        </span>
      ) : (
        <Idle glyph={ListIcon}>No item</Idle>
      );

    case "live-timer":
      // Always the same three parts — dot, word, time — so the item keeps its
      // shape and only its COLOUR changes. Grey is the resting state; green
      // means a service is running.
      //
      // Idle is deliberately not red. Red on this bar means "act now", and it
      // is already spent on an overrun and on a recorder that has stopped
      // mid-service. Lit every day for a state that is entirely normal, it
      // would stop reading as an alarm on the one morning it is.
      return (
        <>
          <span
            className={cn("size-1.5 shrink-0 self-center rounded-full", bar.isLive ? "bg-live-9" : "bg-fg-faint")}
            aria-hidden="true"
          />
          <span
            aria-hidden="true"
            className={cn(
              // The WORD goes at level 2; the dot beside it does not, and neither
              // does its colour. The dot has always been what says live — the
              // word only ever repeated it, which is why it is affordable here
              // and why nothing is lost when it goes.
              "bar-drop-2 text-caption2 font-medium uppercase tracking-wider",
              bar.isLive ? "text-live-11" : "text-fg-subtle",
            )}
          >
            Live
          </span>
          {/* The word stays "Live" either way and only its COLOUR changes,
              which a screen reader cannot see. So the visible word is hidden
              from it and the state is spelled out instead — not an aria-label
              on the span above, which has no role to hang one off. */}
          <span className="sr-only">{bar.isLive ? "Live" : "Not live"}</span>
          {/* Pre-service, the timer's own label says what it is counting to. */}
          {!bar.isLive && bar.itemTitle && (
            <span className="bar-drop-1 text-footnote text-fg-subtle">{bar.itemTitle}</span>
          )}
          <span
            className={cn(
              "text-footnote font-mono tabular-nums",
              // Overrun stays red whether or not an item is running: a start
              // time that has passed with nothing begun is worth the same look.
              bar.isOver ? "text-danger-11" : bar.isLive ? "text-fg" : "text-fg-subtle",
            )}
          >
            {bar.timerText ?? "—"}
          </span>
        </>
      );

    case "integration-health": {
      const { setUp, down } = integrationHealth(integrations?.states);
      // A count on its own is the least useful place to stop: it says something
      // is wrong mid-service and leaves you to open Integrations and read every
      // card to find out what. Clicking it names them and takes you there.
      if (down.length > 0) return <DisconnectedPopover down={down} labels={integrations?.labels ?? {}} />;
      // Healthy reads grey, not green: the reassurance is that the item is
      // there and NOT red, which is legible at a glance without adding a
      // second colour to a strip whose colours all mean "look here".
      return setUp.length === 0 ? (
        <Idle glyph={UnplugIcon}>No integrations</Idle>
      ) : (
        <Idle glyph={PlugZapIcon}>All connected</Idle>
      );
    }

    case "streaming": {
      // The same judgement Home makes, from the same function — including
      // "connected but not live", which mid-service is the state worth seeing.
      const st = streamingStat(streamers(resi, youtube, obs), now);
      // No tone is streamingStat's "no platform is even connected" — unknown,
      // not off air, and the one streaming state not worth a colour.
      if (!st.tone) return <Idle glyph={RadioOffIcon}>No stream</Idle>;
      // Off air is quiet, not red. It is the state the bar sits in all week, and
      // a red word on a bar that is always on screen stops meaning anything long
      // before the morning it matters. Going out is the thing worth a colour, and
      // it gets the same green the widgets use.
      if (st.tone === "danger") return <Idle glyph={RadioTowerIcon}>Off air</Idle>;
      return <span className="text-footnote font-mono tabular-nums text-live-11">{st.value}</span>;
    }

    case "recording": {
      // The same indicator Home draws, from the same function — including
      // "connected but not rolling", which is the state worth surfacing.
      const ind = recordIndicator(recorders(obs, reaper));
      // Offline is not worth a colour, and neither is standby: it is what the
      // bar sits in all week. Rolling is the thing worth saying, and it gets the
      // green the streaming item beside it uses.
      if (ind.state !== "live") {
        return ind.state === "offline" ? (
          <Idle glyph={CircleOffIcon}>No recorder</Idle>
        ) : (
          <Idle glyph={CircleDotIcon}>Standby</Idle>
        );
      }
      return (
        <span className="text-footnote font-mono tabular-nums text-live-11">{ind.sub ?? ind.value}</span>
      );
    }

    case "scores": {
      // THE ONE ITEM THAT MAY RENDER NOTHING. Every other case above ends in a
      // reading; this one ends in null when no followed game is in play, which
      // is most of the year. The amendment to the no-reflow rule, and why it is
      // right here and wrong for the other seven, is written out on
      // BarItem.canBeEmpty in bar-items.tsx — the flag the guard reads, so the
      // exception cannot spread by copy-paste.
      const view = capsuleView(ctx.scores);
      if (view.kind === "none") return null;
      // A score arriving is INVOLUNTARY motion — the viewer did not ask for it —
      // which is the category prefers-reduced-motion exists for most strongly.
      // Checked here, in JS: the global CSS override collapses a transition's
      // duration but cannot stop a class this decides to hand the strip.
      const scored = prefersReducedMotion()
        ? null
        : scoredSide(view.game, ctx.scores?.lastEvents ?? []);
      return (
        <ScoreCapsule game={view.game} scored={scored} preview={ctx.preview} />
      );
    }
  }

  // EVERY id has a case, and the compiler is what says so. Without this a new
  // BarItemId with no case compiled, returned undefined, and BarStripRows'
  // `content === null` did not drop it — leaving an empty .bar-item that still
  // charges the strip a gap. That is the hole the service-type note above is
  // about, and the no-reflow guard cannot catch it: assert.notEqual(x, null)
  // passes on undefined. The same three lines HomeCard's switch already ends on.
  const _never: never = id;
  void _never;
  return null;
}
