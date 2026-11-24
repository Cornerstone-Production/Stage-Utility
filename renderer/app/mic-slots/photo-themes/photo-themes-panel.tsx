// Theme photos: the sheet that turns a service's mic slot photos into themed ones.
//
// A right side sheet beside the boards on desktop, a bottom sheet on a phone. It
// is for ONE service (the plan the Mic slots page is on); the themes themselves
// belong to no service (Manage themes).
//
// Nothing here spends money except two buttons, Generate and Redo (and Redo all,
// which is Generate over everyone). Each is a press, each is refused while it is
// in flight, and each first saves a prompt that was typed and not yet kept: a
// billed edit made from text the operator can no longer see on the server would
// be the worst way to find out the save was refused.

import { CheckIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MAX_THEME_NAME, MAX_THEME_PROMPT, themedPhotoFileOf, type ApproveAllResultDTO, type PlanPersonDTO, type ThemeDTO } from "@main/types/photo-themes";
import { errorMessage } from "@main/services/errors";

import { Button, ErrorNote, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea, toast } from "../../../components/ui";
import { invoke as ipc } from "../../../lib/api";
import { cn } from "../../../lib/cn";
import { INLINE_LINK } from "../../../lib/link-classes";
import { useInAppLink } from "../../../lib/use-search-param";
import { useCardOps } from "./card-ops";
import { ManageThemes } from "./manage-themes";
import { STATES } from "./openai-wording";
import { Num, ShowSwitch } from "./photo-bits";
import { PersonCard, type CardAction } from "./person-card";
import { DeleteTheme, ThemeFacts, themeLabel } from "./theme-boxes";
import { type PhotoPlan, type PhotoThemes, usePlanPeople } from "./use-photo-themes";

const NEW_THEME = "__new";

export function PhotoThemesPanel({ plan, planLabel, photos, onClose }: { plan: PhotoPlan; planLabel: string; photos: PhotoThemes; onClose: () => void }) {
  const [manage, setManage] = useState<{ themeId: string | null } | null>(null);
  const root = useRef<HTMLElement>(null);

  // Focus moves into the sheet when it opens, and back to it when the view under it
  // changes (the button that was pressed is gone), so the keyboard is never left on <body>.
  const inManage = manage !== null;
  useEffect(() => root.current?.focus({ preventScroll: true }), [inManage]);
  // Escape puts it away from anywhere, a menu or a confirm that took it first excepted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const themes = photos.state?.themes ?? [];
  const people = usePlanPeople(plan, true);

  return (
    <>
      {/* A phone's sheet has the page behind it dimmed; tapping that closes it. */}
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-30 bg-scrim lg:hidden" />
      <section
        ref={root}
        role="dialog"
        aria-label="Theme photos"
        tabIndex={-1}
        data-photo-themes-panel
        className={cn(
          "flex min-h-0 flex-col bg-surface-raised text-footnote outline-none",
          // Phone and tablet: a bottom sheet, on a solid ground (the dark raised surface is a see-through tint).
          "max-lg:bg-bg max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:h-[82%] max-lg:rounded-t-2xl max-lg:border-t max-lg:border-line-strong max-lg:shadow-(--su-shadow-2)",
          // Desktop: a side sheet that sits in the page's own flow, as the inspector does.
          "lg:max-h-[calc(100dvh-9.25rem)] lg:rounded-xl lg:border lg:border-line-strong lg:shadow-(--su-shadow-1)",
        )}
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 flex-none rounded-sm bg-line-strong lg:hidden" />
        <div className="flex flex-none items-center gap-2 border-b border-line py-3 pl-4 pr-3">
          <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-[18px] text-fg">Theme photos · {planLabel}</h3>
          {photos.hasApproved && <ShowSwitch choice={photos.choice} plan={plan} photos={photos} />}
          <Button variant="transparent" size="small" iconOnly className="ml-auto flex-none" aria-label="Close Theme photos" onClick={onClose}>
            <XIcon className="size-4" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-4 pt-3.5" data-photo-themes-body>
          {photos.stateLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : photos.stateError ? (
            <ErrorNote>
              Couldn't read the themes: {errorMessage(photos.stateError)}.{" "}
              <button type="button" className="underline" onClick={() => void photos.reread()}>
                Try again
              </button>
            </ErrorNote>
          ) : manage ? (
            <ManageThemes
              photos={photos}
              themes={themes}
              themeId={manage.themeId}
              onPick={(themeId) => setManage({ themeId })}
              onBack={() => setManage(manage.themeId ? { themeId: null } : null)}
            />
          ) : (
            <PanelBody plan={plan} photos={photos} themes={themes} people={people} onManage={(themeId) => setManage({ themeId })} />
          )}
        </div>
      </section>
    </>
  );
}

