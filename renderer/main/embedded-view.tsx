// One View, drawn inside a box, whatever kind it is.
//
// ONE component, called by both `view-embed` and `screen-embed`, because two
// copies would drift into two answers to "does a dashboard render in a tile" —
// and the whole point of a producer multiview is that every tile behaves the
// same.
//
// A custom view is the interesting case: it is the only kind holding a layout,
// so it is drawn with the SAME RenderObject a real display uses, at the box's
// own H. Nothing about it is a preview or an approximation; it is the display's
// own code path with a smaller canvas height.

import type { ReactNode } from "react";

import type { LayoutRenderCtx } from "./layout-renderer";
import { RenderObject } from "./layout-renderer";
import type { View } from "@main/types/views";
import { childChain, embedRefusal } from "./embed-chain";
import { ScriptView } from "./script-view";
import { DashboardView } from "./dashboard-view";
import { StageDisplayView } from "./stage-display-view";
import { TranscriptionView } from "./transcription-view";
import { SplRundownView } from "./spl-rundown-view";
import { SlotsColumns } from "../components/slots-columns";

export function EmbeddedView({
  view,
  ctx,
  displayId,
  showHeader = false,
  autoScroll = true,
}: {
  view: View;
  ctx: LayoutRenderCtx;
  /** Present when the embed is a SCREEN — dashboard, stage and SPL-rundown
   *  kinds are configured per display, so they need the id the tile came from. */
  displayId?: string | null;
  showHeader?: boolean;
  autoScroll?: boolean;
}) {
  const notice = (text: string) => (
    <div className="flex h-full items-center justify-center px-3 text-center text-caption1 text-fg-subtle">
      {text}
    </div>
  );

  /** Configured per DISPLAY, not per view. Without a display id there is nothing
   *  to read the configuration from, and saying so beats drawing an empty box
   *  the operator has to guess about. */
  const perDisplay = (what: string, render: (id: string) => ReactNode) =>
    displayId ? render(displayId) : notice(`A ${what} is set up per screen — embed the screen instead`);

  const refusal = embedRefusal(view.id, ctx.embedChain);
  if (refusal) return notice(refusal.message);

  switch (view.kind) {
    case "script":
      return (
        <ScriptView
          scriptViewLayoutId={view.scriptViewLayoutId ?? null}
          showHeader={showHeader}
          textSizeClass=""
          autoScroll={autoScroll}
        />
      );

    case "slots": {
      // SlotsColumns direct, rather than through a shared "slots for a view"
      // helper: the `slots-grid` OBJECT resolves its slots by object id first
      // (which is what gives a free-dragged grid its own avatar crop — see that
      // case in layout-renderer.tsx) and falls back to slotsByView. An embed has
      // no object of its own and must not take that crop, so the two resolutions
      // are deliberately different. SlotsColumns already IS the shared piece;
      // wrapping it in a component whose parameters said "am I the object or the
      // embed" would have been the duplication, not the cure.
      const slots = ctx.state.slotsByView?.[view.id] ?? [];
      if (slots.length === 0) return notice("No mic slots on this view");
      return (
        <SlotsColumns
          slots={slots}
          slotsLayout={view.slotsLayout ?? null}
          emptySlotLogo={ctx.state.emptySlotLogo}
          defaultAvatar={ctx.state.defaultAvatar}
          className="h-full w-full kiosk-surface"
        />
      );
    }

    case "transcription":
      // The display id is only a name here, so a transcription tile draws with
      // or without one — unlike the per-display kinds below.
      return <TranscriptionView displayId={displayId ?? null} />;

    case "dashboard":
      return perDisplay("dashboard", (id) => <DashboardView displayId={id} />);

    case "stage":
      return perDisplay("stage view", (id) => <StageDisplayView displayId={id} />);

    case "spl-rundown":
      return perDisplay("SPL rundown", (id) => <SplRundownView displayId={id} />);

    case "custom": {
      const objects = [...(view.layout?.objects ?? [])]
        .filter((o) => !o.hidden)
        .sort((a, b) => a.z - b.z);
      if (objects.length === 0) return notice(`"${view.name}" has nothing on it yet`);

      // The child's own context: this view pushed onto the chain. Objects
      // position by PERCENTAGE, so x/y/w/h need no conversion.
      //
      // `placed` is dropped deliberately. It is a map of pixel placements keyed
      // by the PARENT layout's object ids; a child layout's objects are not in
      // it, and carrying it would be a map nothing can hit that still has to be
      // reasoned about at every read.
      const childCtx: LayoutRenderCtx = {
        ...ctx,
        embedChain: childChain(view.id, ctx.embedChain),
        placed: undefined,
      };

      return (
        <div className="relative h-full w-full overflow-hidden">
          {objects.map((o) => (
            <RenderObject key={o.id} o={o} ctx={childCtx} />
          ))}
        </div>
      );
    }

    default: {
      // Exhaustive: a new ViewKind is a compile error here rather than a blank
      // tile discovered on a Sunday.
      const never: never = view.kind;
      void never;
      return notice("Unknown view kind");
    }
  }
}
