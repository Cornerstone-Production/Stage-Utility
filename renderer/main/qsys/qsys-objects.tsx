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

import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { isOn, kindOf, type PanelKind, type QsysAddress, type QsysBinding, type QsysDensity } from "@main/types/qsys";
import type { LayoutObjectConfig } from "@main/types/views";
import { bindGesture, type GestureHandle } from "../../lib/pointer-gesture";
import { LEASE_EXPIRE_MS, LEASE_RENEW_MS } from "@main/services/qsys/qsys-leases";
import { atBottom, faderScale, meterLevel, stepFrom, TICK_MARKS_DB, travelOf, valueAt, type FaderScale } from "./fader-scale";
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
  type QsysPanelState,
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


/**
 * A Boolean, by the rule the writer and the editor use (kindOf). The catalog's
 * Type decides once read; only before that does the value's own type. Not both:
 * a trigger's read-back can be `true`, and a trigger lit by it would stay lit.
 */
const isBooleanControl = (info: QsysControlInfo, value: unknown) => kindOf(info.type ? { Type: info.type } : { Value: value }) === "boolean";

/** "-12.0", "+3.5", "0.0": a level as the readout shows it, in Plex Mono. */
export function formatDb(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "–";
  const s = v.toFixed(1);
  return v > 0 ? `+${s}` : s === "-0.0" ? "0.0" : s;
}

const MONO: CSSProperties = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };

