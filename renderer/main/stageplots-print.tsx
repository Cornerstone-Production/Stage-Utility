// stageplots-print.tsx — a stage plot on one landscape page, for Print and the
// browser's Save as PDF: venue and plot, the plan line, the printed date in the
// app's time zone, the plot, its legend and callout key, and what plugs into
// each connection point.
//
// The sheet is mounted only while printing (the Print button, or the browser's
// own print, which fires beforeprint) and portalled to <body>. The print rules
// in styles.css then drop everything that does not hold it, and put it on its
// own landscape @page. On screen it is never shown. The page is white paper in
// either theme (.stageplots-paper).
//
// The legend runs in columns beside the plot, up to two; a legend too long
// for that goes on a second page, in four columns across it.

import { useCallback, useEffect, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { PrinterIcon } from "lucide-react";

import { hostTimeZone } from "@main/services/app-timezone";
import { errorMessage } from "@main/services/errors";
import type { BackgroundView, PlotItem } from "@main/types/stageplots";

import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { logToServer } from "../lib/client-log";
import { eyebrow } from "./stageplots/doc-helpers";
import { connectionInputs, calloutKey, legendRows } from "./stageplots/legend";
import { Mono } from "./stageplots/mono";
import { PlotLegend } from "./stageplots/plot-legend";
import { PlotSvg } from "./stageplots/plot-svg";
import { useStageState } from "./use-stage-state";

/** "Thu 12 Nov 2026" for the instant `ms`, on the calendar of `timeZone`. */
export function printedDate(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone }).formatToParts(ms);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;
}

/** Legend lines that fit one column beside the plot on a landscape page. */
const LINES_PER_COLUMN = 28;
/** Columns beside the plot before the legend moves to a page of its own. A
 *  third would leave the plot a third of the page, its labels crowding it. */
const MAX_SIDE_COLUMNS = 2;
/** One legend column's width, in CSS pixels. */
const COLUMN_PX = 210;
/** A landscape page's printable width, in CSS pixels: 11 in less two 12 mm margins (A4 is a little wider). */
const PAGE_PX = 965;

/** Characters of legend text that fit on one line of a 210 px column. */
const CHARS_PER_LINE = 32;

/**
 * About how many lines the printed legend takes: a row per label, a callout or
 * a connection point's inputs taking as many lines as its text wraps to, and the
 * section headings. A stage box listing thirty inputs is several lines, not one.
 */
export function legendLines(items: readonly PlotItem[]): number {
  const wrapped = (text: string) => Math.max(1, Math.ceil(text.length / CHARS_PER_LINE));
  return (
    legendRows(items).length +
    calloutKey(items).reduce((n, c) => n + wrapped(c.text), 0) +
    connectionInputs(items).reduce((n, p) => n + wrapped(`${p.label} ${p.inputs.join(", ")}`), 0) +
    3
  );
}

/** How the legend is laid out for `lines` of it: columns beside the plot, or a second page. */
export function printLayout(lines: number): { columns: number; secondPage: boolean } {
  const columns = Math.max(1, Math.ceil(lines / LINES_PER_COLUMN));
  return columns <= MAX_SIDE_COLUMNS ? { columns, secondPage: false } : { columns: 4, secondPage: true };
}

export interface PrintSheetProps {
  venueName: string;
  plotName: string;
  /** "Default plot", or the plan this plot is for (PR 3). */
  planLine: string | null;
  items: readonly PlotItem[];
  background: BackgroundView | null;
  fade: number;
  /** The instant printed; now when absent. */
  now?: number;
}

function ConnectionPoints({ items }: { items: readonly PlotItem[] }) {
  const points = connectionInputs(items);
  if (points.length === 0) return null;
  return (
    <>
      <span className={cn(eyebrow, "break-after-avoid text-[var(--su-print-muted)]")}>Connection points</span>
      <div className="flex flex-col gap-[5px]" data-testid="print-connections">
        {points.map((p, i) => (
          <span key={i} className="text-caption1 break-inside-avoid text-[var(--su-print-ink)]">
            <b className="font-semibold">
              <Mono text={p.label || "Unlabelled"} />
            </b>{" "}
            <Mono text={p.inputs.join(", ")} />
          </span>
        ))}
      </div>
    </>
  );
}

