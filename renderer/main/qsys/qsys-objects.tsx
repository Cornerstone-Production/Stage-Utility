// qsys-objects.tsx — the Q-SYS layout objects, drawn from the Core's live values.
//
// Built to the approved kit (stage-utility-plans mockups Kit, Main direction A
// and Staff), in the app's tokens. The `--color-*` form of them, not `--su-*`:
// a layout is drawn on a kiosk surface, which re-declares the `--color-*` set for
// its dark ground (styles.css, .kiosk-surface), and a `--su-*` read there resolves
// to the light app's value (a dark thumb on a dark card). Every object has three looks: normal, its own
// active state, and offline (greyed to 0.35, deaf to input).
//
// What each one may light or move by, and when it writes, follows the rules in
// use-qsys-values.ts: values are only ever the Core's, and only a fresh pointer
// gesture sends anything. A fader drag is relative to where the finger landed
// and never jumps; a pure trigger with no readable state stays unlit and flashes
// when the Core confirms the write.
//
// A fader's thumb, its drag and its limit line all use one scale: the Core's
// Value, linear over the control's own range (ValueMin..ValueMax from the
// catalog). The Core's Position follows its own taper, which the page does not
// know, so a thumb drawn from it would jump at release when the read-back lands.

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { QsysAddress, QsysBinding } from "@main/types/qsys";
import type { LayoutObjectConfig } from "@main/types/views";
import { bindGesture, type GestureHandle } from "../../lib/pointer-gesture";
import {
  DRAG_COALESCE_MS,
  QsysPanelContext,
  combineStates as combine,
  useQsysControl,
  useQsysPanel,
  useQsysPanelContext,
  useQsysPanelState,
  useQsysStates,
  useQsysValue,
  useQsysWriteState,
  useQsysWrite,
  type QsysControlInfo,
  type QsysReading,
  type QsysState,
} from "./use-qsys-values";

type QsysConfig = Extract<LayoutObjectConfig, { type: `qsys-${string}` }>;
type Of<T extends QsysConfig["type"]> = Extract<QsysConfig, { type: T }>;

/** How long a hold-to-confirm button must be held before it writes. */
export const HOLD_MS = 1_000;
/** How long a confirmed trigger stays lit. */
export const FLASH_MS = 600;
/** Meter colour bands, as a fraction of the meter's height (the approved mockup's). */
const AMBER_AT = 0.74;
const RED_AT = 0.86;

const ADDR = (b: QsysBinding | null | undefined): QsysAddress | null => (b ? { component: b.component, control: b.control } : null);

/** A Core value read as on or off. Q-SYS reports booleans as true/false or 1/0. */
export function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return /^(true|1|on)$/i.test(v.trim());
  return false;
}

/** The catalog's Type decides; only before the catalog is read does the value's own type. */
const isBooleanControl = (info: QsysControlInfo, value: unknown) => (info.type ? /^bool/i.test(info.type) : typeof value === "boolean");

/** A 0..1 height for a reading: linear over the control's range, else the Core's position. */
function levelOf(r: Pick<QsysReading, "value" | "position">, range: QsysControlInfo["range"]): number {
  if (range && typeof r.value === "number") return clamp01((r.value - range.min) / (range.max - range.min));
  return r.position === null ? 0 : clamp01(r.position);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** "-12.0", "+3.5", "0.0": a level as the readout shows it, in Plex Mono. */
export function formatDb(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "–";
  const s = v.toFixed(1);
  return v > 0 ? `+${s}` : s === "-0.0" ? "0.0" : s;
}

const MONO: CSSProperties = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };

/** The Core lit this from its own value or its indicator; null when it reports no state. */
function useLit(b: QsysBinding | null | undefined): boolean | null {
  const own = useQsysValue(ADDR(b));
  const indicator = useQsysValue(b?.indicator ? ADDR(b.indicator) : null);
  const info = useQsysControl(ADDR(b));
  if (b?.indicator) return indicator.state === "unavailable" ? null : truthy(indicator.value);
  if (own.state === "unavailable") return null;
  return isBooleanControl(info, own.value) ? truthy(own.value) : null;
}

/** Light for FLASH_MS after `flash()`; for a trigger the Core confirmed. */
function useFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return [
    on,
    () => {
      setOn(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), FLASH_MS);
    },
  ];
}

// ── The frame every object sits in ──────────────────────────────────────────

