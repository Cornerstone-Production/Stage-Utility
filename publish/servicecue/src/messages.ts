// messages.ts — what a viewer is sent, in one place.
//
// Plain functions that return the text of a message, with no Workers API in them, so
// the root suite can say exactly what goes down a socket. The object (hub.ts) sends
// what these make and nothing it composed itself.

import { DOCS_CHANNEL, HEARTBEAT_CHANNEL, type DocsFrameData, type FrameChannel, type HeartbeatFrameData } from "../../../main/types/servicecue-publish.js";

/** The most doc keys one `publish:docs` message names; beyond it the message says `all`. */
export const DOCS_LIST_MAX = 50;

/** A frame: the stored text of its doc, as `data`. `replay` marks the one sent to a viewer that has just joined. */
export function frameMessage(channel: FrameChannel, dataText: string, replay = false): string {
  return `{"channel":${JSON.stringify(channel)},"data":${dataText}${replay ? ',"replay":true' : ""}}`;
}

/**
 * A heartbeat. Live, it is `at` alone (and the build). On the replay to a viewer that
 * has just joined it also carries `now`, so the viewer can age `at` by the edge's own
 * clock; `at` is null before the first heartbeat.
 */
export function heartbeatMessage(at: number | null, build: string | null, replayAt?: number): string {
  const data: HeartbeatFrameData = { at };
  if (replayAt !== undefined) data.now = replayAt;
  if (build !== null) data.build = build;
  return JSON.stringify({ channel: HEARTBEAT_CHANNEL, data, ...(replayAt !== undefined ? { replay: true } : {}) });
}

/**
 * The close code to answer a viewer's close with: its own when a code like it can be
 * sent, else 1000. 1004, 1005, 1006 and 1015 name no close and cannot be put in one
 * (`close(1004)` throws), and 1016 to 2999 are not for an endpoint to choose. A client
 * can still send any of them.
 */
export function echoableCloseCode(code: number): number {
  const sendable = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}

/** The doc keys whose content changed (or went). A change too wide to list is `all`. */
export function docsMessage(keys: readonly string[]): string {
  const data: DocsFrameData = keys.length > DOCS_LIST_MAX ? { keys: keys.slice(0, DOCS_LIST_MAX), all: true } : { keys: [...keys] };
  return JSON.stringify({ channel: DOCS_CHANNEL, data });
}
