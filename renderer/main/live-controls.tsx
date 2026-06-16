import { useState } from "react";
import { invoke } from "../lib/api";
import { toast } from "../components/ui";
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";

// Previous / Next buttons that drive PCO's Services Live timer — the same
// "go to previous / next item" controls as PCO's own live page. Always active
// (per the dashboards); PCO rejections (e.g. not a live controller) surface as a
// toast. The countdown updates on its own via the pco:live poll.
export function LiveControls({ className = "" }: { className?: string }) {
  const [busy, setBusy] = useState<"previous" | "next" | null>(null);

  async function go(dir: "previous" | "next") {
    if (busy) return;
    setBusy(dir);
    try {
      await invoke(dir === "next" ? "pco:liveNext" : "pco:livePrevious");
    } catch (e) {
      toast.error(
        `PCO ${dir} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(null);
    }
  }

  const btn =
    "flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 " +
    "text-white/85 hover:bg-white/10 active:bg-white/[0.16] transition-colors py-3 " +
    "text-[clamp(0.9rem,2.4vmin,1.25rem)] font-medium uppercase tracking-wider select-none " +
    "disabled:opacity-50 disabled:pointer-events-none";

  return (
    <div className={`shrink-0 grid grid-cols-2 gap-2.5 ${className}`}>
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
  );
}
