// One person's photo in a theme, as a card: original beside edit, a status, what
// can be done next, and the Move / Copy / Remove menu. The panel's grid and the
// Manage themes view draw the same card; they differ in what they know (the panel
// has the original, Manage may not) and in where Redo goes.

import { CheckIcon, MoreHorizontalIcon, RotateCcwIcon, SparklesIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState, type ReactNode } from "react";

import type { ThemeDTO, ThemePersonDTO } from "@main/types/photo-themes";

import { Button, MENU_ITEM, MENU_ITEM_DANGER, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, menuContent } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { Avatar, Chip, InlineBox, Num, PhotoPair, Placeholder, ThemeTag, planningCenterPhoto, useEscapeFirst, type ChipTone } from "./photo-bits";
import { serviceDay } from "./photo-format";

export type CardAction = "redo" | "approve" | "keep";

export interface CardView {
  chip: { tone: ChipTone; label: string; check?: boolean };
  note: string | null;
  actions: CardAction[];
  edited: { kind: "photo"; src: string } | { kind: "none" } | { kind: "making" } | { kind: "failed" };
  border: "ok" | "bad" | null;
}

export interface CardContext {
  /** The plan the card is drawn for. Absent in Manage, which is across all weeks. */
  planId?: string;
  /** Planning Center has no photo for this person, so there is nothing to edit. */
  noOriginal?: boolean;
  /** Others on this plan already have a photo and this person has none: they were added after the last run. */
  addedLater?: boolean;
}

/** What a card says for a person's status. Pure, so each wording is one place. */
export function cardView(p: ThemePersonDTO, ctx: CardContext): CardView {
  const earlier = p.approved ? " The earlier themed photo stays on screen." : "";
  switch (p.status) {
    case "generating":
      return {
        chip: { tone: "plain", label: "Generating…" },
        note: p.approved ? "The earlier themed photo stays on screen until this one is approved." : null,
        actions: [],
        edited: { kind: "making" },
        border: null,
      };
    case "ready":
      return {
        chip: { tone: "ready", label: "Ready to review" },
        note: null,
        actions: ["redo", "approve"],
        edited: p.pending?.url ? { kind: "photo", src: p.pending.url } : { kind: "none" },
        border: null,
      };
    case "approved": {
      const from = p.approved?.fromPlanId && p.approved.fromPlanId !== ctx.planId ? serviceDay(p.approved.fromDate) : ctx.planId ? null : serviceDay(p.approved?.fromDate);
      return {
        chip: { tone: "ok", label: "Approved", check: true },
        note: from ? `From ${from}` : null,
        actions: ["redo"],
        edited: p.approved ? { kind: "photo", src: p.approved.url } : { kind: "none" },
        border: "ok",
      };
    }
    case "stale":
      return {
        chip: { tone: "warn", label: "Made from an older photo" },
        note: "Their Planning Center photo changed after this was made.",
        actions: ["redo", "keep"],
        edited: p.approved ? { kind: "photo", src: p.approved.url } : { kind: "none" },
        border: "bad",
      };
    case "failed":
      return {
        chip: { tone: "bad", label: "Failed" },
        note: `${p.pending?.reason ?? "It could not be made."}${earlier}`,
        actions: ["redo"],
        edited: { kind: "failed" },
        border: "bad",
      };
    case "none":
      return {
        chip: { tone: "plain", label: ctx.noOriginal ? "No Planning Center photo" : ctx.addedLater ? "Added after the last run" : "Not themed yet" },
        note: null,
        actions: [],
        edited: { kind: "none" },
        border: null,
      };
  }
}

export type MenuKind = "move" | "copy" | "remove";

export interface PersonCardProps {
  person: ThemePersonDTO;
  theme: ThemeDTO;
  /** The person's Planning Center photo. `undefined` when this view cannot know it: the original is left out. */
  original?: string | null;
  context: CardContext;
  /** Which of Redo / Approve / Keep are being sent now. */
  busy: ReadonlySet<CardAction>;
  /** Redo can be sent: OpenAI is connected. Approve and Keep call nobody, and never wait for it. */
  canRedo: boolean;
  onAction: (action: CardAction) => void;
  /** Whether the Move / Copy / Remove menu is offered, and what picking one does. */
  onMenu: (kind: MenuKind) => void;
  /** Move and Copy need another theme to go to. */
  hasOtherTheme: boolean;
  /** Where the confirm for Move, Copy or Remove opens. */
  confirm?: ReactNode;
  editedCaption?: string;
}

