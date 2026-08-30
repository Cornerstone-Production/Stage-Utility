import { useEffect, useSyncExternalStore } from "react";
import { invoke, onNotification } from "../lib/api";
import { applyDeviceTelemetry } from "../lib/apply-device-telemetry";
import { applyAccentVar } from "../lib/apply-accent";
import { setDisplayHourCycle } from "../lib/clock-format";

interface UseStageStateResult {
  state: StageState | null;
  isLoading: boolean;
  error: string | null;
}

// ── The one StageState ────────────────────────────────────────────────────────
//
// WHY THIS IS MODULE-LEVEL, and what a per-consumer copy costs.
//
// Seventeen-odd components call this hook, and a custom layout can mount many
// more: a nine-tile producer wall is nine of them on one page. Held per
// consumer, each of those independently
//
//   - fetched the WHOLE StageState on mount, so one page load was nine hydrates
//     of a ~36 KB document, on hardware that is often a Raspberry Pi;
//   - kept its own copy and re-rendered on every `stage:state-changed` and every
//     `slots:devices` push, merging the same telemetry nine times over to
//     produce nine identical documents;
//   - opened its own SSE subscription, so the channel report to the server
//     churned once per mount and once per unmount.
//
// It also allowed TEARING: two consumers rendered in the same commit could hold
// different StageStates, because each had its own `useState` fed by its own
// fetch. `useSyncExternalStore` reads one snapshot, so every consumer in a
// commit sees the same document or none of them do.
//
// The store is started by the first subscriber and then left running for the
// life of the page. It is deliberately NOT torn down when the last consumer
// unmounts: the live subscription is what keeps the cache true, so dropping it
// would leave the next mount a choice between stale state and the refetch this
// exists to remove.

/** The single snapshot every consumer reads. Replaced, never mutated. */
let snapshot: UseStageStateResult = { state: null, isLoading: true, error: null };
const subscribers = new Set<() => void>();

let started = false;
let hydrating = false;
/** Set once a broadcast has landed, so a slow hydrate cannot overwrite it. */
let broadcastSinceHydrateStarted = false;
let unsubscribers: (() => void)[] = [];

function publish(next: UseStageStateResult): void {
  snapshot = next;
  for (const notify of [...subscribers]) notify();
}

/**
 * Take a full StageState — from the hydrate or from a broadcast — as the truth.
 *
 * `setDisplayHourCycle` is called HERE, before the first render that could show
 * a clock, because every surface (operator app and stage display alike) hydrates
 * through this hook: there is exactly one place to keep in sync. With the shared
 * store that is now literally one call per state rather than one per consumer,
 * and it stays in step with the state that carries it — so a toggle in Advanced
 * reaches every open surface on the same broadcast that re-renders them.
 *
 * `applyAccentVar` moved here from a per-consumer effect for the same reason,
 * and the rule it was written for still holds: it is applied ONLY from a
 * hydrated state. A null accent on a real state is the operator choosing no
 * brand colour and must clear the override; a consumer that has not loaded yet
 * must never clear it, which is what made opening a colour picker flash every
 * accent-coloured thing on the page. Reaching it only from here makes that
 * structural — there is no unhydrated state left to apply from.
 */
function adoptState(next: StageState): void {
  setDisplayHourCycle(next.hourCycle);
  applyAccentVar(next.accentColor);
  publish({ state: next, isLoading: false, error: null });
}

function hydrate(): void {
  if (hydrating) return;
  hydrating = true;
  broadcastSinceHydrateStarted = false;
  invoke<StageState>("stage:getState")
    .then((s: StageState) => {
      hydrating = false;
      // A broadcast that landed while this was in flight is NEWER than what the
      // fetch is carrying. Keep it, and just retire the loading flag.
      if (broadcastSinceHydrateStarted) {
        if (snapshot.isLoading) publish({ ...snapshot, isLoading: false });
        return;
      }
      adoptState(s);
    })
    .catch((err: unknown) => {
      hydrating = false;
      // Reported, not swallowed: the failure is handed to every consumer as
      // `error`, and a consumer mounting later retries (see `subscribe`), so a
      // server that was down at page load does not blank the wall for ever.
      console.error("[useStageState] hydrate error", err);
      publish({ state: snapshot.state, isLoading: false, error: String(err) });
    });
}

