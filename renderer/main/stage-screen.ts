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

/**
 * The kiosk chrome a screen draws around whatever it is showing.
 *
 * One shape rather than the same fields repeated on five arms. It is not the
 * type alone that stops a sixth arm being added half-wired — the single
 * ScreenTopBar below is — but an arm that omits this shape cannot be handed to
 * it without failing the build, which is the half worth having. `hideTopBar`
 * was added here for that reason: the bar had six render sites, and gating one
 * of them is how five walls keep a bar the operator turned off.
 */
export interface ScreenChrome {
  displayName: string | null;
  locked: boolean;
  /** This display's "hide top bar" toggle (Screens page). True = draw no top bar
   *  at all and let the content fill the strip. Independent of `locked`, which
   *  keeps the bar and only strips its escape hatches. */
  hideTopBar: boolean;
}

/** The screen a display should be showing, once every input is accounted for. */
export type StageScreen =
  | { k: "loading" }
  | { k: "error"; message: string }
  | { k: "blackout" }
  | ({ k: "unrouted" } & ScreenChrome)
  /** A preview whose View has been deleted. Distinct from `unrouted`: a View WAS
   *  assigned here, and it is the View that is gone. */
  | ({ k: "view-missing" } & ScreenChrome)
  | ({ k: "not-configured" } & ScreenChrome)
  | ({ k: "empty" } & ScreenChrome)
  /** A view kind this build has no arm for. Reachable in earnest, not just in
   *  theory: `kind` comes off server state and the app ships a beta/main track
   *  switch, so a kind written by a beta build and read by a main build lands
   *  here. It used to land on the slots grid instead, silently. */
  | { k: "unknown-kind"; kind: string }
  | ({
      k: "view";
      kind: ViewKind;
      /** The View the arm renders from, resolved once. Null when routing points
       *  at a View that no longer exists. */
      view: View | null;
      displayId: string;
      isPreview: boolean;
      /** How the Output renders — `panel` is the only surface whose controls are
       *  live. Undefined on a preview and on an Output with no mode set, which
       *  `contextForOutput` reads as `display`. Carried here rather than looked
       *  up again by the caller: it comes from the same `outputs.find` the name
       *  does, and a preview has to null it, which is a rule that must live in
       *  exactly one place. */
      outputMode: Output["mode"];
    } & ScreenChrome);

export interface ScreenInput {
  state: StageState | null;
  isLoading: boolean;
  error: string | null;
  /** Canonical display id — already resolved from any friendly slug. */
  displayId: string;
  /** Preview slug → view id (null on a real display). */
  previewViewId: string | null;
  /** The Output a preview is standing in for — the Screens card the iframe sits
   *  in. Null on a real display, and null for a preview that is not a screen (the
   *  View editor's own). See preview-url.ts for how it travels. */
  previewOutputId: string | null;
}

