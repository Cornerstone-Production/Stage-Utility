// http-origin.ts — who sent this request, as far as the headers can say.
//
// Two callers, and they must agree: remote-server's cross-origin write gate, and
// the browser exemption on the cue routes. They used to be one function here and
// a looser copy in cue-tokens.ts, and the copy accepted a bare `Sec-Fetch-Site`
// header — curl with one header minted itself a cue token. One definition now.

/**
 * Hostname of an Origin header ("http://host:port") or a Host header
 * ("host:port"): lower-cased, without a trailing dot, or null when the value is
 * absent or does not parse. IPv6 literals keep their brackets. Pure, so the
 * Host names card validates with it too.
 */
export function hostnameOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const name = new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
    return name.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Whether a request is a browser cross-site request. Pure + exported so the
 * matrix in remote-server.test.ts can be checked without a socket.
 *
 * The app is deliberately unauthenticated: it's a LAN appliance, and displays,
 * phones and the Companion module all reach it without credentials. That is fine
 * for peers on the network — but a browser is a confused deputy. Any page an
 * operator visits can POST here: a "simple" request (a form post, or text/plain)
 * is sent with no preflight at all, so a drive-by page could hit
 * POST /api/update/apply and rebuild + restart every display mid-service.
 *
 * No Origin header  → not a browser cross-site request (Companion, curl, a
 *                     script, or a same-origin navigation). Allowed.
 * Origin present    → its hostname must match the Host it was sent to.
 * Origin: "null"    → a sandboxed iframe or opaque origin. Rejected.
 *
 * Ports are ignored so the Vite dev proxy (:3000 → :8788) keeps working, and so
 * the friendly port 80 and 8788 interoperate.
 *
 * What this does NOT stop is DNS rebinding: a page whose own hostname has been
 * made to resolve to this server sends that hostname as both Origin and Host,
 * so the two match. Checking Host against the names this server answers to
 * closes that, in host-names.ts, once refusal is on.
 */
export function isCrossOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  const from = hostnameOf(origin);
  const to = hostnameOf(host);
  return from === null || to === null || from !== to;
}

/** One header, lower-cased, whatever Node handed us for it. */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = headers[name];
  return String(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
}
