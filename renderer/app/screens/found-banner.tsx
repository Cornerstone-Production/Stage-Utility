// A banner at the top of Screens naming the screens found on the network that are
// not set up.
//
// The Not set up yet section sits below every card, so a screen that was just
// switched on is easy to miss on a page with many. This says so where the eye
// starts, and offers the one thing to do about it. It adds no way to set one up:
// Set up opens the same Screen settings panel, for the same device, that the
// section's "Set up as a new screen" does (see panelDeviceOf).
//
// Dismiss is a choice of the person at this browser, kept here and nowhere else:
// nothing on the server changes, and the device stays under Not set up yet where
// it can be set up at any time.

import { useEffect, type ReactNode } from "react";

import { Button, toast } from "../../components/ui";
import type { SeenDevice } from "@main/types/kiosk";
import type { PanelDevice } from "../../settings/sections/screen-settings-panel";
import { useDevices } from "./use-devices";
import { NOT_SET_UP_ID, foundRow, foundTitle, notSetUp, panelDeviceOf } from "./not-set-up";
import { dismissFound, restoreAllFound, restoreFound, useDismissed } from "./dismissed-found";

const LINK =
  "whitespace-nowrap rounded px-0.5 py-1 text-caption1 font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function FoundBanner({ onSetUp }: {
  /** Open the Screen settings panel for a new screen made for this device. */
  onSetUp: (device: PanelDevice) => void;
}) {
  const { seen, bound } = useDevices();
  const dismissed = useDismissed();

  // A device that was set up is no longer one to dismiss: if it is released later
  // it is a new find, and should be named again.
  const setUpIds = bound.map((b) => b.id).filter((id) => dismissed.has(id));
  const setUpKey = setUpIds.join("\n");
  useEffect(() => {
    if (setUpKey) restoreFound(setUpKey.split("\n"));
  }, [setUpKey]);

  const found = notSetUp(seen);
  const showing = found.filter((d) => !dismissed.has(d.id));
  const hidden = found.length - showing.length;
  if (showing.length === 0) return null;

  const dismiss = (d: SeenDevice) => {
    const kept = dismissFound(d.id);
    const name = foundRow(d).name;
    // Undo is the store's, not this component's: the toast outlives the banner
    // when the operator leaves Screens, and Undo must still work then.
    const forgotten = kept ? "" : " This browser could not remember that, so it will be back after a reload.";
    toast.info(`Dismissed ${name}.${forgotten} It is still under Not set up yet.`, {
      action: { label: "Undo", onSelect: () => restoreFound([d.id]) },
    });
  };
  const seeAll = () =>
    document.getElementById(NOT_SET_UP_ID)?.scrollIntoView?.({ behavior: "smooth", block: "start" });

  return (
    <section aria-live="polite" aria-label="Screens found" className="overflow-hidden rounded-xl border border-accent/30 bg-accent/[0.08]">
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />
        <div className="min-w-0 flex-1">
          <div className="text-callout font-semibold text-fg">{foundTitle(showing.length)}</div>
          <div className="text-caption1 text-fg-muted">
            Set one up to choose its name and what it shows.{hidden > 0 && ` ${hidden} more dismissed.`}
          </div>
        </div>
        {hidden > 0 && (
          <button type="button" className={LINK} onClick={restoreAllFound}>
            Show dismissed
          </button>
        )}
        <button type="button" className={LINK} onClick={seeAll}>
          See all below
        </button>
      </div>
      <ul className="border-t border-accent/30 bg-surface">
        {showing.map((d) => (
          <FoundItem key={d.id} device={d} onDismiss={() => dismiss(d)} onSetUp={() => onSetUp(panelDeviceOf(d))} />
        ))}
      </ul>
    </section>
  );
}

function FoundItem({ device, onDismiss, onSetUp }: { device: SeenDevice; onDismiss: () => void; onSetUp: () => void }) {
  const row = foundRow(device);
  const titleId = `found-${device.id}`;
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
      <span
        aria-hidden="true"
        className="grid size-[30px] shrink-0 place-items-center rounded-lg border border-line bg-bg text-fg-muted"
      >
        <KindIcon decklink={device.output?.kind === "decklink"} />
      </span>
      <div className="min-w-[180px] flex-1">
        <div id={titleId} className="text-footnote font-semibold text-fg">{row.name}</div>
        <div className="text-caption1 text-fg-muted">
          {row.kind}
          {row.machine && ` on ${row.machine}`} <span className="font-mono text-caption2 text-fg-subtle">{row.address}</span>
        </div>
      </div>
      <Button variant="transparent" size="small" onClick={onDismiss} aria-describedby={titleId} className="text-fg-muted">
        Dismiss
      </Button>
      <Button variant="accent" size="small" onClick={onSetUp} aria-describedby={titleId}>
        Set up
      </Button>
    </li>
  );
}

function KindIcon({ decklink }: { decklink: boolean }): ReactNode {
  return decklink ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <circle cx="5" cy="8" r="1.2" />
      <circle cx="11" cy="8" r="1.2" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M6 14h4M8 11.5V14" />
    </svg>
  );
}
