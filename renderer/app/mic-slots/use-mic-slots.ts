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

  async function setSide(next: SlotsTargetSide): Promise<void> {
    if (next === effectiveSide) return;
    if (dirty) {
      if (!(await confirmDiscardSlotEdits())) return;
      setEdits({});
    }
    setOwnSide(next);
  }

  // ── Save all ─────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  /** The refusal from the last Save all, and the board it named when it did. */
  const [saveError, setSaveError] = useState<{ message: string; boardId: string | null } | null>(null);

  async function saveAll(): Promise<boolean> {
    const ids = dirtyIds;
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
      setEdits({});
      await refresh();
      pageTarget.announceSaved(plural(ids.length, "board"));
      return true;
    } catch (err) {
      const message = errorMessage(err);
      // The server names the board it refused: `Board "Left wall": …`.
      const named = boards.find((b) => message.startsWith(`Board "${b.name}"`));
      setSaveError({ message, boardId: named?.id ?? null });
      toast.error(`Nothing was saved. ${message}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  function discardAll(): void {
    setEdits({});
    setSaveError(null);
  }

  // ── layout edits ─────────────────────────────────────────────────────
  function select(slotId: string | null): void {
    setPicked(slotId);
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

  /** Point a screen, or a widget, at a board. */
  async function showOn(t: ShowTarget, boardId: string | null): Promise<boolean> {
    if (t.kind === "view") {
      const next = await attempt(`show the board on ${t.name}`, () => ipc<StageState>("views:setBoard", { id: t.id, boardId }));
      if (next) takeState(next);
      return !!next;
    }
    // A widget's board lives in its view's layout, so pointing it means saving
    // that layout. `layoutRev` makes a layout somebody else changed a refusal
    // instead of an overwrite.
    const view = (state?.views ?? []).find((v) => v.id === t.viewId);
    if (!view?.layout) {
      toast.error(`Couldn't show the board on ${t.name}: its layout is not available.`);
      return false;
    }
    const layout = structuredClone(view.layout);
    const walk = (objs: LayoutObject[]): void => {
      for (const o of objs) {
        if (o.id === t.id && o.config.type === "slots-grid") {
          const { source: _s, sourceViewId: _v, slotsLayout: _l, ...rest } = o.config;
          const displayWidthIn = o.config.displayWidthIn ?? o.config.slotsLayout?.displayWidthIn;
          o.config = { ...rest, boardId, ...(displayWidthIn ? { displayWidthIn } : {}) };
        }
        if (o.children?.length) walk(o.children);
      }
    };
    walk(layout.objects);
    const next = await attempt(`show the board on ${t.name}`, () =>
      ipc<StageState>("views:setLayout", { id: t.viewId, layout, layoutRev: view.layoutRev }),
    );
    if (next) takeState(next);
    return !!next;
  }

  /** Copy a layout onto one board at the target being edited. Written at once. */
  async function copyInto(
    boardId: string,
    from: { fromBoardId?: string; fromServiceTypeId?: string; fromPlanId?: string },
  ): Promise<boolean> {
    if (!(await confirmReplace(boardId, "Copying replaces the layout."))) return false;
    const next = await attempt("copy the layout", () =>
      ipc<StageState>("boards:copyFrom", { id: boardId, ...from, target: wireTarget() }),
    );
    if (!next) return false;
    takeState(next);
    await refresh();
    toast.success("Layout copied.");
    return true;
  }

  /** Revert one board's plan to the default. */
  async function revertBoard(boardId: string): Promise<boolean> {
    if (!planId) return false;
    const name = boards.find((b) => b.id === boardId)?.name ?? "this board";
    const ok = await confirm({
      title: `Revert ${name} to the default?`,
      message: `The layout saved for ${label} on ${name} is deleted, and it goes back to ${namedType(typeName)} default.`,
      confirmLabel: "Revert",
      destructive: true,
    });
    if (!ok) return false;
    dropEdits(boardId);
    const next = await attempt("revert the board", () => ipc<StageState>("boards:clearOverride", { id: boardId, planId }));
    if (!next) return false;
    takeState(next);
    await refresh();
    return true;
  }

  /** Every board that has a layout of its own for this plan, as the plan-level
   *  actions act on it. */
  const overridden = boards.filter((b) => targetsById.get(b.id)?.overrideSlots != null);

  async function eachOverridden(
    run: (id: string) => Promise<StageState>,
  ): Promise<{ done: number; failed: { name: string; message: string }[] }> {
    const failed: { name: string; message: string }[] = [];
    let done = 0;
    for (const b of overridden) {
      try {
        takeState(await run(b.id));
        done++;
      } catch (err) {
        failed.push({ name: b.name, message: errorMessage(err) });
      }
    }
    return { done, failed };
  }

  function reportPartial(what: string, r: { done: number; failed: { name: string; message: string }[] }): void {
    if (r.failed.length === 0) return;
    const names = r.failed.map((f) => `${f.name} (${f.message})`).join("; ");
    toast.error(`${what}: ${r.done} of ${r.done + r.failed.length} boards done. Not done: ${names}`);
  }

  async function revertPlan(): Promise<boolean> {
    if (!planId || overridden.length === 0) return false;
    const ok = await confirm({
      title: `Revert ${label} to the default?`,
      message: `The layouts saved for ${label} on ${plural(overridden.length, "board")} are deleted, and they go back to ${namedType(typeName)} default.`,
      confirmLabel: "Revert",
      destructive: true,
    });
    if (!ok) return false;
    setEdits({});
    const r = await eachOverridden((id) => ipc<StageState>("boards:clearOverride", { id, planId }));
    reportPartial("Revert", r);
    setOwnSide("default");
    await refresh();
    if (r.failed.length === 0) toast.success(`Reverted ${label} to the default.`);
    return r.failed.length === 0;
  }

  async function promotePlan(): Promise<boolean> {
    if (!planId || overridden.length === 0) return false;
    const ok = await confirm({
      title: `Make ${label} the default?`,
      message: `${namedType(typeName, true)} default is replaced by the layouts saved for ${label}, and ${label} stops being an exception.`,
      confirmLabel: "Set as default",
      destructive: true,
    });
    if (!ok) return false;
    setEdits({});
    const r = await eachOverridden((id) => ipc<StageState>("boards:promote", { id, planId }));
    reportPartial("Set as default", r);
    setOwnSide("default");
    await refresh();
    if (r.failed.length === 0) toast.success(`${label} is now ${namedType(typeName)} default.`);
    return r.failed.length === 0;
  }

  /** Copy one source over every board at the target being edited. */
  async function copyIntoAll(from: { fromServiceTypeId?: string; fromPlanId?: string }): Promise<boolean> {
    const clobbers = dirtyIds.length;
    if (clobbers > 0) {
      const ok = await confirm({
        title: "Replace the unsaved changes?",
        message: "Copying replaces every board's layout, and the edits that are not saved yet are lost.",
        confirmLabel: "Replace",
        destructive: true,
      });
      if (!ok) return false;
      setEdits({});
    }
    const failed: { name: string; message: string }[] = [];
    let done = 0;
    for (const b of boards) {
      try {
        takeState(await ipc<StageState>("boards:copyFrom", { id: b.id, ...from, target: wireTarget() }));
        done++;
      } catch (err) {
        failed.push({ name: b.name, message: errorMessage(err) });
      }
    }
    reportPartial("Copy", { done, failed });
    await refresh();
    if (failed.length === 0) toast.success(`Copied onto ${plural(done, "board")}.`);
    return failed.length === 0;
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
    discardAll,
    // layout edits
    selection,
    selectedSlot,
    select,
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
    copyInto,
    copyIntoAll,
    revertBoard,
    revertPlan,
    promotePlan,
    confirmReplace,
    refresh,
  };
}

export type MicSlots = ReturnType<typeof useMicSlots>;
