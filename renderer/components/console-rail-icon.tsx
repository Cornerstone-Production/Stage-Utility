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
}: {
  viewId: string;
  label: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { state } = useStageState();
  const glyphs = state?.iconGlyphs ?? {};

  // ONE key, shared with the Screens card for any screen showing this console —
  // see iconKeyFor. It was two, with the tab preferring its own, and setting the
  // icon on the card then moved nothing if the tab had ever been set.
  const glyph = resolveIcon(glyphs[viewId]) ?? SlidersHorizontalIcon;

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
