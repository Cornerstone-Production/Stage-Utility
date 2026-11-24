// A volunteer panel's way around: the cog menu, the staff PIN pad, and the
// banner that says the page is about to go home.
//
// Built to the approved direction A (stage-utility-plans mockups Main.dc.html),
// in the kiosk surface's tokens:
//
// - The cog lists the device's home panel (marked "This iPad's home") and this
//   panel's siblings, with no PIN. A sibling opens with `?return=<home>`, so the
//   page knows its way back (use-auto-return.ts); home opens with none.
// - Under a divider, "Open Stage Utility" asks for the 4-digit staff PIN. The
//   server checks it and holds the lock (qsys-pin.ts); a correct PIN opens the
//   app at /, and unlocks nothing else. With no PIN set, it never opens: it says
//   a PIN must be set on /qsys/manage first.
// - The banner: "Going back to <home> in m:ss unless someone touches the
//   screen." with "Go back now". The 1 s tick lives here, in the banner, so the
//   panel's layout does not re-render every second.
//
// The mockup's "Go back now" is 40 px tall; it is 44 here, the touch-target floor.

import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { siblingsOf } from "@main/types/qsys";
import type { View } from "@main/types/views";
import { errorMessage } from "@main/services/errors";
import { invoke } from "../../lib/api";
import { logReadFailure, logToServer } from "../../lib/client-log";
import { cn } from "../../lib/cn";
import { QSYS_MANAGE_PATH, qsysPanelPath } from "./qsys-paths";
import { formatCountdown, useAutoReturn } from "./use-auto-return";

/** The approved copy. */
export const HOME_HINT = "This iPad’s home";
export const OPEN_APP_LABEL = "Open Stage Utility";
export const PIN_TITLE = "Enter staff PIN";
export const NO_PIN_NOTE = `No staff PIN is set. Set one on ${QSYS_MANAGE_PATH} first.`;
export const WRONG_PIN_NOTE = "That PIN isn't right.";
export const OPENING_NOTE = "Opening Stage Utility…";

const PIN_LENGTH = 4;

type PinCheck = { ok: true } | { ok: false; lockedForMs: number; notSet?: true };

/** The panels the cog lists: home first, then this panel's siblings, each once. */
export function cogPanels(current: View, home: View, views: readonly View[]): View[] {
  const out: View[] = [home];
  for (const v of siblingsOf(current, views).present) if (!out.some((o) => o.id === v.id)) out.push(v);
  return out;
}

/** Where a cog entry goes: home with no `return`, any other panel remembering home. */
function entrySearch(target: View, home: View): Record<string, string> | undefined {
  const homeSlug = home.qsys?.slug;
  return target.id === home.id || !homeSlug ? undefined : { return: homeSlug };
}