function start(): void {
  if (started) return;
  started = true;

  unsubscribers.push(
    onNotification("stage:state-changed", (payload: unknown) => {
      broadcastSinceHydrateStarted = true;
      adoptState(payload as StageState);
    }),
  );

  // Volatile per-slot telemetry (RF, battery, audio level) arrives on its own
  // channel so a meter twitch does not re-send the whole state document. Merged
  // back onto the slots here, where every component already looks for it — once,
  // rather than once per mounted consumer.
  unsubscribers.push(
    onNotification("slots:devices", (payload: unknown) => {
      const prev = snapshot.state;
      if (!prev) return;
      const next = applyDeviceTelemetry(prev, payload as Record<string, SlotDevice>);
      // applyDeviceTelemetry returns the same object when nothing moved, which
      // is what keeps a no-op push from re-rendering every display.
      if (next !== prev) publish({ ...snapshot, state: next });
    }),
  );

  hydrate();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  start();
  // A hydrate that failed left every consumer with an error and no state. A new
  // consumer arriving is the cheapest honest moment to try again — at worst that
  // is the old per-mount fetch, and only while the state is still missing.
  if (!hydrating && snapshot.error && !snapshot.state) hydrate();
  return () => {
    subscribers.delete(notify);
  };
}

const getSnapshot = (): UseStageStateResult => snapshot;

/** Test seam — drops the shared cache so cases cannot contaminate each other. */
export function __resetForTests(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
  subscribers.clear();
  snapshot = { state: null, isLoading: true, error: null };
  started = false;
  hydrating = false;
  broadcastSinceHydrateStarted = false;
}

/**
 * Hydrate the full StageState from the backend and keep it live.
 *
 * Fetched once for the whole page via `stage:getState`, then kept current from
 * `stage:state-changed` broadcasts. Shared by the kiosk StageView, the operator
 * shell and the display-picker landing page so all of them stay in sync — and,
 * because the cache is module-level, so that a page holding many of them pays
 * for one state rather than one each.
 *
 * `isLoading` is true only until the FIRST answer arrives, and that is a fact
 * about the page rather than about the consumer: a consumer mounting after the
 * state is in hand reads it immediately with `isLoading` false, because there is
 * nothing left to wait for. An error counts as an answer — a consumer mounting
 * while `error` is set sees the error rather than a spinner, and its arrival
 * quietly triggers one retry.
 */
export function useStageState(): UseStageStateResult {
  const { state, isLoading, error } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Auto-reload after an update — including for an installed Home-Screen PWA.
  // The server stamps the version the page was built at into the served HTML
  // (window.__APP_VERSION__) and reports the live version over SSE ("server:hello")
  // and at /api/version. If a page's stamped version differs from the live one it
  // is running a stale (cached) shell, so it reloads to pull the new assets — no
  // manual refresh, no re-adding to the Home Screen. Re-checked on foreground so a
  // PWA opened after a deploy self-heals on relaunch. Falls back to detecting a
  // change while open for pre-stamp shells (which have no __APP_VERSION__).
  //
  // Left PER CONSUMER, unlike the state above, because it opens by reading
  // `window.location.pathname` at mount: hoisting it into the module would
  // freeze that answer at whichever surface on the page mounted first, and
  // getting it wrong reloads the settings console out from under an operator
  // mid-edit. The duplication costs a listener per consumer and nothing else.
  useEffect(() => {
    const path = window.location.pathname;
    // The settings console (+ its live-preview iframes) must not reload out from
    // under an operator mid-edit; only the display / volunteer surfaces self-reload.
    if (path.startsWith("/preview-") || path.startsWith("/settings")) return;
    const own = (window as unknown as { __APP_VERSION__?: string }).__APP_VERSION__ ?? null;
    let reloading = false;
    let seen: string | null = null;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      // Small random delay so a wall of displays doesn't reload in lockstep.
      setTimeout(() => window.location.reload(), 250 + Math.random() * 1000);
    };
    const check = (v: string | null) => {
      if (!v || v === "unknown") return;
      if (own) {
        if (v !== own) reload();
      } else if (seen === null) {
        seen = v;
      } else if (v !== seen) {
        reload();
      }
    };
    const off = onNotification("server:hello", (payload: unknown) => check((payload as { version?: string } | null)?.version ?? null));
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !own) return;
      fetch("/api/version")
        .then((r) => r.json())
        .then((d: { version?: string }) => check(d?.version ?? null))
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { state, isLoading, error };
}
