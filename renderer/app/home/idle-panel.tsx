// Home, the rest of the week.
//
// Next service, this week's plan, and the readiness list — the question an
// operator actually has on a Thursday. Trends are headlines that DRILL INTO
// History rather than restating it: two surfaces computing the same number is
// how they come to disagree about it.

import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { readinessChecks, outstanding, type ReadinessCheck } from "./readiness";
import { flashTarget } from "../flash";
import { cn } from "../../lib/cn";

function CheckRow({ check }: { check: ReadinessCheck }) {
  const body = (
    <>
      <span
        className={cn(
          "grid place-items-center size-4 rounded-full shrink-0",
          check.ok ? "bg-live-9 text-white" : "border border-fg-subtle",
        )}
        aria-hidden="true"
      >
        {check.ok && <CheckIcon className="size-2.5" strokeWidth={3} />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-body text-fg">{check.label}</span>
        <span className="block text-caption1 text-fg-subtle truncate">{check.detail}</span>
      </span>
      {!check.ok && <ChevronRightIcon className="size-4 text-fg-subtle shrink-0" />}
    </>
  );

  // A passing check is not a link: there is nothing to fix, and making it
  // clickable invites a trip that changes nothing.
  if (check.ok || !check.route) {
    return <div className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0">{body}</div>;
  }
  return (
    <Link
      to={check.route}
      onClick={() => check.flash && flashTarget(check.flash)}
      className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 transition-colors hover:bg-fill"
    >
      {body}
    </Link>
  );
}

export function IdlePanel({
  state,
  onlineOutputIds,
}: {
  state: StageState;
  onlineOutputIds: readonly string[];
}) {
  const checks = readinessChecks(state, onlineOutputIds);
  const todo = outstanding(checks);

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-xl border border-line bg-surface overflow-hidden">
        <header className="flex items-baseline gap-2 px-4 py-3 border-b border-line">
          <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            Ready for the next service
          </h2>
          <span className="ml-auto text-caption1 text-fg-subtle">
            {todo.length === 0
              ? "everything set"
              : `${todo.length} to sort out`}
          </span>
        </header>
        {checks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </section>
    </div>
  );
}
