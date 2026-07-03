// sennheiser-probe.mts — dev-only integration test for the Sennheiser providers.
//
// Spins up mock devices (a UDP SSC responder for EW-G4 / EW-DX / CHG 70N, and an
// HTTPS + SSE server for Spectera), points each provider at 127.0.0.1, and asserts
// the emitted DeviceStatus maps telemetry correctly. No real hardware needed.
//
//     npx tsx scripts/sennheiser-probe.mts
//
// Requires `openssl` on PATH (for the Spectera mock's self-signed cert).

import * as dgram from "node:dgram";
import * as https from "node:https";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DeviceProvider, DeviceStatus } from "../main/types/devices.js";
import { SennheiserEwG4 } from "../main/providers/wireless/sennheiser-ewg4.js";
import { SennheiserEwDx } from "../main/providers/wireless/sennheiser-ewdx.js";
import { SennheiserSpectera } from "../main/providers/wireless/sennheiser-spectera.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startUdpMock(port: number, frames: object[]): Promise<dgram.Socket> {
  const s = dgram.createSocket("udp4");
  s.on("message", (_msg, rinfo) => {
    for (const f of frames) s.send(Buffer.from(JSON.stringify(f)), rinfo.port, rinfo.address);
  });
  return new Promise((res) => s.bind(port, "127.0.0.1", () => res(s)));
}

async function collect(provider: DeviceProvider, ms: number): Promise<DeviceStatus[]> {
  const out: DeviceStatus[] = [];
  provider.onStatus((s) => out.push(s));
  await sleep(ms);
  return out;
}
// Latest status per channel.
function byChannel(list: DeviceStatus[]): Map<string, DeviceStatus> {
  const m = new Map<string, DeviceStatus>();
  for (const s of list) m.set(s.channelId, s);
  return m;
}

async function testEwG4(): Promise<void> {
  console.log("\n▶ EW-G4 (SSCv1, UDP)");
  const mock = await startUdpMock(14545, [
    { rx1: { name: "Vocal 1", frequency: 516125, rf: { level: -60, quality: 80 }, bat: 75, audio: { level: -20 } } },
    { rx2: { name: "Vocal 2", frequency: 518000, rf: { level: -85, quality: 30 }, bat: 40, audio: { level: -35 } } },
  ]);
  const p = new SennheiserEwG4();
  await p.connect({ host: "127.0.0.1", port: 14545, channels: 2 });
  const ch = byChannel(await collect(p, 1200));
  check("ch1 name", ch.get("1")?.name === "Vocal 1", ch.get("1")?.name);
  check("ch1 battery 75", ch.get("1")?.battery === 75, String(ch.get("1")?.battery));
  check("ch1 frequency 516.125 MHz", ch.get("1")?.frequencyLabel === "516.125 MHz", String(ch.get("1")?.frequencyLabel));
  check("ch1 rfBars from quality 80 → 4", ch.get("1")?.rfBars === 4, String(ch.get("1")?.rfBars));
  check("ch1 online", ch.get("1")?.online === true);
  check("ch2 battery 40", ch.get("2")?.battery === 40, String(ch.get("2")?.battery));
  await p.disconnect();
  mock.close();
}

async function testEwDx(): Promise<void> {
  console.log("\n▶ EW-DX EM2 (SSCv2, UDP)");
  const mock = await startUdpMock(14546, [
    { rx1: { name: "Wireless 1", frequency: 516125 }, m: { rx1: { rsqi: 90 } }, mates: { tx1: { battery: { gauge: 80 }, name: "HH1" } } },
    { rx2: { frequency: 520000 }, m: { rx2: { rsqi: 20 } }, mates: { tx2: { battery: { gauge: 55 }, name: "BP2" } } },
  ]);
  const p = new SennheiserEwDx();
  await p.connect({ host: "127.0.0.1", port: 14546, model: "EM2" });
  const ch = byChannel(await collect(p, 1200));
  check("ch1 name (rx)", ch.get("1")?.name === "Wireless 1", ch.get("1")?.name);
  check("ch1 battery from mates.tx1.battery.gauge 80", ch.get("1")?.battery === 80, String(ch.get("1")?.battery));
  check("ch1 rfBars from rsqi 90 → 5", ch.get("1")?.rfBars === 5, String(ch.get("1")?.rfBars));
  check("ch1 frequency 516.125 MHz", ch.get("1")?.frequencyLabel === "516.125 MHz", String(ch.get("1")?.frequencyLabel));
  check("ch2 name falls back to tx name BP2", ch.get("2")?.name === "BP2", ch.get("2")?.name);
  check("ch2 rfBars from rsqi 20 → 1", ch.get("2")?.rfBars === 1, String(ch.get("2")?.rfBars));
  await p.disconnect();
  mock.close();
}

