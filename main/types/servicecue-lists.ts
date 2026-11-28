// What `servicecue:lists` carries: that the ServiceCue layouts or the category roles were
// saved, never what is in them. A screen or a rundown page re-reads both when it hears it.

/**
 * The last write to either list, and its place in this server's sequence.
 *
 * Identity only: a frame that carried the lists would put the layouts' contents on the
 * stream for every client that named the channel, and the reader has to ask anyway to get
 * the slugs and the migration the server applies on a read. The connect burst re-sends the
 * last frame, so a page that was disconnected while a save landed hears of it on reconnect.
 */
export interface ServiceCueListsChanged {
  /** This server process. */
  epoch: string;
  /** 0 until the first write since the process started. */
  seq: number;
}

/** The SSE channel that carries a {@link ServiceCueListsChanged}. */
export const SERVICECUE_LISTS_CHANNEL = "servicecue:lists";