export function QsysCogMenu({ view, home, views }: { view: View; home: View; views: readonly View[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const close = () => {
    setOpen(false);
    setPinOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setPinOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function go(target: View) {
    close();
    const slug = target.qsys?.slug;
    if (!slug || target.id === view.id) return;
    void router.navigate({ to: qsysPanelPath(slug), search: entrySearch(target, home) as never });
  }

  return (
    <>
      <button
        type="button"
        aria-label="Panels and settings"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex size-[52px] shrink-0 items-center justify-center rounded-[14px] border border-line-strong bg-surface text-fg"
        data-qsys-cog
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
      {open && (
        <>
          {/* Over the whole panel, the offline card included: the cog works with the Core down. */}
          <div className="absolute inset-0 z-30" onClick={close} aria-hidden data-qsys-cog-backdrop />
          <div
            role="dialog"
            aria-label="Panels and settings"
            className="absolute top-20 right-6 z-30 flex w-80 max-w-[calc(100%-48px)] flex-col gap-0.5 rounded-[18px] border border-line-strong bg-(--kiosk-surface-1) p-2 shadow-(--su-shadow-2)"
            data-qsys-cog-menu
          >
            {pinOpen ? (
              <PinPad onCancel={() => setPinOpen(false)} onOpen={() => void router.navigate({ to: "/" })} />
            ) : (
              <>
                <div className="px-3 pt-2.5 pb-1.5 text-caption1 font-medium tracking-[0.06em] text-fg-muted uppercase">Panels</div>
                {cogPanels(view, home, views).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => go(p)}
                    aria-current={p.id === view.id ? "page" : undefined}
                    className={cn(
                      "flex h-[52px] items-center rounded-xl px-3 text-left text-callout text-fg hover:bg-surface-raised",
                      p.id === view.id && "bg-surface-raised",
                    )}
                    data-qsys-cog-panel={p.qsys?.slug}
                  >
                    <span className="grow truncate">{p.name}</span>
                    {p.id === home.id && <span className="shrink-0 text-footnote text-fg-muted">{HOME_HINT}</span>}
                  </button>
                ))}
                <div className="mx-1 my-1.5 h-px bg-line" />
                <button
                  type="button"
                  onClick={() => setPinOpen(true)}
                  className="flex h-[52px] items-center gap-2.5 rounded-xl px-3 text-left text-callout text-fg hover:bg-surface-raised"
                  data-qsys-open-app
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="4" y="11" width="16" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                  <span className="grow">{OPEN_APP_LABEL}</span>
                  <span className="text-footnote text-fg-muted">PIN</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

type PadState =
  | { at: "reading" }
  | { at: "entry"; note: string }
  | { at: "checking" }
  | { at: "opening" }
  | { at: "locked"; forMs: number }
  | { at: "no-pin" }
  | { at: "failed"; note: string };

/** The PIN pad: four dots, a note, and 1-9, Cancel, 0, delete. */
function PinPad({ onCancel, onOpen }: { onCancel: () => void; onOpen: () => void }) {
  const [digits, setDigits] = useState("");
  const [st, setSt] = useState<PadState>({ at: "reading" });
  /** While locked: how long is left, as the last tick saw it. */
  const [lockLeftMs, setLockLeftMs] = useState(0);

  // Whether a PIN is set at all: with none, the pad says so and takes no digits.
  useEffect(() => {
    let live = true;
    invoke<{ set: boolean }>("qsys:pin").then(
      (r) => live && setSt(r.set === true ? { at: "entry", note: "" } : { at: "no-pin" }),
      (err: unknown) => {
        logReadFailure("qsys", "whether a staff PIN is set", err);
        if (live) setSt({ at: "failed", note: "Couldn't reach Stage Utility. Try again." });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // A lock counts down where it is shown, then the pad takes digits again. Keyed
  // on the state object, so a second lock straight after a first starts afresh.
  const locked = st.at === "locked" ? st : null;
  useEffect(() => {
    if (locked === null) return;
    const end = Date.now() + locked.forMs;
    const tick = () => {
      const left = end - Date.now();
      if (left <= 0) setSt({ at: "entry", note: "" });
      else setLockLeftMs(left);
    };
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [locked]);

  async function check(pin: string) {
    setSt({ at: "checking" });
    try {
      const r = await invoke<PinCheck>("qsys:checkPin", { pin });
      setDigits("");
      // Only an explicit yes opens: any other answer is a no.
      if (r.ok === true) {
        setSt({ at: "opening" });
        onOpen();
      } else if (r.notSet === true) setSt({ at: "no-pin" });
      else if (typeof r.lockedForMs === "number" && r.lockedForMs > 0) {
        setLockLeftMs(r.lockedForMs);
        setSt({ at: "locked", forMs: r.lockedForMs });
      } else setSt({ at: "entry", note: WRONG_PIN_NOTE });
    } catch (err) {
      // A check that could not be made is never read as a wrong PIN.
      logToServer("qsys", `the staff PIN could not be checked: ${errorMessage(err)}`);
      setDigits("");
      setSt({ at: "failed", note: "Couldn't check the PIN. Try again." });
    }
  }

  const takesDigits = st.at === "entry" || st.at === "failed";
  function press(k: string) {
    if (k === "cancel") return onCancel();
    if (!takesDigits) return;
    if (k === "del") return setDigits((d) => d.slice(0, -1));
    const next = (digits + k).slice(0, PIN_LENGTH);
    setDigits(next);
    if (st.at === "entry" && st.note) setSt({ at: "entry", note: "" });
    if (next.length === PIN_LENGTH) void check(next);
  }

  let note = "";
  if (st.at === "entry" || st.at === "failed") note = st.note;
  else if (st.at === "checking") note = "Checking…";
  else if (st.at === "opening") note = OPENING_NOTE;
  else if (st.at === "no-pin") note = NO_PIN_NOTE;
  else if (st.at === "locked") note = `Too many wrong tries. Try again in ${formatCountdown(Math.ceil(lockLeftMs / 1000))}.`;

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "cancel", "0", "del"];
  return (
    <div className="flex flex-col items-center gap-3.5 p-3" data-qsys-pin-pad={st.at}>
      <div className="text-callout font-semibold text-fg">{PIN_TITLE}</div>
      <div className="flex gap-3" aria-label={`${digits.length} of ${PIN_LENGTH} digits entered`} role="img">
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={cn("size-3.5 rounded-full border-2 border-fg", i < digits.length ? "bg-fg" : "bg-transparent")} />
        ))}
      </div>
      <div role="status" className="min-h-4 text-center text-footnote text-fg-muted" data-qsys-pin-note>
        {note}
      </div>
      <div className="grid w-full grid-cols-3 gap-2">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            disabled={k !== "cancel" && !takesDigits}
            aria-label={k === "del" ? "Delete" : k === "cancel" ? "Cancel" : k}
            className={cn(
              "h-14 rounded-xl border border-line bg-surface font-mono text-fg disabled:opacity-40",
              k === "cancel" ? "text-[14px]" : "text-[20px]",
            )}
          >
            {k === "cancel" ? "Cancel" : k === "del" ? "⌫" : k}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The banner over a panel that is away from its home, counting down to going
 * back. Renders nothing at home, or when the home never calls it back (0 min).
 */
export function QsysReturnBanner({ home }: { home: View }) {
  const { secondsLeft, goHome } = useAutoReturn(home.qsys?.slug ?? null, home.qsys?.returnAfterMin ?? 0);
  if (secondsLeft === null) return null;
  return (
    <div className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface-raised px-6" data-qsys-return>
      <span className="grow text-subheadline text-fg">
        Going back to <strong className="font-semibold">{home.name}</strong> in{" "}
        <span className="font-mono" data-qsys-return-countdown>{formatCountdown(secondsLeft)}</span> unless someone touches the screen.
      </span>
      <button type="button" onClick={goHome} className="h-11 shrink-0 rounded-[10px] border border-line-strong bg-transparent px-[18px] text-subheadline text-fg">
        Go back now
      </button>
    </div>
  );
}
