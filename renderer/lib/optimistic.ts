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

/**
 * @param optimistic What to show while the write is in flight, from the cached
 *   value. Not called when the cache is empty — there is nothing to roll back to
 *   and nothing on screen to correct.
 * @param send The write itself. Whatever it resolves to is installed.
 * @param fail Prefix for the error toast. Omit to show the server's message
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
  fail?: string,
): Promise<T | null> {
  const prev = queryClient.getQueryData<T>(key);
  if (prev) queryClient.setQueryData(key, optimistic(prev));
  try {
    const next = await send();
    queryClient.setQueryData(key, next);
    return next;
  } catch (err) {
    if (prev) queryClient.setQueryData(key, prev);
    toast.error(fail ? `${fail}: ${String(err)}` : errorMessage(err));
    return null;
  }
}
