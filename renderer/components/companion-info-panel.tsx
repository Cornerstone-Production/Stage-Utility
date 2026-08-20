import { useStageState } from "../main/use-stage-state";
import {
  Button,
  Field,
  FieldGroup,
  FieldContent,
  FieldLabel,
  FieldDescription,
  toast,
} from "./ui";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { copyText } from "../lib/clipboard";

/** Where the Companion module lives. Not in the app's own repo — it ships to
 *  Companion separately, which is exactly why a link is worth having. */
const MODULE_URL = "https://github.com/Cornerstone-Production/companion-module-cornerstone-stageutility";

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
      </FieldContent>
      <div className="flex items-center gap-1.5 w-full min-w-0 sm:w-56">
        <code className="flex-1 min-w-0 truncate rounded bg-gray-a3 px-2 py-1 text-caption1 text-gray-12 tabular-nums">
          {value}
        </code>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={async () => {
            const ok = await copyText(value);
            if (ok) toast.success(`${label} copied`);
            else toast.error(`Couldn't copy — select and copy manually`);
          }}
          aria-label={`Copy ${label}`}
          tooltip={`Copy ${label}`}
        >
          <CopyIcon className="size-3.5 text-gray-9" />
        </Button>
      </div>
    </Field>
  );
}

// Informational panel shown under the "Bitfocus Companion" integration card.
// There is nothing to configure here: the Companion module connects TO this app's
// HTTP/SSE API. Companion can't resolve DNS and takes host + port as separate
// fields, so we show the raw LAN IP and port split out (from state.lanUrl, not the
// DNS publicUrl), plus a live connected-client count.
export function CompanionInfoPanel({ state }: { state: IntegrationState }) {
  const { state: stage } = useStageState();
  const lanUrl = stage?.lanUrl ?? null;

  let host: string | null = null;
  let port: string | null = null;
  if (lanUrl) {
    try {
      const u = new URL(lanUrl);
      host = u.hostname;
      port = u.port || "8788";
    } catch {
      host = null;
    }
  }

  const connectedCount =
    state.connection === "connected" && state.message ? state.message : null;

  return (
    <FieldGroup>
      <Field orientation="vertical">
        <FieldContent>
          <FieldLabel>Bitfocus Companion</FieldLabel>
          <FieldDescription>
            Add a <span className="text-gray-12 font-medium">Cornerstone Stage Utility</span>{" "}
            connection in Bitfocus Companion and enter this server&apos;s IP and port below. No
            password — it works on your local network.
          </FieldDescription>
          {/* The module is the missing half: this panel told you what to type
              and never said where to get the thing you type it into. */}
          <FieldDescription>
            You need the module first —{" "}
            <a
              href={MODULE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              companion-module-cornerstone-stageutility
              <ExternalLinkIcon className="size-3" />
            </a>
            . Sideload it into Companion, then add the connection.
          </FieldDescription>
        </FieldContent>
      </Field>

      {host ? (
        <>
          <CopyField label="IP / Host" value={host} />
          <CopyField label="Port" value={port ?? "8788"} />
        </>
      ) : (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>IP / Host</FieldLabel>
          </FieldContent>
          <span className="text-caption1 text-gray-9">LAN address unavailable.</span>
        </Field>
      )}

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel>Status</FieldLabel>
        </FieldContent>
        <span className="text-caption1 text-gray-10">
          {connectedCount ?? "No Companion clients connected yet."}
        </span>
      </Field>
    </FieldGroup>
  );
}
