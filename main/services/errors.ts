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
 * The value's own stringification rather than a placeholder for the non-Error
 * case: things get thrown that are not Errors — a string from a library, a
 * DOMException-like object, a rejected fetch value — and their own
 * stringification is more use to whoever is reading the log than "unknown
 * error" would be.
 *
 * Stringified by a template literal, which is String() for every value but a
 * Symbol, and not by String() itself. Every route's error reply comes through
 * here, and CodeQL follows a caught value through String() into the response
 * and reports it as a stack trace sent to the client (js/stack-trace-exposure);
 * it knows a template literal and toString() give only the message. A Symbol
 * would throw in a template literal, and this runs inside catch blocks.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "symbol" ? err.toString() : `${err as string}`;
}

/**
 * A caught FETCH failure, said usefully.
 *
 * Node's own message for every network failure is the word "fetch failed", with
 * the real reason — ECONNREFUSED, EHOSTUNREACH, the address and the port — one
 * level down on `cause`. Driving Companion's button picker against a dead port
 * put "Could not read Companion's configuration: fetch failed" on screen, which
 * tells an operator nothing at all; the REAPER transport action would have said
 * the same for a booth machine that is off.
 *
 * `target` is what was being dialled, for the case where there is no cause to
 * read — it goes in only when the message does not already name the address,
 * because the cause usually does and two copies read as two failures.
 */
export function fetchFailureMessage(err: unknown, target: string): string {
  const top = errorMessage(err);
  const cause = err instanceof Error && err.cause !== undefined ? errorMessage(err.cause) : "";
  const said = cause && cause !== top ? cause : top === "fetch failed" ? `could not reach ${target}` : top;
  const address = target.replace(/^https?:\/\//, "");
  return said.includes(address) ? said : `${said} (${target})`;
}
