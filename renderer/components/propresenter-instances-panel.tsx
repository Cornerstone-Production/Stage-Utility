import { invoke } from "../lib/api";
import { usePropInstances } from "../main/use-dashboard-state";
import { useState, type ChangeEvent } from "react";
import {
  Button,
  Field,
  FieldSet,
  FieldGroup,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Input,
  Status,
  NumberInput,
  InfoHint,
  toast,
} from "./ui";
import { PlusIcon, TrashIcon, Loader2Icon } from "lucide-react";
import { ConnectionBadge } from "./connection-badge";
import { feedId, sameRows } from "./integration-panel-helpers";
import { useReportUnsavedWork } from "./unsaved-work";
import { WIDE_PANEL_ATTR } from "./integration-dialog-size";

// ---- ProPresenter extra instances -------------------------------------------

interface PropInstanceRow {
  id: string;
  name: string;
  host: string;
  port: number;
  pollMs?: number;
}

// Per-instance connection status. Driven by the live `propresenter:instances`
// snapshot, which now carries the same connected/connecting/error/disconnected
// state the primary uses — so we delegate to the very same ConnectionBadge for a
// pixel-identical line. Rows not yet saved aren't known to the backend → "Not saved".
function InstanceStatusBadge({ conn, saved }: { conn: PropInstanceConn | undefined; saved: boolean }) {
  if (!saved || !conn) {
    return (
      <span className="flex items-center gap-1">
        <Status variant="neutral" />
        <span className="text-caption1 text-gray-9">Not saved</span>
      </span>
    );
  }
  return <ConnectionBadge connection={conn.state} message={conn.message} />;
}

// Extra ProPresenter machines beyond the primary (e.g. a second auditorium).
// Stored as non-secret config.instances; a layout object then picks which one to
// read. The primary is the host/port fields above (instance id "default").
//
// Each instance renders with the same field layout as the main ProPresenter card
// (Name / Host / API Port / Poll interval as horizontal Fields) plus a live
// connection badge, so the two read identically.
export function ProPresenterInstancesPanel({
  state,
  onStateChange,
}: {
  state: IntegrationState;
  onStateChange: (next: IntegrationState) => void;
}) {
  const initial = Array.isArray(state.config.instances) ? (state.config.instances as PropInstanceRow[]) : [];
  const [rows, setRows] = useState<PropInstanceRow[]>(initial);
  const [saving, setSaving] = useState(false);
  // Live per-instance status from the backend (keyed by instance id).
  const propInstances = usePropInstances();
  // Ids the backend currently knows about — i.e. rows that have been saved.
  const savedIds = new Set((state.config.instances as PropInstanceRow[] | undefined)?.map((r) => r.id) ?? []);

  function update(idx: number, patch: Partial<PropInstanceRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function remove(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }
  function add() {
    setRows((prev) => [...prev, { id: feedId(), name: `Auditorium ${prev.length + 2}`, host: "", port: 1025 }]);
  }
  /** Save, and say whether it landed. A false must not be followed by a close. */
  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      const next = await invoke<IntegrationState>("integrations:setConfig", {
        id: "propresenter",
        config: { instances: rows },
      });
      onStateChange(next);
      toast.success("ProPresenter instances saved.");
      return true;
    } catch (err) {
      console.error("[ProPresenterInstancesPanel:save]", err);
      toast.error(`Could not save instances: ${String(err)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  // These rows live here, not in the dialog's form, and `instances` is not in
  // the descriptor's configSchema — so the dialog cannot see them and Escape
  // used to throw a half-typed instance away without asking. Report upward.
  useReportUnsavedWork("propresenter-instances", !sameRows(rows, initial), save);

  return (
    // Each instance is a four-field form ~520px wide that cannot wrap, so this
    // panel's dialog takes the wide variant. The marker is what
    // integration-dialog-size.test.tsx reads off the rendered page, so the width
    // and the panel cannot drift apart.
    <div className="flex flex-col gap-2" {...{ [WIDE_PANEL_ATTR]: "" }}>
      <span className="flex items-center gap-1.5 text-caption2 font-semibold uppercase tracking-wider text-gray-9">
        Additional instances (auditoriums)
        <InfoHint>
          Each card is another ProPresenter machine (the primary is the Host/Port fields above). Give it a
          Name, its IP, and API port (default 1025). A custom-layout object can then pick which instance it
          reads from — handy when two rooms run separate ProPresenters.
        </InfoHint>
      </span>
      {rows.length === 0 && (
        <span className="text-caption2 text-gray-9">
          Add another ProPresenter machine to read it in a custom view. A layout object then picks which instance it shows.
        </span>
      )}
      {rows.map((r, i) => {
        const saved = savedIds.has(r.id);
        const conn = propInstances?.conn?.[r.id];
        return (
          <div key={r.id} className="flex flex-col gap-2 rounded-lg border border-gray-5 p-3">
            {/* Header: live status + remove, mirroring the main card's header */}
            <div className="flex items-center justify-between gap-2">
              <InstanceStatusBadge conn={conn} saved={saved} />
              <Button variant="transparent" size="small" iconOnly onClick={() => remove(i)} aria-label="Remove instance">
                <TrashIcon className="size-3.5 text-gray-9" />
              </Button>
            </div>
            <FieldSet flat>
              <FieldGroup>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel className="flex items-center gap-1.5">
                      Name
                    </FieldLabel>
                    <FieldDescription>SA (e.g. Auditorium 2)</FieldDescription>
                  </FieldContent>
                  <Input
                    value={r.name}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => update(i, { name: e.target.value })}
                    placeholder="Auditorium 2"
                    className="w-44"
                    aria-label="Instance name"
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel className="flex items-center gap-1.5">
                      ProPresenter Host
                    </FieldLabel>
                    <FieldDescription>192.168.1.101</FieldDescription>
                  </FieldContent>
                  <Input
                    value={r.host}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => update(i, { host: e.target.value })}
                    placeholder="192.168.1.101"
                    className="w-44"
                    aria-label="Instance host"
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel className="flex items-center gap-1.5">
                      API Port
                    </FieldLabel>
                    <FieldDescription>1025</FieldDescription>
                  </FieldContent>
                  <NumberInput
                    value={r.port}
                    step={1}
                    min={1}
                    max={65535}
                    onChange={(v) => update(i, { port: Math.round(v) })}
                    className="w-44"
                    aria-label="Instance API port"
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel className="flex items-center gap-1.5">
                      Poll interval (ms)
                    </FieldLabel>
                    <FieldDescription>500 (lower = snappier, more requests)</FieldDescription>
                  </FieldContent>
                  <NumberInput
                    value={r.pollMs ?? 500}
                    step={100}
                    min={200}
                    max={10000}
                    onChange={(v) => update(i, { pollMs: Math.round(v) })}
                    className="w-44"
                    aria-label="Instance poll interval"
                  />
                </Field>
              </FieldGroup>
            </FieldSet>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <Button variant="transparent" size="small" onClick={add}>
          <PlusIcon className="size-3.5" /> Add instance
        </Button>
        <Button variant="filled" size="small" onClick={save} disabled={saving}>
          {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null} Save instances
        </Button>
      </div>
    </div>
  );
}
