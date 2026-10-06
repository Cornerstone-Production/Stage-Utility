// lan-ip.ts — this box's own LAN address.
//
// Moved out of remote-server.ts (it used to be a private helper there) so
// video-service.ts's push addresses can share the same one function rather
// than a second copy — see CLAUDE.md's "fixing a repeated pattern".

import * as os from "os";

/** The first non-internal IPv4 address any interface reports, or the
 *  loopback address when nothing else is found (a box with no LAN NIC up
 *  yet, or a sandboxed test environment). */
export function getLanIp(): string {
  const interfaces = os.networkInterfaces();
  for (const ifaces of Object.values(interfaces)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}
