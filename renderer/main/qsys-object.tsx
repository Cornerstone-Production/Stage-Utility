// qsys-object.tsx — the Q-SYS layout objects, until their live renderers land.
//
// Draws the object's name and "Q-SYS" with an Unavailable state, and reads nothing from
// the Core: no live value is shown, and nothing here writes. It is inert on purpose, so
// a Q-SYS object placed on a layout says it has no data rather than showing a made-up one.

import type { CSSProperties } from "react";

import type { LayoutObjectType } from "@main/types/views";
import { LAYOUT_OBJECTS } from "./layout-objects";

export function QsysObject({ type, ts }: { type: LayoutObjectType; ts: CSSProperties }) {
  return (
    <div
      data-qsys-object={type}
      data-state="unavailable"
      style={{
        ...ts,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.2em",
        textAlign: "center",
        opacity: 0.7,
      }}
    >
      <span style={{ fontWeight: 600 }}>{LAYOUT_OBJECTS[type].label}</span>
      <span style={{ fontSize: "0.7em", color: "var(--su-fg-faint)" }}>Q-SYS · Unavailable</span>
    </div>
  );
}
