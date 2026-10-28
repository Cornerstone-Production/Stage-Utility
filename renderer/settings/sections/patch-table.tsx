import { useEffect, useRef, useState } from "react";

import { Switch } from "../../components/ui";
import { cn } from "../../lib/cn";
import { useResyncOn } from "../../lib/use-resync-on";
import { rippleEndpoints, type RippleField } from "../../lib/patch-ripple";
import { DeviceDot } from "./patch-dot";
import { PathCell, type HopEditing } from "./patch-path-cell";
import { RippleBar, type Dir, type RippleState } from "./patch-ripple-bar";

const keyOf = (rackId: string, dir: Dir, index: number) => `${rackId}:${dir}:${index}`;
const meaningful = (e: PatchEndpoint) => Boolean(e.label || e.consoleChannel || (e.path && e.path.length) || e.unused || e.mic || e.feedType);

/** Whether a value is worth rippling (don't fan an empty edit down a rack). */
function rippleHasValue(field: RippleField, value: unknown): boolean {
  if (field === "phantom") return true;
  if (field === "path") return Array.isArray(value) && (value as PatchHop[]).some((h) => (h.connector ?? "").trim() !== "");
  return String(value ?? "").trim() !== "";
}

// A cell reads as plain text; the input underneath is always there, so the
// keyboard walks the sheet the way it would a form. Hover tints it, focus rings it.
const TD_PLAIN = "h-[31px] border-b border-r border-line p-0 last:border-r-0";
const TD = cn(TD_PLAIN, "hover:bg-fill focus-within:bg-surface-raised focus-within:shadow-[inset_0_0_0_2px_var(--color-accent)]");
// scroll-mt: a field scrolled into view by Tab must clear the sticky ripple bar.
const INPUT = "block h-[31px] scroll-mt-14 w-full min-w-0 bg-transparent px-2 text-footnote text-fg outline-none placeholder:text-fg-faint";
const TH = "border-b border-line bg-surface px-2 py-[7px] text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-subtle";

function Cell({ value, onChange, placeholder, label, mono, strong }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; mono?: boolean; strong?: boolean }) {
  return (
    <td className={cn(TD, "cursor-text")}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={cn(INPUT, mono && "font-mono tabular-nums", strong && "font-medium")}
      />
    </td>
  );
}

interface RowProps {
  rackId: string;
  idx: number;
  /** By-device mode with several racks: say which rack the channel is on. */
  rackLabel: string | null;
  dir: Dir;
  endpoint: PatchEndpoint | undefined;
  stageDevices: PatchDevice[];
  showOwner: boolean;
  reach: boolean;
  /** The open hop editor, if it is on THIS row. */
  editing: HopEditing;
  onEditing: (next: HopEditing) => void;
  edit: (rackId: string, index: number, field: RippleField, value: unknown) => void;
  onFocusRow: (rackId: string, index: number) => void;
  onBlurRow: () => void;
}

function Row({ rackId, idx, rackLabel, dir, endpoint: e, stageDevices, showOwner, reach, editing, onEditing, edit, onFocusRow, onBlurRow }: RowProps) {
  // Tint the row's left edge with the color of the device it's sourced from.
  const srcColor = stageDevices.find((dv) => dv.id === e?.path?.[0]?.deviceId)?.color;
  return (
    <tr
      onFocus={() => onFocusRow(rackId, idx)}
      onBlur={onBlurRow}
      data-reach={reach || undefined}
      className="group/row data-[reach]:[&>td:not([data-n])]:bg-accent/10"
    >
      {/* The row header, so a screen reader hears which channel a bare "Source" field is on. */}
      <th scope="row" data-n="" className={cn(TD_PLAIN, "pr-2 text-right font-mono text-caption1 font-normal tabular-nums text-fg-subtle")} style={srcColor ? { boxShadow: `inset 3px 0 0 ${srcColor}` } : undefined}>
        {idx}
      </th>
      {rackLabel != null && <td className={cn(TD_PLAIN, "truncate px-2 text-caption2 text-fg-subtle")}>{rackLabel}</td>}
      <Cell mono label="Console channel" placeholder={String(idx)} value={e?.consoleChannel ?? ""} onChange={(v) => edit(rackId, idx, "consoleChannel", v)} />
      <Cell strong label={dir === "in" ? "Source" : "Destination"} placeholder={dir === "in" ? "Source" : "Destination"} value={e?.label ?? ""} onChange={(v) => edit(rackId, idx, "label", v)} />
      {dir === "in" ? (
        <>
          <Cell label="Mic / DI" placeholder="Mic / DI" value={e?.mic ?? ""} onChange={(v) => edit(rackId, idx, "mic", v)} />
          <td className={cn(TD_PLAIN, "text-center")}>
            <Switch className="scale-[0.85]" aria-label="48V" checked={e?.phantom ?? false} onCheckedChange={(v) => edit(rackId, idx, "phantom", v)} />
          </td>
        </>
      ) : (
        <Cell label="Feed" placeholder="IEM / wedge…" value={e?.feedType ?? ""} onChange={(v) => edit(rackId, idx, "feedType", v)} />
      )}
      <td className={TD_PLAIN}>
        <PathCell path={e?.path} stageDevices={stageDevices} editing={editing} onEditingChange={onEditing} onChange={(hops) => edit(rackId, idx, "path", hops)} />
      </td>
      {showOwner && <Cell label="Owner" placeholder="Owner" value={e?.owner ?? ""} onChange={(v) => edit(rackId, idx, "owner", v)} />}
    </tr>
  );
}

