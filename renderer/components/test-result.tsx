// test-result.tsx — a Test's answer, as an integration dialog draws it: a tick or a
// cross, and the server's own words.
//
// One component for both places it appears. Most dialogs show it in the footer beside
// their Test button, on one line; Companion's Test sits in its second card, where the
// answer has room to wrap and is drawn as a box. The words are the same either way:
// the message the server sent, or OK / Failed when it sent none.

import { CheckCircle2Icon, XCircleIcon } from "lucide-react";

import { cn } from "../lib/cn";

export interface TestOutcome {
  ok: boolean;
  message?: string;
}

/** The words for an answer: the server's message, or OK / Failed when there is none. */
export const testMessage = (r: TestOutcome): string => r.message ?? (r.ok ? "OK" : "Failed");

export function TestResult({ result, wrap = false }: { result: TestOutcome; /** A box that wraps, for a card; otherwise one truncated line, for a footer. */ wrap?: boolean }) {
  const Icon = result.ok ? CheckCircle2Icon : XCircleIcon;
  return (
    <span
      role="status"
      data-test-result={result.ok ? "ok" : "failed"}
      className={cn(
        "flex min-w-0 gap-1.5 text-caption1",
        wrap ? "items-start rounded-md bg-fill px-2.5 py-2 text-footnote" : "items-center",
        result.ok ? (wrap ? "text-fg" : "text-green-10") : wrap ? "text-danger-11" : "text-red-10",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", wrap && "mt-px", result.ok ? "text-green-10" : "text-red-10")} />
      <span className={wrap ? "min-w-0 break-words" : "truncate"}>{testMessage(result)}</span>
    </span>
  );
}
