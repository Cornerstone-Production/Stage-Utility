import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/** Stable identity, so a hook with nothing yet does not hand a new array out per render. */
const NO_CHANNELS: ProdcomChannelDTO[] = [];

/**
 * ProdCom's own channel list — every channel the box has, whether or not it has
 * spoken. Reads the current list once on mount, then replaces it with each
 * "prodcom:channels" broadcast (the server sends the whole list, the same shape
 * as useTranscript). Used by the Transcription colors panel to list every
 * channel, and available to anything else that wants ProdCom's own colors.
 */
export function useProdcomChannels(enabled = true): ProdcomChannelDTO[] {
  const read = useCallback(() => invoke<ProdcomChannelDTO[]>("prodcom:getChannels"), []);
  const channels = useStatusChannel<ProdcomChannelDTO[]>(read, "prodcom:channels", enabled);
  return Array.isArray(channels) ? channels : NO_CHANNELS;
}