/**
 * Every object's box. Anything but live is greyed to the kit's 0.35 and deaf
 * (handlers check the state too: pointer-events alone would leave a keyboard or
 * a stale gesture able to write). Unavailable also says so, in words: "Not
 * bound" for an object with no binding, otherwise "Unavailable".
 */
function Frame({
  type,
  state,
  ts,
  children,
  style,
  bound = true,
  dims = true,
}: {
  type: QsysConfig["type"];
  state: QsysState;
  ts: CSSProperties;
  children?: ReactNode;
  style?: CSSProperties;
  bound?: boolean;
  /** False for the status object, which reports the outage rather than greying out. */
  dims?: boolean;
}) {
  const grey = dims && state !== "live";
  return (
    <div
      data-qsys-object={type}
      data-state={state}
      aria-disabled={state === "live" ? undefined : true}
      style={{
        ...ts,
        position: "relative",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
        minWidth: 0,
        minHeight: 0,
        pointerEvents: grey ? "none" : undefined,
      }}
    >
      <div data-qsys-body style={{ display: "flex", flex: "1 1 auto", minWidth: 0, minHeight: 0, opacity: grey ? 0.35 : 1, ...style }}>
        {/* Unavailable shows the word instead of a control that cannot be used. */}
        {dims && state === "unavailable" ? (
          <span data-unavailable style={{ margin: "auto", textAlign: "center", fontSize: "0.5em", fontWeight: 500 }}>
            {bound ? "Unavailable" : "Not bound"}
          </span>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

const Caption = ({ children }: { children: ReactNode }) => (
  <span style={{ fontSize: "0.55em", fontWeight: 400, color: "var(--color-fg-muted)" }}>{children}</span>
);

// ── Buttons ─────────────────────────────────────────────────────────────────

const BUTTON: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  borderRadius: 12,
  fontFamily: "inherit",
  fontSize: "0.6em",
  cursor: "pointer",
  padding: "0 0.9em",
  boxSizing: "border-box",
  touchAction: "manipulation",
};

function litStyle(lit: boolean): CSSProperties {
  return {
    border: `1px solid ${lit ? "var(--color-accent)" : "var(--color-line)"}`,
    background: lit ? "var(--color-accent)" : "transparent",
    color: lit ? "var(--color-on-accent)" : "var(--color-fg)",
    fontWeight: lit ? 600 : 400,
  };
}

/**
 * A button that fires a trigger, or holds to confirm first. `onFire` runs only
 * after a tap, or after the full hold; letting go early sends nothing.
 */
function PressButton({
  hold,
  disabled,
  lit,
  label,
  holdLabel,
  onFire,
  style,
  testId,
}: {
  hold: boolean;
  disabled: boolean;
  lit: boolean;
  label: ReactNode;
  holdLabel: string;
  onFire: () => void;
  style?: CSSProperties;
  testId?: string;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef<GestureHandle | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(
    () => () => {
      gesture.current?.cancel();
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    // The fill grows over the hold. Web Animations, so the length is the hold itself
    // rather than a motion token: it is a countdown, not an ornament.
    if (holding && bar.current && typeof bar.current.animate === "function") {
      bar.current.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: HOLD_MS, easing: "linear", fill: "forwards" });
    }
  }, [holding]);
  // Going offline mid-hold ends the hold: it never completes into a write later.
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled);
    if (disabled) setHolding(false);
  }
  useEffect(() => {
    if (!disabled) return;
    gesture.current?.cancel();
    gesture.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, [disabled]);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!hold || disabled) return;
    const el = e.currentTarget;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      gesture.current?.cancel();
      gesture.current = null;
      setHolding(false);
      onFire();
    }, HOLD_MS);
    gesture.current = bindGesture(el, e.pointerId, {
      move: () => {},
      end: () => {
        gesture.current = null;
        stop();
      },
    });
  };
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={lit}
      disabled={disabled}
      data-holding={holding || undefined}
      onPointerDown={onPointerDown}
      onClick={() => {
        if (!hold && !disabled) onFire();
      }}
      style={{
        ...BUTTON,
        ...litStyle(lit),
        position: "relative",
        overflow: "hidden",
        ...(holding ? { border: "1px solid var(--color-warn-9)", color: "var(--color-warn-9)", background: "transparent", fontWeight: 500 } : {}),
        ...style,
      }}
    >
      {holding && (
        <div
          ref={bar}
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            transformOrigin: "left",
            transform: "scaleX(0)",
            background: "color-mix(in srgb, var(--color-warn-9) 22%, transparent)",
          }}
        />
      )}
      <span style={{ position: "relative" }}>{holding ? holdLabel : label}</span>
    </button>
  );
}

