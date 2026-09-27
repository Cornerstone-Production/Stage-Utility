// The History chart module: HistoryChart itself, CustomizePopover (a
// section's column-picker control), StatStrip, the persisted-column prefs
// helpers, serviceWindowOf, and the chart geometry/lane helpers.
//
// Attendance, Sound, Service History and History's OWN Trends card
// (history-trends/trends-card.tsx) render HistoryChart, built on these. The
// Baptisms tab's session chart reuses only the lane and geometry helpers for
// its own SVG, without HistoryChart. The Baptisms tab's OWN Trends card
// (baptisms/trends-card.tsx — a different file, easy to confuse with the one
// above) does not use this module at all: it reuses Sparkline and pctChange
// from history-trends directly.
//
// Most consumers import everything they need from this barrel; session-chart.tsx
// and history-trends/trends-card.tsx also import a submodule export directly
// alongside it — pre-existing, and left as it is.

export {
  AXIS_LABEL_GAP,
  HistoryChart,
  fitLabel,
  keepAxisLabels,
  type ChartMilestone,
  type HistoryChartProps,
} from "./history-chart";
export { CustomizePopover, type CustomizeGroup, type CustomizeOption } from "./customize";
export { StatStrip, type StatFigure, type StripHover, type StripValue } from "./stat-strip";
export {
  addDefaultOnce,
  hasStoredChoice,
  readStoredKeys,
  seedStoredKeys,
  subscribeStoredKeys,
  useStoredKeys,
  useStoredKeysVersion,
} from "./prefs";
export { serviceWindowOf, type ServiceWindow } from "./service-window";
export {
  dateTicks,
  niceAxis,
  splitRuns,
  tenMinuteDomainEnd,
  type ChartPoint,
  type ChartSeries,
  type YScale,
} from "./geometry";
export { laneLabel, laneSegments, segmentAt, type LaneItem, type LaneSegment } from "./lane";
