// A Q-SYS panel as a page: /qsys/<slug>, full screen with no app chrome (what an
// iPad opens), and the same surface inside the shell at /qsys/manage/<slug>.
//
// Built to the approved direction A (stage-utility-plans mockups Main.dc.html):
// a header with the panel's name and a connection line, the layout under it, and
// over the layout, when the Core cannot be reached, the offline card. The page
// sits on the kiosk surface, the same ground the layout's canvas is drawn on, so
// it reads the `--color-*` tokens that surface re-declares (styles.css,
// .kiosk-surface) and looks the same in either app theme.
//
// What the page says comes from the panel's own store (use-qsys-values.ts), the
// one every Q-SYS object on it reads: "Connected" exactly when input is open,
// and the overlay exactly when the server says it is not connected to the Core.
// The objects keep their own rules (greyed and deaf until the Core's state has
// been read); the page adds the words.
//
// The cog menu, PIN and auto-return of the mockup are not here yet: a cog that
// opens nothing would be a control that does nothing.

import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";

import { findPanelBySlug, panelKindOf } from "@main/types/qsys";
import type { View } from "@main/types/views";
import { LayoutRenderer } from "../../main/layout-renderer";
import { capabilityLive } from "../../main/render-context";
import { QsysPanelContext, useQsysPanel, useQsysPanelState } from "../../main/qsys/use-qsys-values";
import { AppLink } from "../app-link";
import { useStageSettings } from "../use-stage-settings";
import { cn } from "../../lib/cn";
import { QSYS_MANAGE_PATH, qsysPanelPath } from "./qsys-paths";

/** How long the server must have been without the Core before the offline card
 *  covers the panel. A blip shorter than this reads as Reconnecting instead. */
let overlayAfterMs = 2_000;

/** Test seam: how long the offline card waits. */
export function __setOfflineOverlayDelayForTests(ms: number): void {
  overlayAfterMs = ms;
}

/** The approved copy, word for word. */
export const OFFLINE_TITLE = "Audio controls are offline";
export const OFFLINE_BODY = "This page can't reach the sound system, so nothing here will change anything. Use the Q-SYS panel on the wall, or find a tech.";
export const NO_CORE_TITLE = "No Q-SYS Core is set up";

const INTEGRATIONS_PATH = "/settings/integrations";

/** /qsys/<slug>: the panel full screen. */
export function QsysPanelRoute() {
  const { slug = "" } = useParams({ strict: false }) as { slug?: string };
  const s = useStageSettings();
  // Never "not found" before the views are known: a cold load on a Pi takes a moment.
  if (!s.stageState) return null;
  const view = findPanelBySlug(s.stageState.views ?? [], slug);
  return (
    // The shell gutters its content; a panel paints its own ground to the edges.
    <div className="-mx-2 h-full max-sm:-mx-3">
      {view ? <QsysPanelSurface view={view} settingsLink={view.qsys?.kind === "staff"} /> : <QsysPanelNotFound slug={slug} />}
    </div>
  );
}

/** No panel at this address: said, on the panel's own ground, never a blank page. */
export function QsysPanelNotFound({ slug, link }: { slug: string; link?: boolean }) {
  return (
    <div className="kiosk-surface flex h-full flex-col items-center justify-center gap-2 p-6 text-center" data-qsys-not-found>
      <div className="text-title3 font-semibold text-fg">There is no panel here</div>
      <div className="max-w-[28rem] text-body text-fg-muted">
        Nothing is at <span className="font-mono text-fg">{qsysPanelPath(slug)}</span>. It may have been renamed or removed. Find a tech.
      </div>
      {link && (
        <AppLink to={QSYS_MANAGE_PATH} className="mt-2 text-footnote text-accent-text hover:underline">
          All panels
        </AppLink>
      )}
    </div>
  );
}

/**
 * The panel: header, layout, and the offline card. `settingsLink` adds a way to
 * the Q-SYS settings to the "No Q-SYS Core is set up" warning: a staff panel and
 * the shell get one, a volunteer panel does not. `inShell`: the app's context bar
 * already names the page, so the header carries the connection line alone.
 */
