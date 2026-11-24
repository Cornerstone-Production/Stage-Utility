// Customize mode's context: what every part of the mode reads, and nothing it
// does.
//
// Its own module, apart from the provider in customize-mode.tsx, because the
// context bar reads it and the provider imports the destinations, and through
// them every page: a page that draws the bar would otherwise import itself
// before it had finished loading.

import { createContext, use, type ReactNode, type RefObject } from "react";

import {
  resolveSidebar,
  type ResolvedSidebar,
  type SidebarArrangement,
  type SidebarConsoles,
} from "@main/services/sidebar-arrangement";
import { NO_AIM, type RailAim, type RailDrag } from "./rail-drop";
import type { BarEditor } from "./bar-editor";

/** The two parts of the app's chrome the mode arranges. */
export type CustomizeTab = "sidebar" | "bar";

export interface CustomizeValue {
  customizing: boolean;
  /** Which part the tray is showing. Switching keeps the mode open. */
  tab: CustomizeTab;
  setTab: (tab: CustomizeTab) => void;
  open: (tab: CustomizeTab) => void;
  done: () => void;
  /** The context bar's editor: what the strip and the tray's bar tab draw. */
  bar: BarEditor | null;
  /** The sidebar to draw: the draft while one is held, else what is saved. */
  resolved: ResolvedSidebar;
  /** The arrangement held ahead of the SSE state, or null. */
  draft: SidebarArrangement | null;
  consoles: SidebarConsoles;
  /**
   * Save a change, given as a function of the arrangement it lands on so that
   * one made while another is saving builds on it. Null from it (an edit that
   * broke a rule) does nothing. `said` is toasted once it has saved; with
   * `undoable` it carries an Undo, which a newer change retires, so an Undo only
   * ever puts back the change it was offered for.
   */
  apply: (change: (r: ResolvedSidebar) => ResolvedSidebar | null, said?: string, undoable?: boolean) => void;
  /** List a console in the sidebar, or take it out, through its own switch. */
  setConsoleShown: (id: string, shown: boolean, said?: string) => void;
  /** Hide a page or a console, saying so with an Undo. Advanced says why not. */
  hide: (id: string, label: string) => void;
  drag: RailDrag | null;
  aim: RailAim;
  /** The rail list, which the rail registers so the drag can measure it. */
  listRef: RefObject<HTMLDivElement | null>;
  /** The tray, likewise. */
  trayRef: RefObject<HTMLDivElement | null>;
  /** A page's or console's name and icon, for the tray and the drag ghost. */
  describe: (id: string) => { label: string; icon: ReactNode } | null;
}

const noop = () => {};
const EMPTY_CONSOLES: SidebarConsoles = { all: [], hidden: new Set() };

/** Outside a shell (a test rendering one page) the mode is closed and inert. */
export const CustomizeContext = createContext<CustomizeValue>({
  customizing: false,
  tab: "sidebar",
  setTab: noop,
  open: noop,
  done: noop,
  bar: null,
  resolved: resolveSidebar(null, EMPTY_CONSOLES),
  draft: null,
  consoles: EMPTY_CONSOLES,
  apply: noop,
  setConsoleShown: noop,
  hide: noop,
  drag: null,
  aim: NO_AIM,
  listRef: { current: null },
  trayRef: { current: null },
  describe: () => null,
});

export function useCustomize(): CustomizeValue {
  return use(CustomizeContext);
}

