// What a kiosk screen shows, decided in one place.
//
// StageView interleaved three unrelated kinds of decision — lifecycle
// (loading/error/no state), output state (blackout/unrouted/locked) and view
// kind — across fifteen returns and nine derived values. None of the outcomes
// could be checked without opening a browser on a wall screen, which is how
// every guard in that file was verified for its whole life.
//
// This is that decision and nothing else: state in, screen out. No React, no
// DOM, no hooks — so each outcome is a test rather than a walk to the
// auditorium. Rendering stays in the component; the arms it renders are named
// here.
//
// The behaviour below is MOVED from StageView, not rewritten, comments
// included. Where a comment records a bug that was fixed once, it travelled
// with the line it guards.

/** The screen a display should be showing, once every input is accounted for. */
export type StageScreen =
  | { k: "loading" }
  | { k: "error"; message: string }
  | { k: "blackout" }
  | { k: "unrouted"; displayName: string | null; locked: boolean }
  | { k: "not-configured"; displayName: string | null; locked: boolean }
  | { k: "empty"; displayName: string | null; locked: boolean }
  | {
      k: "view";
      kind: ViewKind;
      /** The View the arm renders from, resolved once. Null when routing points
       *  at a View that no longer exists. */
      view: View | null;
      displayId: string;
      displayName: string | null;
      locked: boolean;
      isPreview: boolean;
      /** How the Output renders — `panel` is the only surface whose controls are
       *  live. Undefined on a preview and on an Output with no mode set, which
       *  `contextForOutput` reads as `display`. Carried here rather than looked
       *  up again by the caller: it comes from the same `outputs.find` the name
       *  does, and a preview has to null it, which is a rule that must live in
       *  exactly one place. */
      outputMode: Output["mode"];
    };

export interface ScreenInput {
  state: StageState | null;
  isLoading: boolean;
  error: string | null;
  /** Canonical display id — already resolved from any friendly slug. */
  displayId: string;
  /** Preview slug → view id (null on a real display). */
  previewViewId: string | null;
}

export function resolveScreen(input: ScreenInput): StageScreen {
  const { state, isLoading, error, displayId, previewViewId } = input;

  if (isLoading) return { k: "loading" };
  if (error) return { k: "error", message: error };
  if (!state) return { k: "error", message: "State is unavailable." };

  // Preview mode: a "/preview-<viewId>" slug renders a View's content directly,
  // regardless of any output routing (used by the settings live preview).
  const previewView = previewViewId
    ? (state.views?.find((v) => v.id === previewViewId) ?? null)
    : null;

  const multiDisplay = (state.outputs?.length ?? 0) > 1;
  // Name comes from the Output, kind from the View it is routed to — the same two
  // places the `displays` shim was assembled from before it was dropped.
  const currentDisplay = previewViewId ? null : (state.outputs?.find((o) => o.id === displayId) ?? null);
  const kind: ViewKind = previewView?.kind ?? state.resolvedByOutput?.[displayId]?.kind ?? "slots";
  const displayName = previewView ? null : (multiDisplay ? (currentDisplay?.name ?? displayId) : null);

  // A real output (not a preview) with no View routed to it is unconfigured —
  // show a clear "no view assigned" screen rather than an empty slot grid.
  //
  // NULL IN A PREVIEW, and that is load-bearing: it is the single line that
  // keeps an output's blackout and its kiosk lock out of the settings preview
  // iframe. The three checks below read it and do not re-test previewViewId.
  const resolved = previewViewId ? null : state.resolvedByOutput?.[displayId];
  // Per-output kiosk lock (Displays-tab toggle) — never in the settings preview iframe.
  const outputLocked = resolved?.locked ?? false;

  // Blackout: a true black screen on command (Companion / Displays page), taking
  // priority over the routed View. Toggling it off restores the View instantly.
  if (resolved?.blackout) {
    return { k: "blackout" };
  }

  // The one check that DOES still need previewViewId: a preview has no resolved
  // output at all, and "no resolved output" is exactly what unrouted means — so
  // without this every preview would render the "no view assigned" placeholder.
  const isUnrouted = !previewViewId && (!resolved || resolved.viewId === null);
  if (isUnrouted) {
    return { k: "unrouted", displayName, locked: outputLocked };
  }

  // The View the chosen arm renders from. StageView computed this same
  // expression separately inside the custom arm, the script arm and the slots
  // arm; resolved once here for all of them.
  const activeView = previewView ?? (state.views?.find((v) => v.id === resolved?.viewId) ?? null);

  const view = (): Extract<StageScreen, { k: "view" }> => ({
    k: "view",
    kind,
    view: activeView,
    displayId,
    displayName,
    locked: outputLocked,
    isPreview: !!previewViewId,
    outputMode: currentDisplay?.mode,
  });

  // Custom-layout views render the visual-editor layout below the same kiosk top
  // bar (brand + plan context + connect QR) the other views show. A custom View
  // with nothing drawn on it yet is empty, not broken.
  if (kind === "custom") {
    if (activeView?.layout) return view();
    return { k: "empty", displayName, locked: outputLocked };
  }

  // Dashboard- and stage-kind displays render entirely different views, as do
  // transcription, script and spl-rundown — each its own component, keyed only
  // by the display id and (for script) the View it resolved to.
  if (
    kind === "dashboard" ||
    kind === "stage" ||
    kind === "transcription" ||
    kind === "script" ||
    kind === "spl-rundown"
  ) {
    return view();
  }

  // Slots-kind (and anything a newer server routes that this build does not
  // know) falls through to here, where Planning Center is the prerequisite.
  if (!state.pcoConfigured) {
    return { k: "not-configured", displayName, locked: outputLocked };
  }

  // Slots-kind. Which slots — and whether there are none, making the screen
  // empty — depends on the unsaved preview draft, which only the component
  // holds, so that last step stays there.
  return view();
}
