import { useEffect, useMemo, useRef, useState } from "react";

import { invoke, onNotification } from "../../lib/api";
import { Button, SkeletonRows, toast } from "../../components/ui";
import { PatchDeviceManager } from "./patch-device-manager";
import { PatchTable } from "./patch-table";

const EMPTY: PatchFile = { devices: [], endpoints: [], variants: [], assignments: { byServiceType: {}, byPlan: {} }, updatedAt: "" };

/**
 * Stage patch sheet editor (Settings → Patch). Rack-centric input/output patch —
 * see docs/patch-sheet/DESIGN.md. Loads the patch, edits a local draft, and saves
 * the whole file back through patch:save (which broadcasts patch:updated for live
 * sync). Variants/weekly assignment and CSV import land in later increments.
 */
export function PatchSection() {
  const [saved, setSaved] = useState<PatchFile | null>(null);
  const [draft, setDraft] = useState<PatchFile | null>(null);
  const [tab, setTab] = useState<"in" | "out">("in");
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => (draft && saved ? JSON.stringify(draft) !== JSON.stringify(saved) : false), [draft, saved]);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    invoke<PatchFile>("patch:get")
      .then((f) => { setSaved(f); setDraft(f); })
      .catch(() => { setSaved(EMPTY); setDraft(EMPTY); });
    // Change-driven live sync — adopt external changes only when we have no unsaved edits.
    return onNotification("patch:updated", (p) => {
      const f = p as PatchFile;
      setSaved(f);
      if (!dirtyRef.current) setDraft(f);
    });
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await invoke<PatchFile>("patch:save", { file: draft });
      setSaved(result);
      setDraft(result);
      toast.success("Patch saved");
    } catch {
      toast.error("Couldn't save the patch");
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return (
      <div className="py-6">
        <SkeletonRows rows={4} />
      </div>
    );
  }

  const setDevices = (devices: PatchDevice[]) => setDraft((d) => (d ? { ...d, devices } : d));
  const setEndpoints = (endpoints: PatchEndpoint[]) => setDraft((d) => (d ? { ...d, endpoints } : d));
  const racks = draft.devices.filter((d) => d.kind === "rack");
  const stageDevices = draft.devices.filter((d) => d.kind !== "rack");

  return (
    <div className="flex flex-col gap-4">
      {/* Save / discard bar — pinned pill, only when there are unsaved edits. */}
      {dirty && (
        <div className="sticky top-1 z-20 flex justify-end">
          <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-popover px-2.5 py-1.5 shadow-md backdrop-blur-xl">
            <span className="text-caption1 text-fg-muted">Unsaved changes</span>
            <Button variant="transparent" size="small" onClick={() => saved && setDraft(saved)} disabled={saving}>Discard</Button>
            <Button variant="accent" size="small" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      )}

      {/* Inputs / Outputs tabs (peers) */}
      <div className="inline-flex self-start rounded-lg border border-line bg-surface p-1">
        {(["in", "out"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-3.5 py-1.5 text-footnote transition-colors ${tab === t ? "bg-fill-active text-fg" : "text-fg-muted hover:text-fg"}`}
          >
            {t === "in" ? "Inputs" : "Outputs"}
          </button>
        ))}
      </div>

      <PatchDeviceManager devices={draft.devices} onChange={setDevices} />

      <PatchTable dir={tab} racks={racks} stageDevices={stageDevices} endpoints={draft.endpoints} onChange={setEndpoints} />
    </div>
  );
}
