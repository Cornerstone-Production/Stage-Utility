import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useState } from "react";
import { useServerClock } from "@renderer/lib/server-clock";
import { Loader2Icon } from "lucide-react";

import { QrHint } from "../components/qr-hint";
import { ErrorNote } from "../components/ui/error-note";
import { invoke } from "../lib/api";
import { useFailedReads } from "../lib/use-failed-reads";
import { useResyncOn } from "../lib/use-resync-on";
import { ScriptViewBody, ScriptViewHeader, useScriptViewRender } from "./scriptview-body";
import { useDashboardState } from "./use-dashboard-state";
import { pcoConnected } from "./use-stage-state";
import type { CategoryRole } from "../../main/types/scriptview-roles.js";

interface ScriptViewProps {
  /** Which saved ScriptView column preset to render; null = all columns. */
  scriptViewLayoutId?: string | null;
  /** The header bar (plan title, countdown, clock). On for a display of its own;
   *  a layout embedding this usually has its own header and clock already. */
  showHeader?: boolean;
  /** Keep the live PCO item scrolled into view. Default on. */
  autoScroll?: boolean;
  /** Row text sizing — see ScriptViewBody. A layout object passes "" so the
   *  rows scale with the object's own font size instead of the viewport. */
  textSizeClass?: string;
}

/**
 * The ScriptView rundown on a display.
 *
 * This IS the /scriptview page — same body, same header, same columns from the
 * same saved presets — pointed at the app's ACTIVE plan rather than at a service
 * type chosen in the URL. Before, it was a third rundown with hardcoded columns
 * of its own, which meant the thing an operator configured on the page and the
 * thing that appeared on a monitor were different tables that happened to look
 * similar.
 *
 * The Max-SPL column it used to carry is not lost: `spl-rundown` is a whole
 * View-kind for exactly that, and duplicating it here is what made this one drift
 * in the first place.
 *
 * Sizes to `h-full`, never to the viewport. The caller owns the box: a kiosk
 * route wraps it in the full screen and the safe-area insets, a layout object
 * wraps it in the object. That is the whole reason it can be embedded.
 */
