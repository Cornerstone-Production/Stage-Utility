// companion-outbound-card.tsx — the second Companion card: Stage Utility presses
// Companion buttons.
//
// The half that dials out. Its two fields (host, API port) are the integration's
// own form, saved by the dialog's Save, so the card takes them as children and
// holds only what is the card's: Test, and Browse buttons. Test reads Companion
// and presses nothing; Browse buttons draws its pages read-only.

import { useState, type ReactNode } from "react";
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";

import { CompanionBrowser } from "./companion-browser";
import { COMPANION_CARD } from "./companion-info-panel";
import { Button } from "./ui";
import { cn } from "../lib/cn";

export function CompanionOutboundCard({
  children,
  testing,
  result,
  onTest,
}: {
  /** The host and API port fields. */
  children: ReactNode;
  testing: boolean;
  /** The last Test's answer, or null before one. */
  result: { ok: boolean; message?: string } | null;
  onTest: () => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  return (
    <section className={COMPANION_CARD} data-companion-card="outbound">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-caption2 tracking-wide text-fg-subtle">STAGE UTILITY → COMPANION</span>
        <h3 className="text-footnote font-semibold text-fg">Stage Utility presses Companion buttons</h3>
        <p className="max-w-[62ch] text-caption1 text-fg-muted">
          Needed for any button, Home tile, command or rule that presses a Companion button. Turn on Settings → Protocols
          → HTTP in Companion. Leave the host blank and nothing is ever pressed.
        </p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2.5">{children}</div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="filled" size="small" onClick={onTest} disabled={testing}>
          {testing ? <Loader2Icon className="size-3.5 animate-spin text-gray-9" /> : null}
          Test
        </Button>
        <Button variant="transparent" size="small" aria-expanded={browsing} onClick={() => setBrowsing((b) => !b)}>
          {browsing ? "Hide buttons" : "Browse buttons"}
        </Button>
      </div>

      {result !== null && (
        <div
          role="status"
          data-companion-test={result.ok ? "ok" : "failed"}
          className={cn(
            "flex items-start gap-1.5 rounded-md bg-fill px-2.5 py-2 text-footnote",
            result.ok ? "text-fg" : "text-danger-11",
          )}
        >
          {result.ok ? (
            <CheckCircle2Icon className="mt-px size-3.5 shrink-0 text-green-10" />
          ) : (
            <XCircleIcon className="mt-px size-3.5 shrink-0 text-red-10" />
          )}
          <span className="min-w-0 break-words">
            {result.ok ? (result.message ?? "OK") : (result.message ?? "Failed")}
          </span>
        </div>
      )}

      {browsing && <CompanionBrowser />}
    </section>
  );
}
