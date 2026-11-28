import { errorMessage } from "@main/services/errors";

import { toast } from "../components/ui";

/** Tell the operator a per-browser choice was not kept (the value in use is unchanged for this visit).
 *  Takes what `storeFailure` returns: nothing to say for null. Kept out of safe-storage.ts, which the
 *  public page bundles and which must not pull in the toast kit. */
export function toastStoreFailure(err: Error | null): void {
  if (err) toast.error(`Couldn't remember that choice: ${errorMessage(err)}`);
}
