// Shared by the repeater panels an integration dialog can hold.

import { uid } from "../lib/uid";

/** A stable key for a newly added repeater row. Shared because the Ross TSL
 *  feeds panel and the ProPresenter instances panel both mint row ids; uid()
 *  carries the plain-HTTP fallback. */
export function feedId(): string {
  return uid("feed");
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

/** A saved repeater row in the shape its editor works in.
 *
 *  A row's optional fields are absent in storage but always SHOWN — the
 *  ProPresenter poll interval renders `?? 500`, a TSL prefix renders `?? ""`.
 *  Nudging such a field back to the value already on screen still WRITES the
 *  key, so the buffer stops matching the saved copy, `sameRows` reports unsaved
 *  work, and the dialog raises its modal over a row nothing has changed. That is
 *  the same defect as a numeric field storing String(n), one panel over.
 *
 *  Filling the defaults in on the way IN makes both sides the same shape. A row
 *  the panel ADDS must be built with them too, or the first save leaves the
 *  buffer a key short of what came back. */
export function withDefaults<T extends object>(rows: readonly T[], defaults: Partial<T>): T[] {
  return rows.map((row) => {
    const out = { ...row };
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      if (out[key] === undefined) out[key] = defaults[key] as T[keyof T];
    }
    return out;
  });
}