/** A card: a title bar, an optional ripple bar, and the channels beneath. */
function Card({ title, dot, meta, ripple, children }: { title: string; dot?: string; meta: string; ripple?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="overflow-clip rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        {dot && <DeviceDot color={dot} className="size-2.5" />}
        <b className="text-footnote font-semibold text-fg">{title}</b>
        <span className="font-mono text-caption1 text-fg-subtle">{meta}</span>
      </div>
      {ripple}
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

const EMPTY = "rounded-xl border border-line bg-surface px-4 py-6 text-center text-footnote text-fg-subtle";

/**
 * Editable rack-centric endpoint sheet for one direction: one card per rack,
 * every channel of it as a 32px row. Grouped either by rack (every channel of
 * every rack, blanks included) or by the stage device each endpoint's path starts
 * at (mirrors the Analog tab's snake/pocket sections). Editing a cell upserts the
 * endpoint keyed by rack + dir + index either way.
 *
 * In by-rack mode a DiGiCo-style ripple can be armed (the switch lives in the
 * editor's toolbar): set one channel and the run below auto-fills (numeric
 * increments, text/toggles copy), clamped to the rack.
 */
export function PatchTable({
  dir,
  group,
  racks,
  stageDevices,
  endpoints,
  onChange,
  ripple,
  setRipple,
  showOwner = false,
}: {
  dir: Dir;
  group: "rack" | "device";
  racks: PatchDevice[];
  stageDevices: PatchDevice[];
  endpoints: PatchEndpoint[];
  onChange: (next: PatchEndpoint[]) => void;
  ripple: RippleState;
  /** Functional, so the one-shot disarm cannot overwrite a chip pressed meanwhile. */
  setRipple: (next: RippleState | ((r: RippleState) => RippleState)) => void;
  /** Show the ownership column + ripple chip (non-analog sheets). */
  showOwner?: boolean;
}) {
  // The row last focused while armed: where the next fill would start, so its
  // reach can be highlighted. It is NOT cleared on blur — pressing a chip in the
  // ripple bar blurs the row, and a bar whose "from row" text vanished on
  // mousedown would shift under the pointer and swallow the click.
  const [focus, setFocus] = useState<{ rackId: string; index: number } | null>(null);
  // The open hop editor, held here rather than in the row's PathCell. In By device
  // a row moves to another card when its first hop's device changes, which remounts
  // it; state inside the cell would go with it and close the editor mid-edit.
  const [editingHop, setEditingHop] = useState<{ row: string; hop: NonNullable<HopEditing> } | null>(null);
  // It does not survive disarming or a switch of direction: the rows it named
  // are no longer the ones on screen.
  useResyncOn([ripple.on, dir], () => setFocus(null));
  // Ripple is one-shot: after a fill actually happens, it disarms when the edited
  // cell loses focus (on blur, not on keystroke — so a multi-digit start like "12"
  // still ripples fully before disarming). This flag tracks "a fill happened".
  const rippledRef = useRef(false);
  useEffect(() => {
    if (!ripple.on) rippledRef.current = false;
  }, [ripple.on]);
  const rippleActive = group === "rack" && ripple.on;

  const byKey = new Map(endpoints.map((e) => [keyOf(e.rackId, e.dir, e.index), e] as const));
  const rackName = (id: string) => racks.find((r) => r.id === id)?.name ?? id;
  const channelsOf = (rackId: string) => {
    const r = racks.find((x) => x.id === rackId);
    return (dir === "in" ? r?.inputs : r?.outputs) ?? 0;
  };

  function upsert(rackId: string, index: number, patch: Partial<PatchEndpoint>) {
    const k = keyOf(rackId, dir, index);
    const existing = byKey.get(k) ?? { rackId, dir, index };
    const next = endpoints.filter((e) => keyOf(e.rackId, e.dir, e.index) !== k);
    next.push({ ...existing, ...patch });
    onChange(next);
  }

  // Route an edit through ripple when armed + the field is checked + it has a
  // value worth spreading; otherwise a plain single-cell upsert.
  function edit(rackId: string, index: number, field: RippleField, value: unknown) {
    const rackChannels = channelsOf(rackId);
    if (rippleActive && ripple.fields[field] && rippleHasValue(field, value)) {
      onChange(rippleEndpoints({ endpoints, rackId, dir, startIndex: index, field, value, count: ripple.count, rackChannels, stageDevices }));
      rippledRef.current = true; // disarm on the next blur
    } else {
      upsert(rackId, index, { [field]: value } as Partial<PatchEndpoint>);
    }
  }

  // Highlight rows the next rippled edit would touch, from the focused row down.
  function lastRippleIndex(start: number, rackChannels: number): number {
    return ripple.count === "end" ? rackChannels : Math.min(rackChannels, start + ripple.count - 1);
  }
  function isInFocusRun(rackId: string, index: number, rackChannels: number): boolean {
    return rippleActive && focus != null && focus.rackId === rackId && index >= focus.index && index <= lastRippleIndex(focus.index, rackChannels);
  }

  const onFocusRow = (rackId: string, index: number) => {
    if (rippleActive) setFocus({ rackId, index });
  };
  const onBlurRow = () => {
    if (rippledRef.current) setRipple((r) => ({ ...r, on: false })); // one-shot: disarm after a fill
  };

  const heads = (dir === "in" ? ["Console", "Source", "Mic / DI", "48V", "From"] : ["Console", "Destination", "Feed", "To"]).concat(showOwner ? ["Owner"] : []);

  // A function, not a component: a component declared in here would be a new
  // type every render, remounting every row — and every input in it — on each
  // keystroke.
  const renderSheet = (rows: React.ReactNode, rackColumn: boolean) => (
    <table className="w-full min-w-[620px] table-fixed border-collapse text-footnote">
      <colgroup>
        <col className="w-11" />
        {rackColumn && <col className="w-24" />}
        <col className="w-20" />
        <col className="w-[20%]" />
        <col className="w-[15%]" />
        {dir === "in" && <col className="w-16" />}
        <col />
        {showOwner && <col className="w-36" />}
      </colgroup>
      <thead>
        <tr>
          <th className={cn(TH, "text-right")}>#</th>
          {rackColumn && <th className={TH}>Rack</th>}
          {heads.map((h) => <th key={h} className={cn(TH, h === "48V" && "text-center")}>{h}</th>)}
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );

  const renderRow = (rackId: string, idx: number, rackLabel: string | null) => (
    <Row
      key={`${rackId}:${idx}`}
      rackId={rackId}
      idx={idx}
      rackLabel={rackLabel}
      dir={dir}
      endpoint={byKey.get(keyOf(rackId, dir, idx))}
      stageDevices={stageDevices}
      showOwner={showOwner}
      reach={isInFocusRun(rackId, idx, channelsOf(rackId))}
      editing={editingHop?.row === `${rackId}:${idx}` ? editingHop.hop : null}
      onEditing={(hop) => setEditingHop(hop ? { row: `${rackId}:${idx}`, hop } : null)}
      edit={edit}
      onFocusRow={onFocusRow}
      onBlurRow={onBlurRow}
    />
  );

  const noun = dir === "in" ? "input" : "output";
  if (racks.length === 0) {
    return <div className={EMPTY}>Add an Input Rack under Devices to build the {noun} patch.</div>;
  }

  // ── By device: group existing endpoints by the stage box their path starts at ──
  if (group === "device") {
    const rows = endpoints.filter((e) => e.dir === dir && meaningful(e));
    const groups = new Map<string, PatchEndpoint[]>();
    for (const e of rows) {
      const gk = e.path?.[0]?.deviceId || "__direct";
      const arr = groups.get(gk);
      if (arr) arr.push(e);
      else groups.set(gk, [e]);
    }
    const orderedKeys = [
      ...stageDevices.map((d) => d.id).filter((id) => groups.has(id)),
      ...[...groups.keys()].filter((k) => k !== "__direct" && !stageDevices.some((d) => d.id === k)),
      ...(groups.has("__direct") ? ["__direct"] : []),
    ];
    if (orderedKeys.length === 0) {
      return <div className={EMPTY}>No patched {noun}s yet — switch to “By rack” to build the patch.</div>;
    }
    return (
      <div className="flex flex-col gap-3.5">
        {orderedKeys.map((gk) => {
          const list = groups.get(gk)!.slice().sort((a, b) => a.rackId.localeCompare(b.rackId) || a.index - b.index);
          const gdev = stageDevices.find((d) => d.id === gk);
          const name = gk === "__direct" ? "Direct to rack" : gdev?.name ?? gk;
          return (
            <Card key={gk} title={name} dot={gdev?.color} meta={`${list.length}`}>
              {renderSheet(list.map((e) => renderRow(e.rackId, e.index, racks.length > 1 ? rackName(e.rackId) : null)), racks.length > 1)}
            </Card>
          );
        })}
      </div>
    );
  }

  // ── By rack: every channel of every rack ──
  return (
    <div className="flex flex-col gap-3.5">
      {racks.map((rack) => {
        const count = dir === "in" ? rack.inputs : rack.outputs;
        return (
          <Card
            key={rack.id}
            title={rack.name}
            dot={rack.color}
            meta={`${rack.inputs} in · ${rack.outputs} out`}
            ripple={rippleActive && <RippleBar dir={dir} ripple={ripple} setRipple={setRipple} showOwner={showOwner} fromRow={focus?.rackId === rack.id ? focus.index : null} />}
          >
            {renderSheet(Array.from({ length: Math.max(0, count) }, (_, i) => renderRow(rack.id, i + 1, null)), false)}
          </Card>
        );
      })}
    </div>
  );
}
