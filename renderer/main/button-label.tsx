// The label on a console button, drawn the same way by every button widget (cue,
// action, OSC, RossTalk). One component, so a new button does not start from a bare
// span.
//
// The button around it supplies the centring of the BLOCK (a flex container with
// both axes centred); this supplies the rest: centred lines whatever the widget's
// text-align says, a margin, a wrap, and a hard stop at the button's own size. A
// label too long for the button shows its first lines and loses the end, rather
// than spilling over the edge or losing both ends to a centred overflow.
//
// The layout itself is verified in a browser; see button-label.test.tsx.

import type { CSSProperties, ReactNode } from "react";

const BUTTON_LABEL_STYLE: CSSProperties = {
  // The label is as wide as its text and no wider than the button, so a short
  // one stays a centred block and a long one wraps inside the button's edges.
  maxWidth: "100%",
  boxSizing: "border-box",
  // Room between the text and the button's edge, in the button's own type size
  // so it scales with the button on every canvas. The thin vertical padding keeps
  // a descender inside the box that clips below it.
  padding: "0.1em 0.6em",
  // Always centred, whatever the widget's text-align says: the block is centred
  // in the button, and every wrapped line is centred on the block.
  textAlign: "center",
  // A word longer than the button breaks rather than escaping it.
  overflowWrap: "anywhere",
  // A hard stop at the button's height. In a row (OSC, RossTalk) the label is as
  // tall as its text and would be centred straight across the edges, so it is
  // capped at the button's height and clips its own end; in a column (cue, action)
  // it may also shrink below its content to make room for the lines around it.
  // The button sets overflow: hidden as well, for anything else it holds.
  minWidth: 0,
  minHeight: 0,
  maxHeight: "100%",
  overflow: "hidden",
};

export function ButtonLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ ...BUTTON_LABEL_STYLE, ...style }}>{children}</span>;
}
