// body.ts — reading a request body that may not be believed.
//
// A publish body is capped, and the cap is enforced WHILE reading: a Content-Length
// can be absent (chunked) or wrong, so it is only the quick refusal, and the count
// of bytes actually received is what decides.

/** The body was over the cap. */
export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`The body is over ${limit} bytes`);
  }
}

/** The body, or a BodyTooLarge the caller turns into a 413. Reads nothing past the cap. */
export async function readCappedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge(limit);
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BodyTooLarge(limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
