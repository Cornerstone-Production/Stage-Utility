// Re-export of the shared patch resolver, which lives in main/services so the
// server-side export renders exactly the patch this screen shows.
export {
  endpointKey,
  endpointsEqual,
  mergeOverrides,
  diffEndpoints,
  resolvePatch,
  type ResolvedPatch,
} from "../../main/services/patch-resolve.js";
