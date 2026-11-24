// Manage themes: every theme, and one theme's name, prompt, keep date, the
// services using it and everyone in it across all weeks.
//
// Reached from the panel's Themes block. A Redo here has no plan: the server
// makes it from the person's current Planning Center photo, or the one their
// approved photo was made from, and it waits for review like every other. So a
// card here can be Approved.

import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";

import { MAX_THEME_NAME, MAX_THEME_PROMPT, type ThemeDTO, type ThemePersonDTO } from "@main/types/photo-themes";

import { Button, Input, Textarea } from "../../../components/ui";
import { invoke as ipc } from "../../../lib/api";
import { useCardOps } from "./card-ops";
import { Num } from "./photo-bits";
import { keptDay } from "./photo-format";
import { PersonCard, type CardAction } from "./person-card";
import { DeleteTheme, ThemeFacts, themeLabel } from "./theme-boxes";
import type { PhotoThemes } from "./use-photo-themes";

export function ManageThemes({
  photos,
  themes,
  themeId,
  onPick,
  onBack,
}: {
  photos: PhotoThemes;
  themes: ThemeDTO[];
  themeId: string | null;
  onPick: (themeId: string) => void;
  onBack: () => void;
}) {
  const theme = themes.find((t) => t.id === themeId) ?? null;
  const ops = useCardOps(photos, themes);

  return (
    <>
      <div>
        <Button variant="transparent" size="small" onClick={onBack}>
          <ChevronLeftIcon className="size-3.5" />
          {theme ? "All themes" : "Theme photos"}
        </Button>
      </div>
      {!theme ? (
        <>
          <h4 className="m-0 text-[10px] font-medium uppercase tracking-[0.07em] text-fg-subtle">Manage themes</h4>
          {themes.map((t) => {
            const services = t.plans.length;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onPick(t.id)}
                className="flex w-full flex-col gap-0.5 rounded-[10px] border border-line px-3 py-2.5 text-left hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <b className="font-semibold">{themeLabel(t)}</b>
                <span className="text-caption1 text-fg-muted">
                  <Num>{t.people.length}</Num> {t.people.length === 1 ? "person" : "people"} · <Num>{services}</Num> {services === 1 ? "service" : "services"} · Kept until {keptDay(t.keptUntil)}
                </span>
              </button>
            );
          })}
          {themes.length === 0 && <p className="m-0 text-caption1 text-fg-muted">No themes yet. Make one from a service's Theme photos.</p>}
          <p className="m-0 text-caption1 text-fg-muted">Open a theme to rename it, change its prompt, and see every person in it across all weeks.</p>
        </>
      ) : (
        <ThemeDetail key={theme.id} theme={theme} photos={photos} ops={ops} onDeleted={onBack} />
      )}
    </>
  );
}

function ThemeDetail({
  theme,
  photos,
  ops,
  onDeleted,
}: {
  theme: ThemeDTO;
  photos: PhotoThemes;
  ops: ReturnType<typeof useCardOps>;
  onDeleted: () => void;
}) {
  // What is typed and not yet kept. The boxes show it over what the server holds,
  // and fall back to the server's the moment it is kept or refused.
  const [draft, setDraft] = useState<{ name?: string; prompt?: string }>({});
  const name = draft.name ?? theme.name;
  const prompt = draft.prompt ?? theme.prompt;

  /** Keep a field when it is left, and say whether the server holds what was typed. A refusal puts the box back to what it holds. */
  async function keep(field: "name" | "prompt"): Promise<boolean> {
    const typed = draft[field];
    if (typed === undefined) return true;
    const value = field === "name" ? typed.trim() : typed;
    const clear = () => setDraft(({ [field]: _gone, ...rest }) => rest);
    if (value === theme[field] || !value.trim()) {
      clear();
      return true;
    }
    let ok: boolean;
    if (field === "prompt") ok = await photos.savePrompt(theme.id, value);
    else {
      ok = (await photos.write(`name:${theme.id}`, () => ipc("photoThemes:updateTheme", { id: theme.id, name: value }))).ok;
      // Read it back before the box stops showing what was typed.
      if (ok) await photos.reread();
    }
    clear();
    return ok;
  }

  async function act(p: ThemePersonDTO, action: CardAction) {
    // A redo is billed from the prompt the server holds: keep what was typed first, and send nothing if it is refused.
    if (action === "redo") {
      if (!(await keep("prompt"))) return;
      await photos.write(`redo:${theme.id}:${p.personId}`, () => ipc("photoThemes:redo", { id: theme.id, personId: p.personId }));
    } else if (action === "approve") await photos.write(`approve:${theme.id}:${p.personId}`, () => ipc("photoThemes:approve", { id: theme.id, personId: p.personId, file: p.pending?.file }));
    else await photos.write(`keep:${theme.id}:${p.personId}`, () => ipc("photoThemes:keep", { id: theme.id, personId: p.personId }));
  }

  const busy = (p: ThemePersonDTO) => {
    const out = new Set<CardAction>();
    for (const a of ["redo", "approve", "keep"] as const) if (photos.isBusy(`${a}:${theme.id}:${p.personId}`)) out.add(a);
    return out;
  };

  return (
    <>
      <div>
        <label htmlFor="manage-theme-name" className="mb-1.5 block font-medium text-fg">
          Name
        </label>
        <Input
          id="manage-theme-name"
          value={name}
          maxLength={MAX_THEME_NAME}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onBlur={() => void keep("name")}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  />
      </div>
      <div>
        <label htmlFor="manage-theme-prompt" className="mb-1.5 block font-medium text-fg">
          Prompt
        </label>
        <Textarea
          id="manage-theme-prompt"
          rows={3}
          value={prompt}
          maxLength={MAX_THEME_PROMPT}
          onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
          onBlur={() => void keep("prompt")}
                  />
        <div className="mt-1 text-[11.5px] leading-[15px] text-fg-subtle">Changes the prompt for every service using {themeLabel(theme)}; existing approved photos stay until redone.</div>
      </div>
      <ThemeFacts theme={theme} timeZone={photos.timeZone} />
      <DeleteTheme theme={theme} photos={photos} onDeleted={onDeleted} />
      <h4 className="m-0 text-[10px] font-medium uppercase tracking-[0.07em] text-fg-subtle">
        People in this theme · <Num>{theme.people.length}</Num>
      </h4>
      {theme.people.length === 0 ? (
        <p className="m-0 text-caption1 text-fg-muted">Nobody has a photo in this theme yet.</p>
      ) : (
        <div role="list" aria-label={`People in ${themeLabel(theme)}`} className="grid grid-cols-[repeat(auto-fill,minmax(188px,1fr))] gap-2.5">
          {theme.people.map((p) => (
            <div role="listitem" key={p.personId} className="min-w-0">
              <PersonCard
                person={p}
                theme={theme}
                original={p.originalUrl}
                context={{ timeZone: photos.timeZone }}
                editedCaption="Themed"
                busy={busy(p)}
                canRedo={photos.canSend}
                onAction={(a) => void act(p, a)}
                onMenu={(kind) => ops.open(theme, p.personId, kind)}
                hasOtherTheme={ops.hasOtherTheme(theme)}
                confirm={ops.confirmFor(theme, p)}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
