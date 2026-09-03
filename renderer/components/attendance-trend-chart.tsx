// The attendance trend chart.
//
// Extracted from service-history-section.tsx so Home's widget and the History
// tab draw the SAME chart rather than two that drift. "The same style as the
// attendance tab" is only true if it is literally the same component — a second
// implementation is a promise to keep them matching, and this repo has enough
// evidence about how those go.

import { useEffect, useId, useRef, useState } from "react";

import { clamp } from "@main/services/clamp";
import { shortDay, type TrendPoint } from "../settings/sections/overview-data";

/** Real attendance trend chart (SVG): a baseline, the per-service polyline, the
 *  latest point marked, and first/last date labels. The hero of the blend — not
 *  decorative. Falls back to a quiet note when there isn't enough to plot. */
export function AttendanceTrendChart({
  points,
  splLabel,
  hoverSuppressed = false,
}: {
  points: TrendPoint[];
  /** The Smaart metric the SPL series is, for the tooltip row. Absent draws no
   *  SPL series at all, whatever the points carry. */
  splLabel?: string | null;
  /**
   * Something else owns the pointer, so draw no hover at all.
   *
   * History opens a right-click menu over this chart, and the chart kept
   * tracking the pointer underneath it: the tooltip drew through the menu and
   * moved as you tried to reach an item. Optional and off by default — Home has
   * no menu over its chart and passes nothing.
   */
  hoverSuppressed?: boolean;
}) {
  /**
   * The chart's own size, measured, and used as PLAIN PIXELS — see the svg
   * below for why there is no viewBox to scale them.
   *
   * The width decides where the points sit; the height decides how much rise
   * the line is given. Both come from the element rather than from a constant,
   * so the same component draws the same chart on History's 640 and on Home's
   * whole-tile width.
   */
  // Unique per instance: Home and History can both be mounted, and two <defs>
  // sharing an id means the second chart paints with the first one's gradient.
  const gradientId = useId();
  const splGradientId = useId();
  const [W, setW] = useState(640);
  /**
   * And the HEIGHT, because a trend needs an aspect to be a shape.
   *
   * History caps the chart at 640px wide, where 130 tall is a reasonable band.
   * Home hands it a whole XL tile — some 1900px — and at a fixed height that is
   * fifteen to one: the line came out as a nearly flat wire pulled across the
   * card, with the tile's remaining height empty underneath it. Taking the
   * height it is actually given gives the curve room to be a curve.
   *
   * 130 is the floor and the fallback, so History — whose container is
   * auto-height — draws exactly what it always drew.
   */
  const [H, setH] = useState(130);
  /**
   * The measured element, in STATE, and the observer keyed to it.
   *
   * It was a ref read once in a mount effect, and that is the bug behind every
   * complaint about this chart. The component returns a different element while
   * there are fewer than two services to plot — the "not enough yet" note, which
   * carries no ref — so on any load where the history had not arrived by first
   * paint, the effect ran with a null ref, returned, and never ran again. No
   * observer was ever attached, and the width stayed at its initial 640 for the
   * life of the page.
   *
   * With a viewBox that came out as 640 stretched across a 1500px card: labels
   * two and a half times too wide, and an endpoint dot drawn as an oval. Without
   * one it came out as a line that stops at a third of its own card. Both were
   * reported; both were this.
   *
   * A callback ref binds whenever the node appears, however many renders later,
   * and re-binds if it is ever replaced.
   */
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([entry]) => {
      // WIDTH gets no floor above zero. The svg below has no viewBox, so its
      // RENDERED width is the real DOM width (CSS 100%) — `W` only decides
      // where the drawing math THINKS that box ends, and nothing here divides
      // by it, so a floor buys no safety. It used to buy a mismatch instead:
      // on a container narrower than the floor (a phone-width History
      // column), the math drew for a box 240px wide while the real one was
      // whatever CSS gave it, and the tooltip's edge-clamp — built to hold
      // the tooltip inside the box it was ACTUALLY measuring — clamped
      // against the wrong number and sat past the real right edge.
      //
      // HEIGHT keeps its floor: unlike width, the svg's `height` attribute IS
      // `H` (no CSS percentage involved), so there's no real box for it to
      // disagree with — measuring 0 back is just the chart reporting its own
      // last-drawn height during a mid-mount frame, not a truth to obey.
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setW(w);
      setH(Math.max(130, Math.round(entry.contentRect.height)));
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  // Tighter than it was. A third of a 130px band spent on margin is a third the
  // line does not get, and at the widths Home hands this thing the line needs
  // every pixel of rise it can be given.
  const padTop = 10;
  const padBottom = 20;
  const padX = 10;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  /**
   * The tooltip's own box, measured the same way the chart's is — see `box`.
   *
   * Its WIDTH is what keeps it on screen: centred on the hovered point it hangs
   * half its width past the last point, which sits at the right edge of the
   * chart, and a chart near the edge of the window had the tooltip clipped by
   * the browser. Mirrored at the first point on a narrow container.
   *
   * The BORDER box, deliberately, and not the observer's `contentRect` the way
   * `box` reads it: what hangs off the card is the tooltip's padding and border
   * as much as its text. The two differ by 18px here, so clamping to the content
   * box would leave 9px of it outside the chart at either end.
   */
  const [tip, setTip] = useState<HTMLDivElement | null>(null);
  const [tipW, setTipW] = useState(0);
  /** Its HEIGHT, the same way — see the vertical placement below `tipTop`.
   *  Held at 0 until measured, same as `tipW`: nothing reads it before then,
   *  since the tooltip is invisible (`opacity`) until it has been. */
  const [tipH, setTipH] = useState(0);
  useEffect(() => {
    if (!tip) return;
    // An observer answers with its first observation as soon as it is given a
    // target, so this needs no separate initial measurement — the same reason
    // the box above does not take one either.
    const ro = new ResizeObserver(() => {
      const r = tip.getBoundingClientRect();
      setTipW(r.width);
      setTipH(r.height);
    });
    ro.observe(tip);
    return () => ro.disconnect();
  }, [tip]);
  /**
   * Drop the hover when something else takes the pointer.
   *
   * CLEARED, not merely hidden: closing the menu must not pop the old tooltip
   * back up under a pointer that never moved.
   *
   * Adjusted during the render rather than from an effect, which is both what
   * React asks for when state has to follow a prop and what this needs — an
   * effect would commit one frame with the tooltip still drawn over the menu
   * that suppressed it, where a render-phase update is re-run before anything
   * is painted.
   */
  const [wasSuppressed, setWasSuppressed] = useState(hoverSuppressed);
  if (hoverSuppressed !== wasSuppressed) {
    setWasSuppressed(hoverSuppressed);
    if (hoverSuppressed) setHover(null);
  }
  if (points.length < 2) {
    return (
      <div className="flex h-full min-h-[130px] items-center justify-center text-caption1 text-fg-subtle">
        Not enough services yet to chart a trend.
      </div>
    );
  }
  // The FULL width of whatever it is given.
  //
  // It was capped at 8:1 for a while, centred, so a wide tile did not render
  // every weekend as the same near-horizontal wire. Asked for outright: a chart
  // in a widget should fill the widget. The aspect is the tile's to decide — a
  // Tall one gives the curve its shape back — and a chart that stops short of
  // its own card reads as broken in a way a shallow slope does not.
  const plotW = W;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const x = (i: number) => padX + (i / (points.length - 1)) * (plotW - padX * 2);
  const y = (v: number) => padTop + (1 - (v - min) / range) * (H - padTop - padBottom);
  const poly = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  // The same points closed down to the baseline, for the fill.
  //
  // A line alone is a thread, and stretched across a metre of wall-width tile a
  // thread is what it looks like — the shape stops registering at all. Weight
  // under it is what makes a shallow slope read as a shape rather than as a
  // scratch, and it costs one path.
  const area = `${padX},${H - padBottom} ${poly} ${plotW - padX},${H - padBottom}`;

  // ── The SPL series ─────────────────────────────────────────────────────────
  //
  // ITS OWN SCALE, and it has to be. Attendance is a count in the hundreds and a
  // service level is a number between about 70 and 100 dB; on one axis the SPL
  // line is a flat wire pinned to the floor of the chart. So the dB band is fitted
  // to the dB data and the two series share only the x axis, which is the honest
  // reading anyway — this is "did it get louder", not "is it bigger than the
  // attendance".
  //
  // PADDED, because a service that runs within 2 dB every week is a real and
  // useful answer, and stretched edge to edge that reads as wild swings. The
  // padding is proportional with a floor, so a steady series sits as a calm line
  // through the middle rather than a cliff.
  const splVals = points.map((p) => p.spl).filter((v): v is number => v != null);
  const showSpl = splLabel != null && splVals.length >= 2;
  const sMin = splVals.length ? Math.min(...splVals) : 0;
  const sMax = splVals.length ? Math.max(...splVals) : 1;
  const sPad = Math.max(1.5, (sMax - sMin) * 0.3);
  const sLo = sMin - sPad;
  const sRange = sMax + sPad - sLo || 1;
  const sy = (v: number) => padTop + (1 - (v - sLo) / sRange) * (H - padTop - padBottom);
  // BROKEN INTO RUNS, so a week with no recording is a gap rather than a dive to
  // the bottom of the band. A missing reading is not a quiet service.
  const splRuns: { i: number; v: number }[][] = [];
  {
    let run: { i: number; v: number }[] = [];
    points.forEach((p, i) => {
      if (p.spl == null) {
        if (run.length) splRuns.push(run);
        run = [];
      } else run.push({ i, v: p.spl });
    });
    if (run.length) splRuns.push(run);
  }
  const lastX = x(points.length - 1);
  const lastY = y(points[points.length - 1].value);
  const latest = points[points.length - 1].value;
  // The SPL endpoint: the LAST point that actually carries a level, not
  // necessarily the chart's own last point. SPL breaks into runs over a gap
  // (see splRuns above), so the newest weekend can be one with attendance and
  // no Smaart reading yet — marking that gap as "the latest level" would be
  // the same lie the broken line already refuses to tell.
  let splEndpointIdx = -1;
  let splLevel: number | null = null;
  if (showSpl) {
    for (let i = 0; i < points.length; i++) {
      const v = points[i].spl;
      if (v != null) {
        splEndpointIdx = i;
        splLevel = v;
      }
    }
  }
  const splEndpointX = x(Math.max(splEndpointIdx, 0));
  const splEndpointY = splLevel != null ? sy(splLevel) : 0;
  // Hollow on the SAME terms as the attendance dot below: only when this
  // reading is the FINAL point in the whole series — not merely the last one
  // with a level — and that point is still recording. A live weekend whose
  // Smaart reading stopped early (SenSource still counting, the meter gone
  // quiet) must not borrow the "still climbing" look for what is actually its
  // last SETTLED level.
  const splEndpointLive = splEndpointIdx === points.length - 1 && !!points[splEndpointIdx]?.live;
  const hp = hover != null ? points[hover] : null;
  const hx = hover != null ? x(hover) : 0;
  const hy = hp ? y(hp.value) : 0;
  // The tooltip's left edge, HELD INSIDE THE CHART. Centred on the point while
  // there is room, sliding along the edge once there is not.
  //
  // In pixels: `hx` already is one and `plotW` is the box's own width, so the
  // percentage this used to be was the same number divided and multiplied back —
  // and no percentage of the box can express "half a tooltip in from the edge".
  const tipMargin = 4;
  const tipLo = tipW / 2 + tipMargin;
  const tipHi = plotW - tipW / 2 - tipMargin;
  // A tooltip wider than the chart it sits in cannot be held inside it at all;
  // centred, it at least overhangs evenly rather than pinning to one edge.
  const tipLeft = tipLo <= tipHi ? clamp(hx, tipLo, tipHi) : plotW / 2;
  // The tooltip's vertical placement — held inside the TOP of the chart the
  // same way its horizontal one is held inside the sides.
  //
  // Above the point by default (`-translate-y-full`, applied below), which is
  // exactly where it runs out of room first: `hy` is smallest at the
  // HIGHEST-attendance point, so the point people are most likely to hover is
  // the one closest to the chart's own top edge. On History that only drew
  // the tooltip over the card above it — visible, if untidy. On Home this
  // chart sits inside two `overflow-hidden` ancestors (cards.tsx), so the
  // same negative top does not overhang there, it is cut off outright — the
  // tooltip silently loses its top few lines for exactly the point an
  // operator is most likely to be checking. Flips below the point instead of
  // letting that happen.
  //
  // Which side is chosen compares BOTH, rather than flipping down the moment
  // the top does not fit. Room-above-only sent a tooltip taller than the space
  // below it over the bottom edge instead — a bigger overflow than the one it
  // was replacing, and on Home a bigger clip. A tooltip too tall for either
  // side now overhangs the shorter distance.
  const tipMarginY = 4;
  const roomAbove = hy - 8 - tipMarginY;
  const roomBelow = H - tipMarginY - (hy + 8);
  const tipAbove = roomAbove >= tipH || (roomBelow < tipH && roomAbove >= roomBelow);
  const tipTop = tipAbove ? hy - 8 : hy + 8;
  // The SPL endpoint's own label — same idea as the attendance one below, but
  // it must never land where THAT one already sits. The two series are scaled
  // independently and can converge onto the same y for very different
  // attendance and dB numbers, so a placement that only looks at the SPL
  // dot's OWN position collides exactly there. The floor is anchored to the
  // attendance label's already-decided band instead, which holds regardless
  // of where either dot lands — two rectangles with disjoint y ranges cannot
  // overlap no matter what either one does on x.
  //
  // SPL_LABEL_H is the caption1 line-height (styles.css), the same "one line"
  // the attendance label's own "-20" already assumes — not a measurement,
  // because unlike the tooltip's caller-supplied content this text is OUR OWN
  // fixed format (`N.N dB`) and does not vary the way a plotted label does.
  const SPL_LABEL_H = 16;
  const attLabelBottom = Math.max(0, lastY - 20) + SPL_LABEL_H;
  const splLabelTop = clamp(Math.max(splEndpointY + 8, attLabelBottom + 4), 0, H - SPL_LABEL_H - 4);
  // Horizontal: centred on the endpoint, clamped inside the chart the same
  // way the tooltip is above (`tipLo`/`tipHi`) — a fixed half-width, again
  // because the content's size is fixed rather than caller-supplied.
  const splLabelHalfW = 28;
  const splLabelLeft =
    splLabelHalfW * 2 <= plotW ? clamp(splEndpointX, splLabelHalfW, plotW - splLabelHalfW) : plotW / 2;
  return (
    <div className="relative h-full min-h-[130px]" ref={setBox}>
      <div className="relative h-full">
      <svg
        ref={svgRef}
        /**
         * NO viewBox, and that is the point.
         *
         * A viewBox is a scale factor between the drawing and the box, and this
         * chart has been distorted by that factor twice now: once because the
         * factor was fixed at 640 and stretched to fit, and again because the
         * measured factor and the real width can disagree — during a resize, at
         * a browser zoom, or on any frame where the observer has not caught up.
         * Whenever they disagree, preserveAspectRatio="none" stretches the text
         * and turns the endpoint dot into an oval. Reported both times.
         *
         * Without one, the SVG's user units ARE CSS pixels, always. A stale
         * measurement then costs a line that stops a few pixels short for one
         * frame, and nothing can ever be drawn out of shape.
         */
        width="100%"
        height={H}
        style={{ display: "block" }}
        onPointerMove={(e) => {
          if (hoverSuppressed) return;
          const svg = svgRef.current;
          if (!svg) return;
          const r = svg.getBoundingClientRect();
          const frac = (e.clientX - r.left) / r.width; // 0..1 across the plotted width
          setHover(clamp(Math.round(frac * (points.length - 1)), 0, points.length - 1));
        }}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Attendance trend across recent services"
      >
        <line x1={0} y1={H - padBottom} x2={plotW} y2={H - padBottom} stroke="var(--su-line)" />
        <defs>
          <linearGradient id={`${gradientId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--su-accent)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--su-accent)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id={`${splGradientId}`} x1="0" y1="0" x2="0" y2="1">
            {/* Lighter than the attendance fill, deliberately. Two washes of equal
                weight read as two foregrounds fighting; this one has to sit under
                the attendance curve and still be legible where they overlap. */}
            <stop offset="0%" stopColor="var(--su-ok-9)" stopOpacity={0.2} />
            <stop offset="100%" stopColor="var(--su-ok-9)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* SPL FIRST — SVG paints in document order, so everything below this is
            drawn over it. That is the depth: the level is the ground the
            attendance curve stands on, not a second line competing with it.
            Slightly thinner and slightly transparent for the same reason. */}
        {showSpl &&
          splRuns.map((run, ri) => (
            <g key={ri}>
              {run.length > 1 && (
                <polygon
                  points={`${x(run[0].i).toFixed(1)},${H - padBottom} ${run
                    .map((r) => `${x(r.i).toFixed(1)},${sy(r.v).toFixed(1)}`)
                    .join(" ")} ${x(run[run.length - 1].i).toFixed(1)},${H - padBottom}`}
                  fill={`url(#${splGradientId})`}
                />
              )}
              <polyline
                points={run.map((r) => `${x(r.i).toFixed(1)},${sy(r.v).toFixed(1)}`).join(" ")}
                fill="none"
                stroke="var(--su-ok-9)"
                strokeWidth={2}
                strokeOpacity={0.85}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              {/* A single reading between two gaps has no line to be seen as, so
                  it is drawn as a dot rather than silently disappearing. */}
              {run.length === 1 && (
                <circle cx={x(run[0].i)} cy={sy(run[0].v)} r={2.5} fill="var(--su-ok-9)" fillOpacity={0.85} />
              )}
            </g>
          ))}
        {/* The SPL endpoint — the latest point that actually carries a level,
            marked the same way the newest attendance point is (hollow while
            still live, solid once settled), in the series' own colour. Not
            necessarily the same x as the attendance dot below it: a weekend
            can have attendance with no Smaart reading at all. */}
        {splLevel != null &&
          (splEndpointLive ? (
            <circle cx={splEndpointX} cy={splEndpointY} r={4} fill="var(--su-bg)" stroke="var(--su-ok-9)" strokeWidth={2} />
          ) : (
            <circle cx={splEndpointX} cy={splEndpointY} r={4} fill="var(--su-ok-9)" />
          ))}
        <polygon points={area} fill={`url(#${gradientId})`} />
        <polyline points={poly} fill="none" stroke="var(--su-accent)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {/* The newest point is hollow while its service is still recording — that
            total is a partial and will keep climbing, so it must not read as a
            settled weekend. */}
        {points[points.length - 1].live ? (
          <circle cx={lastX} cy={lastY} r={4} fill="var(--su-bg)" stroke="var(--su-accent)" strokeWidth={2} />
        ) : (
          <circle cx={lastX} cy={lastY} r={4} fill="var(--su-accent)" />
        )}
        {hp && (
          <g pointerEvents="none">
            <line x1={hx} y1={padTop} x2={hx} y2={H - padBottom} stroke="var(--su-line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={hx} cy={hy} r={4} fill="var(--su-accent)" stroke="var(--su-bg)" strokeWidth={1.5} />
            {showSpl && hp?.spl != null && (
              <circle cx={hx} cy={sy(hp.spl)} r={3.5} fill="var(--su-ok-9)" stroke="var(--su-bg)" strokeWidth={1.5} />
            )}
          </g>
        )}
        <text x={padX} y={H - 8} fontFamily="var(--font-mono)" fontSize={11} fill="var(--su-fg-subtle)">{shortDay(points[0].day)}</text>
        <text x={plotW - padX} y={H - 8} textAnchor="end" fontFamily="var(--font-mono)" fontSize={11} fill="var(--su-fg-subtle)">{shortDay(points[points.length - 1].day)}</text>
      </svg>
      {/* Hover tooltip — an HTML overlay rather than SVG text, so it takes the
          app's own type and wraps like everything else. */}
      {hp && (
        <div
          ref={setTip}
          className={`pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-line-strong bg-popover px-2 py-1 shadow-md backdrop-blur-xl${tipAbove ? " -translate-y-full" : ""}`}
          style={{
            left: `${tipLeft}px`,
            top: `${tipTop}px`,
            // Held back for the one frame between mounting and being measured,
            // because an unmeasured tooltip cannot be clamped and would appear
            // hanging off the edge and then jump. The width survives the
            // tooltip unmounting, so only the first hover of a page waits.
            opacity: tipW > 0 ? undefined : 0,
          }}
        >
          <div className="font-mono text-caption2 tabular-nums text-fg-subtle whitespace-nowrap">
            {shortDay(hp.day)}{hp.live ? " · recording" : ""}
          </div>
          <div className="font-mono text-caption1 font-medium tabular-nums text-fg text-center">{hp.value.toLocaleString()}</div>
          {/* The level for this day, under the attendance figure and marked with
              the series' own colour so the tooltip says which line it belongs to
              without needing a legend. Only when there IS one — a day with no
              recording says nothing rather than "—", which would read as a
              measured silence. */}
          {showSpl && hp.spl != null && (
            <div className="mt-0.5 flex items-center justify-center gap-1.5 font-mono text-caption2 tabular-nums whitespace-nowrap">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--su-ok-9)" }} />
              <span className="text-fg-muted">{splLabel}</span>
              <span className="text-fg">{hp.spl.toFixed(1)} dB</span>
            </div>
          )}
          {hp.parts && hp.parts.length > 1 && (
            <div className="mt-1 flex flex-col gap-0.5 border-t border-line pt-1">
              {hp.parts.map((p, i) => (
                <div key={i} className="flex items-center justify-between gap-3 font-mono text-caption2 tabular-nums text-fg-muted whitespace-nowrap">
                  <span>{p.label}</span>
                  <span>{p.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Latest attendance, pinned above the most recent point (hidden while
          hovering so it doesn't collide with the tooltip). Only this one value —
          labeling every point would clutter. */}
      {!hp && (
        <span
          className="pointer-events-none absolute font-mono text-caption1 font-medium tabular-nums text-fg"
          // Above the last point, or beside it when there is no room above —
          // which is exactly the common case, because the newest weekend being
          // the highest one is what puts the point at the top of the band. It
          // used to clear the dot only because the line stopped short of the
          // card; now that the line reaches the edge, the two share a corner.
          //
          // Stepping sideways rather than making room at the top keeps every
          // pixel of rise the curve has.
          style={{ top: `${Math.max(0, lastY - 20)}px`, right: lastY - 20 < 0 ? 18 : 4 }}
        >
          {latest.toLocaleString()}
        </span>
      )}
      {/* Latest SPL, mirroring the attendance label above but on its own
          endpoint and in the series' own colour — hidden on the same terms
          (no metric chosen, or hovering). */}
      {splLevel != null && !hp && (
        <span
          className="pointer-events-none absolute -translate-x-1/2 font-mono text-caption1 font-medium tabular-nums"
          style={{ top: `${splLabelTop}px`, left: `${splLabelLeft}px`, color: "var(--su-ok-9)" }}
        >
          {splLevel.toFixed(1)} dB
        </span>
      )}
      </div>
    </div>
  );
}

