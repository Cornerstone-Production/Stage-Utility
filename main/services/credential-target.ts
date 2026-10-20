// credential-target.ts — where a stored credential is sent, compared.
//
// ProdCom's API key, the OBS, Smaart and PVP passwords, a Spectera base
// station's API password and a pulled camera's password all go to an address
// the operator typed. A save that changed the address used to keep the stored
// credential, because the form posts it back masked: so any settings write could
// repoint one at another machine, and the next connect or Test handed it over.
// A credential is now kept only while it goes where it was entered for. Each
// path that can change one of those addresses works out the target before and
// after with its own subsystem's rule, the same one its connection dials with,
// and compares the two here.

/**
 * One place a credential goes: a host, and whatever else picks the listener
 * (a port, a scheme, a provider). `host` null is "not set". `encrypted`, when
 * a target has it, says whether the connection carries the credential inside
 * TLS; it is compared one way only (see credentialTargetMoved).
 */
export interface CredentialTarget {
  host: string | null;
  [part: string]: string | number | boolean | null;
}

/** The target as the comparison sees it: a host's case and a trailing dot are
 *  not a different machine. `encrypted` is left out: it is compared on its own. */
function canonical(t: CredentialTarget | null): string {
  if (!t) return "null";
  const host = t.host === null ? null : t.host.trim().toLowerCase().replace(/\.$/, "");
  const parts = Object.keys(t).filter((k) => k !== "host" && k !== "encrypted").sort();
  return JSON.stringify([host, ...parts.map((k) => [k, t[k]])]);
}

/**
 * Whether a credential stored for `before` would now be sent somewhere else, or
 * in the clear where it went encrypted. Taking a connection from plain to TLS
 * on the same listener is not a move: the credential goes where it always did,
 * better protected, and an operator securing a camera should not have to type
 * its password again for it.
 */
export function credentialTargetMoved(before: CredentialTarget | null, after: CredentialTarget | null): boolean {
  if (canonical(before) !== canonical(after)) return true;
  return before?.encrypted === true && after?.encrypted !== true;
}

/** A target for a log line, `scheme://host:port` as far as it has them, then
 *  what else picks the listener, or "no address". Never a credential: a target
 *  holds none. Every part is said, so a move of the provider alone does not
 *  read as "from X to X". */
export function describeTarget(t: CredentialTarget | null): string {
  if (!t?.host) return "no address";
  const scheme = typeof t.scheme === "string" ? `${t.scheme}://` : "";
  const port = t.port === null || t.port === undefined ? "" : `:${t.port}`;
  const encrypted = t.encrypted === true ? " (encrypted)" : "";
  const provider = typeof t.provider === "string" && t.provider ? ` (${t.provider})` : "";
  return `${scheme}${t.host}${port}${encrypted}${provider}`;
}
