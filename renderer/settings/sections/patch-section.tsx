import { useEffect, useMemo, useState } from "react";
import { useLatestRef } from "@renderer/lib/use-latest-ref";
import { UploadIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { Button, Input, SkeletonRows, toast, confirm , UnsavedBanner} from "../../components/ui";
import { mergeOverrides, diffEndpoints } from "../../lib/patch-resolve";
import { uid } from "../../lib/uid";
import { PatchDeviceManager } from "./patch-device-manager";
import { PatchTable } from "./patch-table";
import { PatchImport } from "./patch-import";
import { PatchWeekly } from "./patch-weekly";

const emptyAssignments = (): PatchAssignments => ({ byServiceType: {}, byPlan: {} });
const EMPTY: PatchFile = {
  sheets: [{ id: "analog", name: "Analog", kind: "analog", devices: [], endpoints: [], variants: [], assignments: emptyAssignments() }],
  updatedAt: "",
};

/**
 * Stage patch editor (Settings → Patch). The patch is a set of SHEETS (tabs) —
 * Analog, Dante, WSG, Monitoring, … — each a rack-centric input/output patch with
 * its own devices, named variants, and per-service-type weekly assignment (see
 * docs/patch-sheet/DESIGN.md). Edits a local draft and saves the whole file via
 * patch:save (broadcasts patch:updated for live sync). Within a sheet, editing
 * "Default" changes its base patch; editing a variant stores only diffs.
 */
export function PatchSection() {
  const [saved, setSaved] = useState<PatchFile | null>(null);
  const [draft, setDraft] = useState<PatchFile | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string>("");
  const [tab, setTab] = useState<"in" | "out">("in");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [group, setGroup] = useState<"rack" | "device">("rack");
  const [plan, setPlan] = useState<{ serviceTypeId: string | null; planId: string | null; planTitle: string | null } | null>(null);

  const dirty = useMemo(() => (draft && saved ? JSON.stringify(draft) !== JSON.stringify(saved) : false), [draft, saved]);
  const dirtyRef = useLatestRef(dirty);

  useEffect(() => {
    invoke<PatchFile>("patch:get")
      .then((f) => { setSaved(f); setDraft(f); setActiveSheetId(f.sheets[0]?.id ?? ""); })
      .catch(() => { setSaved(EMPTY); setDraft(EMPTY); setActiveSheetId(EMPTY.sheets[0].id); });
    invoke<StageState>("stage:getState")
      .then((s) => setPlan({ serviceTypeId: s.serviceTypeId, planId: s.planId, planTitle: s.planTitle }))
      .catch(() => setPlan(null));
    return onNotification("patch:updated", (p) => {
      const f = p as PatchFile;
      setSaved(f);
      if (!dirtyRef.current) setDraft(f);
    });
  }, [dirtyRef]);

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

  // Active sheet (fall back to the first if the id drifted, e.g. after a delete).
  const sheet = draft.sheets.find((s) => s.id === activeSheetId) ?? draft.sheets[0];

  // Slice setters write back into the active sheet within the file.
  const patchSheet = (fn: (s: PatchSheet) => PatchSheet) =>
    setDraft((d) => (d ? { ...d, sheets: d.sheets.map((s) => (s.id === sheet.id ? fn(s) : s)) } : d));
  const setDevices = (devices: PatchDevice[]) => patchSheet((s) => ({ ...s, devices }));
  const setEndpoints = (endpoints: PatchEndpoint[]) => patchSheet((s) => ({ ...s, endpoints }));
  const setAssignments = (assignments: PatchAssignments) => patchSheet((s) => ({ ...s, assignments }));
  const setVariants = (variants: PatchVariant[]) => patchSheet((s) => ({ ...s, variants }));

  // Sheet management (tabs).
  function switchSheet(id: string) {
    setActiveSheetId(id);
    setEditingVariantId(null);
  }
  function addSheet() {
    const id = uid("sheet");
    const s: PatchSheet = { id, name: `Sheet ${draft!.sheets.length + 1}`, kind: "custom", devices: [], endpoints: [], variants: [], assignments: emptyAssignments() };
    setDraft((d) => (d ? { ...d, sheets: [...d.sheets, s] } : d));
    switchSheet(id);
  }
  function renameSheet(name: string) {
    patchSheet((s) => ({ ...s, name }));
  }
  async function deleteSheet() {
    if (draft!.sheets.length <= 1) return;
    if (!(await confirm({ title: "Delete sheet?", message: `Delete the "${sheet.name}" sheet, including its devices and patch?`, confirmLabel: "Delete", destructive: true }))) return;
    const remaining = draft!.sheets.filter((s) => s.id !== sheet.id);
    setDraft((d) => (d ? { ...d, sheets: remaining } : d));
    switchSheet(remaining[0].id);
  }

  const racks = sheet.devices.filter((d) => d.kind === "rack");
  const stageDevices = sheet.devices.filter((d) => d.kind !== "rack");
  const isWeek = editingVariantId === "__week" && !!plan?.planId;
  const editingVariant = editingVariantId && editingVariantId !== "__week" ? sheet.variants.find((v) => v.id === editingVariantId) ?? null : null;

  // A week's one-off tweaks layer over: default + the plan's assigned variant.
  const weekBase = (() => {
    if (!plan?.planId) return sheet.endpoints;
    const vid = sheet.assignments.byPlan[plan.planId]?.variantId ?? (plan.serviceTypeId ? sheet.assignments.byServiceType[plan.serviceTypeId] : undefined);
    const v = vid ? sheet.variants.find((x) => x.id === vid) : undefined;
    return v ? mergeOverrides(sheet.endpoints, v.overrides) : sheet.endpoints;
  })();
  const weekTweaks = plan?.planId ? sheet.assignments.byPlan[plan.planId]?.tweaks ?? {} : {};

  // What the table shows + where edits go: Default, a variant (diffed vs default),
  // or this week's tweaks (diffed vs default+variant, stored under the plan).
  const tableEndpoints = isWeek
    ? mergeOverrides(weekBase, weekTweaks)
    : editingVariant
      ? mergeOverrides(sheet.endpoints, editingVariant.overrides)
      : sheet.endpoints;

  const onTableChange = (next: PatchEndpoint[]) => {
    if (isWeek && plan?.planId) {
      const tweaks = diffEndpoints(next, weekBase);
      const pid = plan.planId;
      patchSheet((s) => {
        const byPlan = { ...s.assignments.byPlan };
        const entry = { ...(byPlan[pid] ?? {}) };
        if (Object.keys(tweaks).length) entry.tweaks = tweaks;
        else delete entry.tweaks;
        if (Object.keys(entry).length) byPlan[pid] = entry;
        else delete byPlan[pid];
        return { ...s, assignments: { ...s.assignments, byPlan } };
      });
      return;
    }
    if (!editingVariant) { setEndpoints(next); return; }
    const overrides = diffEndpoints(next, sheet.endpoints);
    setVariants(sheet.variants.map((v) => (v.id === editingVariant.id ? { ...v, overrides } : v)));
  };

  function newVariant() {
    const v: PatchVariant = { id: uid("var"), name: `Variant ${sheet.variants.length + 1}`, overrides: {} };
    setVariants([...sheet.variants, v]);
    setEditingVariantId(v.id);
  }
  function renameVariant(id: string, name: string) {
    setVariants(sheet.variants.map((v) => (v.id === id ? { ...v, name } : v)));
  }
  async function deleteVariant(id: string) {
    const v = sheet.variants.find((x) => x.id === id);
    if (!(await confirm({ title: "Delete variant?", message: `Delete "${v?.name ?? "variant"}"? Weeks using it fall back to the default.`, confirmLabel: "Delete", destructive: true }))) return;
    const byServiceType = Object.fromEntries(Object.entries(sheet.assignments.byServiceType).filter(([, vid]) => vid !== id));
    patchSheet((s) => ({ ...s, variants: s.variants.filter((x) => x.id !== id), assignments: { ...s.assignments, byServiceType } }));
    setEditingVariantId(null);
  }

  return (
    <div className="flex flex-col gap-4">
      {dirty && (
        // pointer-events-none on the full-width wrapper so its transparent area
        // doesn't swallow clicks meant for the sticky ripple bar beneath it; only
        // the banner box itself (pointer-events-auto) is interactive.
        <div className="pointer-events-none sticky top-1 z-30 flex justify-end">
          <UnsavedBanner
            className="pointer-events-auto"
            compact
            saving={saving}
            onSave={save}
            onDiscard={() => saved && setDraft(saved)}
          />
        </div>
      )}

      {/* Sheet tabs (Analog / Dante / WSG / Monitoring / …) + add / rename / delete */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3">
        <div className="flex items-center gap-1 overflow-x-auto">
          {draft.sheets.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => switchSheet(s.id)}
              className={`shrink-0 rounded-md px-3 py-1.5 text-footnote font-medium transition-colors ${s.id === sheet.id ? "bg-fill-active text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {s.name}
            </button>
          ))}
          <button type="button" onClick={addSheet} className="shrink-0 rounded-md px-2 py-1.5 text-fg-subtle hover:text-fg transition-colors" aria-label="Add sheet">
            <PlusIcon className="size-4" />
          </button>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Input value={sheet.name} onChange={(e) => renameSheet(e.target.value)} className="w-36" placeholder="Sheet name" aria-label="Sheet name" />
          {draft.sheets.length > 1 && (
            <button type="button" onClick={deleteSheet} className="rounded-md p-1.5 text-fg-subtle hover:bg-fill hover:text-warn-11 transition-colors" aria-label={`Delete ${sheet.name} sheet`}>
              <Trash2Icon className="size-4" />
            </button>
          )}
        </div>
      </div>

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
        <PatchImport devices={sheet.devices} endpoints={sheet.endpoints} dir={tab} onChange={setEndpoints} onClose={() => setImporting(false)} />
      )}

      <PatchDeviceManager devices={sheet.devices} onChange={setDevices} />

      {/* Variant switcher — Default patch vs a named overlay */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">Editing</span>
        <select
          value={editingVariantId ?? ""}
          onChange={(e) => setEditingVariantId(e.target.value || null)}
          className="h-7 rounded-md border border-line-strong bg-field px-2 text-footnote text-fg focus:outline-none focus:border-focus"
        >
          <option value="">Default patch</option>
          {plan?.planId && <option value="__week">This week{plan.planTitle ? ` — ${plan.planTitle}` : ""}</option>}
          {sheet.variants.map((v) => (
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
        ) : isWeek ? (
          <span className="text-caption2 text-fg-muted">One-off tweaks for this week only — saved over the assigned base.</span>
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

      <PatchTable dir={tab} group={group} racks={racks} stageDevices={stageDevices} endpoints={tableEndpoints} onChange={onTableChange} showOwner={sheet.kind !== "analog"} />

      <PatchWeekly variants={sheet.variants} assignments={sheet.assignments} plan={plan} onChange={setAssignments} />
    </div>
  );
}
