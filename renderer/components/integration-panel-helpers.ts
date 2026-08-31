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

/** Whether a repeater panel's buffer still matches what is saved.
 *
 *  A bare JSON.stringify of the two arrays is not enough. A row the operator
 *  has edited carries its keys in the order the patches applied them, and an
 *  optional field left alone is `undefined` in the buffer but absent in the
 *  saved copy — both compare unequal while nothing has actually changed, which
 *  would put the "Unsaved changes" modal in front of a dismissal with nothing
 *  to save. Shared because the Ross TSL feeds panel and the ProPresenter
 *  instances panel both answer this question. */
export function sameRows(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/** Key-sorted, undefined-free copy of a JSON-shaped value. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] !== undefined) out[key] = stable(src[key]);
    }
    return out;
  }
  return value;
}
