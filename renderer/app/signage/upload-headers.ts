// upload-headers.ts — the metadata that rides alongside an upload's bytes.
//
// The body of a media upload is the file, so everything else travels in headers.
// That makes the operator's filename a header value, and header values are
// unforgiving: fetch() throws outright on a CRLF or a multi-byte character, so a
// filename pasted from a spreadsheet would fail the upload with an error about
// headers rather than about the file.
//
// Kept in its own module, free of DOM types, so the encoding rules are testable
// without a browser.

import { MAX_MEDIA_DIMENSION, MIN_ITEM_MS, MAX_ITEM_MS, isSignageVideo } from "@main/types/signage";

export interface Measured {
  name: string;
  mime: string;
  w: number;
  h: number;
  durationMs?: number;
}

/**
 * Headers for `POST /api/signage/media`.
 *
 * THROWS when a measurement is missing or out of range rather than substituting
 * a default. Measuring in the browser is only worth doing if a failed
 * measurement is reported — a plausible-looking default would put a graphic on a
 * wall for an invented length of time and there would be nothing to notice.
 */
export function uploadHeadersFor(m: Measured): Record<string, string> {
  const ok = (n: number) => Number.isFinite(n) && n >= 1 && n <= MAX_MEDIA_DIMENSION;
  if (!ok(m.w) || !ok(m.h)) {
    throw new Error(`could not read the size of ${m.name}`);
  }

  const headers: Record<string, string> = {
    "Content-Type": m.mime,
    // encodeURIComponent, not a strip: header values are latin-1 on the wire and
    // a CRLF is a header injection, but an operator's accented filename is worth
    // keeping rather than mangling. The server decodes it.
    "X-Signage-Name": encodeURIComponent(m.name),
    "X-Signage-W": String(Math.round(m.w)),
    "X-Signage-H": String(Math.round(m.h)),
  };

  if (isSignageVideo(m.mime)) {
    const d = m.durationMs;
    if (typeof d !== "number" || !Number.isFinite(d) || d < MIN_ITEM_MS || d > MAX_ITEM_MS) {
      throw new Error(`could not read the duration of ${m.name}`);
    }
    headers["X-Signage-Duration-Ms"] = String(Math.round(d));
  }

  return headers;
}
