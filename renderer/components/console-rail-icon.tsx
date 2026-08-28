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

import { createElement, useState } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import { invoke } from "../lib/api";
import { IconMenu } from "./icon-menu";
import { resolveIcon } from "./icon-set";
import { useStageState } from "../main/use-stage-state";

export function ConsoleRailIcon({
  viewId,
  label,
  outputs,
}: {
  viewId: string;
  label: string;
  /** For the fallback below — the screens that show this view. */
  outputs: { id: string; viewId?: string | null }[];
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { state } = useStageState();
  const glyphs = state?.iconGlyphs ?? {};

  // The view's own choice first, then the icon of a SCREEN showing it.
  //
  // A console tab and the Screens card for the screen running it are the same
  // thing to the operator, so changing the card's icon has to move the tab. They
  // stay keyed separately — a card by its output id, a tab by its view id —
  // because a screen re-pointed at another view should keep its own icon.
  // Reading through covers the case without making the two share a key they
  // would then fight over.
  const fromScreen = outputs.find((o) => o.viewId === viewId && glyphs[o.id]);
  const chosen = glyphs[viewId] ?? (fromScreen ? glyphs[fromScreen.id] : null);
  const glyph = resolveIcon(chosen) ?? SlidersHorizontalIcon;

  return (
    <>
      <span
        className="contents"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setAnchor(e.currentTarget.firstElementChild as HTMLElement);
        }}
      >
        {createElement(glyph, { className: "size-4" })}
      </span>
      {anchor && (
        <IconMenu
          anchor={anchor}
          label={`${label} icon`}
          current={glyphs[viewId] ?? null}
          onPick={(name) => void invoke("icons:setIcon", { key: viewId, glyph: name })}
          onClear={() => void invoke("icons:setIcon", { key: viewId, glyph: "" })}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
