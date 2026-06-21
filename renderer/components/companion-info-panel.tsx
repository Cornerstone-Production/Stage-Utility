import { useStageState } from "../main/use-stage-state";
import { Button, toast } from "./ui";
import { CopyIcon } from "lucide-react";

// Informational panel shown under the "Bitfocus Companion" integration card.
// There is nothing to configure here: the Companion module connects TO this app's
// HTTP/SSE API. So this just shows the URL operators point Companion at, and a
// live count of connected Companion clients (pushed from the server as marked SSE
// streams connect/close — see remote-server.ts + integration-manager.ts).
export function CompanionInfoPanel({ state }: { state: IntegrationState }) {
  const { state: stage } = useStageState();
  const url = stage?.remoteUrl ?? null;
  const connectedCount =
    state.connection === "connected" && state.message ? state.message : null;

  return (
    <div className="mt-1 flex flex-col gap-2">
      <p className="text-caption1 text-gray-11">
        Add a <span className="text-gray-12 font-medium">Cornerstone Stage Utility</span>{" "}
        connection in Bitfocus Companion and point it at this server. No password — it works
        on your local network.
      </p>

      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate rounded bg-gray-a3 px-2 py-1 text-caption1 text-gray-12">
          {url ?? "LAN address unavailable"}
        </code>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          disabled={!url}
          onClick={() =>
            url &&
            navigator.clipboard
              .writeText(url)
              .then(() => toast.success("URL copied"))
              .catch(() => toast.error("Couldn't copy URL"))
          }
          aria-label="Copy connect URL"
          title="Copy URL"
        >
          <CopyIcon className="size-3.5 text-gray-9" />
        </Button>
      </div>
      <p className="text-caption2 text-gray-9">
        In Companion, use the host/IP and port from this URL (default port 8788).
      </p>

      <p className="text-caption1 text-gray-11">
        {connectedCount ?? "No Companion clients connected yet."}
      </p>
    </div>
  );
}
