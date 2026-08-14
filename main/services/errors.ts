// errors.ts — what to show when something threw.
//
// `catch (err)` gives `unknown`, and every site that wanted to log or report it
// wrote the same ternary: sixty-two copies of
// `err instanceof Error ? err.message : String(err)` across main, renderer and
// scripts. Identical, so they are one function now.
//
// Not swept: the twelve sites written `err instanceof Error ? err.message : err`,
// which pass the raw value to console. Those are NOT the same thing — console
// prints an object structured, and String() flattens it to "[object Object]",
// throwing away the only detail a thrown non-Error carries. Changing them would
// have made logs worse, quietly, which is the opposite of the point.

/**
 * The human-readable message from a caught value.
 *
 * `String(err)` rather than a placeholder for the non-Error case: things get
 * thrown that are not Errors — a string from a library, a DOMException-like
 * object, a rejected fetch value — and their own stringification is more use to
 * whoever is reading the log than "unknown error" would be.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
