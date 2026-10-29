// The Mic slots page's state: every board, the unsaved edits to each, and what
// the operator can do to them.
//
// ONE EDIT BUFFER, ONE SAVE. `edits` holds the slot list of every board that has
// unsaved work, and nothing else; a board with no entry shows what the server
// holds. Save all sends every entry in a single request, which the server checks
// as a whole and writes as a whole. Nothing the operator does to a layout here
// (drag, stack, type in the inspector, recall a saved layout) reaches a screen
// before that.
//
// What the server writes at once is the board's own bookkeeping: its name, its
// column width, which screens show it, and copying one board's layout over
// another. Those are not layouts-in-progress, and each asks first when it would
// replace a board that has unsaved work.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { confirm, toast } from "../../components/ui";
import { invoke as ipc } from "../../lib/api";
import { useStageState } from "../../main/use-stage-state";
import { useEditingTarget, registerTargetGuard } from "../../settings/sections/editing-target";
import { boardTargetsKey, confirmDiscardSlotEdits, namedType, useSlotsTarget, type SlotsTargetSide } from "../../settings/sections/slots-target-pill";
import { errorMessage } from "@main/services/errors";
import { gridBoardId, forEachSlotsGrid, viewBoardId } from "@main/services/slot-boards";
import { plural } from "@main/services/plural";
import {
  append,
  findSlot,
  insertAfter,
  locate,
  nudge,
  removeSlot,
  stackIntoPrevious,
  toggleStacked,
  unstack,
  type Boards,
} from "./board-model";
import { duplicateOf, newSlot, newSpacer } from "./slot-factory";

export const BOARDS_KEY = ["boards:list"] as const;
const TARGETS_PREFIX = ["boards:targets"] as const;
export const checkKey = (serviceTypeId: string | null, planId: string | null) => ["boards:check", serviceTypeId, planId] as const;

const NO_SLOTS: Slot[] = [];

/** The wire target for a write: the type's default, or one plan's own layout. */
export type WireTarget =
  | { kind: "default"; serviceTypeId: string }
  | { kind: "plan"; planId: string; serviceTypeId: string; sortDate: string | null };

/** Where a board can be shown: a slots screen, or a slots widget on a custom layout. */
export interface ShowTarget {
  kind: "view" | "object";
  /** The view id, or the layout object id. */
  id: string;
  /** The view that holds it (the view itself for a screen). */
  viewId: string;
  name: string;
  /** The board it shows now. */
  boardId: string | null;
}

/** Every slots screen and slots widget, whichever board each shows. */
export function showTargets(views: readonly View[]): ShowTarget[] {
  const out: ShowTarget[] = [];
  for (const v of views) {
    if (v.kind === "slots") out.push({ kind: "view", id: v.id, viewId: v.id, name: v.name, boardId: viewBoardId(v) });
  }
  forEachSlotsGrid(views, (oid, config, v) => {
    out.push({ kind: "object", id: oid, viewId: v.id, name: v.name, boardId: gridBoardId(config, oid) });
  });
  return out;
}

export interface CopyFrom {
  fromBoardId?: string;
  fromServiceTypeId?: string;
  fromPlanId?: string;
}

/** The display width a screen or widget has set, or null for none. */
export function displayWidthOf(t: ShowTarget, views: readonly View[]): number | null {
  const v = views.find((x) => x.id === t.viewId);
  if (!v) return null;
  if (t.kind === "view") return v.slotsLayout?.displayWidthIn ?? null;
  let found: number | null = null;
  forEachSlotsGrid([v], (oid, config) => {
    if (oid === t.id) found = config.displayWidthIn ?? config.slotsLayout?.displayWidthIn ?? null;
  });
  return found;
}

export interface Selection {
  boardId: string;
  slotId: string;
}

