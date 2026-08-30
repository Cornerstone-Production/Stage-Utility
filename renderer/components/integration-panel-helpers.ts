// Shared by the repeater panels an integration dialog can hold.

/** A stable key for a newly added repeater row.
 *
 *  crypto.randomUUID needs a secure context and the kiosk runs plain HTTP, so
 *  it is not there in production — fall back rather than throw. Shared because
 *  the Ross TSL feeds panel and the ProPresenter instances panel both mint row
 *  ids, and a second copy is a second place for the secure-context guard to be
 *  forgotten. */
export function feedId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `feed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
