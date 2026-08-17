// Enrolment: the one URL a kiosk device ever opens, and the API behind Devices.
//
// The device's URL never changes. `/enroll?device=<id>&token=<t>` either
// redirects to the display it is bound to, or shows the holding screen — so the
// SD card holds no display number and the server decides what a screen shows.

import { type RouteCtx, json, error, readBody } from "./context.js";
import { kioskDevicesStore, authorise, claim, release, findByOutput, matchByMac } from "../kiosk-devices-store.js";
import { seenDevices, startScan, stopScan, scanning, scanEndsAt, forgetSeen } from "../kiosk-presence.js";
import { holdingScreen } from "../kiosk-holding-screen.js";
import { stageController } from "../stage-controller.js";
import { errorMessage } from "../errors.js";

/** A device id from a query string is untrusted. Bound like the datagram is. */
const clean = (v: string | null): string | undefined =>
  v && v.length > 0 && v.length <= 128 ? v : undefined;

export async function kioskDeviceRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;

  // ── The device's own URL ────────────────────────────────────────────────
  if (method === "GET" && pathname === "/enroll") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const id = clean(url.searchParams.get("device"));
    const token = clean(url.searchParams.get("token"));
    if (!id) {
      // No id at all: a person opened this by hand. Say so rather than 404.
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(holdingScreen({ id: null, reason: "no-device" }));
      return;
    }
    const devices = await kioskDevicesStore.load();
    const device = authorise(devices, id, token);
    if (device) {
      // Bound and proven. Straight to its display — this is the path taken on
      // every boot forever after the one time somebody claimed it.
      res.writeHead(302, { location: `/${device.outputId}`, "cache-control": "no-store" });
      res.end();
      return;
    }
    // Unbound, or a token that does not match. Both are the same thing from
    // here: this device is not (yet) allowed to show a display.
    const seen = seenDevices().find((d) => d.id === id);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(holdingScreen({
      id,
      ip: seen?.ip,
      hostname: seen?.hostname,
      mac: seen?.macs[0],
      reason: "unclaimed",
    }));
    return;
  }

  // ── Devices page ────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/devices") {
    const bound = await kioskDevicesStore.load();
    const seen = seenDevices();
    json(res, {
      scanning: scanning(),
      scanEndsAt: scanEndsAt(),
      bound,
      // Everything currently heard that we have NOT already bound. A device
      // bound elsewhere only reaches this list when it says it cannot reach the
      // server that owns it — see decideProbe.
      seen: seen.filter((s) => !bound.some((b) => b.id === s.id)),
      // For each unclaimed device, which bound devices share a MAC — the
      // "this looks like Left Mic Display" hint. A suggestion, never a binding.
      matches: Object.fromEntries(
        seen
          .filter((s) => !bound.some((b) => b.id === s.id))
          .map((s) => [s.id, matchByMac(bound, s.macs).map((d) => d.id)])
          .filter(([, ids]) => (ids as string[]).length > 0),
      ),
    });
    return;
  }

  if (method === "POST" && pathname === "/api/devices/scan") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const holder = typeof body.holder === "string" ? body.holder.slice(0, 64) : "manual";
    if (body.stop === true) stopScan(holder);
    else startScan(holder);
    json(res, { scanning: scanning(), scanEndsAt: scanEndsAt() });
    return;
  }

  if (method === "POST" && pathname === "/api/devices/claim") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const id = typeof body.deviceId === "string" ? body.deviceId : "";
    const outputId = typeof body.outputId === "string" ? body.outputId : "";
    if (!id || !outputId) {
      error(res, "body.deviceId and body.outputId are required");
      return;
    }
    const seen = seenDevices().find((d) => d.id === id);
    try {
      let issued = "";
      let displacedId: string | null = null;
      await kioskDevicesStore.update((current) => {
        const { devices, token, displaced } = claim(current, id, outputId, {
          macs: seen?.macs, hostname: seen?.hostname, os: seen?.os, ip: seen?.ip,
          label: typeof body.label === "string" ? body.label : undefined,
          now: Date.now(),
        });
        issued = token;
        displacedId = displaced?.id ?? null;
        return devices;
      });
      // It is bound now, so it stops being something to claim. Without this it
      // lingers in the unclaimed list for the whole TTL, which reads as the
      // claim not having worked.
      forgetSeen(id);
      // Tell the kiosk pages to reload: the device is sitting on the holding
      // screen and this is what sends it to its display. "all", not the output
      // id — the device is not showing that output yet, it is on /enroll, so
      // targeting the output would refresh everything except the one screen
      // that needs it.
      stageController.refreshDisplays("all");
      json(res, { ok: true, token: issued, displaced: displacedId });
    } catch (err) {
      error(res, errorMessage(err));
    }
    return;
  }

  if (method === "POST" && pathname === "/api/devices/release") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const id = typeof body.deviceId === "string" ? body.deviceId : "";
    if (!id) {
      error(res, "body.deviceId is required");
      return;
    }
    try {
      await kioskDevicesStore.update((current) => release(current, id));
      stageController.refreshDisplays("all");
      json(res, { ok: true });
    } catch (err) {
      error(res, errorMessage(err));
    }
    return;
  }

  // Which output a device is on, for the Screens page's per-output line.
  if (method === "GET" && pathname.startsWith("/api/devices/for-output/")) {
    const outputId = decodeURIComponent(pathname.slice("/api/devices/for-output/".length));
    const bound = await kioskDevicesStore.load();
    json(res, { device: findByOutput(bound, outputId) ?? null });
    return;
  }
}
