// The Mic slots page's view of photo themes: the book, the plan's choice, how the
// OpenAI connection stands, and every write the Theme photos panel makes.
//
// Reads and writes are deliberately separate things:
//
//   - A READ is a query, and `photo-themes:changed` re-reads it (photo-themes-sync).
//   - A WRITE is a function a button calls. Nothing here sends a photo to OpenAI
//     from a query, an effect or a frame: `generate` and `redo` bill, and only a
//     press reaches them. Each is refused while one is in flight.
//
// Nothing is drawn optimistically. A write that is refused leaves the screen
// where the server has it, says the server's reason, and reads again so nothing
// looks saved that was not.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "@main/services/errors";
import {
  PHOTO_THEMES_CHANNEL,
  type OpenAiConnectionDTO,
  type PhotoThemesChanged,
  type PhotoThemesDTO,
  type PlanChoiceDTO,
  type PlanPeopleDTO,
  type ThemeDTO,
} from "@main/types/photo-themes";

import { invoke as ipc, onNotification } from "../../../lib/api";
import { toast } from "../../../components/ui";
import { readFrame } from "./photo-themes-sync";

/** Every photo-theme query starts here, so one invalidation reads them all. */
export const PHOTO_THEMES_KEY = ["photo-themes"] as const;
export const photoStateKey = [...PHOTO_THEMES_KEY, "state"] as const;
export const planPeopleKey = (planId: string, serviceTypeId: string) => [...PHOTO_THEMES_KEY, "plan", planId, serviceTypeId] as const;
export const OPENAI_KEY = ["openai", "status"] as const;

/** The plan Theme photos is for: the one the Mic slots page is editing. */
export interface PhotoPlan {
  planId: string;
  serviceTypeId: string;
  /** The plan's date, sent with a choice so the theme's keep date counts from it. */
  sortDate: string | null;
}

/** A connection that can send an edit. Out of credits and unreachable are
 *  "working" so far as pressing the button goes: the panel says what will happen. */
export function connectionWorks(c: OpenAiConnectionDTO | undefined): boolean {
  return !!c && c.state !== "not-connected" && c.state !== "invalid-key";
}

/** What a write answered: the value, or the reason the server gave. */
export type WriteResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function usePhotoThemes(plan: PhotoPlan | null) {
  const qc = useQueryClient();

  const stateQ = useQuery({ queryKey: photoStateKey, queryFn: () => ipc<PhotoThemesDTO>("photoThemes:getState") });

  // The channel is a position. The last frame seen is kept for the next, and the
  // latest for the progress line.
  const [frame, setFrame] = useState<PhotoThemesChanged | null>(null);
  useEffect(() => {
    let last: PhotoThemesChanged | null = null;
    return onNotification(PHOTO_THEMES_CHANNEL, (payload, replayed) => {
      const next = payload as PhotoThemesChanged;
      const reading = readFrame(last, next, replayed);
      // A replay is the cached last frame: it says where the count stands, and a
      // later frame still compares against it.
      last = next;
      setFrame(next);
      if (!reading.reread) return;
      if (reading.why === "missed" || reading.why === "restart") {
        console.info(`[photo-themes] a photo-themes:changed frame was missed (${reading.why}); reading the themes again`);
      }
      void qc.invalidateQueries({ queryKey: PHOTO_THEMES_KEY });
    });
  }, [qc]);

  const reread = useCallback(() => qc.invalidateQueries({ queryKey: PHOTO_THEMES_KEY }), [qc]);

  const state = stateQ.data;
  const choice: PlanChoiceDTO | null = useMemo(() => (plan ? (state?.plans.find((c) => c.planId === plan.planId) ?? null) : null), [state, plan]);
  const theme: ThemeDTO | null = useMemo(() => (choice?.themeId ? (state?.themes.find((t) => t.id === choice.themeId) ?? null) : null), [state, choice]);
  /** The plan uses a theme that has an approved photo: the Original | Themed switch is worth showing. */
  const hasApproved = !!theme?.people.some((p) => p.approved);

  // One write at a time per kind of billing action.
  const inFlight = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const isBusy = (key: string) => busy.has(key);

  /**
   * Make a write. `key` names it for the in-flight guard: pressing the same
   * thing again while it is out does nothing. `send` is the call itself, written
   * with its channel at the call site (api-channels.test.ts follows a literal,
   * and refuses a channel handed through as a value). Always reads again
   * afterwards, whether it landed or was refused, and says the server's reason
   * on a refusal.
   */
  const write = useCallback(
    async <T,>(key: string, send: () => Promise<T>): Promise<WriteResult<T>> => {
      if (inFlight.current.has(key)) return { ok: false, message: "That is already running." };
      inFlight.current.add(key);
      setBusy(new Set(inFlight.current));
      try {
        return { ok: true, value: await send() };
      } catch (err) {
        const message = errorMessage(err);
        toast.error(message);
        return { ok: false, message };
      } finally {
        inFlight.current.delete(key);
        setBusy(new Set(inFlight.current));
        void qc.invalidateQueries({ queryKey: PHOTO_THEMES_KEY });
      }
    },
    [qc],
  );

  return { state, stateError: stateQ.error, stateLoading: stateQ.isLoading, frame, choice, theme, hasApproved, reread, write, isBusy };
}

export type PhotoThemes = ReturnType<typeof usePhotoThemes>;

/** The plan's people and their photo in its theme. Read only while the panel is open. */
export function usePlanPeople(plan: PhotoPlan | null, enabled: boolean) {
  return useQuery({
    queryKey: plan ? planPeopleKey(plan.planId, plan.serviceTypeId) : [...PHOTO_THEMES_KEY, "plan", "none"],
    queryFn: () => ipc<PlanPeopleDTO>("photoThemes:getPlanPeople", { planId: plan!.planId, serviceTypeId: plan!.serviceTypeId }),
    enabled: enabled && !!plan,
  });
}
