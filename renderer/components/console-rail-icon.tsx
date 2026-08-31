// console-rail-icon.tsx — a console's glyph in the sidebar, and how to change it.
//
// A PLAIN glyph, deliberately. The rail's rows are <button> elements and colour
// their own icons by active state; putting an interactive control inside one is
// invalid markup, and the outer button swallowed the click so the page navigated
// every time an icon was touched. And a colour set here would draw nothing,
// because the row's own active/inactive colour wins — so this offers the icon
// and nothing else.
//
// Right-click, on the GLYPH rather than the row. The row is a navigation target;
// a menu that opened from anywhere on it would fire while aiming at the label.

import { createElement, useRef, useState } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import { saveIcon } from "./editable-icon";
import { IconMenu } from "./icon-menu";
import { resolveIcon } from "./icon-set";
import { useReturnFocus } from "../lib/dialog-focus";
import { useStageState } from "../main/use-stage-state";

export function ConsoleRailIcon({
  viewId,
  label,
  active,
}: {
  viewId: string;
  label: string;
  /** Whether this console is the page being shown. */
  active: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const host = useRef<HTMLSpanElement>(null);
  const { state } = useStageState();
  const glyphs = state?.iconGlyphs ?? {};

  // ONE key, shared with the Screens card for any screen showing this console —
  // see iconKeyFor. It was two, with the tab preferring its own, and setting the
  // icon on the card then moved nothing if the tab had ever been set.
  const glyph = resolveIcon(glyphs[viewId]) ?? SlidersHorizontalIcon;

  // The operator's colour, but ONLY while this console is the current page.
  //
  // An inactive row is quiet on purpose: the rail says which page you are on by
  // being the one coloured thing in it, and a column of tinted icons takes that
  // away. Selected, the row is already the accent — so wearing the icon's own
  // colour there says the same thing in the operator's terms instead of the
  // theme's. Unset falls through to the row's own styling, which is what every
  // other tab does.
  //
  // Same key as the Screens card for the screen running this console (see
  // iconKeyFor), so the two are one colour rather than two that can disagree.
  const colour = active ? state?.iconColors?.[viewId] : undefined;

  /**
   * Focus comes back to the rail row when the menu closes.
   *
   * NOT to the anchor the menu was placed against. That anchor is the GLYPH, and
   * picking an icon replaces it — a different lucide component is a different
   * element, so the node the menu opened from is detached by the time it closes
   * and focus() on it does nothing at all. The span around it is the same node
   * throughout, so the row is found from there at the moment of closing rather
   * than remembered. `isConnected` covers the case where the whole row went away
   * — a console deleted from another tab.
   */
  useReturnFocus(anchor !== null, () =>
    host.current?.isConnected ? host.current.closest("button") : null,
  );

  return (
    <>
      <span
        ref={host}
        className="contents"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setAnchor(e.currentTarget.firstElementChild as HTMLElement);
        }}
      >
        {createElement(glyph, { className: "size-4", style: colour ? { color: colour } : undefined })}
      </span>
      {anchor && (
        <IconMenu
          anchor={anchor}
          label={`${label} icon`}
          current={glyphs[viewId] ?? null}
          onPick={(name) => saveIcon(viewId, name)}
          onClear={() => saveIcon(viewId, "")}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
