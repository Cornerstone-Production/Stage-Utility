// stageplots-inspector.tsx — the selected item's fields: its label (with
// suggestions), text kind, colour, size and rotation or a cable's dash, notes,
// and the inputs that plug in there, and on a connection point its patch device
// (stageplots-patch-link.tsx). Every field edits the draft; typing in one is a
// single undo step, committed when the field settles. A linked point's label and
// colour follow its device, so both are locked while the link holds.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CopyIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";

import { PATCH_COLORS, PATCH_COLOR_NAMES } from "@main/types/patch";
import { STAGEPLOT_LIMITS, type PlotItem, type TextKind } from "@main/types/stageplots";
import type { LinkResolution, PatchRead } from "@main/services/stageplots-patch-link";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NumberInput } from "../../components/ui/number-input";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/cn";
import { uid } from "../../lib/uid";
import type { EditorAction } from "../../main/stageplots/editor-state";
import { labelSuggestions, venueLabels } from "../../main/stageplots/label-suggestions";
import { Mono } from "../../main/stageplots/mono";
import { TYPE_NAMES, iconKeyOf, itemTypeName } from "../../main/stageplots/symbols";
import { ItemIcon } from "./stageplots-palette";
import { PatchDeviceField } from "./stageplots-patch-link";
import { Num, Segmented, eyebrow, iconButton, textareaClass } from "./stageplots-shared";

const TEXT_KINDS: readonly { value: TextKind; label: string }[] = (["label", "callout", "dimension"] as const).map((value) => ({
  value,
  label: TYPE_NAMES[value],
}));

/** `text` with the first occurrence of `q` marked, case-insensitively. */
function Marked({ text, q }: { text: string; q: string }) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-accent">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

/** Under a linked point's label and colour, which follow its patch device. */
const FOLLOWS = "Name and color follow the patch device.";

