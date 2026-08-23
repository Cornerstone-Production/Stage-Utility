// signage-screen.tsx — a whole wall screen playing signage.
//
// The surface, not the player. It owns the clock (the player deliberately holds
// no timers, so something has to advance it), the subscription that decides what
// to play, and the offline machinery: prefetching what is coming, keeping the
// plan across a reboot, and playing the group's default when it starts up with
// no server at all.
//
// Ticking at 100ms rather than per animation frame: the player is a pure
// function of the time it is given, and a transition is 600ms by default, so a
// tenth of a second is imperceptible and costs a Pi almost nothing. rAF would
// re-render 60 times a second through eight seconds of a still image.

import { useEffect, useState } from "react";
import type { SignageHorizonEntry } from "@main/types/signage";

import { bootEntry } from "./signage-hold";
import { loadPersistedHorizon, persistHorizon, registerSignageWorker } from "./signage-offline";
import { SignagePlayer } from "./signage-player";
import { planPrefetch } from "./signage-prefetch";
import { useSignagePlan } from "./use-signage-plan";

const TICK_MS = 100;

export function SignageScreen({ outputId }: { outputId: string }) {
  const [now, setNow] = useState(() => Date.now());
  const { entry, horizon, connected } = useSignagePlan(outputId, now);

  /** What a cold boot with no server should play, from the plan last held. */
  const [booted, setBooted] = useState<SignageHorizonEntry | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Feature-detected inside; a platform that cannot do this just loses reload
  // survival, which is not worth saying anything about on a wall.
  useEffect(() => {
    void registerSignageWorker();
  }, []);

  // The plan this screen last held, for a start-up with no server. Read once,
  // and only used while nothing better is available.
  useEffect(() => {
    let live = true;
    void loadPersistedHorizon(outputId).then((h) => {
      if (live && h) setBooted(bootEntry(h));
    });
    return () => {
      live = false;
    };
  }, [outputId]);

  // Keep the plan, and warm what is coming. Both keyed on the horizon itself, so
  // they run when it changes rather than a hundred times a second.
  useEffect(() => {
    if (horizon.length === 0) return;
    void persistHorizon(outputId, horizon).then((ok) => {
      // Reported, not swallowed: a screen whose plan did not persist comes up
      // black after a power cut, and the operator can only know that in advance
      // if somebody says so. Same shape as the boot-record warning next door.
      if (!ok) {
        console.warn(
          "[signage] this screen could not store its plan - a reboot with no server will be black",
        );
      }
    });

    const plan = planPrefetch(horizon, Date.now());
    if (plan.skipped.length) {
      // Said out loud. A display that fetched less than it needed still LOOKS
      // ready, and the pause at the boundary is the first anyone would know.
      console.warn(
        `[signage] prefetch cap reached; ${plan.skipped.length} asset(s) not held:`,
        plan.skipped.map((s) => s.url).join(", "),
      );
    }
    for (const url of plan.urls) {
      // A plain fetch: the browser's HTTP cache holds it, and where a service
      // worker is running its media handler puts it in Cache Storage too.
      void fetch(url, { cache: "force-cache" }).catch(() => {
        /* a warmed asset that failed is fetched again when its turn comes */
      });
    }
  }, [outputId, horizon]);

  // A screen that has never reached a server this session falls back to the
  // group's default from the persisted plan — deliberately not to whatever the
  // clock says, because a Pi has no battery-backed clock and after a cold boot
  // offline it cannot trust what time it thinks it is.
  const drawn = entry ?? (connected ? null : booted);

  return <SignagePlayer entry={drawn} nowMs={now} className="block h-full w-full" />;
}
