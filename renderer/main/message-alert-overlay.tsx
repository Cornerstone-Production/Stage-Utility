// message-alert-overlay.tsx — a stage-message alert, drawn over whatever a kiosk
// screen is showing.
//
// DRAWN AS THE APPROVED MOCKUP DRAWS IT: a banner across the bottom of the screen
// (3% in from each side, 4% up), the word Alert and then the message large and
// white on a deep red ground with a red edge, and a bar along its foot that runs
// down to nothing as the alert's 30 seconds do. It rises into place when it
// arrives. Sizes are the mockup's container-query widths, against a full-screen
// container, with a floor so a phone-sized screen still reads it.
//
// IT NEEDS NO WIDGET. StageView draws it on every kiosk screen, whatever the
// layout or the view kind, so an alert reaches a screen showing a rundown or a
// clock as surely as one with a Messages widget on it.
//
// WHICH ALERT. The newest running alert sent to Everyone or to a group this
// screen is in; when it ends, the next one sent to this screen (if any) shows. A
// screen in no group still gets Everyone's.
//
// THE CLOCK. Whether an alert is running, and how much of it is left, is read
// against the SERVER's clock (useServerNow) from the server-stamped `alertUntil`,
// never the browser's: a wall Pi with no NTP still ends it on time. It does not
// wait for the server's frame saying the alert ran out — that frame is the
// backstop for a screen that keeps no timer — so a late frame cannot hold a banner
// on the wall.
//
// WHERE IT IS NOT DRAWN, by StageView: on a preview (a Screens card is a picture
// of a screen, and an alert in every thumbnail would be the Screens page acting
// as one), and over blackout, which is a deliberate choice for that screen and
// returns before this is reached.
//
// IT TICKS ONLY WHILE THERE IS AN ALERT. The outer component renders on the
// channel's own frames alone; the clock hook lives in the banner, which exists
// only while an alert is on this screen's list.

import { Component, type ReactNode } from "react";

import { isAlertRunning, messageReaches, type StageMessage } from "@main/types/messages";
import { clamp } from "@main/services/clamp";
import { errorMessage } from "@main/services/errors";
import { useServerNow } from "../lib/server-clock";
import { logToServer } from "../lib/client-log";
import { useMessagesStatus } from "./use-messages-state";

/**
 * A failure drawing the banner must not blank the wall: this renders nothing and
 * says so on /log. It is the one place a render error is absorbed, and it is
 * reported, not hidden — the screen under the banner is the thing that matters
 * on a Sunday, and a banner bug taking it down is the worse outcome.
 */
class AlertBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    logToServer("messages", `the alert banner failed to draw and is hidden until reload: ${errorMessage(error)}`);
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** The groups are this screen's own; Everyone's alerts reach it whatever they are. */
export function MessageAlertOverlay({ groups }: { groups: readonly string[] }) {
  return (
    <AlertBoundary>
      <Alerts groups={groups} />
    </AlertBoundary>
  );
}

function Alerts({ groups }: { groups: readonly string[] }) {
  const { value } = useMessagesStatus();
  // The running alerts sent to this screen, newest first, as the server lists them.
  const candidates = (value?.alerts ?? []).filter((a) => messageReaches(a.to, groups));
  if (candidates.length === 0) return null;
  return <Banner candidates={candidates} />;
}

/** How much of the alert is left, 1 down to 0, from its own length. */
function alertLeft(a: StageMessage, now: number): number {
  const length = (a.alertUntil ?? 0) - a.at;
  return length > 0 ? clamp(((a.alertUntil ?? 0) - now) / length, 0, 1) : 0;
}

function Banner({ candidates }: { candidates: readonly StageMessage[] }) {
  // A quarter-second: the bar moves in steps the transition below smooths, and the
  // end is noticed within a quarter-second of the server clock passing it.
  const now = useServerNow(250);
  // The newest still running on the server's clock; the list may hold ones that ended.
  const alert = candidates.find((a) => isAlertRunning(a, now)) ?? null;
  if (!alert) return null;
  return (
    <div
      // The container the banner's sizes are measured against: the whole screen.
      // Fixed and inert, so it covers the view without taking a press from it.
      style={{ position: "fixed", inset: 0, zIndex: 40, pointerEvents: "none", containerType: "inline-size" }}
    >
      <div
        // Keyed by the alert, so the next one rises in rather than swapping text.
        key={alert.id}
        role="alert"
        className="stage-alert-rise"
        style={{
          position: "absolute",
          left: "3%",
          right: "3%",
          bottom: "4%",
          maxHeight: "70%",
          overflow: "hidden",
          boxSizing: "border-box",
          borderRadius: "1.4cqw",
          background: "#3b1219",
          border: "0.25cqw solid var(--color-danger-9, #e5484d)",
          padding: "2cqw 2.6cqw 2.6cqw",
          boxShadow: "0 1cqw 4cqw rgba(0,0,0,0.6)",
          color: "#fff",
        }}
      >
        <div style={{ display: "flex", gap: "2cqw", alignItems: "center" }}>
          <div
            style={{
              fontSize: "max(0.7rem, 1.6cqw)",
              color: "rgba(255,255,255,0.7)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            Alert
          </div>
          <div style={{ fontSize: "max(1.25rem, 3.6cqw)", fontWeight: 600, lineHeight: 1.15, overflowWrap: "anywhere" }}>
            {alert.text}
          </div>
        </div>
        <div
          data-testid="alert-bar"
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            height: "0.6cqw",
            minHeight: 3,
            width: "100%",
            background: "var(--color-danger-9, #e5484d)",
            transformOrigin: "left",
            transform: `scaleX(${alertLeft(alert, now)})`,
            transition: "transform 250ms linear",
          }}
        />
      </div>
    </div>
  );
}
