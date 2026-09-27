// automation-registry.ts — the one react-query definition of the automation
// registry (GET /api/automation/registry).
//
// Three surfaces read it: the Automation section, the layout editor's
// action-button inspector, and every action-button on screen through
// useAutomationActions. A query key they share has to mean one shape. Each used
// to spell its own queryFn, and the button's cached the bare `actions` list
// under the same key the other two cached the whole registry under, so
// whichever fetch landed first handed the rest the wrong shape: the inspector
// sat on "Loading actions…" for good, or a layout opened with a button already
// on it crashed calling `.find` on an object. A consumer that wants part of the
// registry takes it with `select`, never a queryFn of its own.

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
