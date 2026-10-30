// The Mic slots page's dialogs: a new board, deleting one, its charger layout,
// and copying a layout over it.
//
// Each reports what the operator chose and does nothing else; the page does the
// writing (use-mic-slots.ts), so a dialog can be rendered with no server behind
// it.

import { useQueries } from "@tanstack/react-query";
import { useState } from "react";

import {
  Button,
  ButtonGroup,
  Checkbox,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  Input,
  NumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "../../components/ui";
import { invoke as ipc } from "../../lib/api";
import { planLabel } from "../../settings/sections/slots-target-pill";
import { useUpcomingPlans } from "../../settings/sections/plan-switcher";
import { useStageState } from "../../main/use-stage-state";
import { plural } from "@main/services/plural";
import type { ShowTarget } from "./use-mic-slots";

const NOBODY = "__nothing__";

/** "Left Display" or "Stage Layout · widget". */
export function showLabel(t: ShowTarget): string {
  return t.kind === "object" ? `${t.name} · widget` : t.name;
}

// ── New board ───────────────────────────────────────────────────────────────

type Start = "blank" | "board" | "layout";

export function NewBoardDialog({
  open,
  onOpenChange,
  boards,
  presets,
  targets,
  defaultFromBoardId,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  boards: SlotBoardDTO[];
  presets: SlotPreset[];
  targets: ShowTarget[];
  defaultFromBoardId: string | null;
  onCreate: (input: { name: string; from?: { boardId: string } | { presetId: string }; showOn: ShowTarget[] }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [start, setStart] = useState<Start>("blank");
  const [boardId, setBoardId] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const fromBoard = boardId ?? defaultFromBoardId ?? boards[0]?.id ?? null;
  const fromPreset = presetId ?? presets[0]?.id ?? null;
  const from =
    start === "board" && fromBoard ? { boardId: fromBoard } : start === "layout" && fromPreset ? { presetId: fromPreset } : undefined;
  const ready = name.trim().length > 0 && (start === "blank" || !!from);

  async function create() {
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), from, showOn: targets.filter((t) => shown.has(t.id)) });
      onOpenChange(false);
      setName("");
      setShown(new Set());
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New board</DialogTitle>
          <DialogDescription>A board is one set of mic slots that screens and layout widgets can show.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-board-name" className="text-footnote font-medium text-fg">Name</label>
            <Input id="new-board-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pastors widget" autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-footnote font-medium text-fg">Start from</span>
            <ButtonGroup role="group" aria-label="Start from">
              <Button size="small" variant={start === "blank" ? "accent" : "filled"} aria-pressed={start === "blank"} onClick={() => setStart("blank")}>
                Blank
              </Button>
              <Button
                size="small"
                variant={start === "board" ? "accent" : "filled"}
                aria-pressed={start === "board"}
                disabled={boards.length === 0}
                onClick={() => setStart("board")}
              >
                Copy of a board
              </Button>
              <Button
                size="small"
                variant={start === "layout" ? "accent" : "filled"}
                aria-pressed={start === "layout"}
                disabled={presets.length === 0}
                onClick={() => setStart("layout")}
              >
                A saved layout
              </Button>
            </ButtonGroup>
            {start === "board" && (
              <Select value={fromBoard ?? undefined} onValueChange={setBoardId}>
                <SelectTrigger aria-label="Board to copy"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {boards.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {start === "layout" && (
              <Select value={fromPreset ?? undefined} onValueChange={setPresetId}>
                <SelectTrigger aria-label="Saved layout"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {presets.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <span className="text-caption2 text-fg-subtle">
              {start === "board" ? "A copy brings every service type's layout with it." : start === "layout" ? "The layout goes under the service type and plan being edited." : "An empty board."}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-footnote font-medium text-fg">Show on</span>
            {targets.length === 0 ? (
              <span className="text-footnote text-fg-muted">No slots screens or widgets exist yet.</span>
            ) : (
              <>
                <span className="text-footnote text-fg-muted">Optional. Screens and layout widgets can also pick it later.</span>
                <div className="flex max-h-40 flex-col overflow-y-auto">
                  {targets.map((t) => (
                    <label key={t.id} className="flex items-center gap-2 py-1 text-footnote text-fg">
                      <Checkbox
                        checked={shown.has(t.id)}
                        onCheckedChange={(on) =>
                          setShown((prev) => {
                            const next = new Set(prev);
                            if (on === true) next.add(t.id);
                            else next.delete(t.id);
                            return next;
                          })
                        }
                      />
                      {showLabel(t)}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="transparent" size="small" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="accent" size="small" disabled={!ready || busy} onClick={() => void create()}>
            Create board
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

// ── Delete a board ──────────────────────────────────────────────────────────

/**
 * What goes with a board, as far as the page can see: the service types it has a
 * layout for and the upcoming plans with a layout of their own. Read from the
 * plans the switcher already lists, so a plan further out than that list is not
 * counted, and the dialog says so.
 */
function useBoardContents(boardId: string, enabled: boolean) {
  const { plans } = useUpcomingPlans({ enabled });
  const types = [...new Map(plans.map((p) => [p.serviceTypeId, p.serviceTypeName])).entries()];
  const typeQs = useQueries({
    queries: types.map(([id]) => ({
      queryKey: ["boards:contents", boardId, id, null],
      queryFn: () => ipc<SlotTargetsDTO>("boards:targets", { id: boardId, serviceTypeId: id, planId: null }),
      enabled,
    })),
  });
  const planQs = useQueries({
    queries: plans.map((p) => ({
      queryKey: ["boards:contents", boardId, p.serviceTypeId, p.planId],
      queryFn: () => ipc<SlotTargetsDTO>("boards:targets", { id: boardId, serviceTypeId: p.serviceTypeId, planId: p.planId }),
      enabled,
    })),
  });
  const withLayout = types.filter((_, i) => (typeQs[i]?.data?.defaultSlots.length ?? 0) > 0).map(([, name]) => name);
  const planOnly = planQs.filter((q) => q.data?.overrideSlots != null).length;
  const loading = typeQs.some((q) => q.isLoading) || planQs.some((q) => q.isLoading);
  return { withLayout, planOnly, loading };
}

export function DeleteBoardDialog({
  board,
  others,
  onClose,
  onDelete,
}: {
  board: SlotBoardDTO | null;
  others: SlotBoardDTO[];
  onClose: () => void;
  onDelete: (boardId: string, replacement: string | null) => Promise<void>;
}) {
  const [replacement, setReplacement] = useState<string>(NOBODY);
  const [busy, setBusy] = useState(false);
  // Off once the delete is under way: the board is going, and reading its layouts
  // again is a 404 per plan.
  const contents = useBoardContents(board?.id ?? "", !!board && !busy);
  if (!board) return null;
  const shown = board.shownOn;
  const names = shown.map((s) => (s.kind === "object" ? `${s.name} (widget)` : s.name));
  const choice = others.some((o) => o.id === replacement) ? replacement : NOBODY;

  async function go() {
    setBusy(true);
    try {
      await onDelete(board!.id, choice === NOBODY ? null : choice);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {board.name}?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-footnote text-fg-muted">
          <p>
            {contents.loading
              ? "Reading what it holds."
              : contents.withLayout.length > 0 || contents.planOnly > 0
                ? `It has layouts for ${contents.withLayout.length > 0 ? contents.withLayout.join(", ") : "no service type"}${
                    contents.planOnly > 0 ? `, plus ${plural(contents.planOnly, "plan-only layout")} on upcoming plans` : ""
                  }. They are deleted with it.`
                : "It has no saved layouts."}{" "}
            Plan-only layouts further out than the plan list are deleted too.
          </p>
          {shown.length > 0 ? (
            <>
              <p>
                {plural(shown.length, "screen or widget")} show it: {names.join(", ")}.
              </p>
              <div className="flex items-center gap-2.5">
                <span className="flex-1 text-footnote font-medium text-fg">Those screens show instead</span>
                <Select value={choice} onValueChange={setReplacement}>
                  <SelectTrigger className="w-48" aria-label="Show instead"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NOBODY}>Nothing</SelectItem>
                    {others.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : (
            <p>No screen or widget shows it.</p>
          )}
          <p className="text-caption2 text-fg-subtle">Save it as a saved layout first to keep a copy.</p>
        </div>
        <DialogFooter>
          <Button variant="transparent" size="small" onClick={onClose}>Cancel</Button>
          <Button variant="accent" size="small" disabled={busy} className="bg-danger-9 hover:bg-danger-9/90 active:bg-danger-9" onClick={() => void go()}>
            Delete board
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

// ── Charger layout ──────────────────────────────────────────────────────────

export const DEFAULT_COLUMN_WIDTH_IN = 3.49;
/** The width a 37 inch 16:9 panel has, offered for a screen that has none set. */
export const DEFAULT_DISPLAY_WIDTH_IN = 32.25;

export interface ChargerScreen {
  target: ShowTarget;
  /** What it has now; null for none. */
  displayWidthIn: number | null;
}

/**
 * A board's charger layout: align on or off, the column width, and the display
 * width of every screen and widget showing it. Alignment needs both halves, and
 * the display width is each one's own, so each is listed with an input (prefilled
 * with what it has, else a 37 inch panel's) and only what the operator applies is
 * written. Mounted per board and per opening: nothing typed and not applied is
 * kept for next time.
 */
export function ChargerLayoutDialog({
  board,
  screens,
  onClose,
  onApply,
}: {
  board: SlotBoardDTO | null;
  screens: ChargerScreen[];
  onClose: () => void;
  onApply: (boardId: string, columnWidthIn: number | null, displayWidths: { target: ShowTarget; widthIn: number }[]) => Promise<void>;
}) {
  const [width, setWidth] = useState<number | null | undefined>(undefined);
  const [screenWidths, setScreenWidths] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  if (!board) return null;
  const current = width === undefined ? board.columnWidthIn : width;
  const aligned = current !== null;
  const widthFor = (s: ChargerScreen) => screenWidths[s.target.id] ?? s.displayWidthIn ?? DEFAULT_DISPLAY_WIDTH_IN;
  // Written: the ones whose input differs from what is stored, and any with none stored.
  const displayWrites = aligned ? screens.filter((s) => s.displayWidthIn === null || widthFor(s) !== s.displayWidthIn) : [];
  const changed = current !== board.columnWidthIn || displayWrites.length > 0;

  async function apply() {
    setBusy(true);
    try {
      await onApply(board!.id, current, displayWrites.map((s) => ({ target: s.target, widthIn: widthFor(s) })));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Charger layout for {board.name}</DialogTitle>
          <DialogDescription>
            Columns are sized in inches against each screen's active width, so slots line up with the chargers below them.
            Add spacers for the gaps between charger banks and the side margins.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-footnote font-medium text-fg">
            <span className="flex-1">Align to chargers</span>
            <Switch aria-label="Align to chargers" checked={aligned} onCheckedChange={(on: boolean) => setWidth(on ? DEFAULT_COLUMN_WIDTH_IN : null)} />
          </label>
          {aligned && (
            <label className="flex items-center gap-2 text-footnote text-fg">
              <span className="flex-1">Charger column width</span>
              <NumberInput
                value={current}
                step={0.1}
                min={0.1}
                suffix="in"
                className="w-32"
                aria-label="Charger column width (inches)"
                onChange={(n) => setWidth(n)}
              />
            </label>
          )}
          {aligned && (
            <div className="flex flex-col gap-1.5">
              <span className="text-footnote font-medium text-fg">Display width, where it is shown</span>
              {screens.length === 0 ? (
                <span className="text-caption1 text-fg-muted">Nothing shows this board yet. Each screen sets its own display width when it does.</span>
              ) : (
                screens.map((s) => (
                  <label key={s.target.id} className="flex items-center gap-2 text-footnote text-fg">
                    <span className="flex-1 truncate">{showLabel(s.target)}</span>
                    <NumberInput
                      value={widthFor(s)}
                      step={0.25}
                      min={1}
                      suffix="in"
                      className="w-32"
                      aria-label={`Display width of ${showLabel(s.target)} (inches)`}
                      onChange={(n) => setScreenWidths((prev) => ({ ...prev, [s.target.id]: n }))}
                    />
                  </label>
                ))
              )}
              <span className="text-caption2 text-fg-subtle">A screen with no display width is not aligned. Only the widths you change, or ones not set yet, are written.</span>
            </div>
          )}
          <p className="text-caption2 text-fg-subtle">The column width is the board's, so every screen showing it shares it.</p>
        </div>
        <DialogFooter>
          <Button variant="transparent" size="small" onClick={onClose}>Cancel</Button>
          <Button variant="accent" size="small" disabled={!changed || busy} onClick={() => void apply()}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

// ── Copy from ───────────────────────────────────────────────────────────────

type Source = "board" | "type" | "plan";

export interface CopySource {
  fromBoardId?: string;
  fromServiceTypeId?: string;
  fromPlanId?: string;
}

/**
 * Copy a layout over one board (`boards` lists the boards it may come from) or
 * over every board (`boards` empty). A service type means its default, a plan
 * means that plan's own layout, else its type's default.
 */
export function CopyFromDialog({
  title,
  description,
  boards,
  onClose,
  onCopy,
}: {
  title: string;
  description: string;
  /** Boards that can be the source; none when copying over every board. */
  boards: SlotBoardDTO[];
  onClose: () => void;
  /** `sourceName` is how the source reads in a sentence: a board, "Weekend default", a plan. */
  onCopy: (from: CopySource, sourceName: string) => Promise<void>;
}) {
  const { plans } = useUpcomingPlans();
  const { state } = useStageState();
  const types = [...new Map(plans.map((p) => [p.serviceTypeId, p.serviceTypeName])).entries()];
  const [kind, setKind] = useState<Source>(boards.length > 0 ? "board" : "type");
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const options: { value: string; label: string }[] =
    kind === "board"
      ? boards.map((b) => ({ value: b.id, label: b.name }))
      : kind === "type"
        ? types.map(([id, name]) => ({ value: id, label: `${name} default` }))
        : plans.map((p) => ({ value: p.planId, label: `${planLabel(p.sortDate, p.dates, state?.timezone ?? null)} · ${p.serviceTypeName}` }));
  const chosen = options.some((o) => o.value === pick) ? pick : (options[0]?.value ?? null);

  function source(): CopySource | null {
    if (!chosen) return null;
    if (kind === "board") return { fromBoardId: chosen };
    if (kind === "type") return { fromServiceTypeId: chosen };
    const plan = plans.find((p) => p.planId === chosen);
    return { fromPlanId: chosen, ...(plan ? { fromServiceTypeId: plan.serviceTypeId } : {}) };
  }

  async function go() {
    const from = source();
    if (!from) return;
    const sourceName = options.find((o) => o.value === chosen)?.label ?? "that layout";
    setBusy(true);
    try {
      await onCopy(from, sourceName);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <ButtonGroup role="group" aria-label="Copy from">
            {boards.length > 0 && (
              <Button size="small" variant={kind === "board" ? "accent" : "filled"} aria-pressed={kind === "board"} onClick={() => setKind("board")}>
                Another board
              </Button>
            )}
            <Button size="small" variant={kind === "type" ? "accent" : "filled"} aria-pressed={kind === "type"} onClick={() => setKind("type")}>
              A service type
            </Button>
            <Button size="small" variant={kind === "plan" ? "accent" : "filled"} aria-pressed={kind === "plan"} onClick={() => setKind("plan")}>
              A plan
            </Button>
          </ButtonGroup>
          {options.length > 0 ? (
            <Select value={chosen ?? undefined} onValueChange={setPick}>
              <SelectTrigger aria-label="Copy from"><SelectValue /></SelectTrigger>
              <SelectContent>
                {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-footnote text-fg-muted">There is nothing of that kind to copy from.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="transparent" size="small" onClick={onClose}>Cancel</Button>
          <Button variant="accent" size="small" disabled={!chosen || busy} onClick={() => void go()}>
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
