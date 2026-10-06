// main/services/video/feed-id.ts — a feed's permanent id, from its first name.

export const FEED_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MAX_ID_LENGTH = 40;

export function feedIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36)
      .replace(/-+$/g, "") || "feed";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    // The base gives up characters to the suffix, so the id still fits.
    const suffix = `-${n}`;
    const id = `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(id)) return id;
  }
}
