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
import { appZoneOf } from "../../../lib/app-zone";
import { useStageState } from "../../../main/use-stage-state";
import { toast } from "../../../components/ui";
import { readFrame } from "./photo-themes-sync";

/** Every photo-theme query starts here, so one invalidation reads them all. */
export const PHOTO_THEMES_KEY = ["photo-themes"] as const;
export const photoStateKey = [...PHOTO_THEMES_KEY, "state"] as const;
export const planPeopleKey = (planId: string, serviceTypeId: string) => [...PHOTO_THEMES_KEY, "plan", planId, serviceTypeId] as const;
export const OPENAI_KEY = ["openai", "status"] as const;

/** OpenAI's connection, read once and shared: the Integrations tile, its dialog and the
 *  key form all draw from this one query, so a saved key moves all three at once. A
 *  live `photo-themes:changed` frame carries the connection as it stands, so a key
 *  saved in another browser, or refused by an edit, moves them too. A replayed frame
 *  is the cached last one and may be old: the read stands over it. */
export function useOpenAiConnection() {
  const qc = useQueryClient();
  useEffect(
    () =>
      onNotification(PHOTO_THEMES_CHANNEL, (payload, replayed) => {
        const connection = (payload as Partial<PhotoThemesChanged>).connection;
        if (replayed || !connection) return;
        // A read still out would land after this and put the older value back: drop it.
        void qc.cancelQueries({ queryKey: OPENAI_KEY });
        qc.setQueryData(OPENAI_KEY, connection);
      }),
    [qc],
  );
  return useQuery({ queryKey: OPENAI_KEY, queryFn: () => ipc<OpenAiConnectionDTO>("openai:getStatus") });
}

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

  // The channel is a position: the last frame seen is kept, in the effect, to
  // read the next one against. Not in state: nothing draws a frame, and a
  // state copy re-rendered the whole Mic slots page on every one.
  useEffect(() => {
    let last: PhotoThemesChanged | null = null;
    return onNotification(PHOTO_THEMES_CHANNEL, (payload, replayed) => {
      const next = payload as PhotoThemesChanged;
      const reading = readFrame(last, next, replayed);
      // A replay is the cached last frame: it says where the count stands, and a
      // later frame still compares against it.
      last = next;
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
  /** What this plan's screens draw in place of Planning Center photos: the switch, the theme and each approved edit. A Mic slots board preview resolves again when it changes. */
  const shownKey = useMemo(
    () => `${choice?.show ?? ""}|${theme?.id ?? ""}|${(theme?.people ?? []).flatMap((p) => (p.approved ? [`${p.personId}@${p.approved.approvedAt}`] : [])).join(",")}`,
    [choice, theme],
  );
  /** The zone a plan's date is named in: the app's, never this browser's. */
  const timeZone = appZoneOf(useStageState().state);
  /** Generate and Redo can be sent: a key is saved and OpenAI has not rejected it. Nothing else waits for one. */
  const canSend = connectionWorks(state?.connection);

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
   * on a refusal (a toast, or quietly when the caller shows it itself).
   */
  const write = useCallback(
    async <T,>(key: string, send: () => Promise<T>, opts: { quiet?: boolean } = {}): Promise<WriteResult<T>> => {
      if (inFlight.current.has(key)) return { ok: false, message: "That is already running." };
      inFlight.current.add(key);
      setBusy(new Set(inFlight.current));
      try {
        return { ok: true, value: await send() };
      } catch (err) {
        const message = errorMessage(err);
        // `quiet`: the caller draws the reason where the operator is looking (inside a confirm).
        if (!opts.quiet) toast.error(message);
        return { ok: false, message };
      } finally {
        inFlight.current.delete(key);
        setBusy(new Set(inFlight.current));
        void qc.invalidateQueries({ queryKey: PHOTO_THEMES_KEY });
      }
    },
    [qc],
  );

  /**
   * Keep a typed prompt, and say whether the server holds it afterwards.
   *
   * ONE save per theme is in flight at a time, remembered with the text it carries. A
   * click on Generate or Redo arrives right behind the blur that started the save (the
   * button's mousedown is what blurs the box), so a second ask for the SAME text waits
   * for the first and answers what it answered; a refusal there is a refusal here, and
   * nothing billed goes out. Different text waits for the one before, then saves.
   */
  const saves = useRef(new Map<string, { text: string; done: Promise<boolean> }>());
  const savePrompt = useCallback(
    async (themeId: string, text: string): Promise<boolean> => {
      const prior = saves.current.get(themeId);
      if (prior) {
        const ok = await prior.done;
        if (prior.text === text) return ok;
      }
      const entry = {
        text,
        done: (async () => {
          const r = await write(`prompt:${themeId}`, () => ipc("photoThemes:updateTheme", { id: themeId, prompt: text }));
          // Read back before anyone stops showing what was typed, so the box never flashes the old text.
          if (r.ok) await reread();
          return r.ok;
        })(),
      };
      saves.current.set(themeId, entry);
      try {
        return await entry.done;
      } finally {
        if (saves.current.get(themeId) === entry) saves.current.delete(themeId);
      }
    },
    [write, reread],
  );

  return { state, stateError: stateQ.error, stateLoading: stateQ.isLoading, choice, theme, hasApproved, shownKey, canSend, timeZone, reread, write, savePrompt, isBusy };
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
