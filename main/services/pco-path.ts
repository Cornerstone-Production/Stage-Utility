// pco-path.ts — the one way a Planning Center URL path is written.
//
// The services API is addressed by ids spliced into the path:
// /service_types/<id>/plans/<id>/items. Most of those ids come from a request
// (?serviceTypeId=, ?planId=, a body field), and the URL carries the operator's
// App ID and secret. An id of `1/../../../people/v2/people?x=` is then a request
// for another endpoint made with the church's credentials; `1/plans`, `1?x=` and
// `1%2F2` do the same inside Services. Checked per route that was one regex in one
// of five routes, so the check is made where the string is built instead: a path
// is written with the `pcoUrl` tag, and the tag takes nothing that has not been
// through `pcoId` (a value that must look like a PCO id) or `pcoSegment` (a fixed
// word of the code's own). A raw string in an interpolation does not type-check, so
// a new endpoint cannot be written without the check.

export const PCO_BASE = "https://api.planningcenteronline.com/services/v2";

/**
 * A URL the credentialed fetch will not send, or an id that cannot be spliced
 * into one. `status` 400: the caller named something that is not a Planning Center
 * id, which the route layer answers as a 400 rather than a 500 or a retried 502.
 * Deterministic, so the request loop never retries it.
 */
export class PcoUrlRefused extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PcoUrlRefused";
  }
}

/** Held only by this module, so nothing outside it can make a PcoPathPart. */
const CHECKED = Symbol("checked by pcoId or pcoSegment");

/** A value that may be written into a `pcoUrl` path. Made only by pcoId and
 *  pcoSegment: the constructor wants a token no other module holds, and the
 *  private field makes the type nominal, so a plain `{ value }` object does not
 *  pass for one either. */
export class PcoPathPart {
  readonly #value: string;
  constructor(token: typeof CHECKED, value: string) {
    if (token !== CHECKED) throw new PcoUrlRefused("a PCO path part is made by pcoId or pcoSegment");
    this.#value = value;
  }
  get value(): string {
    return this.#value;
  }
  /** Was `part` made here? A cast can get past the type; this is checked at run time. */
  static made(part: unknown): part is PcoPathPart {
    return typeof part === "object" && part !== null && #value in part;
  }
}

/** The shape of every id Planning Center issues: a run of digits. */
const PCO_ID = /^\d{1,20}$/;

/** Is `value` shaped like an id Planning Center issues? */
export function isPcoId(value: unknown): value is string {
  return typeof value === "string" && PCO_ID.test(value);
}

/**
 * `value` as a path part, or a PcoUrlRefused naming `name` (the parameter, never
 * the value: it came from a caller and goes back to one).
 */
export function pcoId(name: string, value: unknown): PcoPathPart {
  if (!isPcoId(value)) {
    throw new PcoUrlRefused(`${name} is not a Planning Center id`);
  }
  return new PcoPathPart(CHECKED, value);
}

/** A fixed word the code chose, for the one path part that is not an id (a collection name). */
export function pcoSegment(name: string, value: string): PcoPathPart {
  if (!/^[a-z_]+$/.test(value)) throw new PcoUrlRefused(`${name} is not a path word`);
  return new PcoPathPart(CHECKED, value);
}

/**
 * A Services API URL: `pcoUrl\`/service_types/${pcoId("serviceTypeId", id)}/plans\``.
 * The literal parts are the code's own; every interpolation has been checked.
 */
export function pcoUrl(strings: TemplateStringsArray, ...parts: PcoPathPart[]): string {
  let out = PCO_BASE;
  strings.forEach((s, i) => {
    const part = parts[i];
    if (part !== undefined && !PcoPathPart.made(part)) {
      throw new PcoUrlRefused("a PCO path part was not checked by pcoId or pcoSegment");
    }
    out += s + (part?.value ?? "");
  });
  return out;
}
