// lib/probe.ts — a pretend kiosk device announcing itself.
//
// A Raspberry Pi running the kiosk agent broadcasts a discovery probe; the server
// lists every unclaimed device it hears (for 90 seconds after the last probe).
// This sends the same datagram to the screenshot server's discovery port, so the
// Screens page has a found-devices banner and the sidebar a count. It goes to
// loopback only, on the port moved away from the real helper's.

import dgram from "node:dgram";

import { FAKE_DEVICES } from "../world.ts";

export { FAKE_DEVICES };

type Device = (typeof FAKE_DEVICES)[number];

export function announceDevices(port: number, devices: Device[] = FAKE_DEVICES): Promise<void> {
  const socket = dgram.createSocket("udp4");
  return new Promise<void>((resolve, reject) => {
    let left = devices.length;
    for (const d of devices) {
      // The address is not on the wire; the preload supplies it.
      const { ip: _ip, ...onWire } = d;
      const datagram = Buffer.from(JSON.stringify({ stageUtility: "discover", v: 1, ...onWire }));
      socket.send(datagram, port, "127.0.0.1", (err) => {
        if (err) return reject(err);
        if (--left === 0) {
          socket.close();
          resolve();
        }
      });
    }
  });
}