function PanelBody({
  plan,
  photos,
  themes,
  people,
  onManage,
}: {
  plan: PhotoPlan;
  photos: PhotoThemes;
  themes: ThemeDTO[];
  people: ReturnType<typeof usePlanPeople>;
  onManage: (themeId: string | null) => void;
}) {
  const { theme, choice } = photos;
  const conn = photos.state?.connection;
  const goInApp = useInAppLink();
  const ops = useCardOps(photos, themes);
  const [newTheme, setNewTheme] = useState<{ name: string; prompt: string; error: string | null } | null>(null);
  const [draft, setDraft] = useState<{ themeId: string; text: string } | null>(null);
  const prompt = theme && draft?.themeId === theme.id ? draft.text : (theme?.prompt ?? "");

  const roster = people.data;
  const list = roster?.people ?? [];
  const planBusy = (what: string) => photos.isBusy(`${what}:${plan.planId}`);
  const generating = list.some((p) => p.status === "generating");
  const readyHere = list.filter((p) => p.status === "ready" && p.pending?.planId === plan.planId);
  const addedLater = list.some((p) => p.status !== "none");
  /** People on THIS service whose photo was made under an earlier prompt. Others' stay flagged on their own services. */
  const promptChangedHere = list.some((p) => p.promptChanged);

  async function choose(themeId: string) {
    if (themeId === NEW_THEME) return setNewTheme({ name: "", prompt: "", error: null });
    setNewTheme(null);
    await photos.write(`choose:${plan.planId}`, () => ipc("photoThemes:choosePlan", { planId: plan.planId, serviceTypeId: plan.serviceTypeId, sortDate: plan.sortDate, themeId }));
  }

  async function create() {
    if (!newTheme) return;
    const made = await photos.write<ThemeDTO>("create-theme", () => ipc("photoThemes:createTheme", { name: newTheme.name.trim(), prompt: newTheme.prompt.trim() }), { quiet: true });
    if (!made.ok) return setNewTheme({ ...newTheme, error: made.message });
    setNewTheme(null);
    await photos.write(`choose:${plan.planId}`, () =>
      ipc("photoThemes:choosePlan", { planId: plan.planId, serviceTypeId: plan.serviceTypeId, sortDate: plan.sortDate, themeId: made.value.id }),
    );
  }

  /** Save a prompt typed and not yet kept. False when it was refused: nothing may be sent from text the server does not have. */
  async function flushPrompt(): Promise<boolean> {
    if (!theme || !draft || draft.themeId !== theme.id || draft.text === theme.prompt) return true;
    if (!draft.text.trim()) {
      setDraft(null);
      return true;
    }
    const kept = await photos.savePrompt(theme.id, draft.text);
    // Kept or refused, the box goes back to what the server holds (refused: so nothing is sent from text it lacks).
    setDraft(null);
    return kept;
  }

  async function generate(mode: "missing" | "all") {
    if (!theme || !(await flushPrompt())) return;
    await photos.write(`generate:${plan.planId}`, () => ipc("photoThemes:generate", { planId: plan.planId, serviceTypeId: plan.serviceTypeId, mode }));
  }

  async function act(person: PlanPersonDTO, action: CardAction) {
    if (!theme) return;
    if (action === "redo") {
      if (!(await flushPrompt())) return;
      await photos.write(`redo:${theme.id}:${person.personId}`, () =>
        ipc("photoThemes:redo", { id: theme.id, personId: person.personId, planId: plan.planId, serviceTypeId: plan.serviceTypeId }),
      );
    } else if (action === "approve") {
      await photos.write(`approve:${theme.id}:${person.personId}`, () => ipc("photoThemes:approve", { id: theme.id, personId: person.personId, file: themedPhotoFileOf(person.pending?.url) }));
    } else {
      await photos.write(`keep:${theme.id}:${person.personId}`, () => ipc("photoThemes:keep", { id: theme.id, personId: person.personId }));
    }
  }

  /** Approve the ready edits on screen, each by the file shown: one redone meanwhile stays for another look. */
  async function approveAll() {
    const shown = readyHere.flatMap((p) => {
      const file = themedPhotoFileOf(p.pending?.url);
      return file ? [{ personId: p.personId, file }] : [];
    });
    const r = await photos.write<ApproveAllResultDTO>(`approve-all:${plan.planId}`, () => ipc("photoThemes:approveAll", { planId: plan.planId, people: shown }));
    if (r.ok && r.value.skipped.length > 0) {
      const names = r.value.skipped.map((id) => list.find((p) => p.personId === id)?.name ?? "Someone");
      toast.info(`Changed since it was shown, so left for another look: ${names.join(", ")}`);
    }
  }

  const toGenerate = roster?.toGenerate ?? 0;
  const generateLabel = generating ? "Generating…" : toGenerate === 0 ? `Everyone has a photo in ${theme ? themeLabel(theme) : "this theme"}` : `Generate ${toGenerate} for ${theme ? themeLabel(theme) : ""}`;
  // No key, or one OpenAI rejected, stops Generate and Redo; the rest of the sheet works without one.
  const trouble = conn && (!photos.canSend || STATES[conn.state].tone === "warn") ? conn : null;

  return (
    <>
      {/* The theme this service uses. */}
      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap font-medium text-fg">Theme:</span>
        <Select value={newTheme ? NEW_THEME : (theme?.id ?? "")} onValueChange={(v) => void choose(v)}>
          <SelectTrigger aria-label="Theme" className="w-full flex-1">
            <SelectValue placeholder="Choose a theme" />
          </SelectTrigger>
          <SelectContent>
            {themes.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {themeLabel(t)}
              </SelectItem>
            ))}
            <SelectItem value={NEW_THEME}>New theme…</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {newTheme && (
        <form
          aria-label="New theme"
          className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (newTheme.name.trim() && newTheme.prompt.trim()) void create();
          }}
        >
          <label htmlFor="new-theme-name" className="font-medium">
            Name
          </label>
          <Input
            id="new-theme-name"
            value={newTheme.name}
            maxLength={MAX_THEME_NAME}
            placeholder="Easter 2027"
            onChange={(e) => setNewTheme({ ...newTheme, name: e.target.value, error: null })}
          />
          <label htmlFor="new-theme-prompt" className="mt-1.5 font-medium">
            Prompt
          </label>
          <Textarea
            id="new-theme-prompt"
            rows={3}
            value={newTheme.prompt}
            maxLength={MAX_THEME_PROMPT}
            placeholder="Describe the look. Say to keep the face the same."
            onChange={(e) => setNewTheme({ ...newTheme, prompt: e.target.value, error: null })}
          />
          {newTheme.error && (
            <span role="alert" className="text-caption1 text-danger-11">
              {newTheme.error}
            </span>
          )}
          <span className="flex flex-wrap gap-1.5">
            <Button type="submit" variant="accent" size="small" disabled={!newTheme.name.trim() || !newTheme.prompt.trim() || photos.isBusy("create-theme")}>
              Create theme
            </Button>
            <Button type="button" variant="filled" size="small" onClick={() => setNewTheme(null)}>
              Cancel
            </Button>
          </span>
        </form>
      )}

      {theme ? (
        <>
          <div>
            <label htmlFor="photo-theme-prompt" className="mb-1.5 block font-medium text-fg">
              Prompt
            </label>
            <Textarea
              id="photo-theme-prompt"
              rows={3}
              value={prompt}
              maxLength={MAX_THEME_PROMPT}
              onChange={(e) => setDraft({ themeId: theme.id, text: e.target.value })}
              // Kept when the box is left: a theme's prompt is every service's, so it is not written per keystroke.
              onBlur={() => void flushPrompt()}
            />
            <div className="mt-1 flex justify-between gap-2 text-[11.5px] leading-[15px] text-fg-subtle">
              <span>Changes the prompt for every service using {themeLabel(theme)}</span>
              <Num>{prompt.length}</Num>
            </div>
          </div>

          {promptChangedHere && (
            <div role="status" data-prompt-changed className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-lg border border-warn-9/35 bg-warn-9/10 px-3 py-2 text-[12.5px] leading-[17px]">
              <span className="min-w-0 flex-[1_1_11rem]">The prompt for {themeLabel(theme)} changed; existing approved photos stay until redone.</span>
              <span className="flex gap-1.5">
                <Button variant="accent" size="small" disabled={planBusy("generate") || !photos.canSend} onClick={() => void generate("all")}>
                  Redo all
                </Button>
                <Button variant="filled" size="small" disabled={photos.isBusy(`keep-prompt:${theme.id}`)} onClick={() => void photos.write(`keep-prompt:${theme.id}`, () => ipc("photoThemes:keepPrompt", { id: theme.id }))}>
                  Keep these
                </Button>
              </span>
            </div>
          )}

          {trouble && (
            <div role="status" className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-lg border border-danger-9/35 bg-danger-9/10 px-3 py-2 text-[12.5px] leading-[17px]">
              <span className="min-w-0 flex-[1_1_11rem]">{trouble.reason ?? STATES[trouble.state].detail}</span>
              <a href="/settings/integrations" onClick={(e) => goInApp(e, { to: "/settings/integrations" })} className={INLINE_LINK}>
                Open Integrations
              </a>
            </div>
          )}

          {choice?.show === "original" && photos.hasApproved && (
            <p role="status" data-showing-original className="rounded-lg bg-fill px-3 py-2 text-caption1 text-fg-muted">
              Screens are showing the original photos. Switch to Themed to show the approved ones.
            </p>
          )}

          <div className="flex flex-col items-start gap-2">
            <Button variant="accent" size="medium" disabled={generating || toGenerate === 0 || planBusy("generate") || people.isLoading || !photos.canSend} onClick={() => void generate("missing")} data-generate>
              <SparklesIcon className="size-4" />
              {generateLabel}
            </Button>
            <p className="m-0 text-caption1 text-fg-muted">Spends only on people without a photo in this theme. Faces can change. Review each one; only approved photos go on screens.</p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5">
            <h4 className="m-0 text-[10px] font-medium uppercase tracking-[0.07em] text-fg-subtle">
              People · <Num>{list.length}</Num>
            </h4>
            <Button variant="filled" size="small" disabled={readyHere.length === 0 || planBusy("approve-all")} onClick={() => void approveAll()}>
              <CheckIcon className="size-3.5" />
              Approve all ready{readyHere.length > 0 && <> (<Num>{readyHere.length}</Num>)</>}
            </Button>
          </div>

          {people.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : people.isError ? (
            <ErrorNote>
              Couldn't read this service's people: {errorMessage(people.error)}.{" "}
              <button type="button" className="underline" onClick={() => void people.refetch()}>
                Try again
              </button>
            </ErrorNote>
          ) : roster?.roster === "unavailable" ? (
            <ErrorNote>Couldn't read who is on this service: {roster.reason ?? "its roster is not available"}.</ErrorNote>
          ) : list.length === 0 ? (
            <p className="m-0 text-caption1 text-fg-muted">Nobody is on this service's boards yet, so there are no photos to theme.</p>
          ) : (
            <div role="list" aria-label="People" className="grid grid-cols-[repeat(auto-fill,minmax(188px,1fr))] gap-2.5">
              {list.map((p) => (
                <div role="listitem" key={p.personId} className="min-w-0">
                  <PersonCard
                    person={p}
                    theme={theme}
                    original={p.originalUrl}
                    context={{ planId: plan.planId, noOriginal: !p.originalUrl, addedLater, timeZone: photos.timeZone }}
                    busy={busyActions(photos, theme.id, p.personId)}
                    canRedo={photos.canSend}
                    onAction={(a) => void act(p, a)}
                    onMenu={(kind) => ops.open(theme, p.personId, kind)}
                    hasOtherTheme={ops.hasOtherTheme(theme)}
                    confirm={ops.confirmFor(theme, p)}
                  />
                </div>
              ))}
              <div role="status" aria-live="polite" className="sr-only" data-photo-live>
                {list.filter((p) => p.status === "ready").length} ready to review, {list.filter((p) => p.status === "approved" || p.status === "stale").length} approved,{" "}
                {list.filter((p) => p.status === "failed").length} failed.
              </div>
            </div>
          )}
        </>
      ) : (
        !newTheme && <p className="m-0 text-caption1 text-fg-muted">Pick a theme to reuse its approved photos on this service, or make a new one.</p>
      )}

      <ThemesBlock themes={themes} usedHere={theme?.id ?? null} photos={photos} onManage={onManage} />
    </>
  );
}

