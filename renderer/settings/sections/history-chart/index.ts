// The History chart module. Attendance, Sound and (in a later PR) Trends are
// configurations of HistoryChart; nothing else in here is imported directly by
// a section except CustomizePopover, which is the section's own control.

export {
  AXIS_LABEL_GAP,
  HistoryChart,
  fitLabel,
  keepAxisLabels,
  type ChartMilestone,
  type HistoryChartProps,
} from "./history-chart";
export { CustomizePopover, type CustomizeGroup, type CustomizeOption } from "./customize";
export { StatStrip, type StatFigure, type StripValue } from "./stat-strip";
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
