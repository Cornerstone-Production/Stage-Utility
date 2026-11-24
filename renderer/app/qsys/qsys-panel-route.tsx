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
// A volunteer panel opened full screen also carries the cog menu (its home's
// siblings, and "Open Stage Utility" behind the staff PIN). Any panel opened from
// a cog (any `?return=`, even one naming no panel) carries the cog too, whatever
// its kind, so a device that went to a staff panel always has a way back; and,
// when `?return` names its home, the banner that counts down to going home on the
// home panel's time (qsys-cog-menu.tsx, use-auto-return.ts). Neither is drawn in
// the shell. The no-Core warning links to the Q-SYS settings only when both the
// open panel and the device's home are staff panels: a volunteer panel never
// does, and neither does a staff panel a volunteer device's cog opened.
//
// An address a panel had before a rename (an alias) still opens it: the page puts
// the URL right, replacing the entry, and a `?return` naming an old address is put
// right with it.

import { useEffect, useState, type ReactNode } from "react";
import { useParams, useRouter, useSearch } from "@tanstack/react-router";

import { QSYS_KIND_TEXT, findPanelBySlug, panelKindOf } from "@main/types/qsys";
import type { View } from "@main/types/views";
import { LayoutRenderer } from "../../main/layout-renderer";
import { capabilityLive } from "../../main/render-context";
import { QsysPanelContext, useQsysPanel, useQsysPanelState } from "../../main/qsys/use-qsys-values";
import { AppLink } from "../app-link";
import { useStageSettings } from "../use-stage-settings";
import { cn } from "../../lib/cn";
import { INTEGRATIONS_ROUTE } from "../legacy-hash";
import { QSYS_MANAGE_PATH, qsysPanelPath } from "./qsys-paths";
import { QsysCogMenu, QsysReturnBanner } from "./qsys-cog-menu";
import { useQsysTiming } from "./qsys-timing";

/** The approved copy, word for word. */
export const OFFLINE_TITLE = "Audio controls are offline";
export const OFFLINE_BODY = "This page can't reach the sound system, so nothing here will change anything. Use the Q-SYS panel on the wall, or find a tech.";
export const NO_CORE_TITLE = "No Q-SYS Core is set up";

/** A `?return=` value as text. The router parses search values as JSON, so an
 *  all-digit slug arrives as a number. */
function returnParam(search: Record<string, unknown>): string | null {
  const r = search.return;
  if (typeof r === "string") return r;
  if (typeof r === "number" && Number.isSafeInteger(r) && r >= 0) return String(r);
  return null;
}

/** /qsys/<slug>: the panel full screen. */
export function QsysPanelRoute() {
  const { slug = "" } = useParams({ strict: false }) as { slug?: string };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const s = useStageSettings();
  const router = useRouter();
  const views = s.stageState?.views ?? [];
  // The panel at this address, or the one that had it before a rename.
  const view = s.stageState ? findPanelBySlug(views, slug) : null;
  // The device's home: the panel `?return=` names (by its address or an old one),
  // when there is one and it is not this one; otherwise this panel is home. An
  // unknown slug is ignored.
  const ret = returnParam(search);
  const named = ret !== null ? findPanelBySlug(views, ret) : null;
  const away = named && view && named.id !== view.id ? named : null;
  // Where this page should be: the panel's own address, and home's.
  const to = view?.qsys && view.qsys.slug !== slug ? qsysPanelPath(view.qsys.slug) : null;
  const returnTo = away?.qsys && away.qsys.slug !== ret ? away.qsys.slug : null;
  useEffect(() => {
    if (!view?.qsys || (to === null && returnTo === null)) return;
    const back = away?.qsys?.slug ?? ret;
    void router.navigate({ to: qsysPanelPath(view.qsys.slug), search: (back !== null ? { return: back } : {}) as never, replace: true });
  }, [router, view, away, ret, to, returnTo]);
  // Never "not found" before the views are known: a cold load on a Pi takes a moment.
  if (!s.stageState) return null;
  const home = away ?? view;
  return (
    // The shell gutters its content; a panel paints its own ground to the edges.
    <div className="-mx-2 h-full max-sm:-mx-3">
      {view && home ? (
        <QsysPanelSurface
          view={view}
          settingsLink={view.qsys?.kind === "staff" && home.qsys?.kind === "staff"}
          device={{ home, away: away !== null, fromCog: ret !== null, views }}
        />
      ) : (
        <QsysPanelNotFound slug={slug} />
      )}
    </div>
  );
}

/** A panel open full screen on a device: its home panel, whether it is away from
 *  it, whether a cog opened it (`?return` present, whatever it names), and every
 *  view (for the cog's list). Absent in the shell. */
type Device = { home: View; away: boolean; fromCog: boolean; views: readonly View[] };

