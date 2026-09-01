// How wide an integration's settings dialog has to be, and why.

import { cn } from "../lib/cn";

/**
 * The attribute a panel puts on its root to say "I hold a row that cannot wrap".
 *
 * It is what makes the width rule checkable against the running page instead of
 * against a second hand-written list: integration-dialog-size.test.tsx renders
 * all sixteen dialog bodies for real and asserts that the ids carrying this
 * marker are exactly WIDE_DIALOG_IDS. Adding a repeater panel to a new
 * integration and forgetting the width therefore fails, which two lists compared
 * to each other could never do.
 */
export const WIDE_PANEL_ATTR = "data-wide-panel";

/** Integrations whose body holds a repeater whose widest row cannot wrap.
 *  Measured off the running app: ross-tsl needs ~620px, wireless and rosstalk
 *  ~560px, osc and propresenter ~520px. DialogContent's default max-w-lg gives
 *  ~464px of content, which is too narrow for every one of them. */
export const WIDE_DIALOG_IDS = new Set([
  "wireless",
  "osc",
  "rosstalk",
  "ross-tsl",
  "propresenter",
]);

/** max-w-3xl = 768px (~720px of content) for the five; max-w-2xl = 672px
 *  (~624px) for the rest. Plus the phone sheet, and a body that scrolls rather
 *  than a dialog that grows past the viewport. */
export function integrationDialogClass(id: string): string {
  return cn(
    "flex flex-col max-h-[86vh] p-0",
    WIDE_DIALOG_IDS.has(id) ? "max-w-3xl" : "max-w-2xl",
    // Phone: a full-screen sheet, not a modal with 16px of margin. The centring
    // translate has to be unwound as well as the inset set, or the sheet sits
    // half off the top-left corner.
    "max-sm:inset-0 max-sm:left-0 max-sm:top-0 max-sm:h-full max-sm:max-h-none",
    "max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0",
    "max-sm:rounded-none max-sm:border-0",
  );
}