/** One trigger, preset or option: lit from the Core, flashed on a confirmed write when it has no state. */
function TriggerButton({
  binding,
  label,
  interactive,
  hold,
  style,
  muted,
}: {
  binding: QsysBinding;
  label: string;
  interactive: boolean;
  hold?: boolean;
  style?: CSSProperties;
  muted?: boolean;
}) {
  const v = useQsysValue(ADDR(binding));
  const info = useQsysControl(ADDR(binding));
  const lit = useLit(binding);
  const [flash, doFlash] = useFlash();
  const write = useQsysWrite();
  const boolean = isBooleanControl(info, v.value);
  const canInput = interactive && v.state === "live" && info.allowed;
  return (
    <PressButton
      hold={!!hold || info.hold}
      disabled={!canInput}
      lit={lit === true || flash}
      label={label}
      holdLabel="Keep holding…"
      onFire={() => {
        if (!canInput) return;
        void write(ADDR(binding)!, true, { final: true }).then((r) => {
          // A pure trigger reports no state: show the confirmed write as a flash, never as lit.
          if (r.ok && (lit === null || !boolean)) doFlash();
        });
      }}
      style={{ ...(muted && lit !== true && !flash ? { color: "var(--color-fg-muted)", borderColor: "var(--color-line-strong)" } : {}), ...style }}
    />
  );
}

// ── Fader ───────────────────────────────────────────────────────────────────

interface FaderProps {
  binding: QsysBinding | null;
  vertical: boolean;
  showDb: boolean;
  steps: boolean;
  stepDb: number;
  interactive: boolean;
  /** Drawn as the strip's mute does: a muted channel's fill and thumb go quiet. */
  muted?: boolean;
  meters?: (QsysBinding | null | undefined)[];
}

