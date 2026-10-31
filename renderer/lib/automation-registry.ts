// automation-registry.ts — the one react-query definition of the automation
// registry (GET /api/automation/registry).
//
// Two surfaces read it: the Automation section and the layout editor's Button
// inspector (its App action choice). A query key they share has to mean one
// shape. Each used to spell its own queryFn, and one cached the bare `actions`
// list under the same key the other cached the whole registry under, so whichever
// fetch landed first handed the rest the wrong shape: the inspector sat on
// "Loading actions…" for good. A consumer that wants part of the registry takes
// it with `select`, never a queryFn of its own.

import { errorMessage } from "@main/services/errors";

import type { Registry } from "../settings/sections/rule-editor-dialog";
import { invoke } from "./api";
import { logToServer } from "./client-log";

export const automationRegistryQuery = {
  queryKey: ["automation:registry"],
  /** Logs once per failed fetch, to the server and not only the console, and
   *  rethrows: every consumer gets the failure in `isError`, and an answer with
   *  no actions array is a failure too rather than an empty registry. */
  queryFn: async (): Promise<Registry> => {
    try {
      const r = await invoke<Registry>("automation:registry");
      if (!Array.isArray(r?.actions)) throw new Error("answered with no actions array");
      return r;
    } catch (err) {
      logToServer("automation", `could not load the automation registry: ${errorMessage(err)}`);
      throw err;
    }
  },
};