/** The Core lit this from its own value or its indicator; null when it reports no state. */
function useLit(b: QsysBinding | null | undefined): boolean | null {
  const own = useQsysValue(b ?? null);
  const indicator = useQsysValue(b?.indicator ?? null);
  const info = useQsysControl(b ?? null);
  if (b?.indicator) return indicator.state === "unavailable" ? null : isOn(indicator.value);
  if (own.state === "unavailable") return null;
  return isBooleanControl(info, own.value) ? isOn(own.value) : null;
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

/** A press held down: no pan, no text selection, no iOS callout may take the pointer. */
const HELD: CSSProperties = { touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" };

function litStyle(lit: boolean): CSSProperties {
  return {
    border: `1px solid ${lit ? "var(--color-accent)" : "var(--color-line)"}`,
    background: lit ? "var(--color-accent)" : "transparent",
    color: lit ? "var(--color-on-accent)" : "var(--color-fg)",
    fontWeight: lit ? 600 : 400,
  };
}

/**
 * A press: a trigger fired on a tap, or after the full hold when `hold`; with
 * `onRelease`, a momentary, whose release is the gesture's second write.
 *
 * Nothing here outlives a break. A hide, a drop or the Core going away (a new
 * panel epoch) ends a hold in progress, and a hold or a release whose press
 * started before the break never writes: the panel is read again first, and only
 * a fresh press writes after that.
 */
function PressButton({
  hold,
  disabled,
  lit,
  label,
  holdLabel,
  onFire,
  onRelease,
  style,
}: {
  hold: boolean;
  disabled: boolean;
  lit: boolean;
  label: ReactNode;
  holdLabel: string;
  onFire: () => void;
  /** A momentary: called when the press that fired ends, if nothing broke meanwhile. */
  onRelease?: () => void;
  style?: CSSProperties;
}) {
  const panel = useQsysPanelContext();
  const { epoch } = useQsysPanelState();
  // The epoch the hold in progress began in; holding only while it is still current.
  const [holdEpoch, setHoldEpoch] = useState<number | null>(null);
  const holding = holdEpoch !== null && holdEpoch === epoch && !disabled;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef<GestureHandle | null>(null);
  /** The press that fired and has not been released: its epoch. */
  const fired = useRef<number | null>(null);
  /** What is pressing it now. One press at a time: a second finger, or a key while a
   *  finger is down, is ignored, so it cannot restart the hold or end the first press. */
  const owner = useRef<"pointer" | "key" | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);

  const clearHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      gesture.current?.cancel();
      clearHold();
    },
    [],
  );
  // A break, or going disabled, ends the hold: its timer never completes into a write.
  useEffect(() => {
    if (!holding) clearHold();
  }, [holding]);
  useEffect(() => {
    // The fill grows over the hold. Web Animations, so the length is the hold itself
    // rather than a motion token: it is a countdown, not an ornament.
    if (holding && bar.current && typeof bar.current.animate === "function") {
      bar.current.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: HOLD_MS, easing: "linear", fill: "forwards" });
    }
  }, [holding]);

  const fire = (at: number) => {
    // Only if nothing broke since the press began.
    if (!panel || panel.epoch !== at) return;
    fired.current = at;
    onFire();
  };
  const release = () => {
    const at = fired.current;
    fired.current = null;
    if (at !== null && onRelease && panel && panel.epoch === at) onRelease();
  };
  /** Start a press by `by`; false when one is already in progress. */
  const begin = (by: "pointer" | "key"): boolean => {
    if (disabled || !panel || owner.current) return false;
    owner.current = by;
    const at = panel.epoch;
    if (!hold) {
      // Only a momentary acts on the press itself; a plain trigger fires on click.
      if (onRelease) fire(at);
      return true;
    }
    setHoldEpoch(at);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHoldEpoch(null);
      fire(at);
    }, HOLD_MS);
    return true;
  };
  /** End the press `by` started; a different source's end is ignored. */
  const end = (by: "pointer" | "key") => {
    if (owner.current !== by) return;
    owner.current = null;
    gesture.current = null;
    clearHold();
    setHoldEpoch(null);
    release();
  };

  // Going disabled mid-press (the allowlist re-read drops it, the panel stops being
  // live) ends the press: a disabled button hears no keyup, and a browser need not
  // blur it, so a key-held momentary would otherwise stay pressed, and renewed, for good.
  const endOnDisable = useEffectEvent(() => {
    if (!owner.current) return;
    gesture.current?.cancel();
    end(owner.current);
  });
  useEffect(() => {
    if (disabled) endOnDisable();
  }, [disabled]);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || (!hold && !onRelease)) return;
    const el = e.currentTarget;
    if (!begin("pointer")) return;
    gesture.current = bindGesture(el, e.pointerId, {
      // Sliding off the button lets go of it, as lifting the finger does.
      move: (ev) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)) {
          gesture.current?.cancel();
          end("pointer");
        }
      },
      end: () => end("pointer"),
    });
  };
  const isKey = (key: string) => key === " " || key === "Enter";
  return (
    <button
      type="button"
      aria-pressed={lit}
      disabled={disabled}
      data-holding={holding || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (!isKey(e.key) || e.repeat || (!hold && !onRelease)) return;
        e.preventDefault();
        begin("key");
      }}
      onKeyUp={(e) => {
        if (!isKey(e.key) || (!hold && !onRelease)) return;
        e.preventDefault();
        end("key");
      }}
      // Focus leaving mid-press means its keyup never comes here: let go now.
      onBlur={() => end("key")}
      onClick={() => {
        if (!hold && !onRelease && !disabled && panel) fire(panel.epoch);
      }}
      style={{
        ...BUTTON,
        // A press that lasts (a hold, a momentary) must not be taken by a pan: the
        // browser would cancel the pointer, and end the press, with the finger down.
        ...(hold || onRelease ? HELD : {}),
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

/** The kit's words while a hold runs: "Keep holding to save…". */
const holdWords = (label: string) => `Keep holding to ${label.trim().toLowerCase() || "confirm"}…`;

/** A renewal that got no answer is tried again this soon, while the lease has time left. */
const RENEW_RETRY_MS = 300;

/** A momentary press being renewed. */
interface LeasedPress {
  interval: ReturnType<typeof setInterval> | null;
  retry: ReturnType<typeof setTimeout> | null;
  /** The press's own write has answered: from then on, "not held" means the lease is gone. */
  wrote: boolean;
  /** The server refused the press (no-lease among the reasons): nothing was sent, nothing to release. */
  refused: boolean;
  /** When the server last said it holds the lease (at first, the press). */
  heldAt: number;
}

/**
 * A momentary's lease, renewed while the press is held: the server lets go of the
 * control itself if the renewals stop (qsys-leases.ts). Renewed while the press
 * is held, nothing broke and the panel is live; only this press's release, a
 * break, the panel going offline, a refused press, or the server saying (after
 * the press answered) that it holds no lease stops it. A renewal with no answer is
 * retried while the lease still has time.
 */
function useLeasedPress(binding: QsysAddress) {
  const panel = useQsysPanelContext();
  const { epoch } = useQsysPanelState();
  const renewing = useRef<LeasedPress | null>(null);
  const last = useRef<LeasedPress | null>(null);
  const stop = () => {
    const p = renewing.current;
    if (!p) return;
    if (p.interval) clearInterval(p.interval);
    if (p.retry) clearTimeout(p.retry);
    renewing.current = null;
  };
  useEffect(() => stop, []);
  // A break stops the renewals; the server's lease then lapses and it releases the control.
  useEffect(() => stop(), [epoch]);

  return {
    /** A press is being sent now: renew its lease until it ends. */
    start(): LeasedPress | null {
      if (!panel) return null;
      stop();
      const at = panel.epoch;
      const press: LeasedPress = { interval: null, retry: null, wrote: false, refused: false, heldAt: Date.now() };
      const renew = () => {
        if (renewing.current !== press) return;
        if (panel.epoch !== at || !panel.live) return stop();
        // Before the press has answered, "not held" only means the lease is not taken yet.
        const afterWrite = press.wrote;
        void panel.renewLease(binding).then((answer) => {
          // Released, or pressed again since: this answer is about a press that is over.
          if (renewing.current !== press) return;
          if (answer === "held") press.heldAt = Date.now();
          else if (answer === "not-held") {
            if (afterWrite) stop();
          } else if (!press.retry && Date.now() - press.heldAt < LEASE_EXPIRE_MS - RENEW_RETRY_MS) {
            press.retry = setTimeout(() => {
              press.retry = null;
              renew();
            }, RENEW_RETRY_MS);
          }
        });
      };
      press.interval = setInterval(renew, LEASE_RENEW_MS);
      renewing.current = last.current = press;
      return press;
    },
    /** The press's own write answered. Refused, there is no lease to renew. */
    answered(press: LeasedPress, ok: boolean): void {
      press.wrote = true;
      press.refused = !ok;
      if (!ok && renewing.current === press) stop();
    },
    /** The press ended. False when the last press is known refused: it sent nothing, so there is nothing to release. */
    release(): boolean {
      stop();
      return !last.current?.refused;
    },
  };
}

/**
 * One trigger, preset or option: lit from the Core, flashed on a confirmed write
 * when it has no state. A button saved as `momentary` is true while pressed and
 * false on release, decided from that saved press alone (never from the catalog,
 * which may not be read yet): its press asks for a lease, and the server refuses a
 * press it cannot hold (`no-lease`), leaving the button unlit.
 */
function TriggerButton({
  binding,
  label,
  interactive,
  hold,
  momentary = false,
  style,
  muted,
}: {
  binding: QsysBinding;
  label: string;
  interactive: boolean;
  hold?: boolean;
  momentary?: boolean;
  style?: CSSProperties;
  muted?: boolean;
}) {
  const v = useQsysValue(binding);
  const info = useQsysControl(binding);
  const writeState = useQsysWriteState(binding);
  const lit = useLit(binding);
  const [flash, doFlash] = useFlash();
  const write = useQsysWrite();
  const boolean = isBooleanControl(info, v.value);
  const canInput = interactive && writeState === "live";
  const leased = useLeasedPress(binding);

  return (
    <PressButton
      hold={!!hold || info.hold}
      disabled={!canInput}
      lit={lit === true || flash}
      label={label}
      holdLabel={holdWords(label)}
      onFire={() => {
        const press = momentary ? leased.start() : null;
        void write(binding, true, { final: true, lease: momentary }).then((r) => {
          if (press) leased.answered(press, r.ok);
          // A pure trigger reports no state: show the confirmed write as a flash, never as lit.
          if (r.ok && !momentary && (lit === null || !boolean)) doFlash();
        });
      }}
      onRelease={
        momentary
          ? () => {
              if (leased.release()) void write(binding, false, { final: true });
            }
          : undefined
      }
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
  /** One step of the -/+ buttons and the arrow keys, in dB. */
  stepDb: number;
  interactive: boolean;
  /** What a screen reader calls it. */
  name: string;
  /** Drawn as the strip's mute does: a muted channel's fill and thumb go quiet. */
  muted?: boolean;
  meters?: (QsysBinding | null | undefined)[];
  density?: QsysDensity;
  /** Where the dB readout sits: above the track (Main) or below it (Staff). */
  readout?: "above" | "below";
}

/**
 * A fader's input: the drag, the steps, and the value the finger holds on screen.
 *
 * A drag is relative (touching the track moves nothing; only movement does),
 * writes at most once per DRAG_COALESCE_MS, and always sends its last value as
 * the final write. The thumb holds the finger's value until that final write has
 * answered, then shows the Core's. A break (the stream dropped, the page hid, the
 * Core went away) ends a drag in progress and lets go of the finger's value, even
 * with a release still out. A refusal snaps the thumb back to the Core's value.
 */
function useFaderDrag({
  addr,
  core,
  scale,
  writable,
  vertical,
  stepDb,
}: {
  addr: QsysAddress | null;
  /** The Core's value, when it is a number. */
  core: number | null;
  scale: FaderScale | null;
  writable: boolean;
  vertical: boolean;
  stepDb: number;
}) {
  const panel = useQsysPanelContext();
  const { epoch } = useQsysPanelState();
  const write = useQsysWrite();
  const track = useRef<HTMLDivElement | null>(null);
  const [local, setLocal] = useState<number | null>(null);
  const drag = useRef<{ epoch: number; gesture: GestureHandle; moved: boolean; last: number } | null>(null);
  /** Releases whose final write has not answered: the thumb holds the finger's value until they have. */
  const pendingFinals = useRef(0);
  /** Bumped by a break: a release answered after it no longer speaks for the thumb. */
  const finalGen = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      drag.current?.gesture.cancel();
    };
  }, []);

  // A break lets go of the finger's value: the fader shows the Core's once the panel is read again.
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (epoch !== seenEpoch) {
    setSeenEpoch(epoch);
    setLocal(null);
  }
  useEffect(() => {
    const d = drag.current;
    if (d && epoch !== d.epoch) {
      d.gesture.cancel();
      drag.current = null;
    }
    finalGen.current++;
    pendingFinals.current = 0;
  }, [epoch]);

  const norm = (x: number) => (scale ? travelOf(scale, x) : 0);
  // What is on screen: the finger's value while a gesture is open, else the Core's.
  const shown = local ?? core;

  const snapBack = () => {
    drag.current?.gesture.cancel();
    drag.current = null;
    if (mounted.current) setLocal(null);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!writable || !panel || drag.current || shown === null) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = track.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const length = vertical ? rect.height : rect.width;
    // jsdom lays nothing out; a real browser always has a length here.
    if (!(length > 0)) return;
    // From the value on screen, not the Core's last report: after a release the
    // thumb stays where the finger left it until the Core answers, and a second
    // touch in that moment must not jump back to the old value.
    const startValue = shown;
    const startNorm = norm(startValue);
    const s = scale!;
    const startAt = vertical ? e.clientY : e.clientX;
    const at = panel.epoch;
    // Relative: touching the track does not move the value. Only movement does.
    const gesture = bindGesture(e.currentTarget, e.pointerId, {
      move: (ev) => {
        const d = drag.current;
        if (!d || panel.epoch !== d.epoch) return;
        const moved = vertical ? startAt - ev.clientY : ev.clientX - startAt;
        const n = Math.min(1, Math.max(0, startNorm + moved / length));
        const next = Math.round(valueAt(s, n) * 100) / 100;
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
          if (mounted.current && pendingFinals.current === 0) setLocal(null);
          return;
        }
        // The release always sends the last value, marked final.
        pendingFinals.current++;
        const gen = finalGen.current;
        void write(addr!, d.last, { final: true }).then(() => {
          if (gen !== finalGen.current) return; // a break came first: the thumb is the Core's again
          pendingFinals.current--;
          // A landed write's read-back is already in the panel; a refusal shows the Core's value.
          if (mounted.current && drag.current === null && pendingFinals.current === 0) setLocal(null);
        });
      },
    });
    drag.current = { epoch: at, gesture, moved: false, last: startValue };
  };

  /** A step from the value on screen: the -/+ buttons and the arrow keys. */
  const step = (dir: 1 | -1) => {
    if (!writable || shown === null || drag.current || !scale) return;
    const next = stepFrom(scale, shown, dir, stepDb > 0 ? stepDb : 1);
    if (next === shown) return;
    void write(addr!, Math.round(next * 100) / 100, { final: true });
  };

  return { track, shown, norm, onPointerDown, step };
}

