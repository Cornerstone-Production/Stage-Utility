// The inspector's form primitives.
//
// Shared by every per-type config editor, which is why they are their own file:
// the inspector is the largest remaining piece and these are the part of it that
// nothing else needs to know about.
//
// NumberInput here is the editor's fractional stepper, distinct from the themed
// NumberInput in components/ui — this one deals in 0..1 canvas fractions.

import * as React from "react";
import { useRef, useState, type ChangeEvent } from "react";
import {
  Switch,
  Input,
  Button,
  ButtonGroup,
  InfoHint,
  NumberInput as UiNumberInput,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "../components/ui";
import { ChevronRightIcon } from "lucide-react";
import { invoke } from "../lib/api";
import { cn } from "../lib/cn";

/**
 * A group heading in the inspector.
 *
 * The panel was one flat column of thirty-odd rows: what the object shows, how
 * it looks, and where it sits, all at the same level and in no stated order.
 * Three headings — Content, Look, Place — answer "what am I looking at" before
 * you read a single control, and they are a component rather than a repeated
 * span so a fourth cannot arrive styled differently.
 */
export function Section({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn("text-caption2 font-semibold uppercase tracking-wider text-fg-muted mt-1", className)}>
      {label}
    </span>
  );
}

/**
 * The controls almost nobody touches, folded away.
 *
 * Which ones those are is not a guess: across a production install's layouts,
 * `background` is set on 29 objects and `fontSize`/`color`/`border` on 24-26,
 * while `lineClamp` is set on 3, `opacity` on 6 and `uppercase` on 7. The long
 * tail was taking the same space as the things every object needs.
 *
 * Folded, not removed — a control you cannot reach is worse than one you scroll
 * past, and these are exactly the fields somebody eventually needs on one
 * object out of forty.
 */
export function MoreControls({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={
          "flex items-center gap-1 self-start rounded text-caption2 text-fg-subtle " +
          "transition-colors hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        }
      >
        <ChevronRightIcon className={"size-3 transition-transform " + (open ? "rotate-90" : "")} />
        {open ? "Fewer options" : "More options"}
      </button>
      {open && <div className="flex flex-col gap-2.5">{children}</div>}
    </>
  );
}

/**
 * Label beside control — until the panel is too narrow for both, and then label
 * ABOVE control.
 *
 * A fixed 96px label in a 176px panel leaves 64px for the control, which is
 * narrower than a stepper field, so the row overflowed and the whole inspector
 * scrolled sideways. Stacking gives the control the full width instead, and the
 * controls wrap inside it, so nothing is ever cut off however far the panel is
 * dragged in.
 *
 * A container query on the PANEL, not a media query: the inspector's width is
 * dragged, and the window's says nothing about it.
 */
export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 @max-[248px]/insp:flex-col @max-[248px]/insp:items-stretch @max-[248px]/insp:gap-1">
      <span className="text-caption2 text-fg-muted w-24 shrink-0 flex items-center gap-1 @max-[248px]/insp:w-auto">
        <span className="truncate">{label}</span>
        {hint && <InfoHint className="shrink-0">{hint}</InfoHint>}
      </span>
      <div className="flex-1 min-w-0 flex items-center gap-1 @max-[248px]/insp:flex-wrap">{children}</div>
    </div>
  );
}

/**
 * Horizontal and vertical alignment, as one 3x3 pad.
 *
 * Two rows of three lettered buttons — L C R and T M B — asked the operator to
 * read the result off two controls and hold the combination in their head. The
 * pad is the shape of the answer, which is how every design tool does it and
 * why it needs no label at all.
 */
export function AlignPad({
  h,
  v,
  onChange,
}: {
  h: "left" | "center" | "right";
  v: "top" | "middle" | "bottom";
  onChange: (next: { textAlign?: "left" | "center" | "right"; vAlign?: "top" | "middle" | "bottom" }) => void;
}) {
  const HS = ["left", "center", "right"] as const;
  const VS = ["top", "middle", "bottom"] as const;
  return (
    <div
      role="group"
      aria-label="Alignment"
      className="grid w-[4.5rem] grid-cols-3 gap-px overflow-hidden rounded-md border border-line-strong bg-line-strong"
    >
      {VS.map((vv) =>
        HS.map((hh) => {
          const on = h === hh && v === vv;
          return (
            <button
              key={`${vv}-${hh}`}
              type="button"
              aria-label={`Align ${vv} ${hh}`}
              aria-pressed={on}
              onClick={() => onChange({ textAlign: hh, vAlign: vv })}
              // cn(), not string concat: `bg-fill` and `bg-accent` are the same
              // Tailwind group, so concatenating both leaves which one wins to
              // stylesheet order — and the active cell rendered grey.
              className={cn(
                "flex h-5 items-center justify-center transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                on ? "bg-accent" : "bg-fill hover:bg-fill-hover",
              )}
            >
              {/* A bar showing where the text would sit, not a letter. */}
              <span className={cn("block h-0.5 w-2.5 rounded-full", on ? "bg-white" : "bg-fg-subtle")} />
            </button>
          );
        }),
      )}
    </div>
  );
}

