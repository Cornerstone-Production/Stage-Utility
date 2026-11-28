// free-port.ts — a port nothing holds right now, for a test that must tell a
// service which port to bind instead of letting it pick.
//
// The port is closed before it is returned, so another process can take it
// before the caller binds; that race is inherent. A caller whose bind can lose
// it (a spawned child) retries on a fresh port, as
// publish/servicecue/test/worker.integration.test.ts does.

import dgram from "node:dgram";
import net from "node:net";

/** A TCP port free on 127.0.0.1. */
export function tcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** A UDP port free on 127.0.0.1. */
export function udpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", reject);
    sock.bind(0, "127.0.0.1", () => {
      const { port } = sock.address();
      sock.close(() => resolve(port));
    });
  });
}
