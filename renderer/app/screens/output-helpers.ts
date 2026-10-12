// What the Screens page says about an output of a Mac output helper, as pure
// functions: one phrasing each, so the card, the Not set up yet rows and Screen
// settings cannot drift apart.

import { DEFAULT_VIDEO_MODE } from "@main/types/output-format";
import { REPEATED_BAD_PERCENT } from "@main/services/output-health";
import type { DeviceOutput, ScreenSize } from "@main/types/kiosk";
import type { OutputHealth } from "@main/types/output-health";

/** The card's name out of an output's, which reads `<port> · <card>`; the whole
 *  name when it does not start with the port. There is no wire field for the card
 *  yet, so this reads it back out of the name the helper built. */
export function cardOf(output: DeviceOutput): string {
  const prefix = `${output.port} · `;
  return output.name.startsWith(prefix) ? output.name.slice(prefix.length) : output.name;
}

/** "60 Hz" out of a mode such as "1920x1080@60" or "1920x1080 59.94Hz"; undefined
 *  when the mode names no rate, which is every mode a Linux agent reports. */
export function refreshRate(mode: string | undefined): string | undefined {
  const m = mode?.match(/@\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*hz\b/i);
  const hz = m?.[1] ?? m?.[2];
  return hz ? `${hz} Hz` : undefined;
}

/** "1920 × 1080 · 60 Hz" for a display the Mac drives: the size it is driven at,
 *  and the rate when the probe's mode carries one. Either part is left out when
 *  it is not known. */
function displayMode(screen: ScreenSize | undefined): string {
  if (!screen) return "";
  const driven = screen.mode?.match(/^(\d+)\s*x\s*(\d+)/i);
  const size = driven ? `${driven[1]} × ${driven[2]}` : screen.w > 0 && screen.h > 0 ? `${screen.w} × ${screen.h}` : "";
  return [size, refreshRate(screen.mode)].filter(Boolean).join(" · ");
}

/**
 * The mode an output is sending: a DeckLink port sends the mode its screen is set
 * to (the house standard until one is chosen), and a display runs at whatever the
 * Mac drives it at. Empty when a display's size is not known yet.
 */
export function outputModeLine(
  output: Pick<DeviceOutput, "kind">,
  videoMode: string | undefined,
  screen: ScreenSize | undefined,
): string {
  return output.kind === "decklink" ? (videoMode ?? DEFAULT_VIDEO_MODE) : displayMode(screen);
}

/** What a struggling output says about itself on its screen's card. */
export interface OutputStruggle {
  port: string;
  repeated: number;
  dropped: number;
}

/**
 * The card's warning, after its bold lead: what the figures show, then what to
 * check. A late page and a card that ran out of frames have the same remedy, so
 * there is one sentence for it.
 */
export function outputStruggleSentences(s: Pick<OutputStruggle, "repeated" | "dropped">): string[] {
  const seen: string[] = [];
  if (s.repeated >= REPEATED_BAD_PERCENT) seen.push(`${Math.round(s.repeated)}% of its frames repeated because the page ran late.`);
  if (s.dropped > 0) seen.push(`The card has dropped ${s.dropped} frames since the output opened.`);
  return [...seen, "Check the Mac's load and how much this screen's view draws."];
}

/**
 * Which screens have an output in trouble, by screen id: the devices bound to
 * them whose last health report says struggling.
 */
export function struggleByScreen(
  bound: readonly { id: string; outputId: string; output?: DeviceOutput }[],
  health: readonly OutputHealth[],
): Map<string, OutputStruggle> {
  const out = new Map<string, OutputStruggle>();
  for (const d of bound) {
    const h = d.output ? health.find((x) => x.deviceId === d.id) : undefined;
    if (d.output && h?.struggling) out.set(d.outputId, { port: d.output.port, repeated: h.repeated, dropped: h.dropped });
  }
  return out;
}
