// http-origin.ts — who sent this request, as far as the headers can say.
//
// Two callers, and they must agree: remote-server's cross-origin write gate, and
// the browser exemption on the cue routes. They used to be one function here and
// a looser copy in cue-tokens.ts, and the copy accepted a bare `Sec-Fetch-Site`
// header — curl with one header minted itself a cue token. One definition now.

/** Hostname of an Origin header ("http://host:port") or a Host header ("host:port"). */
export function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
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
 * operator visits can POST here, and with permissive CORS the preflight passes,
 * so a drive-by page could hit POST /api/update/apply and rebuild + restart every
 * display mid-service. DNS rebinding makes that reachable from the open internet.
 *
 * No Origin header  → not a browser cross-site request (Companion, curl, a
 *                     script, or a same-origin navigation). Allowed.
 * Origin present    → its hostname must match the Host it was sent to.
 * Origin: "null"    → a sandboxed iframe or opaque origin. Rejected.
 *
 * Ports are ignored so the Vite dev proxy (:3000 → :8788) keeps working, and so
 * the friendly port 80 and 8788 interoperate. The check rests on hostname, which
 * an attacker cannot serve the appliance's own address from.
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