function LabelField({
  item,
  labelSources,
  dispatch,
  locked,
}: {
  item: PlotItem;
  labelSources: readonly (readonly PlotItem[])[];
  dispatch: (a: EditorAction) => void;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** The full list on focus; filtered once something is typed. */
  const [typed, setTyped] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const q = typed ? item.label : "";
  const groups = labelSuggestions(venueLabels(labelSources, item.id), q);
  const all = [...groups.venue, ...groups.starter];
  const callout = item.type === "text" && item.textKind === "callout";

  const take = (label: string) => {
    dispatch({ type: "patch", id: item.id, fields: { label }, live: true });
    dispatch({ type: "commitGesture" });
    setOpen(false);
    setHighlight(-1);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.max(0, Math.min(all.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && highlight >= 0 && all[highlight]) take(all[highlight]);
      else {
        dispatch({ type: "commitGesture" });
        setOpen(false);
      }
    } else if (e.key === "Escape") setOpen(false);
  };
  let n = 0;
  const option = (s: string) => {
    const i = n++;
    return (
      <button
        key={`${i}-${s}`}
        type="button"
        role="option"
        aria-selected={i === highlight}
        // Down, not click: a click would blur the field first and close the list.
        onPointerDown={(e) => {
          e.preventDefault();
          take(s);
        }}
        className="flex h-7 w-full items-center rounded-[5px] px-2 text-left text-footnote text-fg hover:bg-fill aria-selected:bg-fill"
      >
        <span>
          <Marked text={s} q={q} />
        </span>
      </button>
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      <label className={eyebrow} htmlFor="stageplots-item-label">
        {callout ? "Callout text" : "Label"}
      </label>
      <div className="relative">
        <Input
          id="stageplots-item-label"
          data-testid="f-label"
          value={item.label}
          maxLength={STAGEPLOT_LIMITS.labelChars}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="stageplots-label-suggestions"
          placeholder="Type or pick a label"
          disabled={locked}
          onFocus={() => {
            setTyped(false);
            setHighlight(-1);
            setOpen(true);
          }}
          onChange={(e) => {
            setTyped(true);
            setHighlight(-1);
            setOpen(true);
            dispatch({ type: "patch", id: item.id, fields: { label: e.target.value }, live: true });
          }}
          onBlur={() => {
            dispatch({ type: "commitGesture" });
            setOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
        {open && !locked && (
          <div
            id="stageplots-label-suggestions"
            role="listbox"
            data-testid="suggestions"
            className="absolute top-[calc(100%+4px)] right-0 left-0 z-20 max-h-[260px] overflow-auto rounded-lg border border-line-strong bg-popover p-1 shadow-[var(--su-shadow-2)]"
          >
            {groups.venue.length > 0 && <span className={cn(eyebrow, "px-2 pt-1.5 pb-[3px]")}>In this venue</span>}
            {groups.venue.map(option)}
            {groups.starter.length > 0 && <span className={cn(eyebrow, "px-2 pt-1.5 pb-[3px]")}>Starter gear</span>}
            {groups.starter.map(option)}
            {all.length === 0 && <div className="px-2 py-1.5 text-caption1 text-fg-subtle">No match. Keep typing to use your own label.</div>}
          </div>
        )}
      </div>
      {locked && <p className="text-caption1 text-fg-subtle">{FOLLOWS}</p>}
    </div>
  );
}

function Swatches({ item, dispatch, locked }: { item: PlotItem; dispatch: (a: EditorAction) => void; locked: boolean }) {
  const ring = "aria-pressed:shadow-[0_0_0_2px_var(--su-bg),0_0_0_4px_var(--su-fg)]";
  const set = (color: string | null) => item.color !== color && dispatch({ type: "patch", id: item.id, fields: { color } });
  return (
    <div className="flex flex-col gap-[5px]">
      <span className={eyebrow}>Color</span>
      <div className="flex flex-wrap gap-[7px]" role="group" aria-label="Color">
        <button
          type="button"
          title="No color"
          aria-label="No color"
          aria-pressed={item.color === null}
          disabled={locked}
          onClick={() => set(null)}
          className={cn(
            "relative size-5 overflow-hidden rounded-full border border-line-strong bg-transparent transition-transform enabled:hover:scale-110 disabled:opacity-45 after:absolute after:top-[-2px] after:bottom-[-2px] after:left-1/2 after:w-px after:rotate-45 after:bg-fg-subtle",
            ring,
          )}
        />
        {PATCH_COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            title={PATCH_COLOR_NAMES[i]}
            aria-label={PATCH_COLOR_NAMES[i]}
            aria-pressed={item.color === c}
            disabled={locked}
            onClick={() => set(c)}
            // The swatch's colour is data, one of the patch sheet's ten.
            style={{ background: c }}
            className={cn("size-5 rounded-full transition-transform enabled:hover:scale-110 disabled:opacity-45 disabled:aria-pressed:opacity-100", ring)}
          />
        ))}
      </div>
    </div>
  );
}

function Inputs({ item, dispatch }: { item: PlotItem; dispatch: (a: EditorAction) => void }) {
  const list = useRef<HTMLDivElement>(null);
  /** Set by Add input: the new row's field takes focus once it is drawn. */
  const focusLast = useRef(false);
  useEffect(() => {
    if (!focusLast.current) return;
    focusLast.current = false;
    const fields = list.current?.querySelectorAll("input");
    fields?.[fields.length - 1]?.focus();
  }, [item.inputs.length]);
  return (
    <div className="flex flex-col gap-[5px]">
      <span className={eyebrow}>Inputs</span>
      <div className="flex flex-col gap-1" ref={list}>
        {item.inputs.length === 0 && <p className="text-caption1 text-fg-subtle">None yet.</p>}
        {item.inputs.map((v, i) => (
          <div key={i} className="grid grid-cols-[18px_minmax(0,1fr)_24px] items-center gap-1.5">
            <span className="text-right font-mono text-[11px] text-fg-subtle tabular-nums">{i + 1}</span>
            <Input
              value={v}
              aria-label={`Input ${i + 1}`}
              maxLength={STAGEPLOT_LIMITS.inputChars}
              className="h-[26px] text-caption1"
              onChange={(e) => dispatch({ type: "patch", id: item.id, fields: { inputs: item.inputs.map((x, j) => (j === i ? e.target.value : x)) }, live: true })}
              onBlur={() => dispatch({ type: "commitGesture" })}
            />
            <button
              type="button"
              className={cn(iconButton, "size-6 hover:text-danger-11")}
              title="Remove input"
              aria-label={`Remove input ${i + 1}`}
              onClick={() => dispatch({ type: "removeInput", id: item.id, index: i })}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      <Button
        variant="transparent"
        size="small"
        className="self-start"
        disabled={item.inputs.length >= STAGEPLOT_LIMITS.inputsPerItem}
        onClick={() => {
          focusLast.current = true;
          dispatch({ type: "addInput", id: item.id });
        }}
      >
        <PlusIcon className="size-3.5" />
        Add input
      </Button>
    </div>
  );
}

export function StagePlotsInspector({
  item,
  labelSources,
  dispatch,
  link,
  patch,
}: {
  /** The selected item as shown: a linked point's label and colour as its device has them. */
  item: PlotItem | null;
  /** The item lists whose labels the label field suggests: the draft, then the venue's other plots. */
  labelSources: readonly (readonly PlotItem[])[];
  dispatch: (a: EditorAction) => void;
  /** The selected point's link, resolved; undefined when it has none or the patch has not answered. */
  link?: LinkResolution;
  /** The patch, for the device picker; null until it has answered. */
  patch: PatchRead | null;
}) {
  if (!item) {
    return (
      <aside aria-label="Inspector" className="su-card flex flex-col gap-3 p-3" data-testid="inspector">
        <div className="px-1.5 py-7 text-center">
          <b className="mb-1 block text-footnote font-semibold text-fg">Nothing selected</b>
          <p className="text-caption1 text-fg-muted">Pick an item on the plot, or add one from the palette.</p>
        </div>
      </aside>
    );
  }
  const live = (fields: Partial<PlotItem>) => dispatch({ type: "patch", id: item.id, fields, live: true });
  const locked = !!item.patchLink;
  const settle = () => dispatch({ type: "commitGesture" });
  return (
    <aside aria-label="Inspector" className="su-card flex flex-col gap-3 p-3" data-testid="inspector">
      <div className="flex items-center gap-2">
        <ItemIcon kind={iconKeyOf(item)} className="size-[22px]" />
        <span className="min-w-0 flex-1 text-footnote font-semibold text-fg">
          {itemTypeName(item)}
          <small className="block truncate text-[11px] font-normal text-fg-subtle">{item.label ? <Mono text={item.label} /> : "No label"}</small>
        </span>
        <button type="button" className={cn(iconButton, "size-7")} title="Duplicate" aria-label="Duplicate" onClick={() => dispatch({ type: "duplicate", id: item.id, newId: uid("i") })}>
          <CopyIcon className="size-4" />
        </button>
        <button type="button" className={cn(iconButton, "size-7 hover:text-danger-11")} title="Delete" aria-label="Delete" onClick={() => dispatch({ type: "remove", id: item.id })}>
          <Trash2Icon className="size-4" />
        </button>
      </div>
      <LabelField item={item} labelSources={labelSources} dispatch={dispatch} locked={locked} />
      {item.type === "text" && (
        <div className="flex flex-col gap-[5px]">
          <span className={eyebrow}>Kind</span>
          <Segmented label="Text kind" value={item.textKind ?? "label"} options={TEXT_KINDS} onChange={(textKind) => dispatch({ type: "patch", id: item.id, fields: { textKind } })} />
        </div>
      )}
      <Swatches item={item} dispatch={dispatch} locked={locked} />
      {item.type === "cable" ? (
        <div className="flex items-center gap-2.5">
          <span className="min-w-0 flex-1">
            <b className="block text-footnote font-medium text-fg">Dashed</b>
            <small className="block text-[11px] leading-[14px] text-fg-subtle">
              <Num>{item.points?.length ?? 0}</Num> points · drag a point&apos;s handle to move it
            </small>
          </span>
          <Switch checked={item.dashed === true} aria-label="Dashed" onCheckedChange={(dashed) => dispatch({ type: "patch", id: item.id, fields: { dashed } })} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col gap-[5px]">
              <span className={eyebrow}>Width</span>
              <NumberInput aria-label="Width" value={item.w} min={STAGEPLOT_LIMITS.itemMinSize} max={STAGEPLOT_LIMITS.itemMaxSize} step={4} onChange={(w) => live({ w })} onCommit={settle} />
            </div>
            <div className="flex min-w-0 flex-col gap-[5px]">
              <span className={eyebrow}>Height</span>
              <NumberInput aria-label="Height" value={item.h} min={STAGEPLOT_LIMITS.itemMinSize} max={STAGEPLOT_LIMITS.itemMaxSize} step={4} onChange={(h) => live({ h })} onCommit={settle} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col gap-[5px]">
              <span className={eyebrow}>Rotation</span>
              <NumberInput aria-label="Rotation" value={item.rotation} step={5} suffix="°" onChange={(rotation) => live({ rotation })} onCommit={settle} />
            </div>
          </div>
        </>
      )}
      <div className="flex min-w-0 flex-col gap-[5px]">
        <label className={eyebrow} htmlFor="stageplots-item-notes">
          Notes
        </label>
        <textarea
          id="stageplots-item-notes"
          rows={2}
          value={item.notes}
          maxLength={STAGEPLOT_LIMITS.notesChars}
          placeholder="Shown when someone taps it"
          className={textareaClass}
          onChange={(e) => live({ notes: e.target.value })}
          onBlur={settle}
        />
      </div>
      <Inputs item={item} dispatch={dispatch} />
      {item.type === "conn" && <PatchDeviceField key={item.id} item={item} link={link} patch={patch} dispatch={dispatch} />}
    </aside>
  );
}