export function PersonCard({ person, theme, original, context, busy, canRedo, onAction, onMenu, hasOtherTheme, confirm, editedCaption }: PersonCardProps) {
  const view = cardView(person, context);
  const [menuOpen, setMenuOpen] = useState(false);
  const name = person.name;
  const edited =
    view.edited.kind === "photo" ? (
      <Avatar src={view.edited.src} label={`${name}, themed photo`} />
    ) : view.edited.kind === "making" ? (
      <Placeholder tone="making" label={`${name}, being made`} />
    ) : view.edited.kind === "failed" ? (
      <Placeholder tone="failed" label={`${name}, could not be made`} />
    ) : (
      <Placeholder tone="none" label={`${name}, not made yet`} />
    );
  return (
    <div
      data-person-card={person.personId}
      data-person-status={person.status}
      className={cn(
        "relative flex min-w-0 flex-col gap-2 rounded-[10px] border bg-surface p-2.5",
        view.border === "ok" ? "border-ok-9/45" : view.border === "bad" ? "border-danger-9/45" : "border-line",
      )}
    >
      {person.approved && (
        <div className="absolute right-1 top-1 z-[3]">
          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <Button variant="transparent" size="small" iconOnly aria-label={`More for ${name}`}>
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" className={menuContent("min-w-48")}>
                <DropdownMenu.Item className={MENU_ITEM} disabled={!hasOtherTheme} onSelect={() => onMenu("move")}>
                  Move to theme…
                </DropdownMenu.Item>
                <DropdownMenu.Item className={MENU_ITEM} disabled={!hasOtherTheme} onSelect={() => onMenu("copy")}>
                  Copy to theme…
                </DropdownMenu.Item>
                <DropdownMenu.Item className={MENU_ITEM_DANGER} onSelect={() => onMenu("remove")}>
                  Remove from theme…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
      <PhotoPair
        original={original === undefined ? undefined : <Avatar src={original ? planningCenterPhoto(original) : null} label={`${name}, original photo`} />}
        edited={edited}
        editedCaption={editedCaption}
      />
      <span className="truncate font-semibold text-fg">{name}</span>
      <ThemeTag icon={<SparklesIcon className="size-2.5" aria-hidden />}>{theme.name.trim() || "Untitled theme"}</ThemeTag>
      <Chip tone={view.chip.tone} icon={view.chip.check ? <CheckIcon className="size-3 stroke-[2.2]" aria-hidden /> : undefined} data-person-chip={person.status}>
        {view.chip.label}
      </Chip>
      {view.note && <span className="text-[11.5px] leading-[15px] text-fg-muted">{view.note}</span>}
      {view.actions.length > 0 && (
        <div className="mt-auto flex gap-1.5">
          {view.actions.includes("redo") && (
            <Button variant="filled" size="small" className="flex-1" disabled={busy.has("redo") || !canRedo}
              tooltip={canRedo ? "" : "Connect OpenAI in Integrations to redo"}
              aria-label={`Redo ${name}`}
              onClick={() => onAction("redo")}
            >
              <RotateCcwIcon className="size-3.5" />
              Redo
            </Button>
          )}
          {view.actions.includes("approve") && (
            <Button variant="accent" size="small" className="flex-1" disabled={busy.has("approve")} aria-label={`Approve ${name}`} onClick={() => onAction("approve")}>
              <CheckIcon className="size-3.5" />
              Approve
            </Button>
          )}
          {view.actions.includes("keep") && (
            <Button variant="filled" size="small" className="flex-1" disabled={busy.has("keep")} aria-label={`Keep the older photo for ${name}`} onClick={() => onAction("keep")}>
              Keep
            </Button>
          )}
        </div>
      )}
      {confirm}
    </div>
  );
}

// ── The confirms behind the menu ────────────────────────────────────────────

export interface PersonOp {
  kind: MenuKind;
  personId: string;
  /** The theme chosen to move or copy to. */
  target: string | null;
  /** Why the last attempt was refused, drawn inside the confirm. */
  error: string | null;
}

export function OpBox({
  op,
  person,
  theme,
  others,
  busy,
  onTarget,
  onGo,
  onCancel,
}: {
  op: PersonOp;
  person: ThemePersonDTO;
  theme: ThemeDTO;
  others: ThemeDTO[];
  busy: boolean;
  onTarget: (themeId: string) => void;
  onGo: () => void;
  onCancel: () => void;
}) {
  useEscapeFirst(onCancel);
  const services = theme.plans.length;
  const serviceWord = services === 1 ? "service" : "services";
  const themeName = theme.name.trim() || "Untitled theme";
  const error = op.error && (
    <span role="alert" className="text-danger-11">
      {op.error}
    </span>
  );
  if (op.kind === "remove") {
    return (
      <InlineBox label="Confirm remove">
        <span>
          {person.name} goes back to the original photo on <Num>{services}</Num> {serviceWord} using {themeName}.
        </span>
        {error}
        <span className="flex flex-wrap gap-1.5">
          <Button variant="filled" size="small" className="text-danger-11" disabled={busy} onClick={onGo}>
            Remove
          </Button>
          <Button variant="filled" size="small" onClick={onCancel}>
            Cancel
          </Button>
        </span>
      </InlineBox>
    );
  }
  const verb = op.kind === "move" ? "Move" : "Copy";
  const to = others.find((t) => t.id === op.target);
  const clash = to?.people.some((p) => p.personId === person.personId && p.approved) ? ` Replaces their photo in ${to.name.trim() || "Untitled theme"}.` : "";
  const what =
    op.kind === "move" ? (
      <>
        Moves {person.name}'s photo out of {themeName}; they go back to the original on <Num>{services}</Num> {serviceWord} using it.
      </>
    ) : (
      <>Copies {person.name}'s photo. Nothing changes here.</>
    );
  return (
    <InlineBox label={`Confirm ${verb.toLowerCase()}`}>
      <span className="font-medium">{verb} to theme</span>
      <Select value={op.target ?? ""} onValueChange={onTarget}>
        <SelectTrigger aria-label={`${verb} to theme`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {others.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name.trim() || "Untitled theme"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span>
        {what}
        {clash}
      </span>
      {error}
      <span className="flex flex-wrap gap-1.5">
        <Button variant="accent" size="small" disabled={busy || !to} onClick={onGo}>
          {verb}
        </Button>
        <Button variant="filled" size="small" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </InlineBox>
  );
}
