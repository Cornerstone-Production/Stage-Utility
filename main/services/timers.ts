// timers.ts — clearing a timer held in a nullable field.

/** Clears `timer` if one is set, and returns null to store in its place:
 *  `this.retryTimer = cleared(this.retryTimer)`. */
export function cleared(timer: NodeJS.Timeout | null): null {
  if (timer) clearTimeout(timer);
  return null;
}