function Fader({ binding, vertical, showDb, steps, stepDb, interactive, muted = false, meters = [] }: FaderProps) {
  const panel = useQsysPanelContext();
  const { epoch } = useQsysPanelState();
  const addr = ADDR(binding);
  const v = useQsysValue(addr);
  const info = useQsysControl(addr);
  const write = useQsysWrite();
  const track = useRef<HTMLDivElement | null>(null);
  const [local, setLocal] = useState<number | null>(null);
  const drag = useRef<{ epoch: number; gesture: GestureHandle; moved: boolean; last: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      drag.current?.gesture.cancel();
    };
  }, []);

  // A break (the stream dropped, the page hid, the Core went away) ends a drag in
  // progress, and the fader shows the Core's value once the panel is read again.
  useEffect(() => {
    const d = drag.current;
    if (d && epoch !== d.epoch) {
      d.gesture.cancel();
      drag.current = null;
      setLocal(null);
    }
  }, [epoch]);

  const range = info.range;
  const lo = range ? Math.max(range.min, info.limits.min ?? range.min) : 0;
  const hi = range ? Math.min(range.max, info.limits.max ?? range.max) : 0;
  const norm = (x: number) => (range ? clamp01((x - range.min) / (range.max - range.min)) : 0);
  const writable =
    interactive && v.state === "live" && info.allowed && !!range && info.limits.min !== null && info.limits.max !== null && typeof v.value === "number";

  const shown = local ?? (typeof v.value === "number" ? v.value : null);
  const level = shown === null ? (v.position ?? 0) : range ? norm(shown) : (v.position ?? 0);
  const limitAt = range && hi < range.max ? norm(hi) : null;
  const atLimit = range !== null && shown !== null && limitAt !== null && shown >= hi - 1e-6;

  const snapBack = () => {
    drag.current?.gesture.cancel();
    drag.current = null;
    if (mounted.current) setLocal(null);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!writable || !panel || drag.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = track.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const length = vertical ? rect.height : rect.width;
    // jsdom lays nothing out; a real browser always has a length here.
    if (!(length > 0)) return;
    const startValue = v.value as number;
    const startNorm = norm(startValue);
    const startAt = vertical ? e.clientY : e.clientX;
    const epoch = panel.epoch;
    // Relative: touching the track does not move the value. Only movement does.
    const gesture = bindGesture(e.currentTarget, e.pointerId, {
      move: (ev) => {
        const d = drag.current;
        if (!d || panel.epoch !== d.epoch) return;
        const moved = vertical ? startAt - ev.clientY : ev.clientX - startAt;
        const n = Math.min(norm(hi), Math.max(norm(lo), startNorm + moved / length));
        const next = Math.round((range!.min + n * (range!.max - range!.min)) * 100) / 100;
        if (next === d.last) return;
        d.moved = true;
        d.last = next;
        setLocal(next);
        void write(addr!, next, { final: false, coalesceMs: DRAG_COALESCE_MS }).then((r) => {
          if (!r.ok && drag.current === d) snapBack();
        });
      },
      end: () => {
        const d = drag.current;
        drag.current = null;
        if (!d || !d.moved || panel.epoch !== d.epoch) {
          // A tap writes nothing: sending the value it already shows would be the page's own state.
          if (mounted.current) setLocal(null);
          return;
        }
        // The release always sends the last value, marked final.
        void write(addr!, d.last, { final: true }).then(() => {
          // A landed write's read-back is already in the panel; a refusal shows the Core's value.
          if (mounted.current && drag.current === null) setLocal(null);
        });
      },
    });
    drag.current = { epoch, gesture, moved: false, last: startValue };
  };

  const step = (dir: 1 | -1) => {
    if (!writable) return;
    const next = Math.min(hi, Math.max(lo, (v.value as number) + dir * stepDb));
    void write(addr!, Math.round(next * 100) / 100, { final: true });
  };

  const thumbLong = "10%";
  const thumbCross = "70%";
  const along = (n: number) => `calc((100% - ${thumbLong}) * ${1 - n})`;
  const fill = muted ? "var(--color-fg-subtle)" : "var(--color-accent)";

  const faderBody = (
    <div
      ref={track}
      data-fader
      data-at-limit={atLimit || undefined}
      onPointerDown={onPointerDown}
      style={{
        position: "relative",
        flex: "1 1 auto",
        minWidth: vertical ? 44 : 0,
        minHeight: vertical ? 0 : 44,
        touchAction: "none",
        cursor: writable ? "grab" : "default",
      }}
    >
      {/* the track and its fill */}
      <div
        style={{
          position: "absolute",
          borderRadius: 4,
          background: "var(--color-fill-active)",
          overflow: "hidden",
          ...(vertical ? { left: "calc(50% - 4px)", width: 8, top: 0, bottom: 0 } : { top: "calc(50% - 4px)", height: 8, left: 0, right: 0 }),
        }}
      >
        <div
          style={{
            position: "absolute",
            background: fill,
            opacity: muted ? 0.5 : 1,
            ...(vertical ? { left: 0, right: 0, bottom: 0, height: `${level * 100}%` } : { top: 0, bottom: 0, left: 0, width: `${level * 100}%` }),
          }}
        />
      </div>
      {limitAt !== null && (
        <div
          data-limit
          aria-hidden
          style={{
            position: "absolute",
            background: atLimit ? "var(--color-warn-9)" : "var(--color-line-strong)",
            ...(vertical
              ? { height: 2, left: "15%", right: "15%", top: `calc(${along(limitAt)} + ${thumbLong} / 2)` }
              : { width: 2, top: "15%", bottom: "15%", right: `calc(${along(limitAt)} + ${thumbLong} / 2)` }),
          }}
        />
      )}
      {/* No value from the Core at all: no thumb, rather than one parked at the bottom. */}
      {shown !== null && <div
        aria-hidden
        style={{
          position: "absolute",
          borderRadius: 10,
          // Opaque: the fill and the limit line must not show through the thumb.
          background: muted ? "var(--color-surface-raised)" : "var(--color-fg-strong)",
          border: "1px solid var(--color-line-strong)",
          boxShadow: atLimit ? "0 0 0 2px var(--color-warn-9)" : undefined,
          pointerEvents: "none",
          ...(vertical
            ? { height: thumbLong, left: `calc((100% - ${thumbCross}) / 2)`, width: thumbCross, top: along(level) }
            : { width: thumbLong, top: `calc((100% - ${thumbCross}) / 2)`, height: thumbCross, right: along(level) }),
        }}
      />}
    </div>
  );

  const meterBars = meters.filter((m): m is QsysBinding => !!m).map((m, i) => <MeterBar key={i} binding={m} vertical={vertical} />);

  return (
    <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center", gap: "0.3em", flex: "1 1 auto", minHeight: 0, minWidth: 0, width: vertical ? "100%" : undefined }}>
      {showDb && (
        <span data-db style={{ ...MONO, fontSize: "0.5em", color: atLimit ? "var(--color-warn-9)" : "var(--color-fg-muted)", minHeight: "1.2em" }}>
          {muted ? "Muted" : formatDb(shown)}
        </span>
      )}
      {steps && <StepButton label="+" onPress={() => step(1)} disabled={!writable} />}
      <div style={{ display: "flex", flexDirection: vertical ? "row" : "column", gap: 4, flex: "1 1 auto", alignSelf: "stretch", minHeight: 0, minWidth: 0, justifyContent: "center" }}>
        {faderBody}
        {meterBars}
      </div>
      {steps && <StepButton label="−" onPress={() => step(-1)} disabled={!writable} />}
    </div>
  );
}

function StepButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      aria-label={label === "+" ? "Up a step" : "Down a step"}
      disabled={disabled}
      onClick={onPress}
      style={{ ...BUTTON, border: "1px solid var(--color-line-strong)", background: "transparent", color: "var(--color-fg)", ...MONO, padding: 0 }}
    >
      {label}
    </button>
  );
}

// ── Meter ───────────────────────────────────────────────────────────────────

function bandColour(level: number): string {
  return level > RED_AT ? "var(--color-danger-9)" : level > AMBER_AT ? "var(--color-warn-9)" : "var(--color-ok-9)";
}

/** A meter bar, drawn by the panel's animation loop straight into the element. */
function MeterBar({ binding, vertical }: { binding: QsysBinding; vertical: boolean }) {
  const panel = useQsysPanelContext();
  const { component, control } = binding;
  const info = useQsysControl(ADDR(binding));
  const bar = useRef<HTMLDivElement | null>(null);
  const min = info.range?.min;
  const max = info.range?.max;
  useEffect(() => {
    if (!panel) return;
    const range = min !== undefined && max !== undefined ? { min, max } : null;
    return panel.addMeterSink({ component, control }, (r) => levelOf(r, range), {
      draw: (level) => {
        const el = bar.current;
        if (!el) return;
        el.style[vertical ? "height" : "width"] = `${level * 100}%`;
        el.style.background = bandColour(level);
      },
    });
  }, [panel, component, control, min, max, vertical]);
  return (
    <div
      data-meter
      style={{
        position: "relative",
        flex: "0 0 auto",
        borderRadius: 3,
        background: "var(--color-fill-active)",
        overflow: "hidden",
        ...(vertical ? { width: 6, alignSelf: "stretch" } : { height: 6, alignSelf: "stretch" }),
      }}
    >
      <div ref={bar} style={{ position: "absolute", ...(vertical ? { left: 0, right: 0, bottom: 0, height: 0 } : { top: 0, bottom: 0, left: 0, width: 0 }) }} />
    </div>
  );
}

/** A meter's number form (LKFS and kin), written straight to the text node. */
function MeterNumber({ binding, unit }: { binding: QsysBinding; unit?: string }) {
  const panel = useQsysPanelContext();
  const { component, control } = binding;
  const text = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!panel) return;
    return panel.onMeter({ component, control }, (r) => {
      if (text.current) text.current.textContent = formatDb(r.value);
    });
  }, [panel, component, control]);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.1em", margin: "auto" }}>
      <span ref={text} data-meter-number style={{ ...MONO, fontSize: "1em" }}>
        –
      </span>
      {unit && <Caption>{unit}</Caption>}
    </div>
  );
}

// ── The objects ─────────────────────────────────────────────────────────────

function FaderObject({ c, interactive, ts }: { c: Of<"qsys-fader">; interactive: boolean; ts: CSSProperties }) {
  const state = useQsysWriteState(ADDR(c.binding), true);
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!c.binding} style={{ padding: "0.3em" }}>
      <Fader binding={c.binding} vertical={c.orientation !== "horizontal"} showDb={c.showDb} steps={c.steps} stepDb={c.stepDb} interactive={interactive} />
    </Frame>
  );
}

function MeterObject({ c, ts }: { c: Of<"qsys-meter">; ts: CSSProperties }) {
  const a = useQsysValue(ADDR(c.binding));
  const b = useQsysValue(ADDR(c.binding2));
  const state = c.binding2 ? combine(a.state, b.state) : a.state;
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!c.binding} style={{ padding: "0.3em", justifyContent: "center", gap: 6 }}>
      {!c.binding ? null : c.form === "number" ? (
        <MeterNumber binding={c.binding} unit={c.unit} />
      ) : (
        <>
          <MeterBar binding={c.binding} vertical />
          {c.binding2 && <MeterBar binding={c.binding2} vertical />}
        </>
      )}
    </Frame>
  );
}

