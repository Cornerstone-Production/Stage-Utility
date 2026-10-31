// companion-browser.tsx — Browse buttons: Companion's pages, read-only, as its own
// export draws them.
//
// For finding out what Stage Utility can press and what it will call it, without opening
// a rule. The page dropdown and the grid are the shared companion-pages.tsx, the same
// ones the Button inspector picks from; with no `pick` the grid is read-only. Mounted
// only while the card's Browse buttons is on, so Companion is not read for a page
// nobody opened.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { CompanionPageView } from "@main/services/companion-export";
import { errorMessage } from "@main/services/errors";

import { invoke } from "../lib/api";
import { companionButtonsQuery } from "../lib/companion-buttons";
import { CompanionPageGrid, CompanionPageSelect, listedPages, pageName } from "./companion-pages";

type PageReply = ({ ok: true } & CompanionPageView) | { ok: false; reason: string };

function PageView({ page }: { page: number }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["companion:page", page],
    queryFn: () => invoke<PageReply>("companion:page", { page }),
  });
  if (isLoading) return <p className="py-6 text-center text-caption1 text-fg-muted">Reading page {page}…</p>;
  if (error) return <p className="text-caption1 text-danger-11">Could not read page {page}: {errorMessage(error)}</p>;
  if (!data) return null;
  if (!data.ok) return <p className="text-caption1 text-danger-11">Could not read page {page}: {data.reason}</p>;
  return (
    <>
      <CompanionPageGrid view={data} />
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-caption1 text-fg-muted">
        <span>Read from Companion's export</span>
        <span className="font-mono tabular-nums" title={pageName(data)}>
          page {page} · {data.cols} × {data.rows}
        </span>
      </div>
    </>
  );
}

export function CompanionBrowser() {
  const { data, error, isLoading } = useQuery(companionButtonsQuery);
  const [picked, setPicked] = useState<number | null>(null);
  const pages = useMemo(() => (data?.ok ? listedPages(data.pages) : []), [data]);

  if (isLoading) return <p className="text-caption1 text-fg-muted">Reading Companion's pages…</p>;
  if (error) return <p className="text-caption1 text-danger-11">Could not read Companion: {errorMessage(error)}</p>;
  if (!data) return null;
  if (!data.ok) return <p className="text-caption1 text-danger-11">Could not read Companion: {data.reason ?? "it did not answer"}</p>;
  if (pages.length === 0) return <p className="text-caption1 text-fg-muted">Companion has no page with a labelled button.</p>;

  // A page that has since gone empty falls back to the first listed one rather than drawing nothing.
  const page = pages.some((p) => p.page === picked) ? picked! : pages[0]!.page;
  return (
    <div className="flex flex-col gap-2" data-companion-browser="">
      <CompanionPageSelect pages={pages} page={page} onPage={setPicked} />
      <PageView page={page} />
    </div>
  );
}
