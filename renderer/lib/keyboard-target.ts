// keyboard-target.ts — the two questions every page-wide keyboard shortcut asks first.
//
// "Is the operator typing?" and "is something modal open over the page?" were spelled
// five ways: each handler blocked a different set of roles (the layout editor missed
// the app's own confirm(), which is an alertdialog; the page tabs missed menus; the
// plot editor's undo checked nothing, so Cmd+Z behind an open dialog undid the plot) and
// a different contenteditable selector. One spelling here.

/** What a shortcut yields to: a dialog (a confirm() is an alertdialog) or an open menu. */
const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/**
 * Whether a dialog or menu is over the page, so the keyboard is theirs.
 *
 * `listbox` adds open lists, for the layout editor, whose delete keys have always
 * yielded to one. It is opt-in because some pages keep a listbox mounted while it is
 * idle (the plot editor's device picker, the Companion action pane), and a shortcut
 * there must not read it as a modal.
 */
export function modalOpen(opts?: { listbox?: boolean }): boolean {
  return document.querySelector(opts?.listbox ? `${MODAL_SELECTOR}, [role="listbox"]` : MODAL_SELECTOR) !== null;
}

/** The `<input>` types that take no typed text. */
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/**
 * Whether a key's target is a field that keeps its own keys: an input, a textarea, a
 * select, or anything contenteditable.
 *
 * `textOnly` treats an `<input>` that takes no typed text (a checkbox, a button, a
 * range) as not typing, for a shortcut that should still work with one focused, as the
 * widget shelf's Cmd+F does.
 */
export function isTypingTarget(target: EventTarget | null, opts?: { textOnly?: boolean }): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
  if (!field) return false;
  if (opts?.textOnly && field instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(field.type);
  return true;
}

/** The platform's command key: Cmd on a Mac, Ctrl elsewhere. Either is accepted. */
export function isMod(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">): boolean {
  return e.metaKey || e.ctrlKey;
}