function MuteButton({ binding, interactive }: { binding: QsysBinding | null; interactive: boolean }) {
  const addr = ADDR(binding);
  const v = useQsysValue(addr);
  const info = useQsysControl(addr);
  const write = useQsysWrite();
  const muted = v.state !== "unavailable" && truthy(v.value);
  const canInput = interactive && v.state === "live" && info.allowed;
  return (
    <button
      type="button"
      data-mute
      aria-pressed={muted}
      disabled={!canInput}
      onClick={() => {
        // The new state is the Core's state flipped; shown only once the Core says so.
        if (canInput) void write(addr!, !muted, { final: true });
      }}
      style={{
        ...BUTTON,
        fontWeight: 500,
        border: `1px solid ${muted ? "var(--color-danger-9)" : "var(--color-line-strong)"}`,
        background: muted ? "var(--color-danger-9)" : "transparent",
        color: muted ? "var(--color-on-accent)" : "var(--color-fg)",
      }}
    >
      {/* Words, not only a colour. */}
      {muted ? "Muted" : "Mute"}
    </button>
  );
}

function MuteObject({ c, interactive, ts }: { c: Of<"qsys-mute">; interactive: boolean; ts: CSSProperties }) {
  const state = useQsysWriteState(ADDR(c.binding));
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!c.binding} style={{ alignItems: "center", justifyContent: "center" }}>
      <MuteButton binding={c.binding} interactive={interactive} />
    </Frame>
  );
}

function ButtonObject({ c, interactive, ts }: { c: Of<"qsys-button">; interactive: boolean; ts: CSSProperties }) {
  const state = useQsysWriteState(ADDR(c.binding));
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!c.binding} style={{ alignItems: "stretch", justifyContent: "stretch" }}>
      {c.binding && <TriggerButton binding={c.binding} label={c.label || c.binding.control} interactive={interactive} hold={c.hold} style={{ flex: 1 }} />}
    </Frame>
  );
}

function SwitchTrack({ on, disabled, onPress, label }: { on: boolean; disabled: boolean; onPress: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label || undefined}
      disabled={disabled}
      onClick={onPress}
      style={{
        position: "relative",
        width: 88,
        height: 48,
        flex: "0 0 auto",
        borderRadius: 24,
        border: 0,
        padding: 0,
        cursor: "pointer",
        background: on ? "var(--color-accent)" : "var(--color-fill-active)",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 4,
          left: on ? 44 : 4,
          width: 40,
          height: 40,
          borderRadius: 20,
          background: on ? "var(--color-bg)" : "var(--color-fg-subtle)",
          transition: "left var(--motion-quick) var(--motion-ease)",
        }}
      />
    </button>
  );
}

function SwitchObject({ c, interactive, ts }: { c: Of<"qsys-switch">; interactive: boolean; ts: CSSProperties }) {
  const write = useQsysWrite();
  const own = useQsysValue(ADDR(c.binding));
  const ownState = useQsysWriteState(ADDR(c.binding));
  const pairState = useQsysStates([ADDR(c.onBinding), ADDR(c.offBinding)], true);
  const pairLit = useLit(c.onBinding);
  const label = <span style={{ fontSize: "0.6em", fontWeight: 500 }}>{c.label}</span>;

  if (c.binding) {
    const on = own.state !== "unavailable" && truthy(own.value);
    const canInput = interactive && ownState === "live";
    return (
      <Frame type={c.type} state={ownState} ts={ts} style={{ alignItems: "center", gap: "0.5em", padding: "0.3em" }}>
        <SwitchTrack on={on} disabled={!canInput} label={c.label} onPress={() => canInput && void write(ADDR(c.binding)!, !on, { final: true })} />
        {label}
      </Frame>
    );
  }
  if (c.onBinding && c.offBinding) {
    const state = pairState;
    if (pairLit !== null) {
      // The Core reports which way it is (an indicator on the On trigger): one switch.
      const target = pairLit ? c.offBinding : c.onBinding;
      const canInput = interactive && state === "live";
      return (
        <Frame type={c.type} state={state} ts={ts} style={{ alignItems: "center", gap: "0.5em", padding: "0.3em" }}>
          <SwitchTrack on={pairLit} disabled={!canInput} label={c.label} onPress={() => canInput && void write(ADDR(target)!, true, { final: true })} />
          {label}
        </Frame>
      );
    }
    // No readable state: two triggers, neither lit, each flashing when the Core confirms it.
    return (
      <Frame type={c.type} state={state} ts={ts} style={{ alignItems: "center", gap: "0.4em", padding: "0.3em" }}>
        {label}
        <TriggerButton binding={c.onBinding} label="On" interactive={interactive} />
        <TriggerButton binding={c.offBinding} label="Off" interactive={interactive} />
      </Frame>
    );
  }
  return (
    <Frame type={c.type} state="unavailable" ts={ts} bound={false} style={{ alignItems: "center", gap: "0.5em" }}>
      {label}
    </Frame>
  );
}

