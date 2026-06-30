import { ExternalLinkIcon, CopyIcon } from "lucide-react";

import { Button, toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { BaptismOperator } from "../../main/baptism-operator";

/**
 * Settings "Baptisms" tab — the operator panel plus a link to the standalone
 * /baptism kiosk page. Both render the SAME <BaptismOperator/> and drive the
 * same live session (singleton baptism-timer service over the "baptism:state"
 * channel), so an operator can run it from a tablet on /baptism while this tab
 * mirrors it.
 */
export function BaptismsSection() {
  const url = `${window.location.origin}/baptism`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-5 bg-gray-2 px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-caption1 text-gray-11">Operator page</span>
          <code className="text-caption2 text-gray-9 truncate">{url}</code>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="transparent"
            onClick={() => void copyText(url).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy — copy it from the address bar")))}
            tooltip="Copy the operator-page link to open on a tablet/phone"
          >
            <CopyIcon className="size-4 text-gray-9" /> Copy link
          </Button>
          <Button
            variant="filled"
            onClick={() => window.open("/baptism", "_blank", "noopener")}
            tooltip="Open the standalone operator page (drives the same live session)"
          >
            <ExternalLinkIcon className="size-4 text-gray-9" /> Open operator page
          </Button>
        </div>
      </div>

      <BaptismOperator />
    </div>
  );
}
