// The Public link settings and status, read under ONE query key. The Public link card
// writes every save into this entry (setQueryData), so a second reader under a key of its
// own never hears of it and shows the old address until its own window runs out.

import { useQuery } from "@tanstack/react-query";

import type { PublishSettingsDTO } from "../../../main/types/servicecue-publish-status.js";
import { invoke } from "../../lib/api";

export const PUBLISH_QUERY_KEY = ["servicecue:getPublish"] as const;

/** The publishing settings, read again every `pollMs` while anything that shows them is mounted
 *  (never, with `false`: a reader that only needs the address, and is told of a change by the
 *  card that writes it). */
export function usePublishQuery(pollMs: number | false = false) {
  return useQuery({
    queryKey: PUBLISH_QUERY_KEY,
    queryFn: () => invoke<PublishSettingsDTO>("servicecue:getPublish"),
    refetchInterval: pollMs,
  });
}