function PresetsObject({ c, interactive, ts }: { c: Of<"qsys-presets">; interactive: boolean; ts: CSSProperties }) {
  const state = useQsysStates([...c.items.map((i) => i.binding), ...(c.previous ? [c.previous] : [])].map(ADDR), true);
  return (
    <Frame type={c.type} state={state} ts={ts} bound={c.items.length > 0} style={{ padding: "0.3em" }}>
      {c.items.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(6em, 1fr))", gap: 8, width: "100%", alignContent: "start" }}>
          {c.items.map((item, i) => (
            <TriggerButton key={i} binding={item.binding} label={item.label} interactive={interactive} style={{ minHeight: 52 }} />
          ))}
          {c.previous && <TriggerButton binding={c.previous} label="Previous" interactive={interactive} muted style={{ minHeight: 52 }} />}
        </div>
      )}
    </Frame>
  );
}

function SelectorRow({ label, selected, disabled, onPick, children }: { label: string; selected: boolean; disabled: boolean; onPick: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onPick}
      style={{
        ...BUTTON,
        display: "flex",
        alignItems: "center",
        gap: 8,
        textAlign: "left",
        borderRadius: 10,
        border: `1px solid ${selected ? "var(--color-accent)" : "var(--color-line)"}`,
        background: selected ? "var(--color-surface-raised)" : "transparent",
        color: "var(--color-fg)",
        fontWeight: selected ? 600 : 400,
      }}
    >
      <span style={{ flexGrow: 1 }}>{label}</span>
      {selected && (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12l5 5L20 7" />
        </svg>
      )}
      {children}
    </button>
  );
}

function SelectorItem({ item, interactive }: { item: { label: string; binding: QsysBinding }; interactive: boolean }) {
  const addr = ADDR(item.binding);
  const v = useQsysValue(addr);
  const info = useQsysControl(addr);
  const lit = useLit(item.binding);
  const [flash, doFlash] = useFlash();
  const write = useQsysWrite();
  const canInput = interactive && v.state === "live" && info.allowed;
  return (
    <SelectorRow
      label={item.label}
      selected={lit === true || flash}
      disabled={!canInput}
      onPick={() => {
        if (!canInput) return;
        void write(addr!, true, { final: true }).then((r) => {
          if (r.ok && lit === null) doFlash();
        });
      }}
    />
  );
}

function SelectorObject({ c, interactive, ts }: { c: Of<"qsys-selector">; interactive: boolean; ts: CSSProperties }) {
  const addr = ADDR(c.binding);
  const v = useQsysValue(addr);
  const info = useQsysControl(addr);
  const write = useQsysWrite();
  const items = c.items;
  const state = useQsysStates(items.length ? items.map((i) => ADDR(i.binding)) : [addr], true);
  const canInput = interactive && state === "live";
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!c.binding || items.length > 0} style={{ flexDirection: "column", gap: 8, padding: "0.3em" }}>
      <div role="radiogroup" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.length > 0 ? (
          items.map((item, i) => <SelectorItem key={i} item={item} interactive={interactive} />)
        ) : info.choices && info.choices.length > 0 ? (
          info.choices.map((choice) => (
            <SelectorRow
              key={choice}
              label={choice}
              selected={v.state !== "unavailable" && v.string === choice}
              disabled={!canInput}
              onPick={() => canInput && void write(addr!, choice, { final: true })}
            />
          ))
        ) : c.binding ? (
          <span style={{ fontSize: "0.6em" }}>{v.string || "–"}</span>
        ) : null}
      </div>
    </Frame>
  );
}

