// stageplots-public-page.tsx — a venue's published stage plots, for anyone with the link.
//
// Served by the ServiceCue Worker at /stageplots/<secret> while the venue is published
// (publish/servicecue/; see docs/features/stageplots.md#publishing). It reads the venue's
// index and each plot from under the same secret and draws them with the read-only
// component /stageplots uses (venue-plots.tsx): no venue list, no editor, no print.
//
// It reads nothing else and writes nothing. It reads again when the tab comes back into
// view, so a phone left on the page picks up a republish without a timer.

import { useEffect, useState } from "react";

import { STAGEPLOTS_PATH, stagePlotsPath } from "@main/types/servicecue-publish";
import type { Plot, PlotBackground, PublishedPlot, PublishedVenue } from "@main/types/stageplots";

import { useTheme } from "../lib/use-theme";
import { VenuePlots } from "../main/stageplots/venue-plots";
import { planDateLabel } from "../settings/sections/plan-date-label";

/** The secret in a /stageplots/<secret> address, or null when the address carries none. */
export function secretFromPath(path: string): string | null {
  const at = stagePlotsPath(path);
  return at && at.key === null ? at.secret : null;
}

/** One plot as last read: its doc, kept from an earlier read (stale) when the latest failed, or failed with none to show. */
type PlotRead = { doc: PublishedPlot; stale: boolean } | { doc: null };

type Loaded =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; index: PublishedVenue; plots: Map<string, PlotRead> };

async function read<T>(url: string): Promise<{ ok: true; value: T } | { ok: false; status: number }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, value: (await res.json()) as T };
}

/**
 * Read the venue again. A plot whose read fails keeps the copy `before` had of it, marked stale:
 * a phone at load-in must not lose the plot it is reading because one read failed. A 404 on the
 * index is the venue unpublished, and blanks the page whatever was there.
 */
async function load(secret: string, before: Loaded): Promise<Loaded> {
  const base = `${STAGEPLOTS_PATH}/${secret}`;
  const index = await read<PublishedVenue>(`${base}/index`);
  if (!index.ok) return index.status === 404 ? { kind: "missing" } : { kind: "failed" };
  const plots = new Map<string, PlotRead>();
  await Promise.all(
    index.value.plots.map(async ({ id }) => {
      const r = await read<PublishedPlot>(`${base}/plot/${encodeURIComponent(id)}`).catch(() => null);
      const last = before.kind === "ready" ? before.plots.get(id) : undefined;
      plots.set(id, r && r.ok ? { doc: r.value, stale: false } : last?.doc ? { doc: last.doc, stale: true } : { doc: null });
    }),
  );
  return { kind: "ready", index: index.value, plots };
}

function Message({ children }: { children: string }) {
  return <p className="pt-10 text-center text-body text-fg-muted">{children}</p>;
}

export function StagePlotsPublicPage({ path }: { path: string }) {
  // The visitor's light or dark, as /stageplots follows it in the building.
  useTheme();
  const secret = secretFromPath(path);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });

  useEffect(() => {
    if (!secret) return;
    let live = true;
    let current: Loaded = { kind: "loading" };
    const show = (next: Loaded) => {
      current = next;
      if (live) setLoaded(next);
    };
    const refresh = () => {
      load(secret, current).then(
        (next) => show(next.kind === "failed" && current.kind === "ready" ? current : next),
        () => show(current.kind === "ready" ? current : { kind: "failed" }),
      );
    };
    refresh();
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [secret]);

  const name = loaded.kind === "ready" ? loaded.index.name : null;
  useEffect(() => {
    document.title = name ? `${name} · Stage plots` : "Stage plots";
  }, [name]);

  if (!secret || loaded.kind === "missing") return <Message>This link is not published.</Message>;
  if (loaded.kind === "failed") return <Message>The stage plots could not be loaded. Try again in a moment.</Message>;
  if (loaded.kind === "loading") return <Message>Loading…</Message>;

  const { index } = loaded;
  const base = `${STAGEPLOTS_PATH}/${secret}`;
  const plots: Plot[] = index.plots.map(({ id, name: plotName }) => {
    const p = loaded.plots.get(id)?.doc;
    return { id, venueId: "published", name: plotName, backgroundId: null, bgFade: p?.bgFade ?? 0, items: p?.items ?? [], version: 0 };
  });
  const backgroundOf = (plot: Plot): PlotBackground | null => {
    const bg = loaded.plots.get(plot.id)?.doc?.background;
    if (!bg) return null;
    return { url: bg.hash ? `${base}/image/${bg.hash}` : "", converted: { hash: bg.hash ?? "", width: bg.width, height: bg.height, bytes: 0 } };
  };
  const shown = plots.find((p) => p.id === index.shown.plotId) ?? null;
  return (
    <main className="mx-auto px-3 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-[1100px] sm:px-5 sm:pt-6">
      <VenuePlots
        id="published"
        name={index.name}
        notes={index.notes}
        plots={plots}
        defaultPlotId={index.defaultPlotId}
        resolved={{ plot: shown, reason: index.shown.reason }}
        planDay={index.plan ? planDateLabel(index.plan.date, index.timeZone, { dates: index.plan.dates }) : null}
        backgroundOf={backgroundOf}
        plotState={(plot) => {
          const r = loaded.plots.get(plot.id);
          return !r?.doc ? "failed" : r.stale ? "stale" : "ok";
        }}
      />
    </main>
  );
}
