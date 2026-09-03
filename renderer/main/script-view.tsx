import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useState } from "react";
import { useServerSkew } from "@renderer/lib/use-server-skew";
import { Loader2Icon } from "lucide-react";

import { QrHint } from "../components/qr-hint";
import { invoke } from "../lib/api";
import { ScriptViewBody, ScriptViewHeader, useScriptViewRender } from "./scriptview-body";
import { useDashboardState } from "./use-dashboard-state";
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
  const [layouts, setLayouts] = useState<ScriptViewLayout[]>([]);
  const [roles, setRoles] = useState<CategoryRole[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The ACTIVE service type — getScriptViewRundown resolves that to the active
  // plan, so this display follows whatever the app is set to without being told.
  const serviceTypeId = state?.serviceTypeId ?? null;
  // Keyed on as well as the type: the operator can switch PLAN without changing
  // service type (a manual pick, or the auto-rollover advancing to the next
  // occurrence). Watching only the type left the monitor on the previous plan
  // for up to a poll interval — during the pre-service window, which is exactly
  // when a plan gets corrected.
  const planId = state?.planId ?? null;

  // Items change rarely; refetch on a slow timer. The live position arrives
  // separately over SSE, so a stale rundown still highlights the right row.
  //
  // The presets and roles ride the same timer rather than being fetched once at
  // mount. Fetched once, a transient failure at boot left `layouts` empty for
  // the life of the page, and an empty list resolves to ALL columns — a display
  // configured for one department silently showing every other department's
  // notes, with nothing on screen to say so.
  useEffect(() => {
    if (!serviceTypeId) return;
    let cancelled = false;
    const load = () => {
      invoke<ScriptViewLayout[]>("scriptview:listLayouts")
        .then((l) => { if (!cancelled) setLayouts(l); })
        .catch(() => { /* keep the last good list; the next tick retries */ });
      invoke<CategoryRole[]>("scriptview:listRoles")
        .then((r) => { if (!cancelled) setRoles(r); })
        .catch(() => { /* as above */ });
      invoke<ScriptViewRundownDTO>("scriptview:rundown", { serviceTypeId })
        .then((r) => { if (!cancelled) { setRundown(r); setError(null); } })
        .catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [serviceTypeId, planId]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const skewMs = useServerSkew(pcoLive?.serverNow);

  const layout = useMemo(
    () => (scriptViewLayoutId ? layouts.find((l) => l.id === scriptViewLayoutId) ?? null : null),
    [layouts, scriptViewLayoutId],
  );
  const render = useScriptViewRender(rundown, layout, roles, pcoLive, now, skewMs);

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

      <ScriptViewBody
        rundown={rundown}
        roles={roles}
        layout={layout}
        render={render}
        error={serviceTypeId ? error : "Planning Center not configured"}
        textSizeClass={textSizeClass}
        autoScroll={autoScroll}
      />
    </div>
  );
}
