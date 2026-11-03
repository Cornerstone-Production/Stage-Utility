// A Home card that can open over the page.
//
// THE CORNER CONTROL IS A SIBLING OF THE CARD'S CONTENT, never its ancestor —
// the rule expand-overlay.tsx exists to hold, and this repository has shipped
// the opposite twice. The press-on-the-card convenience is a handler on the
// wrapper that gives way to any control under the pointer, so a button, link or
// field inside a card still gets its own press. It is not a layer over them.

import type { MouseEvent, ReactNode, SyntheticEvent } from "react";

import type { LayoutObject } from "@main/types/views";

import { AppLink } from "../../app-link";
import { useExpand } from "../../../main/expand-overlay";
import type { LayoutRenderCtx } from "../../../main/layout-renderer";
import { expandedBodyFor } from "./registry";

/** Anything a press should be left to. */
const OWN_PRESS = "a, button, input, select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']";

/** Whether a click landed on a control of the card's own. Exported for the test. */
export function pressIsControls(target: EventTarget | null, tile: Element): boolean {
  const hit = target instanceof Element ? target.closest(OWN_PRESS) : null;
  return hit !== null && tile.contains(hit);
}

export function ExpandableTile({
  o,
  ctx,
  editing,
  children,
}: {
  o: LayoutObject;
  ctx: LayoutRenderCtx;
  /** The editor's overlay is on the card: expanding is off while arranging. */
  editing: boolean;
  children: ReactNode;
}) {
  const spec = expandedBodyFor(o);
  if (!spec) return <>{children}</>;
  return (
    <Expandable spec={spec} ctx={ctx} enabled={ctx.interactive && !editing}>
      {children}
    </Expandable>
  );
}

function Expandable({
  spec,
  ctx,
  enabled,
  children,
}: {
  spec: NonNullable<ReturnType<typeof expandedBodyFor>>;
  ctx: LayoutRenderCtx;
  enabled: boolean;
  children: ReactNode;
}) {
  const { tileRef, control, overlay, open } = useExpand(enabled);
  const { Body } = spec;

  /** Whether the event came from the PANEL. A portal's events still bubble
   *  through the React tree, so a press on Close reaches this wrapper — and
   *  would reopen the panel it just closed — and a right-click in the panel
   *  would open the card's menu behind it. The DOM says where it really was. */
  const fromPanel = (e: SyntheticEvent<HTMLDivElement>) => !e.currentTarget.contains(e.target as Node);
  const keepInPanel = (e: SyntheticEvent<HTMLDivElement>) => {
    if (fromPanel(e)) e.stopPropagation();
  };

  function onPress(e: MouseEvent<HTMLDivElement>) {
    if (fromPanel(e)) return;
    if (!enabled || !spec.bodyPress) return;
    if (pressIsControls(e.target, e.currentTarget)) return;
    open();
  }

  return (
    // No key handler: the corner control is the keyboard path, and it is a real
    // button. This wrapper only adds the pointer convenience.
    <div
      ref={tileRef}
      className="relative h-full w-full"
      onClick={onPress}
      onPointerDown={keepInPanel}
      onPointerMove={keepInPanel}
      onPointerUp={keepInPanel}
      onPointerCancel={keepInPanel}
      onContextMenu={keepInPanel}
    >
      {children}
      {control(spec.name)}
      {overlay(
        () => <Body ctx={ctx} />,
        spec.name,
        <AppLink
          to={spec.page.to}
          className="touch-target rounded-md px-2 py-1 text-caption1 font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {spec.page.label}
        </AppLink>,
      )}
    </div>
  );
}
