// Enrolment: the one URL a kiosk device ever opens, and the API behind Devices.
//
// The device's URL never changes. `/enroll?device=<id>&token=<t>` either
// redirects to the display it is bound to, or shows the holding screen — so the
// SD card holds no display number and the server decides what a screen shows.

import { type RouteCtx, json, error, readBody } from "./context.js";
import { kioskDevicesStore, authorise, claim, release, findById, findByOutput, matchByMac, withoutTokens, pinSecret, updateDevices } from "../kiosk-devices-store.js";
import { seenDevices, startScan, stopScan, scanning, forgetSeen, rememberSecret, secretFor, rememberScreen, recordHealth, healthList, forgetHealth } from "../kiosk-presence.js";
import { parseHealthReport } from "../output-health.js";
import { headerValue } from "../http-origin.js";
import { screenFromQuery, describeScreen } from "../kiosk-screen-size.js";
import { holdingScreen } from "../kiosk-holding-screen.js";
import { stageController } from "../stage-controller.js";
import type { CreateScreenInput } from "../../types/views.js";
import { answerScreenWriteFailure, CREATE_SCREEN_FIELDS, readCreateScreenBody } from "./screen-write.js";
import { errorMessage } from "../errors.js";
import { scrub } from "../scrub.js";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { APP_ROOT } from "../app-root.js";

/** Exactly what may be served from scripts/kiosk. An allowlist rather than a
 *  path join, because this reads a file from disk on request. */
const KIOSK_INSTALLERS = new Set(["install-linux.sh", "install-macos.sh", "install-windows.ps1"]);

/** A device id from a query string is untrusted. Bound like the datagram is. */
const clean = (v: string | null): string | undefined =>
  v && v.length > 0 && v.length <= 128 ? v : undefined;