function busyActions(photos: PhotoThemes, themeId: string, personId: string): ReadonlySet<CardAction> {
  const out = new Set<CardAction>();
  for (const a of ["redo", "approve", "keep"] as const) if (photos.isBusy(`${a}:${themeId}:${personId}`)) out.add(a);
  return out;
}

/** Every theme, at the foot of the panel: open one to manage it, or delete it. */
function ThemesBlock({ themes, usedHere, photos, onManage }: { themes: ThemeDTO[]; usedHere: string | null; photos: PhotoThemes; onManage: (themeId: string | null) => void }) {
  return (
    <div aria-label="Themes" data-themes-block className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <h4 className="m-0 text-[10px] font-medium uppercase tracking-[0.07em] text-fg-subtle">Themes</h4>
        <Button variant="filled" size="small" onClick={() => onManage(null)}>
          Manage themes
        </Button>
      </div>
      <p className="m-0 text-caption1 text-fg-muted">Kept until 3 months after the last service that uses a theme; using it again pushes the date out.</p>
      {themes.map((t) => (
        <div key={t.id} className="flex flex-col gap-1 rounded-[10px] border border-line px-3 py-2.5">
          <span>
            <b className="font-semibold">{themeLabel(t)}</b>{" "}
            {t.id === usedHere && <span className="ml-1 rounded-full bg-accent-soft px-2 py-px text-[11.5px] font-medium text-accent-soft-fg">This plan</span>}
          </span>
          <ThemeFacts theme={t} timeZone={photos.timeZone} showPeople />
          <span className="flex flex-wrap gap-1.5">
            <Button variant="filled" size="small" onClick={() => onManage(t.id)}>
              Manage
            </Button>
          </span>
          <DeleteTheme theme={t} photos={photos} />
        </div>
      ))}
    </div>
  );
}
