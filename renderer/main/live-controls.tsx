import { errorMessage } from "@main/services/errors";
import { useState } from "react";
import { invoke } from "../lib/api";
import { confirm, toast } from "../components/ui";
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon, RotateCcwIcon } from "lucide-react";

// Previous / Next buttons that drive PCO's Services Live timer — the same
// "go to previous / next item" controls as PCO's own live page. Always active
// (per the dashboards); PCO rejections (e.g. not a live controller) surface as a
// toast. The countdown updates on its own via the pco:live poll.
export function LiveControls({
  className = "",
  live = false,
}: {
  className?: string;
  /** A service is currently recording — gates Reset pacing, which the server
   *  409s outside of one. Previous/Next stay always-on: they drive PCO Live
   *  directly and PCO itself answers if there is nothing to step through. */
  live?: boolean;
}) {
  const [busy, setBusy] = useState<"previous" | "next" | "reset-pacing" | null>(null);

  async function go(dir: "previous" | "next") {
    if (busy) return;
    setBusy(dir);
    try {
      await invoke(dir === "next" ? "pco:liveNext" : "pco:livePrevious");
    } catch (e) {
      toast.error(
        `PCO ${dir} failed: ${errorMessage(e)}`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function resetPacing() {
    if (busy) return;
    if (!(await confirm({
      title: "Reset pacing?",
      message: "Items before now stop counting toward the pacing readout. The recording itself is untouched.",
      confirmLabel: "Reset pacing",
    }))) return;
    setBusy("reset-pacing");
    try {
      await invoke("serviceTimeline:resetPacing");
      toast.success("Pacing reset");
    } catch (e) {
      toast.error(`Couldn't reset pacing: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const btn =
    "flex items-center justify-center gap-2 rounded-2xl border border-line bg-surface " +
    "text-fg hover:bg-white/10 active:bg-white/[0.16] transition-colors py-3 " +
    "text-[clamp(0.9rem,2.4vmin,1.25rem)] font-medium uppercase tracking-wider select-none " +
    "disabled:opacity-50 disabled:pointer-events-none";

  return (
    <div className={`shrink-0 flex flex-col gap-2.5 ${className}`}>
      <div className="grid grid-cols-2 gap-2.5 flex-1">
        <button
          type="button"
          onClick={() => go("previous")}
          disabled={!!busy}
          className={btn}
          aria-label="Previous timer item"
        >
          {busy === "previous" ? (
            <Loader2Icon className="size-5 animate-spin" />
          ) : (
            <ChevronLeftIcon className="size-5" />
          )}
          Previous
        </button>
        <button
          type="button"
          onClick={() => go("next")}
          disabled={!!busy}
          className={btn}
          aria-label="Next timer item"
        >
          Next
          {busy === "next" ? (
            <Loader2Icon className="size-5 animate-spin" />
          ) : (
            <ChevronRightIcon className="size-5" />
          )}
        </button>
      </div>
      {live && (
        <button
          type="button"
          onClick={resetPacing}
          disabled={!!busy}
          className={btn}
          aria-label="Reset pacing"
        >
          {busy === "reset-pacing" ? (
            <Loader2Icon className="size-5 animate-spin" />
          ) : (
            <RotateCcwIcon className="size-5" />
          )}
          Reset pacing
        </button>
      )}
    </div>
  );
}
