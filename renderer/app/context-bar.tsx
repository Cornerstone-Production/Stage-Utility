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

import { useState } from "react";
import { EllipsisIcon } from "lucide-react";

import { ContextMenu, type ContextMenuItem } from "../components/ui/context-menu";
import { useContextMenuTrigger } from "../components/ui/context-menu-trigger";
import { cn } from "../lib/cn";
import { useIsMobile, useCoarsePointer } from "../lib/use-media-query";
import type { ActivePage } from "./active-page";
import { BarEditStrip } from "./bar-editor";
import { barRowsFor } from "./bar-items";
import { useBarFit } from "./bar-fit";
import { useCustomize } from "./customize-context";
import { PageActionsEnd, PageTitle } from "./page-title";
import { ScoreActivityHost } from "./score-activity";
export * from "./bar-strip";
import { BAR_STRIP_CLASS, BarStripRows, useBarContext } from "./bar-strip";

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
  const customize = useCustomize();

  const menuItems: ContextMenuItem[] = [
    { label: "Customize bar…", onSelect: () => customize.open("bar") },
  ];

  const trigger = useContextMenuTrigger((pt) => setMenu(pt));
  // A mouse never sees this: the strip's own right-click is unaffected, and the
  // button exists only where that gesture does not — see useCoarsePointer.
  const isCoarse = useCoarsePointer();

  // Customize mode on its Context bar tab: this same strip, editable in place,
  // above the same page. The page title and actions step aside for it.
  if (customize.bar) return <BarEditStrip editor={customize.bar} ctx={ctx} isMobile={isMobile} />;

  return (
    <>
      <header
        ref={stripRef}
        className={cn("shrink-0", BAR_STRIP_CLASS)}
        onContextMenu={trigger.onContextMenu}
        onPointerDown={trigger.onPointerDown}
        onPointerMove={trigger.onPointerMove}
        onPointerUp={trigger.onPointerUp}
        onPointerCancel={trigger.onPointerCancel}
        onClickCapture={trigger.onClickCapture}
        style={trigger.style}
      >
        {/* FIRST CHILD, so the name sits where the header's h1 sat — the strip's
            inset is the page gutter, so the name lines up with the content
            below it. It is also the only shrinkable element
            on the row, which is what makes it the first thing to give way. */}
        <PageTitle active={active} />
        <BarStripRows rows={rows} ctx={ctx} />
        {/* LAST CHILD, so the controls sit at the right edge where the header
            put them. `visibleBarItems` guarantees the rows carry at least one
            flexible spacer, so there is always something between the operator's
            last reading and these. */}
        <PageActionsEnd active={active} />
        {isCoarse && (
          <button
            type="button"
            aria-label="Bar options"
            className="ml-1 grid size-11 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-fill-active hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom });
            }}
          >
            <EllipsisIcon className="size-4" />
          </button>
        )}
      </header>

      {/* The panel belongs to the ITEM: a bar without the capsule has no panel to
          grow out of, and mounting it anyway would give the page a document-wide
          pointerdown listener nothing can ever open. */}
      {rows.includes("scores") && (
        <ScoreActivityHost scores={ctx.scores} />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </>
  );
}

