import { DropletIcon, ChevronLeftIcon } from "lucide-react";

import { BaptismOperator } from "./baptism-operator";

/**
 * Standalone kiosk page for running baptisms (reachable at /baptism, listed in
 * the display picker). Renders the same <BaptismOperator/> as the Settings
 * "Baptisms" tab and drives the same live session — meant to be opened on a
 * tablet/phone at the baptism. Scrollable (unlike the fixed display views) so the
 * controls, log and past sessions all reach on a small screen.
 */
export function BaptismOperatorView() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-gray-5 px-4 py-3 shrink-0">
        <a
          href="/"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption1 text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
          title="Back to displays"
        >
          <ChevronLeftIcon className="size-4" /> Displays
        </a>
        <span className="inline-flex items-center gap-1.5 text-headline font-semibold text-gray-12">
          <DropletIcon className="size-5 text-blue-9" /> Baptisms
        </span>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto w-full max-w-2xl">
          <BaptismOperator />
        </div>
      </div>
    </div>
  );
}
