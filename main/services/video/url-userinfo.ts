// main/services/video/url-userinfo.ts — a username or password inside an address.

/** A username or password inside the address itself. Refused for every kind
 *  that takes an address: stored there it would sit in the config store and
 *  go out on video:state to every screen, and a browser refuses to fetch an
 *  address that carries one, so it could never play either. */
export function hasUserinfo(u: URL): boolean {
  return u.username !== "" || u.password !== "";
}
