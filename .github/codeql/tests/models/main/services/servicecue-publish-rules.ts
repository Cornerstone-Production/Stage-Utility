// Stand-in for the real servicecue-publish-rules.ts: it parses an address, but nothing
// in its shape tells the query the result is safe to request, so the barrier model is
// the only thing that can make a call to it safe.
export function parsePublishUrl(raw: unknown): { ok: true; origin: string } | { ok: false; message: string } {
  try {
    const url = new URL(String(raw));
    return url.protocol === "https:" ? { ok: true, origin: url.origin } : { ok: false, message: "https only" };
  } catch {
    return { ok: false, message: "not an address" };
  }
}