function LabelObject({ c, ts }: { c: Of<"qsys-label">; ts: CSSProperties }) {
  const v = useQsysValue(ADDR(c.binding));
  // The editor's text wins when set; otherwise the Core's.
  const text = c.text.trim() ? c.text : v.string;
  const state = c.text.trim() ? (c.binding ? v.state : "live") : v.state;
  return (
    <Frame type={c.type} state={state === "unavailable" && c.text.trim() ? "live" : state} ts={ts} bound={!!c.binding || !!c.text.trim()} style={{ alignItems: "center", padding: "0 0.3em" }}>
      <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text || (c.binding ? "–" : "Label")}</span>
    </Frame>
  );
}

function StripObject({ c, interactive, ts }: { c: Of<"qsys-strip">; interactive: boolean; ts: CSSProperties }) {
  const name = useQsysValue(ADDR(c.name));
  const mute = useQsysValue(ADDR(c.mute));
  const muted = mute.state !== "unavailable" && truthy(mute.value);
  const gainState = useQsysWriteState(ADDR(c.gain), true);
  const muteState = useQsysWriteState(ADDR(c.mute));
  const state = combine(...[c.gain && gainState, c.mute && muteState].filter((s): s is QsysState => !!s), c.gain || c.mute ? "live" : "unavailable");
  const title = c.label.trim() || name.string || "–";
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!(c.gain || c.mute || c.meter || c.meter2)} style={{ flexDirection: "column", alignItems: "center", gap: "0.3em", padding: "0.3em" }}>
      <div style={{ fontSize: "0.6em", fontWeight: 500, textAlign: "center", lineHeight: 1.25, minHeight: "2.5em" }}>{title}</div>
      {c.gain ? (
        <Fader binding={c.gain} vertical showDb steps={false} stepDb={0} interactive={interactive} muted={muted} meters={[c.meter, c.meter2]} />
      ) : (
        <div style={{ flex: 1, display: "flex", gap: 4 }}>{[c.meter, c.meter2].filter((m): m is QsysBinding => !!m).map((m, i) => <MeterBar key={i} binding={m} vertical />)}</div>
      )}
      {c.mute && <MuteButton binding={c.mute} interactive={interactive} />}
    </Frame>
  );
}

function StatusObject({ ts }: { ts: CSSProperties }) {
  const conn = useQsysPanelState().connection;
  const [colour, text] =
    conn === "connected"
      ? ["var(--color-ok-9)", "Connected"]
      : conn === "reconnecting"
        ? ["var(--color-warn-9)", "Reconnecting… controls held"]
        : ["var(--color-danger-9)", "Offline"];
  return (
    <Frame type="qsys-status" state={conn === "connected" ? "live" : "offline"} ts={ts} dims={false} style={{ alignItems: "center", gap: 8, padding: "0 0.3em" }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: colour, flex: "0 0 auto" }} />
      <span data-connection={conn} style={{ fontSize: "0.6em" }}>
        {text}
      </span>
    </Frame>
  );
}

function Body({ config, interactive, ts }: { config: QsysConfig; interactive: boolean; ts: CSSProperties }) {
  switch (config.type) {
    case "qsys-fader":
      return <FaderObject c={config} interactive={interactive} ts={ts} />;
    case "qsys-meter":
      return <MeterObject c={config} ts={ts} />;
    case "qsys-mute":
      return <MuteObject c={config} interactive={interactive} ts={ts} />;
    case "qsys-button":
      return <ButtonObject c={config} interactive={interactive} ts={ts} />;
    case "qsys-switch":
      return <SwitchObject c={config} interactive={interactive} ts={ts} />;
    case "qsys-presets":
      return <PresetsObject c={config} interactive={interactive} ts={ts} />;
    case "qsys-selector":
      return <SelectorObject c={config} interactive={interactive} ts={ts} />;
    case "qsys-label":
      return <LabelObject c={config} ts={ts} />;
    case "qsys-strip":
      return <StripObject c={config} interactive={interactive} ts={ts} />;
    case "qsys-status":
      return <StatusObject ts={ts} />;
  }
}

/**
 * A Q-SYS object on the panel `panelId` (the View that holds it). Writes only
 * where `interactive` (a live display route), never in the editor or a preview.
 * With no panel (Home, a bare preview) it reads Unavailable and watches nothing.
 */
export function QsysObject({ config, panelId, interactive, ts }: { config: QsysConfig; panelId: string | null; interactive: boolean; ts: CSSProperties }) {
  const panel = useQsysPanel(panelId);
  return (
    <QsysPanelContext.Provider value={panel}>
      <Body config={config} interactive={interactive} ts={ts} />
    </QsysPanelContext.Provider>
  );
}
