// sparkline.tsx — eight peaks, in the width of a tile.
//
// Deliberately NOT a HistoryChart. That component carries an axis, a grid, a
// stat strip, an item lane and a hover readout, and every one of them is wrong
// at 120×28: a tile's line is a shape, not a chart, and the numbers beside it
// are what is read. The chart module is reused for the full-width trend plot
// below the tiles, which is the place that wants all of it.

/** A line through `values`, filling the box. A single value draws a flat rule
 *  at the middle rather than nothing — one recording is a fact worth showing. */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  /** Named for a screen reader, which cannot read a line. */
  label: string;
}) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return null;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const span = hi - lo || 1;
  // 2px of inset top and bottom so the 1.5px stroke is not half-clipped at the
  // extremes — the highest and lowest points are exactly the ones being read.
  const y = (v: number) => 2 + (1 - (v - lo) / span) * (height - 4);
  const x = (i: number) => (finite.length === 1 ? width / 2 : (i / (finite.length - 1)) * width);
  const d = finite.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = finite.length - 1;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      className="block overflow-visible"
    >
      <path
        data-sparkline=""
        d={finite.length === 1 ? `M0,${y(finite[0]).toFixed(1)}L${width},${y(finite[0]).toFixed(1)}` : d}
        fill="none"
        stroke="var(--color-green-9)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* The newest recording, marked: a tile is read right-to-left, and which
          end is "now" is otherwise a guess. */}
      <circle cx={x(last)} cy={y(finite[last])} r={2} fill="var(--color-green-9)" />
    </svg>
  );
}
