import { useRef } from "react";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";

import { useStageState } from "../main/use-stage-state";
import { Button, Input, toast } from "./ui";
import { SETTINGS_CARD } from "../lib/card-classes";
import { copyText } from "../lib/clipboard";

/** Where the Companion module lives. Not in the app's own repo — it ships to
 *  Companion separately, which is exactly why a link is worth having. */
const MODULE_URL = "https://github.com/Cornerstone-Production/companion-module-stageutility-stageutility";

/** A read-only value with a Copy button. Companion takes host and port as separate fields and cannot resolve DNS, so each is copied on its own. */
function CopyField({ label, value }: { label: string; value: string }) {
  const input = useRef<HTMLInputElement>(null);
  const id = `companion-copy-${label.toLowerCase()}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-caption1 font-medium text-fg-muted">
        {label}
      </label>
      <div className="flex gap-1.5">
        <Input ref={input} id={id} readOnly value={value} className="min-w-0 flex-1 font-mono tabular-nums" />
        <Button
          variant="filled"
          size="small"
          onClick={async () => {
            // Inside the dialog's focus trap, or the legacy copy path loses its selection to it.
            const ok = await copyText(value, input.current?.closest<HTMLElement>('[role="dialog"]'));
            if (ok) toast.success(`${label} copied`);
            else {
              // Plain HTTP has no clipboard write; the field is selected so the operator can copy it by hand.
              input.current?.select();
              toast.error(`Couldn't copy — select and copy manually`);
            }
          }}
          aria-label={`Copy ${label}`}
        >
          <CopyIcon className="size-3.5" /> Copy
        </Button>
      </div>
    </div>
  );
}

// The first Companion card: Companion controls Stage Utility. There is nothing to
// configure here and no switch: the Companion module connects TO this app's
// HTTP/SSE API, so what is shown is the address to give it and what the row says
// about the modules that have. Companion can't resolve DNS and takes host + port as
// separate fields, so we show the raw LAN IP and port split out (from state.lanUrl,
// not the DNS publicUrl), plus the row's own status line.
//
// The Status field is where the Companion row's message is read. ConnectionBadge,
// which every integration card and dialog header uses, shows a message only while
// the row is in `error`, and the Companion row is in error for exactly one
// reason: a Test that could not reach Companion (integration-manager's
// applyCompanionRow). Every other thing that message carries — the module-client
// count, the connection health from the hourly reconcile — is shown here or
// nowhere.
//
// An earlier version of this comment said the row was "never in error, because
// nothing dials out to fail". That was wrong: the outbound half dials out and
// fails whenever Companion is switched off.
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

  /**
   * The row's whole message, whatever the connection state is.
   *
   * It used to be shown only while `connection === "connected"`, which meant
   * only while a Companion module was attached. Everything else the message can
   * carry is true with none attached: the connection health from the hourly
   * reconcile ("12 of 52 connection(s) in error"), and the reason a Test failed.
   * Both were written to the row and rendered nowhere — the panel showed "No
   * Companion clients connected yet." over the top of them.
   *
   * `break-words` on the element below, and no truncation: the message is
   * several sentences now and this is the one place it is read in full.
   */
  const status = state.message ?? null;

  return (
    <section className={SETTINGS_CARD} data-companion-card="inbound">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-caption2 tracking-wide text-fg-subtle">COMPANION → STAGE UTILITY</span>
        <h3 className="text-footnote font-semibold text-fg">Companion controls Stage Utility</h3>
        <p className="max-w-[62ch] text-caption1 text-fg-muted">
          Stream Deck buttons for plan control, view routing and blackout. Add a connection in Bitfocus Companion —
          search its connection list for <span className="font-medium text-fg">Stage Utility</span> — and give it this
          address. No password, and nothing to switch on here: it works on your local network.
        </p>
        {/* The module is the missing half: this panel told you what to type
            and never said where to get the thing you type it into. */}
        <p className="max-w-[62ch] text-caption1 text-fg-muted">
          You need the module first —{" "}
          <a
            href={MODULE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            companion-module-stageutility-stageutility
            <ExternalLinkIcon className="size-3" />
          </a>
          . Sideload it into Companion, then add the connection.
        </p>
      </div>

      {host ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2.5">
          <CopyField label="Host" value={host} />
          <CopyField label="Port" value={port ?? "8788"} />
        </div>
      ) : (
        <p className="text-caption1 text-fg-muted">LAN address unavailable.</p>
      )}

      {/* The row's message, below the address: the client count, the connection health,
          and the reason a Test failed. It grew a second sentence once Companion gained an
          outbound half ("… — 508 button(s), 39 on/off pair(s)"), so it wraps. */}
      <div className="flex flex-col gap-1 rounded-md border border-line px-2.5 py-2">
        <span className="text-caption1 font-medium text-fg-muted">Status</span>
        <span className="break-words text-footnote text-fg" data-testid="companion-status">
          {status ?? "No Companion clients connected yet."}
        </span>
      </div>
    </section>
  );
}
