// What a Mac output helper reports about one output, and what the server makes of
// it. The same shapes for the server that holds it and the Screens page that
// shows it.

/** The body of POST /api/devices/:id/health, as the server accepts it. */
export interface OutputHealthReport {
  /** Frames per second the output sent over the reporting window. */
  fps: number;
  /** Percent, 0 to 100, of that window's frames that repeated the picture before
   *  because the page was late. */
  repeated: number;
  /** Frames the card dropped since the output opened. Cumulative, so a lower
   *  number than the last report means the output was reopened. */
  dropped: number;
  /** When the helper took the reading, ms since the epoch on the helper's own
   *  clock. Shown nowhere and trusted for nothing: the server dates a report by
   *  when it arrived. */
  at: number;
  /** Milliseconds from the page being drawn to the picture leaving the card, as
   *  the helper measured it. Absent until the helper has a measurement; a DeckLink
   *  output's only. Not part of the struggle rule: a long latency is a fact about
   *  the card and its mode, not a fault. */
  latencyMs?: number;
}

/** What Screens is shown for one output. */
export interface OutputHealth extends OutputHealthReport {
  /** The device the report is for. */
  deviceId: string;
  /** When the server received it, ms since the epoch. */
  receivedAt: number;
  /** Frames dropped or repeated for the last few reports running. */
  struggling: boolean;
}
