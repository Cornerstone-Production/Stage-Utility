// cue-tokens.ts — bearer tokens for the callers allowed to fire a cue.
//
// The rest of this app is deliberately unauthenticated on the LAN. Cue calls are
// not: a cue turns the projectors off, and the callers are a voice assistant and
// whatever else somebody wires up later, none of which is a browser and none of
// which the same-origin write gate protects. So a call carries a bearer token,
// one per caller, revocable on its own.
//
// The token is shown ONCE, at mint. Only a SHA-256 of it is stored, in the
// existing encrypted secrets blob under the companion slot — so an operator who
// can read secrets.bin still cannot replay a caller's token, and a lost token is
// replaced rather than recovered. There is nothing to compare against a
// plaintext store; the hash is the whole point.
//
// SHA-256 rather than a password hash: the secret is 32 bytes of CSPRNG output,
// not something a person chose, so there is no dictionary to run and the work
// factor a password hash buys does nothing here.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { errorMessage } from "./errors.js";
import { headerValue, isCrossOrigin } from "./http-origin.js";
import { scrub } from "./scrub.js";
import { secretsStore } from "./secrets.js";

/** The secrets slot and key the token list lives in. */
const SLOT = "companion";
const KEY = "cueTokens";

/** Every token starts with this, so one is recognisable in a config file. */
const PREFIX = "su_";

export interface CueTokenRecord {
  id: string;
  label: string;
  /** SHA-256 of the presented token, hex. NEVER leaves this module. */
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What a caller may see: everything but the hash. */
export interface CueTokenSummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The identified caller behind a request. */
export interface CueCaller {
  id: string;
  label: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Constant-time hex comparison, so a wrong token cannot be narrowed by timing. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function summarise(t: CueTokenRecord): CueTokenSummary {
  return { id: t.id, label: t.label, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt };
}

/**
 * Is this WRITE from a page THIS server served?
 *
 * The signal is an `Origin` naming this server, checked by the same
 * `isCrossOrigin` the cross-origin write gate in remote-server uses — hostname,
 * so the friendly port 80, port 8788 and the Vite dev proxy on 3000 all still
 * work. A page on another origin cannot forge it, which is the confused-deputy
 * case this exists to close.
 *
 * `Sec-Fetch-Site` is NOT required, and it used to be. Browsers send the
 * Fetch-metadata headers only to a "potentially trustworthy" destination — HTTPS
 * or localhost — and this app runs on plain HTTP on a LAN address, so a real
 * operator's browser never sent it and the settings page answered 401 to its own
 * import. It passed every test because the tests drove localhost. When the
 * header IS present it must still say `same-origin`; a browser that volunteers
 * `cross-site` is telling the truth about itself.
 *
 * Only WRITES may use this. A same-origin **GET** carries no `Origin` header at
 * all (Fetch sends one only for non-GET/HEAD or CORS), so the app's own settings
 * page would answer 401 to its own token list. Those two GET routes are
 * therefore not gated at all rather than gated on a header curl can type — see
 * cue-routes.ts.
 *
 * This is still a BROWSER convenience, not a boundary: curl can type an Origin
 * as easily as a browser sends one, exactly as it can for every other write in
 * the app. It closes the confused-deputy case and nothing more. The boundary is
 * the network — see SECURITY.md.
 */
export function isSameOriginBrowser(headers: Record<string, string | string[] | undefined>): boolean {
  const site = headerValue(headers, "sec-fetch-site").toLowerCase();
  if (site && site !== "same-origin") return false;
  const origin = headerValue(headers, "origin");
  if (!origin) return false;
  return !isCrossOrigin(origin, headerValue(headers, "host"));
}

/** The bearer token on a request, or null. Case-insensitive scheme, per RFC 7235. */
export function bearerOf(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return m ? m[1]! : null;
}

class CueTokenStore {
  private async read(): Promise<CueTokenRecord[]> {
    const secrets = await secretsStore.getSecrets(SLOT);
    const raw = secrets[KEY];
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Not swallowed: a token list that will not parse means every caller is
      // about to get a 401, and the operator has to be told which failure that
      // is. Rethrown so the route answers 500 rather than "your token is wrong".
      throw new Error(`cue tokens are unreadable: ${errorMessage(e)}`, { cause: e });
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is CueTokenRecord => {
      const o = t as Record<string, unknown> | null;
      return (
        !!o &&
        typeof o === "object" &&
        typeof o.id === "string" &&
        typeof o.label === "string" &&
        typeof o.hash === "string"
      );
    });
  }

  private async write(list: CueTokenRecord[]): Promise<void> {
    await secretsStore.setSecret(SLOT, KEY, JSON.stringify(list));
  }

  /** Labels, ids and last use. Never a hash — there is no route that returns one. */
  async list(): Promise<CueTokenSummary[]> {
    return (await this.read()).map(summarise);
  }

  /**
   * Mint a token for a named caller.
   *
   * Returns the plaintext exactly once; it is never stored and cannot be shown
   * again. 32 bytes of CSPRNG, base64url, so it is safe in a header and in a YAML
   * file without quoting.
   */
  async mint(label: string): Promise<{ token: CueTokenSummary; secret: string }> {
    const clean = label.trim();
    if (!clean) throw new Error("A token needs a label — it is how you know which one to revoke");
    const secret = PREFIX + randomBytes(32).toString("base64url");
    const record: CueTokenRecord = {
      id: randomBytes(8).toString("hex"),
      label: clean,
      hash: sha256(secret),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await this.write([...(await this.read()), record]);
    console.log(`[cues] minted a token for "${scrub(clean)}"`);
    return { token: summarise(record), secret };
  }

  /** Revoke by id. Returns whether anything was removed. */
  async revoke(id: string): Promise<boolean> {
    const list = await this.read();
    const next = list.filter((t) => t.id !== id);
    if (next.length === list.length) return false;
    await this.write(next);
    console.log("[cues] revoked a token");
    return true;
  }

  /**
   * Identify the caller behind a token, or null.
   *
   * Does NOT record the use — see `touch`. Recording it here would put an
   * encrypted whole-blob rewrite on the request path of every cue, and its
   * failure would have nowhere to go but a swallowing catch.
   */
  async verify(presented: string | null): Promise<CueCaller | null> {
    if (!presented) return null;
    const hash = sha256(presented);
    const match = (await this.read()).find((t) => hashesMatch(t.hash, hash));
    return match ? { id: match.id, label: match.label } : null;
  }

  /**
   * Record that a token was used just now.
   *
   * Separate from `verify` and RETURNS its failure rather than logging it away:
   * a cue must still fire when the secrets file cannot be written, but the
   * operator reading the activity log has to see that the timestamp is stale.
   */
  async touch(id: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const list = await this.read();
      const t = list.find((x) => x.id === id);
      if (!t) return { ok: false, detail: "token no longer exists" };
      t.lastUsedAt = new Date().toISOString();
      await this.write(list);
      return { ok: true, detail: "" };
    } catch (e) {
      return { ok: false, detail: `could not record token use: ${errorMessage(e)}` };
    }
  }
}

export const cueTokens = new CueTokenStore();