async function testCharger(): Promise<void> {
  console.log("\n▶ EW-DX CHG 70N charger (SSCv2, UDP)");
  const mock = await startUdpMock(14547, [
    { bays: { bat_gauge: [50, 90], state: ["NORMAL", "NORMAL"], bat_health: [95, 97], bat_cycles: [10, 12], device_type: ["EW-DX SK", "BA70"] } },
  ]);
  const p = new SennheiserEwDx();
  await p.connect({ host: "127.0.0.1", port: 14547, model: "CHG70N" });
  const ch = byChannel(await collect(p, 1200));
  check("bay1 deviceType charger", ch.get("1")?.deviceType === "charger", ch.get("1")?.deviceType);
  check("bay1 battery 50", ch.get("1")?.battery === 50, String(ch.get("1")?.battery));
  check("bay1 health 95", ch.get("1")?.health === 95, String(ch.get("1")?.health));
  check("bay1 cycles 10", ch.get("1")?.cycles === 10, String(ch.get("1")?.cycles));
  check("bay1 charging (NORMAL & <100)", ch.get("1")?.charging === true, String(ch.get("1")?.charging));
  check("bay2 battery 90", ch.get("2")?.battery === 90, String(ch.get("2")?.battery));
  await p.disconnect();
  mock.close();
}

async function testSpectera(): Promise<void> {
  console.log("\n▶ Spectera (SSCv2, HTTPS + SSE)");
  const dir = os.tmpdir();
  const keyPath = path.join(dir, "spectera-test.key");
  const certPath = path.join(dir, "spectera-test.crt");
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 1 -subj "/CN=localhost"`, { stdio: "ignore" });
  const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    if (req.method === "GET" && req.url === "/api/ssc/state/subscriptions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: open\ndata: {"sessionUUID":"test-123"}\n\n`);
      const payload = { address: "/api/mts/paired/all/SEK01", value: { name: "Guitar", state: "Connected", battery: { gauge: 66 }, rf: { quality: 88 }, frequency: 550000 } };
      const t = setInterval(() => res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`), 250);
      req.on("close", () => clearInterval(t));
    } else if (req.method === "PUT") {
      res.writeHead(200);
      res.end("{}");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(14548, "127.0.0.1", r));

  const p = new SennheiserSpectera();
  await p.connect({ host: "127.0.0.1", port: 14548, password: "x" });
  const ch = byChannel(await collect(p, 1500));
  check("SEK01 discovered", ch.has("SEK01"), [...ch.keys()].join(","));
  check("SEK01 name Guitar", ch.get("SEK01")?.name === "Guitar", ch.get("SEK01")?.name);
  check("SEK01 online (state=Connected)", ch.get("SEK01")?.online === true, String(ch.get("SEK01")?.online));
  check("SEK01 battery 66", ch.get("SEK01")?.battery === 66, String(ch.get("SEK01")?.battery));
  check("SEK01 rfBars from quality 88 → 4", ch.get("SEK01")?.rfBars === 4, String(ch.get("SEK01")?.rfBars));
  check("SEK01 frequency 550.000 MHz", ch.get("SEK01")?.frequencyLabel === "550.000 MHz", String(ch.get("SEK01")?.frequencyLabel));
  await p.disconnect();
  server.close();
}

async function main(): Promise<void> {
  await testEwG4();
  await testEwDx();
  await testCharger();
  await testSpectera();
  console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