/** The arrow keys a slider steps on, and which way. */
const ARROW_STEP: Record<string, 1 | -1> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };

function Fader({ binding, vertical, showDb, steps, stepDb, interactive, name, muted = false, meters = [], density = "standard", readout = "above" }: FaderProps) {
  const addr = binding;
  const v = useQsysValue(addr);
  const info = useQsysControl(addr);
  const writeState = useQsysWriteState(addr, true);

  const dense = density === "dense";
  const range = info.range;
  // The fader's own scale (fader-scale.ts): linear in dB from -60 (or the allowlist's
  // minimum) to the allowlist's maximum, the Core's minimum at the bottom stop.
  const scale = faderScale(range, info.limits);
  const writable = interactive && writeState === "live" && typeof v.value === "number" && scale !== null;
  const { track, shown, norm, onPointerDown, step } = useFaderDrag({
    addr,
    core: typeof v.value === "number" ? v.value : null,
    scale,
    writable,
    vertical,
    stepDb,
  });

  const level = shown === null ? (v.position ?? 0) : scale ? norm(shown) : (v.position ?? 0);
  // The allowlist's limit is the top of travel; marked there when it stops short of the Core's own.
  const limitAt = scale && range && scale.top < range.max ? 1 : null;
  const atLimit = scale !== null && shown !== null && limitAt !== null && shown >= scale.top - 1e-6;
  const offline = v.state === "offline";

  // The thumb in px, as the mockups draw it: Main 48 x 40 r10, Staff 28 x 24 r6.
  const thumbAlong = dense ? 24 : 40;
  const thumbAcross = dense ? 28 : 48;
  const trackWidth = dense ? 4 : 8;
  const limitAcross = dense ? 20 : 32;
  const along = (n: number) => `calc((100% - ${thumbAlong}px) * ${1 - n})`;
  const fill = offline || muted ? "var(--color-fg-subtle)" : "var(--color-accent)";

  const faderBody = (
    <div
      ref={track}
      data-fader
      data-at-limit={atLimit || undefined}
      role="slider"
      aria-label={name}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={scale ? scale.bottom : undefined}
      aria-valuemax={scale ? scale.top : undefined}
      aria-valuenow={shown ?? undefined}
      aria-valuetext={shown === null ? undefined : scale && atBottom(scale, shown) ? "-inf dB" : `${formatDb(shown)} dB`}
      aria-disabled={writable ? undefined : true}
      tabIndex={writable ? 0 : -1}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        const dir = ARROW_STEP[e.key];
        if (!dir) return;
        e.preventDefault();
        step(dir);
      }}
      style={{
        position: "relative",
        flex: "1 1 auto",
        minWidth: vertical ? 44 : 0,
        minHeight: vertical ? 0 : 44,
        touchAction: "none",
        cursor: writable ? "grab" : "default",
      }}
    >
      {dense && vertical && scale && (
        <div aria-hidden style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "1.8em", ...MONO, fontSize: 9, color: "var(--color-fg-subtle)" }}>
          {TICK_MARKS_DB.filter((t) => t >= scale.floor && t <= scale.top).map((t) => (
            <span key={t} data-tick style={{ position: "absolute", left: 0, top: `calc(${along(norm(t))} + ${thumbAlong / 2}px)`, transform: "translateY(-50%)" }}>
              {t > 0 ? `+${t}` : t}
            </span>
          ))}
        </div>
      )}
      {/* the track and its fill */}
      <div
        style={{
          position: "absolute",
          borderRadius: trackWidth / 2,
          background: "var(--color-fill-active)",
          overflow: "hidden",
          ...(vertical
            ? { left: `calc(50% - ${trackWidth / 2}px)`, width: trackWidth, top: 0, bottom: 0 }
            : { top: `calc(50% - ${trackWidth / 2}px)`, height: trackWidth, left: 0, right: 0 }),
        }}
      >
        <div
          style={{
            position: "absolute",
            background: fill,
            opacity: muted && !offline ? 0.5 : 1,
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
            // Across the track, as Main draws it: 32 px centred on it (20 px on a dense strip).
            ...(vertical
              ? { height: 2, width: limitAcross, left: `calc(50% - ${limitAcross / 2}px)`, top: `calc(${along(limitAt)} + ${thumbAlong / 2}px)` }
              : { width: 2, height: limitAcross, top: `calc(50% - ${limitAcross / 2}px)`, right: `calc(${along(limitAt)} + ${thumbAlong / 2}px)` }),
          }}
        />
      )}
      {/* No value from the Core at all: no thumb, rather than one parked at the bottom. */}
      {shown !== null && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            borderRadius: dense ? 6 : 10,
            // Opaque: the fill and the limit line must not show through the thumb.
            background: offline ? "var(--color-fg-subtle)" : muted ? "var(--color-surface-raised)" : "var(--color-fg-strong)",
            border: "1px solid var(--color-line-strong)",
            boxShadow: atLimit ? "0 0 0 2px var(--color-warn-9)" : dense ? undefined : "var(--su-shadow-1)",
            pointerEvents: "none",
            ...(vertical
              ? { height: thumbAlong, width: `min(${thumbAcross}px, 100%)`, left: `calc((100% - min(${thumbAcross}px, 100%)) / 2)`, top: along(level) }
              : { width: thumbAlong, height: `min(${thumbAcross}px, 100%)`, top: `calc((100% - min(${thumbAcross}px, 100%)) / 2)`, right: along(level) }),
          }}
        />
      )}
    </div>
  );

  const meterBars = meters.filter((m): m is QsysBinding => !!m).map((m, i) => <MeterBar key={i} binding={m} vertical={vertical} thin={dense} scale={scale} />);
  const db = showDb && (
    <span data-db style={{ ...MONO, fontSize: dense ? 12 : "0.5em", color: atLimit ? "var(--color-warn-9)" : "var(--color-fg-muted)", minHeight: "1.2em" }}>
      {muted ? (dense ? "mute" : "Muted") : shown !== null && scale && atBottom(scale, shown) ? "-inf" : formatDb(shown)}
    </span>
  );

  return (
    <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center", gap: "0.3em", flex: "1 1 auto", minHeight: 0, minWidth: 0, width: vertical ? "100%" : undefined }}>
      {readout === "above" && db}
      {steps && <StepButton label="+" onPress={() => step(1)} disabled={!writable} />}
      <div style={{ display: "flex", flexDirection: vertical ? "row" : "column", gap: dense ? 2 : 4, flex: "1 1 auto", alignSelf: "stretch", minHeight: 0, minWidth: 0, justifyContent: "center" }}>
        {faderBody}
        {meterBars}
      </div>
      {steps && <StepButton label="−" onPress={() => step(-1)} disabled={!writable} />}
      {readout === "below" && db}
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

/**
 * A meter bar, drawn by the panel's animation loop straight into the element. A
 * frame sets only what changed: the bar's scale (a transform, so no layout), and
 * its colour only when it crosses into another band. On a Pi with a full staff
 * panel this loop is most of the page's work.
 */
function MeterBar({ binding, vertical, thin = false, scale = null }: { binding: QsysBinding; vertical: boolean; thin?: boolean; scale?: FaderScale | null }) {
  const panel = useQsysPanelContext();
  const { component, control } = binding;
  const bar = useRef<HTMLDivElement | null>(null);
  /** What the element shows now. */
  const drawn = useRef<{ level: number; band: string } | null>(null);
  // The scale's numbers, not the object: a new object each render would resubscribe the sink.
  const bottom = scale?.bottom;
  const floor = scale?.floor;
  const top = scale?.top;
  useEffect(() => {
    if (!panel) return;
    const on = bottom !== undefined && floor !== undefined && top !== undefined ? { bottom, floor, top } : null;
    drawn.current = null;
    return panel.addMeterSink({ component, control }, (r) => meterLevel(r, on), {
      draw: (level) => {
        const el = bar.current;
        if (!el) return;
        const was = drawn.current;
        if (was?.level === level) return;
        el.style.transform = `${vertical ? "scaleY" : "scaleX"}(${level})`;
        const band = bandColour(level);
        if (was?.band !== band) el.style.background = band;
        drawn.current = { level, band };
      },
    });
  }, [panel, component, control, bottom, floor, top, vertical]);
  return (
    <div
      data-meter
      style={{
        position: "relative",
        flex: "0 0 auto",
        // Main draws 6 px meters, Staff 5 px.
        borderRadius: thin ? 0 : 3,
        background: "var(--color-fill-active)",
        overflow: "hidden",
        ...(vertical ? { width: thin ? 5 : 6, alignSelf: "stretch" } : { height: thin ? 5 : 6, alignSelf: "stretch" }),
      }}
    >
      <div data-meter-bar ref={bar} style={{ position: "absolute", inset: 0, transformOrigin: vertical ? "bottom" : "left", transform: vertical ? "scaleY(0)" : "scaleX(0)", willChange: "transform" }} />
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
  const state = useQsysWriteState(c.binding, true);
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!c.binding} style={{ padding: "0.3em" }}>
      <Fader
        binding={c.binding}
        vertical={c.orientation !== "horizontal"}
        showDb={c.showDb}
        steps={c.steps}
        stepDb={c.stepDb}
        interactive={interactive}
        name={c.binding ? `${c.binding.component} ${c.binding.control}` : "Fader"}
        density={c.density}
      />
    </Frame>
  );
}

