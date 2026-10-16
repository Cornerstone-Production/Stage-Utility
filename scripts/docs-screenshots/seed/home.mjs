// seed/home.mjs — which cards Home shows.
//
// Home is a view like the others (id "home"), its tiles layout objects with a grid
// size and a mood. The default set includes Recording and SPL, which read
// "Offline" on a machine with no recorder and no Smaart; this set keeps to cards
// that have something to say here, and adds the clock and the wireless summary.

import { layout, obj } from "./layout-kit.mjs";

export async function seedHome(api) {
  const tile = (config, home, id) => obj(config, [0, 0, 1, 0.1], { id, extra: { home }, style: {} });
  const objects = [
    tile({ type: "home-live-status" }, { size: "xl", when: "live" }, "home-live-status"),
    tile({ type: "home-next-service" }, { size: "m", when: "idle" }, "home-next-service"),
    tile({ type: "home-screens" }, { size: "s", when: "always" }, "home-screens"),
    tile({ type: "wireless-summary", showOnline: true, showBattery: true, showRuntime: false, showLabel: true, label: "Wireless" }, { size: "s", when: "always" }, "home-wireless"),
    tile({ type: "clock", showSeconds: false, format: "12h", showMeridiem: true }, { size: "s", when: "always" }, "home-clock"),
    tile({ type: "home-readiness" }, { size: "m", when: "idle" }, "home-readiness"),
    tile({ type: "home-recent-services" }, { size: "xl", when: "always" }, "home-recent-services"),
  ];
  await api.patch("/api/views/home", { layout: { ...layout(objects, { background: null, fit: "responsive" }) } });
}
