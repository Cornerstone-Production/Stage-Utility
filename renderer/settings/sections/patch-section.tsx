import { useEffect, useState } from "react";
import { CableIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { EmptyState, SkeletonRows } from "../../components/ui";

/**
 * Stage patch sheet editor (Settings → Patch). Rack-centric input/output patch
 * with per-week variants — see docs/patch-sheet/DESIGN.md. This increment scaffolds
 * the section shell (load + live sync + Inputs/Outputs tabs); the device manager
 * and the editable table land next.
 */
export function PatchSection() {
  const [file, setFile] = useState<PatchFile | null>(null);
  const [tab, setTab] = useState<"in" | "out">("in");

  useEffect(() => {
    invoke<PatchFile>("patch:get")
      .then(setFile)
      .catch(() => setFile({ devices: [], endpoints: [], variants: [], assignments: { byServiceType: {}, byPlan: {} }, updatedAt: "" }));
    // Change-driven: the server broadcasts patch:updated on every save.
    return onNotification("patch:updated", (p) => setFile(p as PatchFile));
  }, []);

  if (!file) {
    return (
      <div className="py-6">
        <SkeletonRows rows={4} />
      </div>
    );
  }

  const racks = file.devices.filter((d) => d.kind === "rack");
  const rows = file.endpoints.filter((e) => e.dir === tab);
  const hasDevices = file.devices.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Inputs / Outputs tabs (peers) */}
      <div className="inline-flex self-start rounded-lg border border-line bg-surface p-1">
        {(["in", "out"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-3.5 py-1.5 text-footnote transition-colors ${
              tab === t ? "bg-fill-active text-fg" : "text-fg-muted hover:text-fg"
            }`}
          >
            {t === "in" ? "Inputs" : "Outputs"}
          </button>
        ))}
      </div>

      {!hasDevices ? (
        <EmptyState
          icon={<CableIcon />}
          title="No patch yet"
          hint="Add your SD racks and stage boxes to start recording the patch. You'll be able to import from CSV/Excel or build it here."
        />
      ) : (
        <div className="text-footnote text-fg-muted tabular-nums">
          {racks.length} rack{racks.length === 1 ? "" : "s"} · {file.devices.length} device{file.devices.length === 1 ? "" : "s"} · {rows.length}{" "}
          {tab === "in" ? "input" : "output"} row{rows.length === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}