// ── Declarative inspector rows ───────────────────────────────────────────────
// Thin label+control wrappers so each object's inspector block reads as a list
// of options and every control is laid out consistently. Bespoke controls
// (live-data selects, list editors) still use <Row> directly.

export function RowSwitch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <Row label={label} hint={hint}><Switch checked={checked} onCheckedChange={onChange} /></Row>;
}

export function RowText({ label, hint, value, placeholder, onChange }: { label: string; hint?: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <Row label={label} hint={hint}>
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="text-fg" />
    </Row>
  );
}

/** Image object config: a URL field (external https / existing) plus an upload
 *  button that stores a local file server-side and sets src to the returned URL —
 *  so the bytes never live in the layout JSON (which rides in stage:state). */
export function ImageConfig({ src, onChange }: { src: string; onChange: (v: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("Couldn't read the file"));
        r.readAsDataURL(file);
      });
      const { url } = await invoke<{ url: string }>("layout:uploadImage", { dataUrl });
      onChange(url);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <RowText label="URL" value={src} placeholder="https://… or upload →" onChange={onChange} />
      <Row label="Upload">
        <div className="flex items-center gap-2 min-w-0">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
          <Button variant="filled" size="small" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "Uploading…" : "Choose image…"}
          </Button>
          {src.startsWith("/layout-images/") && <span className="text-caption2 text-green-10 shrink-0">uploaded ✓</span>}
          {err && <span className="text-caption2 text-red-11 truncate">{err}</span>}
        </div>
      </Row>
    </>
  );
}

export function RowNumber({ label, hint, value, step, min, max, onChange }: { label: string; hint?: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return <Row label={label} hint={hint}><NumberInput value={value} step={step} min={min} max={max} onChange={onChange} /></Row>;
}

/** A segmented (accent/filled) button toggle — the most repeated inspector control. */
export function RowToggle<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  // TWO options stay a toggle; three or more become a dropdown.
  //
  // A binary choice reads better shown than hidden — Rect / Ellipse is one
  // glance. Past two, a row of word buttons squeezes each label until it
  // truncates, and it does it worst in a narrow panel, which is where the
  // inspector spends most of its life. The rule lives HERE rather than at each
  // of the seven call sites, so they cannot drift into disagreeing about it.
  if (options.length > 2) {
    return (
      <Row label={label} hint={hint}>
        <Select value={String(value)} onValueChange={(v: string) => onChange(v as T)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {options.map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Row>
    );
  }
  return (
    <Row label={label} hint={hint}>
      <ButtonGroup>
        {options.map((o) => (
          <Button key={o.value} variant={value === o.value ? "accent" : "filled"} size="small" onClick={() => onChange(o.value)}>
            {o.label}
          </Button>
        ))}
      </ButtonGroup>
    </Row>
  );
}

/** A labeled dropdown row (for when there are more options than fit a toggle). */
export function RowSelect({ label, hint, value, options, onChange }: { label: string; hint?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <Row label={label} hint={hint}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

/** Thin wrappers over the shared themed NumberInput, kept so existing call sites
 *  and PixelField do not change. */
export function NumberField({ value, onChange, step = 1, min, max, suffix }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return <UiNumberInput value={Number.isFinite(value) ? value : 0} onChange={onChange} step={step} min={min} max={max} suffix={suffix} />;
}

/** Style-row number (fraction value). */
export function NumberInput({ value, onChange, step = 0.01, min, max }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return <NumberField value={Number.isFinite(value) ? value : 0} onChange={onChange} step={step} min={min} max={max} />;
}

/** X/Y/W/H field shown as whole design-canvas pixels (stored as a 0..1 fraction). */
export function PixelField({ label, value, dim, onChange }: { label: string; value: number; dim: number; onChange: (frac: number) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-caption2 text-fg-muted w-3.5 shrink-0">{label}</span>
      <NumberField
        value={Math.round((Number.isFinite(value) ? value : 0) * dim)}
        step={1}
        min={0}
        max={dim}
        suffix="px"
        onChange={(v) => onChange(v / dim)}
      />
    </label>
  );
}

// ── main editor ──────────────────────────────────────────────────────────────

