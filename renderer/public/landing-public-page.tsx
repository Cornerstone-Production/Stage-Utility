// landing-public-page.tsx — the public page's own address, `/`, while a venue is listed on it.
//
// Served by the ServiceCue Worker in place of the redirect to /servicecue (publish/servicecue/;
// see docs/ops/servicecue-on-the-web.md#the-landing-page). Two cards: ServiceCue, and Stage
// plots naming each listed venue, which opens through its own secret link exactly as a crew
// member with the link sees it. The list is names, plot counts and links: nothing else of a
// venue is on it. With nothing listed (the last venue just taken off) it goes on to
// /servicecue, as `/` itself then does.

import { useEffect, useState } from "react";
import { ChevronRightIcon, ListIcon, MapIcon } from "lucide-react";

import { LANDING_PATH, STAGEPLOTS_PATH, readLandingList, type LandingVenue } from "@main/types/servicecue-publish";

import { useTheme } from "../lib/use-theme";

type Loaded = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; venues: LandingVenue[] };

/** The list, or failed: an answer that is not one, an unreadable body and no answer at all alike. Never rejects. */
async function load(): Promise<Loaded> {
  try {
    const res = await fetch(LANDING_PATH, { cache: "no-store" });
    if (!res.ok) return { kind: "failed" };
    const r = readLandingList(await res.json());
    return r.ok ? { kind: "ready", venues: r.list.venues } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

const card = "flex rounded-xl border border-line bg-surface text-fg shadow-[var(--su-shadow-1)]";
const icon = "grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent";

export function LandingPublicPage() {
  // The visitor's light or dark.
  useTheme();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    void load().then((next) => {
      if (!live) return;
      // Nothing listed any more: `/` is ServiceCue again.
      if (next.kind === "ready" && next.venues.length === 0) window.location.replace("/servicecue");
      else setLoaded(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-4 px-[max(16px,4vw)] pt-7 pb-[max(1.75rem,env(safe-area-inset-bottom))]">
      <div className="flex flex-col gap-0.5">
        <h1 className="m-0 text-[20px] leading-[26px] font-semibold text-fg">Welcome</h1>
        <p className="m-0 text-footnote text-fg-subtle">Pick what you came for.</p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] items-start gap-3">
        <a href="/servicecue" className={`${card} items-center gap-3 px-3.5 py-3 no-underline transition-colors hover:bg-fill`}>
          <span className={icon}>
            <ListIcon className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <b className="block text-[14px] font-semibold">ServiceCue</b>
            <small className="block text-caption1 text-fg-muted">Run sheets and cues for today&apos;s services</small>
          </span>
          <ChevronRightIcon className="ml-auto size-4 shrink-0 text-fg-subtle" aria-hidden />
        </a>
        <section aria-label="Stage plots" className={`${card} flex-col gap-1 px-3.5 py-3`}>
          <div className="flex items-center gap-3 pb-1">
            <span className={icon}>
              <MapIcon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <b className="block text-[14px] font-semibold">Stage plots</b>
              <small className="block text-caption1 text-fg-muted">Where everything goes on stage</small>
            </span>
          </div>
          {loaded.kind === "loading" && <p className="m-0 border-t border-line px-2 py-[7px] text-footnote text-fg-subtle">Loading…</p>}
          {loaded.kind === "failed" && (
            <p className="m-0 border-t border-line px-2 py-[7px] text-footnote text-fg-muted">The venues could not be loaded. Try again in a moment.</p>
          )}
          {loaded.kind === "ready" &&
            loaded.venues.map((v) => (
              <a
                key={v.secret}
                href={`${STAGEPLOTS_PATH}/${v.secret}`}
                className="flex items-center gap-2 rounded-lg border-t border-line px-2 py-[7px] text-footnote text-fg no-underline transition-colors hover:bg-fill"
              >
                <span className="min-w-0 truncate">{v.name}</span>
                <small className="font-mono text-[11.5px] text-fg-subtle tabular-nums">
                  {v.plots} {v.plots === 1 ? "plot" : "plots"}
                </small>
                <ChevronRightIcon className="ml-auto size-4 shrink-0 text-fg-subtle" aria-hidden />
              </a>
            ))}
        </section>
      </div>
    </main>
  );
}
