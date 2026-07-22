import { useEffect, useMemo, useRef, useState } from "react";
import { UploadIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { Button, Input, SkeletonRows, toast, confirm } from "../../components/ui";
import { mergeOverrides, diffEndpoints } from "../../lib/patch-resolve";
import { uid } from "../../lib/uid";
import { PatchDeviceManager } from "./patch-device-manager";
import { PatchTable } from "./patch-table";
import { PatchImport } from "./patch-import";
import { PatchWeekly } from "./patch-weekly";

const EMPTY: PatchFile = { devices: [], endpoints: [], variants: [], assignments: { byServiceType: {}, byPlan: {} }, updatedAt: "" };

/**
 * Stage patch sheet editor (Settings → Patch). Rack-centric input/output patch
 * with named variants and per-service-type weekly assignment — see
 * docs/patch-sheet/DESIGN.md. Edits a local draft and saves the whole file via
 * patch:save (which broadcasts patch:updated for live sync). Editing "Default"
 * changes the base patch; editing a variant stores only the diffs vs the default.
 */
export function PatchSection() {
  const [saved, setSaved] = useState<PatchFile | null>(null);
  const [draft, setDraft] = useState<PatchFile | null>(null);
  const [tab, setTab] = useState<"in" | "out">("in");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [group, setGroup] = useState<"rack" | "device">("rack");

  const dirty = useMemo(() => (draft && saved ? JSON.stringify(draft) !== JSON.stringify(saved) : false), [draft, saved]);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    invoke<PatchFile>("patch:get")
      .then((f) => { setSaved(f); setDraft(f); })
      .catch(() => { setSaved(EMPTY); setDraft(EMPTY); });
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
  const setAssignments = (assignments: PatchAssignments) => setDraft((d) => (d ? { ...d, assignments } : d));
  const setVariants = (variants: PatchVariant[]) => setDraft((d) => (d ? { ...d, variants } : d));

  const racks = draft.devices.filter((d) => d.kind === "rack");
  const stageDevices = draft.devices.filter((d) => d.kind !== "rack");
  const editingVariant = editingVariantId ? draft.variants.find((v) => v.id === editingVariantId) ?? null : null;

  // What the table shows + where its edits go: the Default patch, or a variant
  // rendered as (default + overrides) whose edits are diffed back into overrides.
  const tableEndpoints = editingVariant ? mergeOverrides(draft.endpoints, editingVariant.overrides) : draft.endpoints;
  const onTableChange = (next: PatchEndpoint[]) => {
    if (!editingVariant) { setEndpoints(next); return; }
    const overrides = diffEndpoints(next, draft.endpoints);
    setVariants(draft.variants.map((v) => (v.id === editingVariant.id ? { ...v, overrides } : v)));
  };

  function newVariant() {
    const v: PatchVariant = { id: uid("var"), name: `Variant ${draft!.variants.length + 1}`, overrides: {} };
    setVariants([...draft!.variants, v]);
    setEditingVariantId(v.id);
  }
  function renameVariant(id: string, name: string) {
    setVariants(draft!.variants.map((v) => (v.id === id ? { ...v, name } : v)));
  }
  async function deleteVariant(id: string) {
    const v = draft!.variants.find((x) => x.id === id);
    if (!(await confirm({ title: "Delete variant?", message: `Delete "${v?.name ?? "variant"}"? Weeks using it fall back to the default.`, confirmLabel: "Delete", destructive: true }))) return;
    const byServiceType = Object.fromEntries(Object.entries(draft!.assignments.byServiceType).filter(([, vid]) => vid !== id));
    setDraft((d) => (d ? { ...d, variants: d.variants.filter((x) => x.id !== id), assignments: { ...d.assignments, byServiceType } } : d));
    setEditingVariantId(null);
  }

  return (
    <div className="flex flex-col gap-4">
      {dirty && (
        <div className="sticky top-1 z-20 flex justify-end">
          <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-popover px-2.5 py-1.5 shadow-md backdrop-blur-xl">
            <span className="text-caption1 text-fg-muted">Unsaved changes</span>
            <Button variant="transparent" size="small" onClick={() => saved && setDraft(saved)} disabled={saving}>Discard</Button>
            <Button variant="accent" size="small" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      )}

      {/* Inputs / Outputs tabs (peers) + import */}
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-line bg-surface p-1">
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
        <Button variant="filled" size="small" onClick={() => setImporting((v) => !v)}>
          <UploadIcon className="size-3.5" /> Import CSV
        </Button>
      </div>

      {importing && (
        <PatchImport devices={draft.devices} endpoints={draft.endpoints} dir={tab} onChange={setEndpoints} onClose={() => setImporting(false)} />
      )}

      <PatchDeviceManager devices={draft.devices} onChange={setDevices} />

      {/* Variant switcher — Default patch vs a named overlay */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">Editing</span>
        <select
          value={editingVariantId ?? ""}
          onChange={(e) => setEditingVariantId(e.target.value || null)}
          className="h-7 rounded-md border border-line-strong bg-field px-2 text-footnote text-fg focus:outline-none focus:border-focus"
        >
          <option value="">Default patch</option>
          {draft.variants.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
        {editingVariant ? (
          <>
            <Input value={editingVariant.name} onChange={(e) => renameVariant(editingVariant.id, e.target.value)} className="w-40" placeholder="Variant name" />
            <button type="button" onClick={() => deleteVariant(editingVariant.id)} className="rounded-md p-1.5 text-fg-subtle hover:bg-fill hover:text-warn-11 transition-colors" aria-label="Delete variant">
              <Trash2Icon className="size-4" />
            </button>
            <span className="text-caption2 text-fg-muted">Only changes vs the default are saved.</span>
          </>
        ) : (
          <Button variant="transparent" size="small" onClick={newVariant}>
            <PlusIcon className="size-3.5" /> New variant
          </Button>
        )}
        <div className="ml-auto inline-flex rounded-lg border border-line bg-surface p-1">
          {(["rack", "device"] as const).map((g) => (
            <button key={g} type="button" onClick={() => setGroup(g)} className={`rounded-md px-3 py-1 text-caption1 transition-colors ${group === g ? "bg-fill-active text-fg" : "text-fg-muted hover:text-fg"}`}>
              {g === "rack" ? "By rack" : "By device"}
            </button>
          ))}
        </div>
      </div>

      <PatchTable dir={tab} group={group} racks={racks} stageDevices={stageDevices} endpoints={tableEndpoints} onChange={onTableChange} />

      <PatchWeekly variants={draft.variants} assignments={draft.assignments} onChange={setAssignments} />
    </div>
  );
}