export function QsysPanelSurface({ view, settingsLink = false, inShell = false }: { view: View; settingsLink?: boolean; inShell?: boolean }) {
  // The store every object on this panel reads (same id, same kind), held here too so
  // the header and the card follow it.
  const panel = useQsysPanel(view.id, panelKindOf(view));
  return (
    <QsysPanelContext.Provider value={panel}>
      <div className="kiosk-surface relative flex h-full min-h-0 flex-col" data-qsys-panel={view.qsys?.slug ?? view.id}>
        <PanelHeader name={inShell ? null : view.name} />
        <PanelBody view={view} settingsLink={settingsLink} />
      </div>
    </QsysPanelContext.Provider>
  );
}

type Line = { tone: "ok" | "warn" | "danger"; text: string };

/** What the connection line says, from the panel's store. */
function useConnectionLine(): { line: Line; noCore: boolean; coreDown: boolean } {
  const st = useQsysPanelState();
  const noCore = st.configured === false;
  const coreDown = !noCore && st.core === "reconnecting";
  if (noCore) return { line: { tone: "warn", text: NO_CORE_TITLE }, noCore, coreDown };
  if (st.live) return { line: { tone: "ok", text: "Connected to sound system" }, noCore, coreDown };
  if (coreDown) return { line: { tone: "danger", text: "Sound system offline" }, noCore, coreDown };
  return { line: { tone: "warn", text: "Reconnecting to sound system" }, noCore, coreDown };
}

const DOT: Record<Line["tone"], string> = { ok: "bg-ok-9", warn: "bg-warn-9", danger: "bg-danger-9" };

function PanelHeader({ name }: { name: string | null }) {
  const { line } = useConnectionLine();
  return (
    <header className={cn("flex shrink-0 items-center gap-4 border-b border-line px-6", name === null ? "h-10" : "h-[72px]")}>
      <div className="flex min-w-0 grow flex-col gap-0.5">
        {name !== null && <h1 className="truncate text-title2 font-semibold tracking-[-0.01em] text-fg">{name}</h1>}
        <div className="flex items-center gap-2 text-footnote text-fg-muted" data-connection-line={line.tone}>
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[line.tone])} />
          <span>{line.text}</span>
        </div>
      </div>
    </header>
  );
}

function PanelBody({ view, settingsLink }: { view: View; settingsLink: boolean }) {
  const { noCore, coreDown } = useConnectionLine();
  const overlay = useAfter(coreDown, overlayAfterMs);
  return (
    <>
      {noCore && <NoCoreStrip settingsLink={settingsLink} />}
      <div className="relative min-h-0 flex-1">
        {view.layout && view.layout.objects.length > 0 ? (
          <LayoutRenderer
            layout={view.layout}
            viewId={view.id}
            ndiSource={null}
            interactive={capabilityLive("shell", "control")}
            surface="console"
            allowHls
            screen={null}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-body text-fg-muted">Nothing on this panel yet.</div>
        )}
        {overlay && <OfflineCard />}
      </div>
    </>
  );
}

/** True once `on` has held for `ms`; false the moment it stops. */
function useAfter(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setHeld(true), ms);
    return () => {
      clearTimeout(t);
      setHeld(false);
    };
  }, [on, ms]);
  return on && held;
}

function NoCoreStrip({ settingsLink }: { settingsLink: boolean }) {
  return (
    <div role="status" className="flex shrink-0 items-center gap-4 border-b border-line bg-warn-9/14 px-6 py-3 text-subheadline text-warn-11" data-qsys-no-core>
      <span className="grow">
        <strong className="font-semibold">{NO_CORE_TITLE}</strong>. Its controls are disabled until one is.
      </span>
      {settingsLink && (
        <AppLink to={INTEGRATIONS_PATH} className="shrink-0 text-footnote font-medium text-fg hover:underline">
          Q-SYS settings
        </AppLink>
      )}
    </div>
  );
}

function OfflineCard(): ReactNode {
  return (
    // Over the layout only, so the header's connection line still shows; the scrim
    // also takes every touch, though the objects are deaf anyway while offline.
    <div className="absolute inset-0 flex items-start justify-center bg-black/60 px-6 pt-[min(200px,20vh)]" data-qsys-offline>
      <div role="alert" className="flex w-[480px] max-w-full flex-col gap-2.5 rounded-[20px] border border-line-strong bg-[var(--kiosk-surface-1)] p-7 text-center">
        <div className="text-title3 font-semibold text-fg">{OFFLINE_TITLE}</div>
        <div className="text-subheadline text-fg-muted">{OFFLINE_BODY}</div>
        <div className="font-mono text-footnote text-fg-subtle">Retrying on its own</div>
      </div>
    </div>
  );
}