export function resolveScreen(input: ScreenInput): StageScreen {
  const { state, isLoading, error, displayId, previewViewId, previewOutputId } = input;

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
  // The Output's name, or NOTHING.
  //
  // This used to fall back to `displayId`, and a display id is whatever came out
  // of the URL: a preview slug whose View had been deleted, or any path typed by
  // hand, was drawn into the top bar as the screen's own name. A URL fragment on
  // an auditorium wall reads as a bug and tells an operator less than blank does.
  //
  // No preview check is needed here: `currentDisplay` is already null in one, for
  // the same reason `resolved` is.
  const displayName = multiDisplay ? (currentDisplay?.name ?? null) : null;

  // A real output (not a preview) with no View routed to it is unconfigured —
  // show a clear "no view assigned" screen rather than an empty slot grid.
  //
  // NULL IN A PREVIEW, and that is load-bearing: it is the line that keeps an
  // output's blackout and its kiosk lock out of the settings preview iframe.
  // Those two checks read it and do not re-test previewViewId.
  const resolved = previewViewId ? null : state.resolvedByOutput?.[displayId];

  // AND THIS IS THE OTHER HALF, because a per-output flag now has two possible
  // answers in a preview and the difference is not a detail:
  //
  //   `resolved`   — the output this screen IS. A preview is not any screen, so
  //                  it is null there and stays null.
  //   `standingIn` — the output this screen is a PICTURE OF: the Screens card the
  //                  iframe sits in, named in the query (see preview-url.ts).
  //                  On a real display the two are the same thing.
  //
  // Which one a flag reads is the whole decision, and it is decided by what the
  // flag would DO to a console full of thumbnails:
  //
  //   blackout   -> `resolved`.   The Screens page must not become a grid of
  //                               black rectangles with nothing to click.
  //   locked     -> `resolved`.   Its only effect is stripping the bar's escape
  //                               hatches, and the preview lives inside the
  //                               console, which needs its navigation.
  //   hideTopBar -> `standingIn`. Purely visual, and showing what a screen will
  //                               look like is the entire job of the card. Left
  //                               on `resolved` the operator hides the bar, the
  //                               card they are looking at does not change, and
  //                               the control reads as broken.
  //
  // A new per-output flag picks a side here. "Would the Screens page still be
  // usable if every card did this at once" is the question that decides it.
  const standingIn = previewViewId
    ? (previewOutputId ? state.resolvedByOutput?.[previewOutputId] : null)
    : resolved;

  // The kiosk chrome every arm below carries, built once.
  const chrome: ScreenChrome = {
    displayName,
    locked: resolved?.locked ?? false,
    hideTopBar: standingIn?.hideTopBar ?? false,
  };

  // Blackout: a true black screen on command (Companion), taking
  // priority over the routed View. Toggling it off restores the View instantly.
  if (resolved?.blackout) {
    return { k: "blackout" };
  }

  // Where the kind comes from. A preview answers with its own View; a real output
  // answers with the routing the server resolved for it. Exactly one of the two
  // applies — which is the one check that still needs previewViewId, since a
  // preview has no resolved output at all and "no resolved output" is what
  // unrouted means for everything else.
  //
  // When the source that applies is absent, this screen does not know what to
  // show. That used to be written `?? "slots"`, so a preview of a View that had
  // been DELETED drew somebody's mic-slot grid with nothing to say anything was
  // wrong. There is no default kind any more: not knowing is its own screen.
  const source: { kind: ViewKind } | null = previewViewId
    ? previewView
    : ((resolved && resolved.viewId !== null) ? resolved : null);
  if (!source) {
    // A preview gets its own wording. "No view assigned" would be false here —
    // one was assigned; it is the View that is gone.
    return previewViewId
      ? { k: "view-missing", ...chrome }
      : { k: "unrouted", ...chrome };
  }
  const kind: ViewKind = source.kind;

  // The View the chosen arm renders from. StageView computed this same
  // expression separately inside the custom arm, the script arm and the slots
  // arm; resolved once here for all of them.
  const activeView = previewView ?? (state.views?.find((v) => v.id === resolved?.viewId) ?? null);

  const view = (): Extract<StageScreen, { k: "view" }> => ({
    k: "view",
    kind,
    view: activeView,
    displayId,
    isPreview: !!previewViewId,
    outputMode: currentDisplay?.mode,
    ...chrome,
  });

  // Custom-layout views render the visual-editor layout below the same kiosk top
  // bar (brand + plan context + connect QR) the other views show. A custom View
  // with nothing drawn on it yet is empty, not broken.
  if (kind === "custom") {
    if (activeView?.layout) return view();
    return { k: "empty", ...chrome };
  }

  // Dashboard- and stage-kind displays render entirely different views, as do
  // transcription, script and spl-rundown — each its own component, keyed only
  // by the display id and (for script) the View it resolved to.
  if (
    kind === "dashboard" ||
    kind === "stage" ||
    kind === "transcription" ||
    kind === "script" ||
    kind === "spl-rundown" ||
    // Calendar is NOT gated on Planning Center here, unlike slots: the component
    // takes pcoConfigured as a prop and says so on its own face, rather than the
    // whole screen becoming the not-configured one.
    kind === "calendar"
  ) {
    return view();
  }

  // Slots are the only kind whose content comes from Planning Center, so this
  // check lives HERE rather than above, gating slots alone. While slots was the
  // catch-all it sat above everything and would now wrongly gate a clock wall on
  // a PCO connection nothing on it needs.
  //
  // Which slots — and whether there are none, making the screen empty — depends
  // on the unsaved preview draft, which only the component holds, so that last
  // step stays there.
  if (kind === "slots") {
    if (!state.pcoConfigured) {
      return { k: "not-configured", ...chrome };
    }
    return view();
  }

  // Every kind is now accounted for, so adding a ViewKind without an arm above
  // fails the BUILD here. Slots used to be the implicit fallback that caught an
  // unhandled kind, which meant an eighth kind added by somebody who missed this
  // file would have put a department's mic-slot grid on an office wall, silently,
  // and the first report of it would have come from whoever stood in front of it.
  const _never: never = kind;
  void _never;
  return { k: "unknown-kind", kind: String(kind) };
}