function MeterObject({ c, ts }: { c: Of<"qsys-meter">; ts: CSSProperties }) {
  const a = useQsysValue(c.binding ?? null);
  const b = useQsysValue(c.binding2 ?? null);
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

/**
 * Mute, as Kit and Main draw it: 48 px high, 84 wide, "Mute" / "Muted". Dense is
 * Staff's 64 x 36 "M", inside a 44 px tall hit area; its state is still in words
 * for a screen reader, and in the strip's readout ("mute").
 */
function MuteButton({ binding, interactive, dense = false }: { binding: QsysBinding | null; interactive: boolean; dense?: boolean }) {
  const addr = binding;
  const v = useQsysValue(addr);
  const writeState = useQsysWriteState(addr);
  const write = useQsysWrite();
  const muted = v.state !== "unavailable" && isOn(v.value);
  const canInput = interactive && writeState === "live";
  const look: CSSProperties = {
    borderRadius: dense ? 8 : 12,
    fontWeight: dense ? 600 : 500,
    border: `1px solid ${muted ? "var(--color-danger-9)" : "var(--color-line-strong)"}`,
    background: muted ? "var(--color-danger-9)" : "transparent",
    color: muted ? "var(--color-on-accent)" : dense ? "var(--color-fg-muted)" : "var(--color-fg)",
  };
  return (
    <button
      type="button"
      data-mute
      aria-pressed={muted}
      aria-label={dense ? (muted ? "Muted" : "Mute") : undefined}
      disabled={!canInput}
      onClick={() => {
        // The new state is the Core's state flipped; shown only once the Core says so.
        if (canInput) void write(addr!, !muted, { final: true });
      }}
      style={
        dense
          ? { ...BUTTON, padding: 0, border: 0, background: "transparent", minHeight: 44, width: 64, display: "flex", alignItems: "center", justifyContent: "center" }
          : { ...BUTTON, ...look, minHeight: 48, minWidth: 84 }
      }
    >
      {dense ? (
        <span aria-hidden style={{ ...look, width: 64, height: 36, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, boxSizing: "border-box" }}>
          M
        </span>
      ) : muted ? (
        // Words, not only a colour.
        "Muted"
      ) : (
        "Mute"
      )}
    </button>
  );
}

function MuteObject({ c, interactive, ts }: { c: Of<"qsys-mute">; interactive: boolean; ts: CSSProperties }) {
  const state = useQsysWriteState(c.binding ?? null);
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!c.binding} style={{ alignItems: "center", justifyContent: "center" }}>
      <MuteButton binding={c.binding} interactive={interactive} />
    </Frame>
  );
}