export function ScriptView({ scriptViewLayoutId, showHeader = true, textSizeClass, autoScroll }: ScriptViewProps) {
  const { state, isLoading, error: stateError, pcoLive } = useDashboardState();
  const [rundown, setRundown] = useState<ScriptViewRundownDTO | null>(null);
  // Null until the first read lands. "The last good list" only exists once one
  // has: before that, an empty list resolved to ALL columns (the comment on the
  // effect below), and a failure has to say so instead.
  const [layouts, setLayouts] = useState<ScriptViewLayout[] | null>(null);
  const [roles, setRoles] = useState<CategoryRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { failed, fail, clear } = useFailedReads<"layouts" | "roles" | "rundown">("scriptview");

  // The ACTIVE service type — getScriptViewRundown resolves that to the active
  // plan, so this display follows whatever the app is set to without being told.
  const serviceTypeId = state?.serviceTypeId ?? null;
  // Keyed on as well as the type: the operator can switch PLAN without changing
  // service type (a manual pick, or the auto-rollover advancing to the next
  // occurrence). Watching only the type left the monitor on the previous plan
  // for up to a poll interval — during the pre-service window, which is exactly
  // when a plan gets corrected.
  const planId = state?.planId ?? null;
  // The plan comes from Planning Center, so it is asked for only once it is
  // connected, and until then the body says so in the plan's own quiet voice
  // (see pcoConnected). Anything read before it was known to be disconnected
  // goes with it: the plan can no longer be followed.
  const pcoConfigured = pcoConnected(state, stateError);
  useResyncOn([pcoConfigured], () => {
    if (pcoConfigured !== false) return;
    clear();
    setError(null);
    setRundown(null);
  });

  // Items change rarely; refetch on a slow timer. The live position arrives
  // separately over SSE, so a stale rundown still highlights the right row.
  //
  // The presets and roles ride the same timer rather than being fetched once at
  // mount. Fetched once, a transient failure at boot left `layouts` empty for
  // the life of the page, and an empty list resolves to ALL columns — a display
  // configured for one department silently showing every other department's
  // notes, with nothing on screen to say so.
  useEffect(() => {
    if (!serviceTypeId || !pcoConfigured) return;
    let cancelled = false;
    const load = () => {
      // A failure keeps the last good list, and the next tick retries. It is
      // logged once, when it starts; it is SHOWN only while there is no good
      // list to keep, because only then is the display wrong.
      invoke<ScriptViewLayout[]>("scriptview:listLayouts")
        .then((l) => {
          if (cancelled) return;
          setLayouts(l);
          clear("layouts");
        })
        .catch((err: unknown) => { if (!cancelled) fail("layouts", "the column layouts for a Script view", err); });
      invoke<CategoryRole[]>("scriptview:listRoles")
        .then((r) => {
          if (cancelled) return;
          setRoles(r);
          clear("roles");
        })
        .catch((err: unknown) => { if (!cancelled) fail("roles", "the category roles for a Script view", err); });
      // The last good rundown stays on screen through a failure (see
      // ScriptViewBody), so the log is the only place a failing one shows.
      invoke<ScriptViewRundownDTO>("scriptview:rundown", { serviceTypeId })
        .then((r) => {
          if (cancelled) return;
          setRundown(r);
          setError(null);
          clear("rundown");
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(errorMessage(e));
          fail("rundown", "the rundown for a Script view", e);
        });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [serviceTypeId, planId, pcoConfigured, fail, clear]);

  const now = useServerClock(pcoLive?.serverNow);

  const layout = useMemo(
    () => (scriptViewLayoutId ? (layouts ?? []).find((l) => l.id === scriptViewLayoutId) ?? null : null),
    [layouts, scriptViewLayoutId],
  );
  const shownRoles = useMemo(() => roles ?? [], [roles]);
  const render = useScriptViewRender(rundown, layout, shownRoles, pcoLive, now);
  // Only a display set to a column set is wrong without the layouts; one on
  // All columns shows every column either way.
  const layoutsMissing = failed.has("layouts") && layouts === null && !!scriptViewLayoutId;
  const rolesMissing = failed.has("roles") && roles === null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full kiosk-surface">
        <Loader2Icon className="size-8 text-fg-subtle animate-spin" />
      </div>
    );
  }
  if (stateError || !state) {
    return (
      <div className="flex items-center justify-center h-full kiosk-surface text-fg-subtle">
        Could not load script
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden kiosk-surface">
      {showHeader && (
      <ScriptViewHeader
        rundown={rundown}
        render={render}
        appLogo={state.appLogo}
        appLogoMonochrome={state.appLogoMonochrome}
        now={now}
        trailing={
          state.showQr && state.remoteUrl ? (
            <a href="/settings" target="_blank" rel="noopener noreferrer" className="rounded hover:opacity-70 transition-opacity">
              <QrHint url={state.remoteUrl} compact />
            </a>
          ) : undefined
        }
      />
      )}

      {(layoutsMissing || rolesMissing) && (
        <div className="flex flex-col gap-1.5 px-4 pt-2">
          {layoutsMissing && <ErrorNote>Couldn't load the column layouts, so all columns are shown.</ErrorNote>}
          {rolesMissing && <ErrorNote>Couldn't load the category roles, so no note columns are shown.</ErrorNote>}
        </div>
      )}

      <ScriptViewBody
        rundown={rundown}
        roles={shownRoles}
        layout={layout}
        render={render}
        error={error}
        notice={
          pcoConfigured === false
            ? "Planning Center isn't connected, so this display can't find its plan."
            : !serviceTypeId
              ? "No service type is selected, so this display has no plan to follow."
              : null
        }
        textSizeClass={textSizeClass}
        autoScroll={autoScroll}
      />
    </div>
  );
}