export function useMicSlots() {
  const { state } = useStageState();
  const qc = useQueryClient();
  const editing = useEditingTarget();
  const { serviceTypeId, planId } = editing.target;

  // ── boards ───────────────────────────────────────────────────────────
  const boardsQ = useQuery({ queryKey: BOARDS_KEY, queryFn: () => ipc<SlotBoardDTO[]>("boards:list") });
  const boards = useMemo(() => boardsQ.data ?? [], [boardsQ.data]);

  // Where each board is shown is the server's answer, and it changes when a
  // screen is pointed somewhere else from elsewhere. Re-read when the set of
  // screens and widgets, or what they point at, changes: a signature, because the
  // views array is a new object on every state frame.
  const views = state?.views ?? [];
  const pointers = JSON.stringify(showTargets(views).map((t) => [t.id, t.name, t.boardId]));
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: BOARDS_KEY });
  }, [pointers, qc]);

  // ── which plan, and which side of it ─────────────────────────────────
  // One target for the whole page, read off the first board: the plan's date and
  // the service type's name are the same whichever board they are asked of.
  const pageTarget = useSlotsTarget(boards[0]?.id ?? "");
  const { hasPlan, side: effectiveSide, setSide: setOwnSide, label, typeName, wireTarget } = pageTarget;

  // ── every board's two layouts at the target being edited ─────────────
  const targetQs = useQueries({
    queries: boards.map((b) => ({
      queryKey: boardTargetsKey(b.id, serviceTypeId, planId),
      queryFn: () => ipc<SlotTargetsDTO>("boards:targets", { id: b.id, serviceTypeId, planId }),
      enabled: !!serviceTypeId,
    })),
  });
  const targetsById = new Map<string, SlotTargetsDTO | undefined>(boards.map((b, i) => [b.id, targetQs[i]?.data]));
  const dataVersion = targetQs.map((q) => q.dataUpdatedAt).join(",");
  const targetsFailed = targetQs.find((q) => q.isError)?.error ?? null;

  // ── unsaved work ─────────────────────────────────────────────────────
  const [edits, setEdits] = useState<Record<string, Slot[]>>({});
  const dirtyIds = Object.keys(edits).filter((id) => boards.some((b) => b.id === id));
  const dirty = dirtyIds.length > 0;

  /** What each board shows now: its unsaved edit, else the saved rows for the
   *  side being edited. Stable between renders, because the previews resolve on
   *  the identity of these arrays. */
  const boardsMap: Boards = useMemo(() => {
    const out: Boards = {};
    for (const b of boards) {
      const t = targetsById.get(b.id);
      const saved = !t ? NO_SLOTS : [...(effectiveSide === "plan" ? (t.overrideSlots ?? t.defaultSlots) : t.defaultSlots)].sort((a, c) => a.order - c.order);
      out[b.id] = edits[b.id] ?? saved;
    }
    return out;
    // `targetsById` is rebuilt every render; `dataVersion` says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards, dataVersion, effectiveSide, edits]);
  const latest = useRef(boardsMap);
  latest.current = boardsMap;

  const loaded = boards.length === 0 || boards.every((b) => !!targetsById.get(b.id));
  const hasOverride = boards.some((b) => targetsById.get(b.id)?.overrideSlots != null);

  /** Apply a move to every board at once; boards it did not change stay clean. */
  function mutate(fn: (b: Boards) => Boards): void {
    const base = latest.current;
    const next = fn(base);
    if (next === base) return;
    const changed: Record<string, Slot[]> = {};
    for (const id of Object.keys(next)) if (next[id] !== base[id]) changed[id] = next[id]!;
    latest.current = { ...base, ...changed };
    setEdits((prev) => ({ ...prev, ...changed }));
  }

  // ── selection ────────────────────────────────────────────────────────
  const [picked, setPicked] = useState<string | null>(null);
  const at = picked ? locate(boardsMap, picked) : null;
  const selection: Selection | null = picked && at ? { boardId: at.boardId, slotId: picked } : null;
  const selectedSlot = selection ? findSlot(boardsMap, selection.slotId) : null;

  // ── refreshing ───────────────────────────────────────────────────────
  async function refresh(): Promise<void> {
    await Promise.all([
      qc.invalidateQueries({ queryKey: BOARDS_KEY }),
      qc.invalidateQueries({ queryKey: TARGETS_PREFIX }),
      qc.invalidateQueries({ queryKey: ["boards:check"] }),
    ]);
  }
  function takeState(next: StageState): void {
    qc.setQueryData(["stage:getState"], next);
  }

  // ── leaving with unsaved work ────────────────────────────────────────
  // The plan switcher asks this question from its own header, so the page
  // registers while dirty and withdraws when clean.
  useEffect(() => {
    if (!dirty) return;
    registerTargetGuard("mic-slots", async () => {
      if (!(await confirmDiscardSlotEdits())) return false;
      setEdits({});
      return true;
    });
    return () => registerTargetGuard("mic-slots", null);
  }, [dirty]);

  /** Move to the other side. False when it did not move (already there, or the
   *  operator kept their unsaved work). */
  async function setSide(next: SlotsTargetSide): Promise<boolean> {
    if (next === effectiveSide) return false;
    if (dirty) {
      if (!(await confirmDiscardSlotEdits())) return false;
      setEdits({});
    }
    setOwnSide(next);
    return true;
  }

  // ── Save all ─────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  /** The refusal from the last Save all, and the board it named when it did. */
  const [saveError, setSaveError] = useState<{ message: string; boardId: string | null } | null>(null);

  async function saveAll(): Promise<boolean> {
    return submitSave(dirtyIds, false);
  }

  /**
   * Write these boards' edits in one request.
   *
   * A board deleted from another tab makes the whole request a 404 (it is all or
   * nothing). The page then re-reads the boards, drops what vanished, says whose
   * edits went, and saves the rest once, so one dead board does not strand the
   * others' work.
   */
  async function submitSave(ids: string[], retried: boolean): Promise<boolean> {
    if (ids.length === 0) return true;
    setSaving(true);
    setSaveError(null);
    try {
      const target = wireTarget();
      const next = await ipc<StageState>("boards:saveAll", {
        boards: ids.map((id) => ({
          boardId: id,
          slots: edits[id]!.map((s, i) => ({ ...s, order: i })),
          ...(target ? { target } : {}),
        })),
      });
      takeState(next);
      setEdits((prev) => {
        const rest = { ...prev };
        for (const id of ids) delete rest[id];
        return rest;
      });
      await refresh();
      pageTarget.announceSaved(plural(ids.length, "board"));
      return true;
    } catch (err) {
      const message = errorMessage(err);
      if (!retried) {
        const fresh = await qc.fetchQuery({ queryKey: BOARDS_KEY, queryFn: () => ipc<SlotBoardDTO[]>("boards:list"), staleTime: 0 }).catch(() => null);
        const gone = fresh ? ids.filter((id) => !fresh.some((b) => b.id === id)) : [];
        if (gone.length > 0) {
          const names = gone.map((id) => boards.find((b) => b.id === id)?.name ?? id);
          dropEditsOf(gone);
          toast.error(`${names.join(", ")} ${names.length === 1 ? "was" : "were"} deleted elsewhere, so ${names.length === 1 ? "its" : "their"} unsaved changes were dropped.`);
          return submitSave(ids.filter((id) => !gone.includes(id)), true);
        }
      }
      // The server names the board it refused: `Board "Left wall": …`.
      const named = boards.find((b) => message.startsWith(`Board "${b.name}"`));
      setSaveError({ message, boardId: named?.id ?? null });
      toast.error(`Nothing was saved. ${message}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  function dropEditsOf(boardIds: readonly string[]): void {
    setEdits((prev) => {
      const rest = { ...prev };
      for (const id of boardIds) delete rest[id];
      return rest;
    });
  }

  // A board deleted elsewhere while it has unsaved work: its edits go, and the
  // operator is told whose, rather than the work quietly vanishing from the count.
  const knownNames = useRef(new Map<string, string>());
  useEffect(() => {
    for (const b of boards) knownNames.current.set(b.id, b.name);
    if (!boardsQ.isSuccess) return;
    const gone = Object.keys(edits).filter((id) => !boards.some((b) => b.id === id));
    if (gone.length === 0) return;
    dropEditsOf(gone);
    const names = gone.map((id) => knownNames.current.get(id) ?? id);
    toast.error(`${names.join(", ")} ${names.length === 1 ? "was" : "were"} deleted elsewhere, so ${names.length === 1 ? "its" : "their"} unsaved changes were dropped.`);
  }, [boards, boardsQ.isSuccess, edits]);

  function discardAll(): void {
    setEdits({});
    setSaveError(null);
  }

  /** Throw away every board's unsaved edits, after asking. */
  async function discard(): Promise<boolean> {
    if (dirtyIds.length === 0) return true;
    const names = dirtyIds.map((id) => boards.find((b) => b.id === id)?.name ?? id).join(", ");
    const ok = await confirm({
      title: "Discard unsaved changes?",
      message: `The edits to ${names} that are not saved yet are lost, and each board goes back to what is saved.`,
      confirmLabel: "Discard",
      destructive: true,
    });
    if (ok) discardAll();
    return ok;
  }

  // ── layout edits ─────────────────────────────────────────────────────
  /** Slots the check asked to show (its "Show them"); cleared by the next selection. */
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(new Set());
  function select(slotId: string | null): void {
    setPicked(slotId);
    setHighlighted((prev) => (prev.size === 0 ? prev : new Set()));
  }
  /** Mark these slots and select the first, so the inspector and the preview agree. */
  function showSlots(slotIds: readonly string[]): void {
    setPicked(slotIds[0] ?? null);
    setHighlighted(new Set(slotIds));
  }

  function updateSlot(slotId: string, fn: (s: Slot) => Slot): void {
    const where = locate(latest.current, slotId);
    if (!where) return;
    const list = latest.current[where.boardId]!;
    const next = list.map((s) => (s.id === slotId ? fn(s) : s));
    latest.current = { ...latest.current, [where.boardId]: next };
    setEdits((prev) => ({ ...prev, [where.boardId]: next }));
  }

  /** A new slot at the end of a board. `init` fills it in (the check's "Add to"
   *  starts it on the position that had nobody to take it). */
  function addSlot(boardId: string, init?: Partial<Slot>): void {
    const base = latest.current[boardId] ?? NO_SLOTS;
    const slot = { ...newSlot(base), ...init };
    mutate((b) => append(b, boardId, slot));
    setPicked(slot.id);
  }
  function addSpacer(boardId: string): void {
    const base = latest.current[boardId] ?? NO_SLOTS;
    const slot = newSpacer(base);
    mutate((b) => append(b, boardId, slot));
    setPicked(slot.id);
  }
  function duplicateSlot(slotId: string): void {
    const where = locate(latest.current, slotId);
    const slot = findSlot(latest.current, slotId);
    if (!where || !slot) return;
    const copy = duplicateOf(slot, latest.current[where.boardId]!);
    mutate((b) => insertAfter(b, slotId, copy));
    setPicked(copy.id);
  }
  function removeSelected(slotId: string): void {
    const where = locate(latest.current, slotId);
    mutate((b) => removeSlot(b, slotId));
    if (picked === slotId) {
      const first = where ? latest.current[where.boardId]?.find((s) => s.link.kind !== "spacer") : undefined;
      setPicked(first?.id ?? null);
    }
  }
  function toggleStack(slotId: string): void {
    mutate((b) => toggleStacked(b, slotId));
  }
  function stackSlot(slotId: string): void {
    mutate((b) => stackIntoPrevious(b, slotId));
  }
  function unstackSlot(slotId: string): void {
    mutate((b) => unstack(b, slotId));
  }
  function nudgeSlot(slotId: string, dir: Parameters<typeof nudge>[2]): void {
    mutate((b) => nudge(b, slotId, dir));
  }
  /** A saved layout recalled into a board: the editor only, nothing saved. */
  function replaceBoard(boardId: string, slots: Slot[]): void {
    const next = slots.map((s, i) => ({ ...s, order: i }));
    latest.current = { ...latest.current, [boardId]: next };
    setEdits((prev) => ({ ...prev, [boardId]: next }));
    setPicked(null);
  }
  function dropEdits(boardId: string): void {
    setEdits((prev) => {
      const { [boardId]: _gone, ...rest } = prev;
      return rest;
    });
  }

  /** Ask before a write that would replace a board's rows, when it has unsaved
   *  work. True to go ahead, with that work dropped. */
  async function confirmReplace(boardId: string, what: string): Promise<boolean> {
    if (!(boardId in edits)) return true;
    const name = boards.find((b) => b.id === boardId)?.name ?? "This board";
    const ok = await confirm({
      title: `Replace the unsaved changes to ${name}?`,
      message: `${what} The edits to ${name} that are not saved yet are lost.`,
      confirmLabel: "Replace",
      destructive: true,
    });
    if (ok) dropEdits(boardId);
    return ok;
  }

  // ── what the server does at once ─────────────────────────────────────
  /** Run a write; a failure is a toast naming it, and `undefined` to the caller. */
  async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (err) {
      toast.error(`Couldn't ${what}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  async function createBoard(input: {
    name: string;
    from?: { boardId: string } | { presetId: string };
    showOn: ShowTarget[];
  }): Promise<string | null> {
    const target = wireTarget();
    const made = await attempt("create the board", () =>
      ipc<{ id: string; boards: SlotBoardDTO[] }>("boards:create", { name: input.name, from: input.from, target }),
    );
    if (!made) return null;
    qc.setQueryData(BOARDS_KEY, made.boards);
    for (const t of input.showOn) await showOn(t, made.id);
    await refresh();
    setPicked(null);
    return made.id;
  }

  async function renameBoard(boardId: string, name: string): Promise<void> {
    const list = await attempt("rename the board", () => ipc<SlotBoardDTO[]>("boards:update", { id: boardId, name }));
    if (list) qc.setQueryData(BOARDS_KEY, list);
  }

  async function duplicateBoard(boardId: string): Promise<string | null> {
    const made = await attempt("duplicate the board", () =>
      ipc<{ id: string; boards: SlotBoardDTO[] }>("boards:duplicate", { id: boardId }),
    );
    if (!made) return null;
    qc.setQueryData(BOARDS_KEY, made.boards);
    await refresh();
    return made.id;
  }

  async function deleteBoard(boardId: string, replacement: string | null): Promise<boolean> {
    const next = await attempt("delete the board", () => ipc<StageState>("boards:delete", { id: boardId, replacement }));
    if (!next) return false;
    takeState(next);
    dropEdits(boardId);
    // The board is gone: asking for its layouts again is a 404 in the console.
    qc.removeQueries({ queryKey: ["boards:targets", boardId] });
    qc.removeQueries({ queryKey: ["boards:contents", boardId] });
    await refresh();
    return true;
  }

  async function setColumnWidth(boardId: string, columnWidthIn: number | null): Promise<void> {
    const list = await attempt("set the charger layout", () => ipc<SlotBoardDTO[]>("boards:update", { id: boardId, columnWidthIn }));
    if (list) qc.setQueryData(BOARDS_KEY, list);
  }

  /**
   * Change a widget's config in its view's layout and save that layout. `layoutRev`
   * makes a layout somebody else changed a refusal instead of an overwrite.
   */
  async function rewriteGrid(
    t: ShowTarget,
    what: string,
    change: (c: Extract<LayoutObjectConfig, { type: "slots-grid" }>) => LayoutObjectConfig,
  ): Promise<boolean> {
    const view = (state?.views ?? []).find((v) => v.id === t.viewId);
    if (!view?.layout) {
      toast.error(`Couldn't ${what}: its layout is not available.`);
      return false;
    }
    const layout = structuredClone(view.layout);
    const walk = (objs: LayoutObject[]): void => {
      for (const o of objs) {
        if (o.id === t.id && o.config.type === "slots-grid") o.config = change(o.config);
        if (o.children?.length) walk(o.children);
      }
    };
    walk(layout.objects);
    const next = await attempt(what, () => ipc<StageState>("views:setLayout", { id: t.viewId, layout, layoutRev: view.layoutRev }));
    if (next) takeState(next);
    return !!next;
  }

  /** Point a screen, or a widget, at a board. */
  async function showOn(t: ShowTarget, boardId: string | null): Promise<boolean> {
    if (t.kind === "view") {
      const next = await attempt(`show the board on ${t.name}`, () => ipc<StageState>("views:setBoard", { id: t.id, boardId }));
      if (next) takeState(next);
      return !!next;
    }
    return rewriteGrid(t, `show the board on ${t.name}`, (c) => {
      const { source: _s, sourceViewId: _v, slotsLayout: _l, ...rest } = c;
      const displayWidthIn = c.displayWidthIn ?? c.slotsLayout?.displayWidthIn;
      return { ...rest, boardId, ...(displayWidthIn ? { displayWidthIn } : {}) };
    });
  }

  /** A screen's or a widget's own display width, the other half of charger alignment. */
  async function setDisplayWidth(t: ShowTarget, displayWidthIn: number): Promise<boolean> {
    if (t.kind === "view") {
      const next = await attempt(`set the display width of ${t.name}`, () =>
        ipc<StageState>("views:setSlotsLayout", { id: t.id, slotsLayout: { displayWidthIn } }),
      );
      if (next) takeState(next);
      return !!next;
    }
    return rewriteGrid(t, `set the display width of ${t.name}`, (c) => {
      const { source: _s, sourceViewId: _v, slotsLayout: _l, ...rest } = c;
      return { ...rest, displayWidthIn };
    });
  }

  /**
   * Copy a layout over boards, at the target being edited. Written at once.
   *
   * What each copy would do is READ first: a source with no layout is skipped and
   * named (writing its empty list would blank a live wall), and the operator is
   * asked before anything replaces saved or unsaved rows, with the boards and the
   * target named. Edits are dropped only for a board whose copy landed.
   */
  async function copyLayouts(boardIds: string[], from: CopyFrom, sourceName: string): Promise<boolean> {
    const targetName = effectiveSide === "plan" ? `${label} only` : `${namedType(typeName)} default`;
    const copies: SlotBoardDTO[] = [];
    const skipped: string[] = [];
    const replaces: string[] = [];
    try {
      for (const id of boardIds) {
        const b = boards.find((x) => x.id === id);
        if (!b) continue;
        const asked: { serviceTypeId: string | null; planId: string | null } = from.fromPlanId
          ? { serviceTypeId: from.fromServiceTypeId ?? serviceTypeId, planId: from.fromPlanId }
          : from.fromServiceTypeId
            ? { serviceTypeId: from.fromServiceTypeId, planId: null }
            : { serviceTypeId, planId: effectiveSide === "plan" ? planId : null };
        const t = await ipc<SlotTargetsDTO>("boards:targets", { id: from.fromBoardId ?? b.id, ...asked });
        const rows = asked.planId ? (t.overrideSlots ?? t.defaultSlots) : t.defaultSlots;
        if (rows.length === 0) {
          skipped.push(`${b.name}: ${sourceName} has no layout, left as it was`);
          continue;
        }
        copies.push(b);
        const here = targetsById.get(b.id);
        const saved = effectiveSide === "plan" ? (here?.overrideSlots ?? here?.defaultSlots ?? []) : (here?.defaultSlots ?? []);
        if (b.id in edits) replaces.push(`${b.name} (unsaved changes)`);
        else if (saved.length > 0) replaces.push(`${b.name} (its saved layout)`);
      }
    } catch (err) {
      toast.error(`Couldn't read what to copy: ${errorMessage(err)}`);
      return false;
    }
    if (copies.length === 0) {
      toast.info(`Nothing copied. ${skipped.join("; ")}.`);
      return false;
    }
    if (replaces.length > 0) {
      const ok = await confirm({
        title: `Copy ${sourceName} over ${plural(copies.length, "board")}?`,
        message:
          `${targetName} on ${copies.map((c) => c.name).join(", ")} is replaced. That throws away: ${replaces.join(", ")}.` +
          (skipped.length > 0 ? ` Left as they are: ${skipped.join("; ")}.` : ""),
        confirmLabel: "Copy",
        destructive: true,
      });
      if (!ok) return false;
    }
    const failed: { name: string; message: string }[] = [];
    const landed: string[] = [];
    for (const b of copies) {
      try {
        takeState(await ipc<StageState>("boards:copyFrom", { id: b.id, ...from, target: wireTarget() }));
        landed.push(b.id);
      } catch (err) {
        failed.push({ name: b.name, message: errorMessage(err) });
      }
    }
    dropEditsOf(landed);
    reportPartial("Copy", { done: landed.length, failed });
    await refresh();
    if (failed.length === 0) {
      toast.success(`Copied onto ${plural(landed.length, "board")}.`);
      if (skipped.length > 0) toast.info(`${skipped.join("; ")}.`);
    }
    return failed.length === 0;
  }

  async function copyInto(boardId: string, from: CopyFrom, sourceName: string): Promise<boolean> {
    return copyLayouts([boardId], from, sourceName);
  }

  async function copyIntoAll(from: CopyFrom, sourceName: string): Promise<boolean> {
    return copyLayouts(boards.map((b) => b.id), from, sourceName);
  }

  /** Every board that has a layout of its own for this plan, as the plan-level
   *  actions act on it. */
  const overridden = boards.filter((b) => targetsById.get(b.id)?.overrideSlots != null);

  /** Run a write per board; which landed, and which did not. Each landed board's
   *  state is taken as it comes. */
  async function eachBoard(
    ids: readonly string[],
    run: (id: string) => Promise<StageState>,
  ): Promise<{ landed: string[]; failed: { name: string; message: string }[] }> {
    const failed: { name: string; message: string }[] = [];
    const landed: string[] = [];
    for (const id of ids) {
      try {
        takeState(await run(id));
        landed.push(id);
      } catch (err) {
        failed.push({ name: boards.find((b) => b.id === id)?.name ?? id, message: errorMessage(err) });
      }
    }
    return { landed, failed };
  }

  function reportPartial(what: string, r: { done: number; failed: { name: string; message: string }[] }): void {
    if (r.failed.length === 0) return;
    const names = r.failed.map((f) => `${f.name} (${f.message})`).join("; ");
    toast.error(`${what}: ${r.done} of ${r.done + r.failed.length} boards done. Not done: ${names}`);
  }

  const nameOf = (id: string) => boards.find((b) => b.id === id)?.name ?? id;

  /** Revert plans to the default for these boards. Their unsaved edits go with the
   *  plan's layout, but only once the request has landed: a refused revert loses
   *  nothing. */
  async function revertBoards(ids: string[], what: string): Promise<boolean> {
    if (!planId || ids.length === 0) return false;
    const unsaved = ids.filter((id) => id in edits);
    const ok = await confirm({
      title: `Revert ${what} to the default?`,
      message:
        `The layout saved for ${label} on ${ids.map(nameOf).join(", ")} is deleted, and ${ids.length === 1 ? "it goes" : "they go"} back to ${namedType(typeName)} default.` +
        (unsaved.length > 0 ? ` Unsaved changes to ${unsaved.map(nameOf).join(", ")} are thrown away with it.` : ""),
      confirmLabel: unsaved.length > 0 ? "Revert and discard changes" : "Revert",
      destructive: true,
    });
    if (!ok) return false;
    const r = await eachBoard(ids, (id) => ipc<StageState>("boards:clearOverride", { id, planId }));
    dropEditsOf(r.landed);
    reportPartial("Revert", { done: r.landed.length, failed: r.failed });
    if (r.landed.length > 0 && ids.length > 1) setOwnSide("default");
    await refresh();
    if (r.failed.length === 0) toast.success(`Reverted ${label} to the default.`);
    return r.failed.length === 0;
  }

  async function revertBoard(boardId: string): Promise<boolean> {
    return revertBoards([boardId], nameOf(boardId));
  }

  async function revertPlan(): Promise<boolean> {
    return revertBoards(overridden.map((b) => b.id), label);
  }

  /**
   * Make plan layouts the default for these boards. The plan's layout is the SAVED
   * one, so unsaved edits are saved first (the confirm says so), and nothing is
   * promoted if that save is refused.
   */
  async function promoteBoards(ids: string[], what: string): Promise<boolean> {
    if (!planId) return false;
    const unsaved = effectiveSide === "plan" ? ids.filter((id) => id in edits) : [];
    const targets = [...new Set([...ids.filter((id) => overridden.some((b) => b.id === id)), ...unsaved])];
    if (targets.length === 0) return false;
    const ok = await confirm({
      title: `Make ${what} the default?`,
      message:
        `${namedType(typeName, true)} default is replaced by the layouts saved for ${label} on ${targets.map(nameOf).join(", ")}, and ${label} stops being an exception.` +
        (unsaved.length > 0 ? ` Unsaved changes to ${unsaved.map(nameOf).join(", ")} are saved first.` : ""),
      confirmLabel: unsaved.length > 0 ? "Save, then set as default" : "Set as default",
      destructive: true,
    });
    if (!ok) return false;
    if (unsaved.length > 0 && !(await submitSave(unsaved, false))) return false;
    const r = await eachBoard(targets, (id) => ipc<StageState>("boards:promote", { id, planId }));
    reportPartial("Set as default", { done: r.landed.length, failed: r.failed });
    if (r.landed.length > 0) setOwnSide("default");
    await refresh();
    if (r.failed.length === 0) toast.success(`${label} is now ${namedType(typeName)} default.`);
    return r.failed.length === 0;
  }

  async function promoteBoard(boardId: string): Promise<boolean> {
    return promoteBoards([boardId], nameOf(boardId));
  }

  async function promotePlan(): Promise<boolean> {
    return promoteBoards(boards.map((b) => b.id), label);
  }

  return {
    // data
    boards,
    boardsLoading: boardsQ.isLoading,
    boardsError: boardsQ.error ?? null,
    targetsFailed,
    loaded,
    views,
    boardsMap,
    targetsById,
    // the target
    editing,
    serviceTypeId,
    planId,
    hasPlan,
    side: effectiveSide,
    setSide,
    hasOverride,
    label,
    typeName,
    wireTarget,
    // unsaved work
    dirty,
    dirtyIds,
    saving,
    saveError,
    saveAll,
    discard,
    discardAll,
    // layout edits
    selection,
    selectedSlot,
    select,
    highlighted,
    showSlots,
    mutate,
    updateSlot,
    addSlot,
    addSpacer,
    duplicateSlot,
    removeSelected,
    toggleStack,
    stackSlot,
    unstackSlot,
    nudgeSlot,
    replaceBoard,
    // board-level writes
    createBoard,
    renameBoard,
    duplicateBoard,
    deleteBoard,
    setColumnWidth,
    showOn,
    setDisplayWidth,
    copyInto,
    copyIntoAll,
    revertBoard,
    promoteBoard,
    revertPlan,
    promotePlan,
    confirmReplace,
    refresh,
  };
}

export type MicSlots = ReturnType<typeof useMicSlots>;