export function PrintSheet({ venueName, plotName, planLine, items, background, fade, now }: PrintSheetProps) {
  const timeZone = useStageState().state?.timezone ?? hostTimeZone();
  const [printedAt] = useState(() => now ?? Date.now());
  const { columns, secondPage } = printLayout(legendLines(items));
  const legend = (
    <PlotLegend items={items} layout="column" className="[&_span]:break-inside-avoid">
      <ConnectionPoints items={items} />
    </PlotLegend>
  );
  const footer = (page: number) => (
    <footer className="flex justify-between text-[10px] text-[var(--su-print-muted)]">
      <span>Stage Utility · /stageplots</span>
      <span>
        Page <Mono text={`${page} of ${secondPage ? 2 : 1}`} />
      </span>
    </footer>
  );
  return createPortal(
    <div className="stageplots-print-sheet stageplots-paper" data-testid="print-page" aria-hidden>
      <div className="stageplots-print-page grid grid-rows-[auto_minmax(0,1fr)_auto] gap-4">
        <header className="flex items-end gap-4 border-b border-[var(--su-print-line)] pb-2.5">
          <h1 className="flex-1 text-[22px] leading-[27px] font-semibold">
            {venueName} <span className="font-normal text-[var(--su-print-muted)]">· {plotName}</span>
          </h1>
          <p className="text-right text-caption1 text-[var(--su-print-muted)]">
            {planLine && (
              <>
                {planLine}
                <br />
              </>
            )}
            Printed <Mono text={printedDate(printedAt, timeZone)} />
          </p>
        </header>
        <div className="grid min-h-0 items-start gap-[22px]" style={{ gridTemplateColumns: secondPage ? "minmax(0,1fr)" : `minmax(0,1fr) ${columns * COLUMN_PX}px` }}>
          <PlotSvg
            plot={{ name: plotName, items: items as PlotItem[] }}
            background={background}
            fade={fade}
            labelPx={10}
            widthPx={secondPage ? PAGE_PX : PAGE_PX - columns * COLUMN_PX - 22}
            decorative
            className="max-h-full w-full border border-[var(--su-print-line)]"
          />
          {!secondPage && (
            <div style={{ columnCount: columns, columnGap: 16 }} data-testid="print-legend">
              {legend}
            </div>
          )}
        </div>
        {footer(1)}
      </div>
      {secondPage && (
        <div className="stageplots-print-page stageplots-print-next grid grid-rows-[minmax(0,1fr)_auto] gap-4">
          <div style={{ columnCount: columns, columnGap: 16 }} data-testid="print-legend">
            {legend}
          </div>
          {footer(2)}
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * The Print button and the sheet it prints, for /stageplots and the editor:
 * the editor hands in its draft's items, the viewer the saved plot's.
 */
export function PrintControl({ className, ...sheet }: PrintSheetProps & { className?: string }) {
  const { printing, print } = usePrintSheet(sheet.background?.url ?? null);
  return (
    <>
      <Button variant="filled" size="small" className={className} onClick={() => void print()}>
        <PrinterIcon className="size-3.5" />
        Print
      </Button>
      {printing && <PrintSheet {...sheet} />}
    </>
  );
}

/**
 * Printing a plot: `printing` mounts the sheet, `print` mounts it, waits for
 * the background to be decoded so the page is not printed without it, and
 * opens the browser's print dialog. The browser's own print (Cmd+P) mounts it
 * too, from beforeprint.
 */
export function usePrintSheet(backgroundUrl: string | null): { printing: boolean; print: () => Promise<void> } {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const afterPrint = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", afterPrint);
    };
  }, []);
  const print = useCallback(async () => {
    flushSync(() => setPrinting(true));
    if (backgroundUrl && typeof Image !== "undefined") {
      const img = new Image();
      img.src = backgroundUrl;
      // A background that will not decode prints as the paper it sits on; the
      // plot and its items still print. Said on /log, since the page shows
      // nothing of it.
      const decoded = await img.decode().then(
        () => null,
        (err: unknown) => err,
      );
      if (decoded !== null) logToServer("stageplots", `print: the background did not load (${errorMessage(decoded)}); printed without it`);
    }
    window.print();
  }, [backgroundUrl]);
  return { printing, print };
}
