// companion-outbound-card.tsx — the second Companion card: Stage Utility presses
// Companion buttons.
//
// The half that dials out. Its two fields (host, API port) are the integration's
// own form, saved by the dialog's Save, so the card takes them as children and
// holds only what is the card's: Test, and Browse buttons. Test reads Companion
// and presses nothing; Browse buttons draws its pages read-only.

import { useState, type ReactNode } from "react";
import { Loader2Icon } from "lucide-react";

import { CompanionBrowser } from "./companion-browser";
import { SETTINGS_CARD } from "../lib/card-classes";
import { Button } from "./ui";
import { TestResult, type TestOutcome } from "./test-result";

export function CompanionOutboundCard({
  children,
  testing,
  result,
  onTest,
  dirty,
}: {
  /** The host and API port fields. */
  children: ReactNode;
  testing: boolean;
  /** The last Test's answer, or null before one. */
  result: TestOutcome | null;
  onTest: () => void;
  /** The fields above hold changes that are not saved. */
  dirty: boolean;
}) {
  const [browsing, setBrowsing] = useState(false);
  return (
    <section className={SETTINGS_CARD} data-companion-card="outbound">
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
        {/* Test reads the SAVED host and port, not what is typed. Beside fields with unsaved edits
            it would report on a Companion the operator is not looking at, so it waits for Save. */}
        <Button variant="filled" size="small" onClick={onTest} disabled={testing || dirty}>
          {testing ? <Loader2Icon className="size-3.5 animate-spin text-gray-9" /> : null}
          Test
        </Button>
        {dirty && <span className="text-caption1 text-fg-muted" data-test-needs-save="">Save first: Test reads the saved settings.</span>}
        <Button variant="transparent" size="small" aria-expanded={browsing} onClick={() => setBrowsing((b) => !b)}>
          {browsing ? "Hide buttons" : "Browse buttons"}
        </Button>
      </div>

      {result !== null && <TestResult result={result} wrap />}

      {browsing && <CompanionBrowser />}
    </section>
  );
}
