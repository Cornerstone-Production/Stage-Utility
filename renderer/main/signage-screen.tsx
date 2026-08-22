// signage-screen.tsx — a whole wall screen playing signage.
//
// The surface, not the player. It owns the clock (the player deliberately holds
// no timers, so something has to advance it) and, from the task that adds the
// horizon channel, the subscription that decides what to play.
//
// Ticking at 100ms rather than per animation frame: the player is a pure
// function of the time it is given, and a transition is 600ms by default, so a
// tenth of a second is imperceptible and costs a Pi almost nothing. rAF would
// re-render 60 times a second for eight seconds of a still image.

import { useEffect, useState } from "react";

import { SignagePlayer } from "./signage-player";
import { useSignagePlan } from "./use-signage-plan";

const TICK_MS = 100;

export function SignageScreen({ outputId }: { outputId: string }) {
  const [now, setNow] = useState(() => Date.now());
  const { entry } = useSignagePlan(outputId, now);


  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Fills the screen and is black behind whatever it draws — including when
  // there is nothing to draw, which is the correct appearance for "no schedule
  // matches right now" rather than a state worth reporting on a wall.
  return <SignagePlayer entry={entry} nowMs={now} className="block h-full w-full" />;
}
