// fakes/shure.mjs — a Shure ULX-D receiver, as far as the app can tell.
//
// Speaks the ASCII-over-TCP protocol the driver in
// main/providers/wireless/shure-ulxd.ts reads: `< GET 0 ALL >` is answered with
// one REP frame per field per channel, then a SAMPLE frame per channel every
// second so the meters move. Values come from the invented WIRELESS_CHANNELS.

import net from "node:net";

import { WIRELESS_CHANNELS } from "../world.mjs";

const pad = (n, width) => String(n).padStart(width, "0");

function repFrames(channels) {
  const frames = [];
  channels.forEach((c, i) => {
    const ch = i + 1;
    const present = c.bars !== 255;
    frames.push(`REP ${ch} CHAN_NAME {${c.name}}`);
    frames.push(`REP ${ch} BATT_BARS ${pad(c.bars, 3)}`);
    frames.push(`REP ${ch} BATT_CHARGE ${pad(c.charge, 3)}`);
    frames.push(`REP ${ch} BATT_RUN_TIME ${pad(c.mins, 5)}`);
    frames.push(`REP ${ch} FREQUENCY ${pad(c.freq, 6)}`);
    frames.push(`REP ${ch} AUDIO_MUTE ${c.muted ? "ON" : "OFF"}`);
    frames.push(`REP ${ch} RF_INT_DET NONE`);
    frames.push(`REP ${ch} CHAN_QUALITY ${pad(c.quality, 3)}`);
    frames.push(`REP ${ch} TX_TYPE ${present ? "ULXD2" : "UNKN"}`);
  });
  return frames;
}

function sampleFrames(channels, tick) {
  return channels.map((c, i) => {
    if (c.bars === 255) return `SAMPLE ${i + 1} ALL X 000 000`;
    // A little movement so the meters read as live rather than painted.
    const wobble = Math.sin(tick / 2 + i) * 0.12;
    const audio = Math.max(0, Math.min(1, c.audio + (c.audio > 0 ? wobble : 0)));
    return `SAMPLE ${i + 1} ALL A ${pad(c.rf + 128, 3)} ${pad(Math.round(audio * 50), 3)}`;
  });
}

/**
 * Start the fake receiver on a loopback port the OS picks.
 *
 * One server answers for every invented receiver address: the connection's
 * remote address is gone by the time it arrives, so `hostFor` is told which
 * address the app meant when it dialled (see preload.mjs).
 *
 * @returns {Promise<{ port: number, close: () => void, expect: (localPort: number, host: string) => void }>}
 */
export async function startFakeShure() {
  /** Which invented host each inbound socket stands for, keyed by remote port. */
  const hosts = new Map();
  const sockets = new Set();
  let tick = 0;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      // Looked up here, not at accept: the dialling side records which address it
      // meant on its own 'connect', which can land after the accept.
      const channels = WIRELESS_CHANNELS[hosts.get(socket.remotePort)] ?? WIRELESS_CHANNELS["192.168.1.41"];
      buffer += chunk;
      const segments = buffer.split(">");
      buffer = segments.pop() ?? "";
      for (const raw of segments) {
        const cmd = raw.replace(/^[\s<]+/, "").trim().toUpperCase();
        if (cmd === "GET 0 ALL") for (const f of repFrames(channels)) socket.write(`< ${f} >\n`);
        else if (cmd.endsWith("METER_RATE") || cmd.startsWith("SET 0 METER_RATE")) socket.write("< REP 1 METER_RATE 01000 >\n");
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });

  const timer = setInterval(() => {
    tick++;
    for (const socket of sockets) {
      const host = hosts.get(socket.remotePort);
      const channels = WIRELESS_CHANNELS[host] ?? WIRELESS_CHANNELS["192.168.1.41"];
      for (const f of sampleFrames(channels, tick)) socket.write(`< ${f} >\n`);
    }
  }, 1000);
  timer.unref();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    expect: (localPort, host) => hosts.set(localPort, host),
    close: () => {
      clearInterval(timer);
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
