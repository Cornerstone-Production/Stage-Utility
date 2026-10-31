// unconverted-button.tsx — what a stored Run an action Button draws.
//
// The type is gone: nothing in the app makes one or presses one, and the server turns every one
// it finds into a Button with a command of its own at start-up and on import. A layout can still
// hold one for a moment (the rules could not be saved, so the pass said so on the log and left
// it), and an older tab can save one back. It is drawn as an inert tile saying what is wrong,
// never as a control: a Button that looked like one and pressed nothing would say nothing.

import type { CSSProperties } from "react";

import { BUTTON_BASE_STYLE, ButtonLabel } from "./button-label";

export const UNCONVERTED_TEXT = "Needs converting — see the log";

/** Is this stored config a Run an action Button, the one type that is no longer in the config union? */
export function isUnconvertedButton(config: unknown): boolean {
  return (config as { type?: unknown } | null | undefined)?.type === "action-button";
}

export function UnconvertedButton({ ts }: { ts: CSSProperties }) {
  return (
    <div
      data-unconverted-button
      style={{
        ...ts,
        ...BUTTON_BASE_STYLE,
        opacity: 0.7,
        cursor: "default",
        outline: "0.06em dashed var(--su-fg-faint)",
        outlineOffset: "-0.16em",
      }}
    >
      <ButtonLabel style={{ fontWeight: 500, textTransform: "none", lineHeight: 1.05 }}>{UNCONVERTED_TEXT}</ButtonLabel>
    </div>
  );
}
