// Whether Home is being arranged, for a card that opens something of its own.
//
// Home's render context says `interactive: true` while editing too: the editor
// draws the live cards under its own overlay, and the cards' controls are not
// what is being judged there. ExpandableTile is told `editing` by the grid and
// draws no expand control; a card that opens the same overlay from a control of
// its own (Needs attention's "+N more") is drawn by the shared renderer, which
// has no such prop, so it reads this instead. Without it, Tab reached "+N more"
// under the editor's overlay and opened a panel over the page being arranged.

import { createContext } from "react";

/** True inside HomeGridView while it draws the editor's grid. */
export const HomeEditing = createContext(false);