export async function kioskDeviceRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, url, method } = c;

  // ── The device's own URL ────────────────────────────────────────────────
  if (method === "GET" && pathname === "/enroll") {
    const id = clean(url.searchParams.get("device"));
    // The device's own secret, generated at install. Over unicast HTTP, never in
    // the broadcast probe.
    const token = clean(url.searchParams.get("token"));
    if (!id) {
      // No id at all: a person opened this by hand. Say so rather than 404.
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(holdingScreen({ id: null, reason: "no-device" }));
      return;
    }
    const devices = await kioskDevicesStore.load();
    // Remember it even when unclaimed: this is what claim() pins, and it is the
    // only channel a shell-script-and-a-browser agent has to tell us its secret.
    if (token) rememberSecret(id, token);
    const device = authorise(devices, id, token);
    if (device) {
      // Claimed before it had ever enrolled — pin what it just showed us.
      if (device.token === "" && token) {
        await updateDevices((current) => pinSecret(current, id, token));
      }
      // Bound and proven. Straight to its display — this is the path taken on
      // every boot forever after the one time somebody claimed it.
      //
      // The device id rides along so its heartbeats are attributable. Without it
      // ANY browser opening this screen's URL — a phone checking the wall panel —
      // reports its own size as the screen's, and the card then shows 390 x 844
      // until the real device next checks in.
      res.writeHead(302, {
        location: `/${device.outputId}?device=${encodeURIComponent(device.id)}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    // Unbound, or a token that does not match. Both are the same thing from
    // here: this device is not (yet) allowed to show a display.
    // The holding screen puts its own size on the reload URL. It is the only
    // way a Mac or a PC reports one before it is claimed — the physical mode in
    // the probe comes from /sys/class/drm, which is Linux only.
    const reported = screenFromQuery(url.searchParams);
    if (reported) rememberScreen(id, reported);
    const seen = seenDevices().find((d) => d.id === id);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(holdingScreen({
      id,
      ip: seen?.ip,
      hostname: seen?.hostname,
      mac: seen?.macs[0],
      screen: describeScreen(seen?.screen),
      reason: "unclaimed",
    }));
    return;
  }

  // ── The installer, served by the server it installs against ─────────────
  // So the whole setup is one line typed at the screen, and the URL in it is the
  // server you are standing in front of.
  if (method === "GET" && pathname.startsWith("/kiosk/install-")) {
    const name = pathname.slice("/kiosk/".length);
    // Allowlist, not a path join: this reads a file from disk on request.
    if (!KIOSK_INSTALLERS.has(name)) {
      error(res, "unknown installer", 404);
      return;
    }
    try {
      // APP_ROOT, not a path relative to this module. `import.meta.url` is
      // main/services/routes/ in a checkout but the bundled server.mjs at the
      // install root, where "../../../scripts" resolves to file:///scripts and
      // 404s. app-root.ts exists for exactly this and is used in five other
      // places; this was the copy that drifted.
      const body = await readFile(path.join(APP_ROOT, "scripts", "kiosk", name), "utf8");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    } catch {
      error(res, "installer not found in this build", 404);
    }
    return;
  }

  // ── Devices page ────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/devices") {
    const bound = await kioskDevicesStore.load();
    const seen = seenDevices();
    json(res, {
      scanning: scanning(),
      // Tokens stripped: reads are open on this server, and a listing that hands
      // out the secret makes the token check meaningless.
      bound: withoutTokens(bound),
      // Everything currently heard that we have NOT already bound. A device
      // bound elsewhere only reaches this list when it says it cannot reach the
      // server that owns it — see decideProbe.
      // No stripping needed: a device's secret is not a field on the record any
      // more, it lives in its own map. A field that had to be removed on the way
      // out was removed here and forgotten on the SSE broadcast.
      seen: seen.filter((s) => !bound.some((b) => b.id === s.id)),
      // What each helper output last reported about itself, for the ones that
      // are still reporting. Runtime: never stored, gone on restart.
      health: healthList(),
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

  // ── An output helper's health, from the device itself ──────────────────
  // Authenticated by the device's own secret, the one /enroll checks, not by the
  // same-origin gate a browser is held to: the caller is a native app. The secret
  // travels as `Authorization: Bearer <secret>` or as `?token=`, as it does to
  // /enroll. An id this server holds no binding for is 404, a wrong or missing
  // secret is 401, and neither says anything about the other.
  const healthMatch = method === "POST" ? pathname.match(/^\/api\/devices\/([^/]+)\/health$/) : null;
  if (healthMatch) {
    let id: string;
    try {
      id = decodeURIComponent(healthMatch[1]);
    } catch {
      error(res, "the device id in the path is not valid", 400);
      return;
    }
    const devices = await kioskDevicesStore.load();
    if (!findById(devices, id)) {
      error(res, "no device is set up with that id", 404);
      return;
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(headerValue(req.headers, "authorization"))?.[1];
    if (!authorise(devices, id, clean(bearer ?? null) ?? clean(url.searchParams.get("token")))) {
      error(res, "the device secret is missing or wrong", 401);
      return;
    }
    const parsed = parseHealthReport(await readBody(req));
    if ("error" in parsed) {
      error(res, parsed.error, 400);
      return;
    }
    recordHealth(id, parsed.report);
    json(res, { ok: true });
    return;
  }

  if (method === "POST" && pathname === "/api/devices/scan") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const holder = typeof body.holder === "string" ? body.holder.slice(0, 64) : "manual";
    if (body.stop === true) stopScan(holder);
    else startScan(holder);
    json(res, { scanning: scanning() });
    return;
  }

  if (method === "POST" && pathname === "/api/devices/claim") {
    const alreadyBound = (on: string) => {
      const screen = stageController.getOutputs().find((o) => o.id === on);
      return `This device was set up as "${screen?.name ?? on}" meanwhile, so it is not made a new screen. Release it from that screen first.`;
    };
    const body = (await readBody(req)) as Record<string, unknown>;
    const id = typeof body.deviceId === "string" ? body.deviceId : "";
    let outputId = typeof body.outputId === "string" ? body.outputId : "";
    if (!id) {
      error(res, "body.deviceId is required");
      return;
    }
    const seen = seenDevices().find((d) => d.id === id);
    // No output named: this is a brand new screen. Creating one HERE rather than
    // when the device was first heard is deliberate — a spare machine booting
    // must not mint a screen nobody asked for, and deleting a phantom would not
    // stick while it kept announcing itself. Creation is the operator pressing
    // "Set up as a new screen".
    //
    // Through createScreen, the same path POST /api/outputs takes, so the guided
    // setup can name a role, a view, a friendly link and the sidebar listing and
    // have them validated before anything is written. The binding is its LAST
    // step, so a binding that fails takes back everything before it in one
    // rollback: the screen, a view made for it, and a sidebar listing written on
    // a view that already existed. An error must not leave a brand new empty
    // screen behind, the exact phantom the paragraph above says this avoids.
    // Read BEFORE anything is written: a body that is wrong is refused with
    // nothing created.
    let input: CreateScreenInput | null = null;
    if (!outputId) {
      // A device that is already bound is not waiting, so it is not set up as a
      // new screen: the panel offering that was opened on a device another
      // operator has bound since, and a new screen would silently take it from
      // the screen it shows. Moving it is the operator naming the screen
      // (`outputId`), which stays allowed. Nothing else sends a claim without
      // one: the Screens page lists only devices that are not bound here.
      const already = findById(await kioskDevicesStore.load(), id);
      if (already) {
        error(res, alreadyBound(already.outputId), 409);
        return;
      }
      const read = readCreateScreenBody(body);
      if ("error" in read) {
        error(res, read.error);
        return;
      }
      // `name` first, then `newName` the Screens page used to send, then the
      // device's own hostname. `||` for the hostname, as it always was: a device
      // that reports an empty one is "New screen", not "Display N".
      const named = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
      read.name = named(body.name) ?? named(body.newName) ?? (seen?.hostname || "New screen");
      input = read;
    } else if (CREATE_SCREEN_FIELDS.some((f) => f in body)) {
      // Naming a screen to take over AND describing a new one: one of the two is a
      // mistake, and quietly ignoring the description would hide which.
      error(res, `body.outputId names an existing screen, so ${CREATE_SCREEN_FIELDS.join(", ")} (which describe a new one) must not be sent`);
      return;
    }
    let displacedId: string | null = null;
    const bind = (target: string) =>
      updateDevices((current) => {
        // Checked again inside the write, for a binding that landed while the
        // screen was being made. Throwing here fails createScreen's last step,
        // which takes the new screen back.
        const bound = input ? findById(current, id) : undefined;
        if (bound) throw new Error(alreadyBound(bound.outputId));
        const { devices, displaced } = claim(current, id, target, {
          secret: secretFor(id),
          macs: seen?.macs, hostname: seen?.hostname, os: seen?.os, ip: seen?.ip,
          screen: seen?.screen,
          output: seen?.output,
          label: typeof body.label === "string" ? body.label : undefined,
          now: Date.now(),
        });
        displacedId = displaced?.id ?? null;
        return devices;
      });
    try {
      if (input) {
        // The created output, not the last one in the returned state: two
        // operators pressing this at once would otherwise both read the later
        // id and claim the same screen.
        const made = await stageController.createScreen(input, {
          label: "bind the device",
          run: (output) => bind(output.id),
        });
        outputId = made.output.id;
      } else {
        await bind(outputId);
      }
      // It is bound now, so it stops being something to claim. Without this it
      // lingers in the unclaimed list for the whole TTL, which reads as the
      // claim not having worked.
      forgetSeen(id);
      // What a displaced device reported was about the screen it no longer shows.
      if (displacedId) forgetHealth(displacedId);
      if (seen?.output) {
        console.log(
          `[output-helper] claimed: ${scrub(id)} (${scrub(seen.output.kind)} "${scrub(seen.output.name)}") now shows screen ${scrub(outputId)}`
          + (displacedId ? `, displacing ${scrub(displacedId)}` : ""),
        );
      }
      // Tell the kiosk pages to reload: the device is sitting on the holding
      // screen and this is what sends it to its display. "all", not the output
      // id — the device is not showing that output yet, it is on /enroll, so
      // targeting the output would refresh everything except the one screen
      // that needs it.
      stageController.refreshDisplays("all");
      // claim()'s `token` is deliberately not read: the device already holds the
      // secret, and a response carrying it would put it in a browser and a log.
      json(res, { ok: true, displaced: displacedId, outputId });
    } catch (err) {
      // The same answer POST /api/outputs gives: a refusal made before anything
      // was written is a 400; a failure part-way is a 500 saying what was and was
      // not put back.
      answerScreenWriteFailure(res, err);
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
      const output = findById(await kioskDevicesStore.load(), id)?.output;
      await updateDevices((current) => release(current, id));
      forgetHealth(id);
      if (output) {
        console.log(`[output-helper] released: ${scrub(id)} (${scrub(output.kind)} "${scrub(output.name)}") is not set up again`);
      }
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
    const device = findByOutput(bound, outputId);
    json(res, { device: device ? withoutTokens([device])[0] : null });
    return;
  }
}