/** No panel at this address: said, on the panel's own ground, never a blank page. */
export function QsysPanelNotFound({ slug, link }: { slug: string; link?: boolean }) {
  return (
    <div className="kiosk-surface flex h-full flex-col items-center justify-center gap-2 p-6 text-center" data-qsys-not-found>
      <div className="text-title3 font-semibold text-fg">There is no panel here</div>
      <div className="max-w-[28rem] text-body text-fg-muted">
        Nothing is at <span className="font-mono text-fg">{qsysPanelPath(slug)}</span>. It may have been renamed or removed. Find a tech.
      </div>
      {link && (
        <AppLink to={QSYS_MANAGE_PATH} className="mt-2 inline-flex min-h-11 items-center text-footnote text-accent-text hover:underline">
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
export function QsysPanelSurface({ view, settingsLink = false, inShell = false, device }: { view: View; settingsLink?: boolean; inShell?: boolean; device?: Device }) {
  // The store every object on this panel reads (same id, same kind), held here too so
  // the header and the card follow it.
  const panel = useQsysPanel(view.id, panelKindOf(view));
  return (
    <QsysPanelContext.Provider value={panel}>
      <PanelFrame view={view} settingsLink={settingsLink} inShell={inShell} device={device} />
    </QsysPanelContext.Provider>
  );
}

type Line = { tone: "ok" | "warn" | "danger"; text: string };

/**
 * What the panel says, from its store: the connection line, the no-Core strip, and
 * whether the offline card covers it. The card comes when the server has been
 * without the Core for 2 s, or this page without Stage Utility for 10 s; either way
 * nothing here can change anything. When the page's stream comes back, the store
 * reads the Core's state again before it takes input (use-qsys-values.ts).
 */
function useConnection(): { line: Line; noCore: boolean; overlay: boolean } {
  const st = useQsysPanelState();
  const { coreLostAfterMs, pageLostAfterMs } = useQsysTiming();
  const noCore = st.configured === false;
  const coreLost = useAfter(!noCore && st.core === "reconnecting", coreLostAfterMs);
  const pageLost = useAfter(!st.stream, pageLostAfterMs);
  const overlay = coreLost || pageLost;
  if (pageLost) return { line: { tone: "danger", text: "Sound system offline" }, noCore, overlay };
  if (noCore) return { line: { tone: "warn", text: NO_CORE_TITLE }, noCore, overlay };
  if (st.live) return { line: { tone: "ok", text: "Connected to sound system" }, noCore, overlay };
  if (st.core === "reconnecting") return { line: { tone: "danger", text: "Sound system offline" }, noCore, overlay };
  return { line: { tone: "warn", text: "Reconnecting to sound system" }, noCore, overlay };
}

const DOT: Record<Line["tone"], string> = { ok: "bg-ok-9", warn: "bg-warn-9", danger: "bg-danger-9" };

function PanelFrame({ view, settingsLink, inShell, device }: { view: View; settingsLink: boolean; inShell: boolean; device?: Device }) {
  const { line, noCore, overlay } = useConnection();
  // Keyed by panel and home, so a move to another panel starts the menu and the count afresh.
  const key = `${view.id}:${device?.home.id ?? ""}`;
  return (
    <div className="kiosk-surface relative flex h-full min-h-0 flex-col" data-qsys-panel={view.qsys?.slug ?? view.id}>
      <header className={cn("flex shrink-0 items-center gap-4 border-b border-line px-6", inShell ? "h-10" : "h-[72px]")}>
        <div className="flex min-w-0 grow flex-col gap-0.5">
          {!inShell && <h1 className="truncate text-title2 font-semibold tracking-[-0.01em] text-fg">{view.name}</h1>}
          {/* A live region: a screen reader hears the Core drop, not only the card. */}
          <div role="status" aria-live="polite" className="flex items-center gap-2 text-footnote text-fg-muted" data-connection-line={line.tone}>
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[line.tone])} />
            <span>{line.text}</span>
          </div>
        </div>
        {/* In the shell, the page's name is the context bar's; the panel's address and
            kind go here, as the approved navigation board shows them. */}
        {inShell && view.qsys && (
          <div className="flex shrink-0 items-center gap-3 text-footnote" data-qsys-shell-note>
            <span className="font-mono text-fg-subtle">{qsysPanelPath(view.qsys.slug)}</span>
            <span className="text-fg-muted">{QSYS_KIND_TEXT[view.qsys.kind]}</span>
          </div>
        )}
        {/* A volunteer panel has a cog, and so does any panel a cog opened: a staff
            panel on its own is already behind the shell or a staff device. */}
        {device && (view.qsys?.kind === "volunteer" || device.fromCog) && <QsysCogMenu key={key} view={view} home={device.home} views={device.views} />}
      </header>
      {device?.away && <QsysReturnBanner key={key} home={device.home} />}
      {noCore && <NoCoreStrip settingsLink={settingsLink} />}
      <div className="relative min-h-0 flex-1">
        {/* Dimmed under the card, as the approved panel draws it. */}
        <div className={cn("h-full", overlay && "pointer-events-none opacity-35")}>
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
        </div>
        {overlay && <OfflineCard />}
      </div>
    </div>
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
    <div role="status" className="flex shrink-0 items-center gap-4 border-b border-line bg-warn-9/14 px-6 py-1.5 text-subheadline text-warn-11" data-qsys-no-core>
      <span className="grow">
        <strong className="font-semibold">{NO_CORE_TITLE}</strong>. Its controls are disabled until one is.
      </span>
      {settingsLink && (
        <AppLink to={INTEGRATIONS_ROUTE} className="inline-flex min-h-11 shrink-0 items-center text-footnote font-medium text-fg hover:underline">
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
    <div className="absolute inset-0 flex items-start justify-center bg-(--kiosk-bg)/60 px-6 pt-[min(200px,20vh)]" data-qsys-offline>
      <div role="alert" className="flex w-[480px] max-w-full flex-col gap-2.5 rounded-[20px] border border-line-strong bg-[var(--kiosk-surface-1)] p-7 text-center">
        <div className="text-title3 font-semibold text-fg">{OFFLINE_TITLE}</div>
        <div className="text-subheadline text-fg-muted">{OFFLINE_BODY}</div>
        {/* The mockup says "Retrying every few seconds". The Core's reconnect backs off
            exponentially, to two minutes while a page watches (integration-base.ts
            scheduleReconnect), so that would not be true for long. */}
        <div className="font-mono text-footnote text-fg-subtle">Retrying on its own</div>
      </div>
    </div>
  );
}