function ButtonObject({ c, interactive, ts }: { c: Of<"qsys-button">; interactive: boolean; ts: CSSProperties }) {
  const state = useQsysWriteState(c.binding ?? null);
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!c.binding} style={{ alignItems: "stretch", justifyContent: "stretch" }}>
      {c.binding && (
        // A saved momentary is on while pressed, off on release; absent is a trigger.
        <TriggerButton binding={c.binding} label={c.label || c.binding.control} interactive={interactive} hold={c.hold} momentary={c.press === "momentary"} style={{ flex: 1 }} />
      )}
    </Frame>
  );
}

/** `name` is what a screen reader calls it: never empty (the label, else the control). */
function SwitchTrack({ on, disabled, onPress, name }: { on: boolean; disabled: boolean; onPress: () => void; name: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
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
  const own = useQsysValue(c.binding ?? null);
  const ownState = useQsysWriteState(c.binding ?? null);
  const pairState = useQsysStates([c.onBinding ?? null, c.offBinding ?? null], true);
  const pairLit = useLit(c.onBinding);
  const label = <span style={{ fontSize: "0.6em", fontWeight: 500 }}>{c.label}</span>;
  // The editor's label, else the control it switches: a switch is never announced as just "switch".
  const name = c.label.trim() || (c.binding ?? c.onBinding)?.control || "Switch";

  if (c.binding) {
    const on = own.state !== "unavailable" && isOn(own.value);
    const canInput = interactive && ownState === "live";
    return (
      <Frame type={c.type} state={ownState} ts={ts} style={{ alignItems: "center", gap: "0.5em", padding: "0.3em" }}>
        <SwitchTrack on={on} disabled={!canInput} name={name} onPress={() => canInput && void write(c.binding!, !on, { final: true })} />
        {label}
      </Frame>
    );
  }
  if (c.onBinding && c.offBinding) {
    if (pairLit !== null) {
      // The Core reports which way it is (an indicator on the On trigger): one switch.
      const target = pairLit ? c.offBinding : c.onBinding;
      const canInput = interactive && pairState === "live";
      return (
        <Frame type={c.type} state={pairState} ts={ts} style={{ alignItems: "center", gap: "0.5em", padding: "0.3em" }}>
          <SwitchTrack on={pairLit} disabled={!canInput} name={name} onPress={() => canInput && void write(target, true, { final: true })} />
          {label}
        </Frame>
      );
    }
    // No readable state: two triggers, neither lit, each flashing when the Core confirms it.
    return (
      <Frame type={c.type} state={pairState} ts={ts} style={{ alignItems: "center", gap: "0.4em", padding: "0.3em" }}>
        {label}
        <TriggerButton binding={c.onBinding} label={c.onLabel?.trim() || "On"} interactive={interactive} />
        <TriggerButton binding={c.offBinding} label={c.offLabel?.trim() || "Off"} interactive={interactive} />
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
  const state = useQsysStates([...c.items.map((i) => i.binding), ...(c.previous ? [c.previous] : [])], true);
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
      {/* The check sits right after the words, as the kit and Main draw it. */}
      <span>{label}</span>
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
  const addr = item.binding;
  // Read-only on the Core, or off the allowlist: Unavailable, as every other writing object.
  const writeState = useQsysWriteState(addr);
  const lit = useLit(item.binding);
  const [flash, doFlash] = useFlash();
  const write = useQsysWrite();
  const canInput = interactive && writeState === "live";
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
  const addr = c.binding ?? null;
  const v = useQsysValue(addr);
  const info = useQsysControl(addr);
  const write = useQsysWrite();
  const items = c.items;
  const state = useQsysStates(items.length ? items.map((i) => i.binding) : [addr], true);
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
  const v = useQsysValue(c.binding ?? null);
  // The editor's text wins when set; otherwise the Core's. Set text is never Unavailable.
  const hasText = c.text.trim() !== "";
  const text = hasText ? c.text : v.string;
  const state = hasText && v.state === "unavailable" ? "live" : v.state;
  return (
    <Frame type={c.type} state={state} ts={ts} bound={!!c.binding || hasText} style={{ alignItems: "center", padding: "0 0.3em" }}>
      <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text || (c.binding ? "–" : "Label")}</span>
    </Frame>
  );
}

/**
 * A channel strip. Standard is Main direction A's 92 px strip (name, dB, fader with
 * its meter beside it, Mute); dense is Staff's 80 px strip (12 px name, a dB tick
 * scale, a 4 px track, two 5 px meters, the readout under the fader, an "M").
 */
function StripObject({ c, interactive, ts }: { c: Of<"qsys-strip">; interactive: boolean; ts: CSSProperties }) {
  const dense = c.density === "dense";
  const name = useQsysValue(c.name);
  const mute = useQsysValue(c.mute);
  const muted = mute.state !== "unavailable" && isOn(mute.value);
  const gainState = useQsysWriteState(c.gain, true);
  const muteState = useQsysWriteState(c.mute);
  const meters = [c.meter, c.meter2].filter((m): m is QsysBinding => !!m);
  const meterState = useQsysStates(meters);
  // What it has decides its state: a meters-only strip is a meter, read and drawn.
  const parts: QsysState[] = [...(c.gain ? [gainState] : []), ...(c.mute ? [muteState] : []), ...(meters.length ? [meterState] : [])];
  const state = parts.length ? combine(...parts) : "unavailable";
  const title = c.label.trim() || name.string || "–";
  return (
    <Frame
      type={c.type}
      state={state}
      ts={ts}
      bound={parts.length > 0}
      style={{ flexDirection: "column", alignItems: "center", gap: dense ? 5 : "0.3em", padding: dense ? 4 : "0.3em" }}
    >
      <div
        style={
          dense
            ? { fontSize: 12, fontWeight: 500, textAlign: "center", lineHeight: 1.2, minHeight: 30 }
            : { fontSize: "0.6em", fontWeight: 500, textAlign: "center", lineHeight: 1.25, minHeight: "2.5em" }
        }
      >
        {title}
      </div>
      {c.gain ? (
        <Fader
          binding={c.gain}
          vertical
          showDb
          steps={false}
          stepDb={1}
          interactive={interactive}
          name={`${title} level`}
          muted={muted}
          meters={meters}
          density={c.density}
          readout={dense ? "below" : "above"}
        />
      ) : (
        <div style={{ flex: 1, display: "flex", gap: dense ? 2 : 4, alignSelf: "center" }}>
          {meters.map((m, i) => (
            <MeterBar key={i} binding={m} vertical thin={dense} />
          ))}
        </div>
      )}
      {c.mute && <MuteButton binding={c.mute} interactive={interactive} dense={dense} />}
    </Frame>
  );
}

/** What the Connection status object shows for each state: its dot and its words. */
const CONNECTION_LOOK: Record<QsysPanelState["connection"], { colour: string; text: string }> = {
  connected: { colour: "var(--color-ok-9)", text: "Connected" },
  reconnecting: { colour: "var(--color-warn-9)", text: "Reconnecting… controls held" },
  offline: { colour: "var(--color-danger-9)", text: "Offline" },
};

function StatusObject({ ts }: { ts: CSSProperties }) {
  const conn = useQsysPanelState().connection;
  const { colour, text } = CONNECTION_LOOK[conn];
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
 * A Q-SYS object on panel `panel.id` (the View that holds it), whose kind picks the meter channel. Writes only
 * where `interactive` (a live display route), never in the editor or a preview.
 * With no panel (Home, a bare preview) it reads Unavailable and watches nothing.
 */
export function QsysObject({ config, panel: on, interactive, ts }: { config: QsysConfig; panel: { id: string | null; kind: PanelKind }; interactive: boolean; ts: CSSProperties }) {
  const panel = useQsysPanel(on.id, on.kind);
  return (
    <QsysPanelContext.Provider value={panel}>
      <Body config={config} interactive={interactive} ts={ts} />
    </QsysPanelContext.Provider>
  );
}
