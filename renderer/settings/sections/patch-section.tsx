import { useEffect, useMemo, useState } from "react";
import { useLatestRef } from "@renderer/lib/use-latest-ref";
import { UploadIcon, PlusIcon, Trash2Icon, PrinterIcon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import { invoke, onNotification } from "../../lib/api";
import { useFailedReads } from "../../lib/use-failed-reads";
import { Button, ErrorNote, Input, SkeletonRows, toast, confirm , UnsavedBanner, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";
import { mergeOverrides, diffEndpoints } from "../../lib/patch-resolve";
import { uid } from "../../lib/uid";
import { PatchDeviceManager, EYEBROW } from "./patch-device-manager";
import { PatchImport } from "./patch-import";
import { PatchWeekly } from "./patch-weekly";
import { PatchTable } from "./patch-table";
import { ExportMenu } from "./patch-export";
import { RippleSwitch, DEFAULT_RIPPLE, type RippleState } from "./patch-ripple-bar";
import { SheetTabs } from "./patch-sheet-tabs";

/** The Editing select's value for this week's one-off tweaks. */
const WEEK = "__week";

const emptyAssignments = (): PatchAssignments => ({ byServiceType: {}, byPlan: {} });

/** A two-way switch between peers, e.g. Inputs / Outputs. */
function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-footnote transition-colors ${value === o.value ? "bg-fill-active text-fg" : "text-fg-muted hover:text-fg"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Stage patch editor (Settings → Patch). The patch is a set of SHEETS (tabs) —
 * Analog, Dante, WSG, Monitoring, … — each a rack-centric input/output patch with
 * its own devices, named variants, and per-service-type weekly assignment (see
 * docs/patch-sheet/DESIGN.md). Edits a local draft and saves the whole file via
 * patch:save (broadcasts patch:updated for live sync). Within a sheet, editing
 * "Default" changes its base patch; editing a variant stores only diffs.
 *
 * Layout: sheet tabs and toolbar on top; beside the sheet, a column holding the
 * Devices and Weekly assignment cards; the sheet itself is one card per rack.
 */
export function PatchSection() {
  const [saved, setSaved] = useState<PatchFile | null>(null);
  const [draft, setDraft] = useState<PatchFile | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string>("");
  const [dir, setDir] = useState<"in" | "out">("in");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [group, setGroup] = useState<"rack" | "device">("rack");
  const [ripple, setRipple] = useState<RippleState>(DEFAULT_RIPPLE);
  const [plan, setPlan] = useState<{ serviceTypeId: string | null; planId: string | null; planTitle: string | null } | null>(null);
  const { failed, fail } = useFailedReads<"patch" | "plan">("patch");

  const dirty = useMemo(() => (draft && saved ? JSON.stringify(draft) !== JSON.stringify(saved) : false), [draft, saved]);
  const dirtyRef = useLatestRef(dirty);

  useEffect(() => {
    invoke<PatchFile>("patch:get")
      .then((f) => { setSaved(f); setDraft(f); setActiveSheetId(f.sheets[0]?.id ?? ""); })
      .catch((err: unknown) => {
        // NOT an empty patch. This used to draw a blank default sheet, which
        // looked like a new install and which Save would have written over the
        // real patch. A `patch:updated` push still brings the editor up.
        fail("patch", "the patch", err);
      });
    invoke<StageState>("stage:getState")
      .then((s) => setPlan({ serviceTypeId: s.serviceTypeId, planId: s.planId, planTitle: s.planTitle }))
      .catch((err: unknown) => {
        // Not "no plan this week", which is what a null plan already says: it
        // hides This week without a word.
        fail("plan", "the current plan", err);
      });
    return onNotification("patch:updated", (p) => {
      const f = p as PatchFile;
      setSaved(f);
      if (!dirtyRef.current) setDraft(f);
    });
  }, [dirtyRef, fail]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await invoke<PatchFile>("patch:save", { file: draft });
      setSaved(result);
      setDraft(result);
      toast.success("Patch saved");
    } catch (e) {
      toast.error(`Couldn't save the patch: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return (
      <div className="py-6">
        {failed.has("patch") ? (
          <ErrorNote>Couldn't load the patch. Nothing has been changed; reload the page to try again.</ErrorNote>
        ) : (
          <SkeletonRows rows={4} />
        )}
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
  const isWeek = editingVariantId === WEEK && !!plan?.planId;
  const editingVariant = editingVariantId && editingVariantId !== WEEK ? sheet.variants.find((v) => v.id === editingVariantId) ?? null : null;

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

      {/* Sheet tabs, with the active one's Rename / Delete menu, and what is done
          with the whole sheet: import, export, print. */}
      <div className="patch-print-hide flex flex-wrap items-center gap-2 border-b border-line">
        <SheetTabs
          sheets={draft.sheets}
          activeId={sheet.id}
          onSwitch={switchSheet}
          onAdd={addSheet}
          onRename={renameSheet}
          onDelete={deleteSheet}
        />
        <div className="ml-auto flex items-center gap-1.5 pb-1.5">
          <Button variant="filled" size="small" onClick={() => setImporting((v) => !v)}>
            <UploadIcon className="size-3.5" /> Import
          </Button>
          <ExportMenu
            sheetId={sheet.id}
            variantId={editingVariant?.id ?? null}
            plan={isWeek && plan?.planId ? { planId: plan.planId, serviceTypeId: plan.serviceTypeId } : null}
            dirty={dirty}
          />
          <Button variant="filled" size="small" onClick={() => window.print()}>
            <PrinterIcon className="size-3.5" /> Print
          </Button>
        </div>
      </div>

      {/* Inputs / Outputs, which patch is being edited, how it is grouped, ripple */}
      <div className="patch-print-hide flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <Seg
          label="Direction"
          value={dir}
          onChange={setDir}
          options={[{ value: "in", label: "Inputs" }, { value: "out", label: "Outputs" }]}
        />
        <span className={`ml-1.5 ${EYEBROW}`}>Editing</span>
        {/* WEEK is only offered while a plan is loaded, so an operator editing
            this week's tweaks when the plan drops out would otherwise see the
            switcher snap to "Default patch" and start writing there. */}
        <Select value={editingVariantId ?? ""} onValueChange={(v) => setEditingVariantId(v || null)}>
          <SelectTrigger className="px-2" aria-label="Patch being edited"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Default patch</SelectItem>
            {plan?.planId && <SelectItem value={WEEK}>This week{plan.planTitle ? ` — ${plan.planTitle}` : ""}</SelectItem>}
            {sheet.variants.map((v) => (
              <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {editingVariant ? (
          <>
            <Input value={editingVariant.name} onChange={(e) => renameVariant(editingVariant.id, e.target.value)} className="w-40" placeholder="Variant name" aria-label="Variant name" />
            <button type="button" onClick={() => deleteVariant(editingVariant.id)} className="touch-target rounded-md p-1.5 text-fg-subtle hover:bg-fill hover:text-danger-11 transition-colors" aria-label="Delete variant">
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
        <span className="flex-1" />
        <Seg
          label="Group by"
          value={group}
          onChange={setGroup}
          options={[{ value: "rack", label: "By rack" }, { value: "device", label: "By device" }]}
        />
        {/* Ripple fills down a rack, so it has nothing to do in By device. */}
        {group === "rack" && <RippleSwitch ripple={ripple} setRipple={setRipple} />}
      </div>

      {importing && (
        <PatchImport devices={sheet.devices} endpoints={sheet.endpoints} dir={dir} onChange={setEndpoints} onClose={() => setImporting(false)} />
      )}

      {failed.has("plan") && (
        <ErrorNote className="patch-print-hide">Couldn't load the current plan, so This week isn't offered.</ErrorNote>
      )}

      {/* Devices and weekly assignment beside the sheet. On paper only the sheet
          prints, and the print stylesheet releases this grid (see styles.css). */}
      <div className="grid items-start gap-3.5 lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="patch-print-hide flex flex-col gap-3">
          <PatchDeviceManager devices={sheet.devices} onChange={setDevices} />
          <PatchWeekly variants={sheet.variants} assignments={sheet.assignments} plan={plan} onChange={setAssignments} />
        </aside>
        {/* The only thing that belongs on paper. Everything else here is editing
            chrome and is hidden by the print stylesheet. */}
        <div className="patch-print-sheet min-w-0">
          <PatchTable
            dir={dir}
            group={group}
            racks={racks}
            stageDevices={stageDevices}
            endpoints={tableEndpoints}
            onChange={onTableChange}
            ripple={ripple}
            setRipple={setRipple}
            showOwner={sheet.kind !== "analog"}
          />
        </div>
      </div>
    </div>
  );
}
