// data-archive-request.ts — the two archive POSTs (inspect, import), as one request.
//
// STOPGAP, not the home. These belong in lib/api.ts as `archive:inspect` and
// `archive:import` channels on its raw-upload path, which gives a body-less
// error shape, a timeout and the shared-read invalidation a write needs. api.ts
// has no such channel yet, so this keeps what the panel was missing: read the
// status BEFORE the body (a proxy's HTML 502 is not JSON and used to surface as
// "Unexpected token <"), and bound the wait so `busy` ends.

/** An archive can be large, and a Pi writes slowly; but not for ever. */
const ARCHIVE_TIMEOUT_MS = 300_000;

export async function postArchive<T>(
  path: "/api/archive/inspect" | "/api/archive/import",
  body: ArrayBuffer,
  { headers, failure, timeoutMs = ARCHIVE_TIMEOUT_MS }: { headers?: Record<string, string>; failure: string; timeoutMs?: number },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`${failure} The server did not answer in time.`, { cause: err });
    }
    throw err;
  }
  // The routes answer JSON on their own errors; a proxy or a crash does not.
  const parsed: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = (parsed as { error?: unknown } | null)?.error;
    throw new Error(typeof reason === "string" ? reason : `${failure} (HTTP ${res.status})`);
  }
  if (parsed === null) throw new Error(`${failure} The server's answer was not readable.`);
  return parsed as T;
}
