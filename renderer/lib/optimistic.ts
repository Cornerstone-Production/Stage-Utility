// The optimistic-write-then-roll-back dance, once.
//
// Show the change immediately, send it, install what the server returns — and if
// the server refuses, put the old value back. The rollback is the whole point:
// without it a refused write leaves the UI showing a change that never happened,
// which reads as saved until the next reload quietly loses it.
//
// One module because there were seven copies. Five lived in use-stage-settings
// (three reorders, two output patches), and two more in set-bar-items and
// use-saved-colors — the first of which opens with a comment explaining that a
// second copy is "a second place for a failed save to read as saved", written
// when there were two. Seven is how a rollback goes missing from one of them.

import type { QueryClient } from "@tanstack/react-query";

import { errorMessage } from "@main/services/errors";
import { toast } from "../components/ui";
import { logToServer } from "./client-log";

/** The refused write, told to the operator and written to /log in the same words. */
function reportWrite(tag: string, fail: string | undefined, key: string[], err: unknown): void {
  const why = errorMessage(err);
  toast.error(fail ? `${fail}: ${why}` : why);
  // With no prefix the toast is the server's sentence alone, so the line names
  // the cache key it was writing to, or it would say nothing about what failed.
  logToServer(tag, `${fail ?? `write to ${key.join("/")} refused`}: ${why}`);
}

/**
 * @param optimistic What to show while the write is in flight, from the cached
 *   value. Not called when the cache is empty — there is nothing to roll back to
 *   and nothing on screen to correct.
 * @param send The write itself. Whatever it resolves to is installed.
 * @param opts.tag The /log tag of the area the write belongs to. Required: a
 *   refused write is toasted AND logged, and the type checker is what keeps a
 *   new caller from toasting alone.
 * @param opts.fail Prefix for the error toast. Omit to show the server's message
 *   verbatim, which is right where the refusal is written FOR the operator.
 * @returns What the server returned, or null if it refused. Callers with
 *   follow-up work — one reports a colour the server dropped — key off that
 *   rather than assuming the write landed.
 */
export async function writeOptimistic<T>(
  queryClient: QueryClient,
  key: string[],
  optimistic: (current: T) => T,
  send: () => Promise<T>,
  opts: { tag: string; fail?: string },
): Promise<T | null> {
  const prev = queryClient.getQueryData<T>(key);
  if (prev) queryClient.setQueryData(key, optimistic(prev));
  try {
    const next = await send();
    queryClient.setQueryData(key, next);
    return next;
  } catch (err) {
    if (prev) queryClient.setQueryData(key, prev);
    reportWrite(opts.tag, opts.fail, key, err);
    return null;
  }
}

/**
 * Send a write and install what the server returns under `key`, with no
 * optimistic step: the toast says why it failed, and `ok`, when given, confirms.
 *
 *  - `fail` set: the toast reads "<fail>: <err>".
 *  - `fail` omitted: the server's own message, verbatim, for a refusal written
 *    FOR the operator, which a prefix would bury.
 *
 * @returns What the server returned, or null if it refused.
 */
export async function writeTo<T>(
  queryClient: QueryClient,
  key: string[],
  send: () => Promise<T>,
  opts: { tag: string; fail?: string; ok?: string },
): Promise<T | null> {
  try {
    const next = await send();
    queryClient.setQueryData(key, next);
    if (opts.ok) toast.success(opts.ok);
    return next;
  } catch (err) {
    reportWrite(opts.tag, opts.fail, key, err);
    return null;
  }
}
