// board-routes.ts — Slot boards
//
// A board is a named set of slot layouts that slots screens and slots widgets
// point at. These are the routes the Mic slots page uses. The older per-screen
// routes (POST /api/views/:id/slots, /api/layout-objects/:id/slots, POST
// /api/slots, preset apply by view) stay in their own modules as aliases onto
// the board the screen shows.
//
// A bare `return` means "handled, stop" (see RouteCtx).

import { type RouteCtx, json, error, readBody } from "./context.js";
import { isRecord } from "../is-record.js";
import { scrub } from "../scrub.js";
import { readSlotsTarget, INVALID_TARGET, TARGET_ERROR } from "../slots-target-body.js";
import type { SlotsTarget } from "../slots-store.js";
import { SlotsNotFoundError, stageController } from "../stage-controller.js";
import type { Slot } from "../../types/stage.js";

/** A refusal the controller raised on purpose answers with its status; anything
 *  else goes up to the dispatcher, which answers 500 and logs. */
function boardFailure(res: RouteCtx["res"], err: unknown): void {
  if (!(err instanceof SlotsNotFoundError)) throw err;
  error(res, err.message, err.status);
}

/** The body as an object; anything else (null, a list) reads as empty, which
 *  every route below then refuses for what it lacks. */
async function bodyOf(req: RouteCtx["req"]): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  return isRecord(body) ? body : {};
}

/** A list of slot objects, or null. */
function slotList(v: unknown): Slot[] | null {
  return Array.isArray(v) && v.every(isRecord) ? (v as unknown as Slot[]) : null;
}

export async function boardRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method, url } = c;
  if (!pathname.startsWith("/api/boards")) return;

  // GET /api/boards — every board with where it is shown.
  if (method === "GET" && pathname === "/api/boards") {
    json(res, stageController.listBoards());
    return;
  }

  // POST /api/boards — { name, from?: { boardId } | { presetId }, target? }
  if (method === "POST" && pathname === "/api/boards") {
    const body = await bodyOf(req);
    const from = body.from;
    let start: { boardId: string } | { presetId: string } | undefined;
    if (from !== undefined && from !== null) {
      const f = isRecord(from) ? from : {};
      if (typeof f.boardId === "string" && f.boardId) start = { boardId: f.boardId };
      else if (typeof f.presetId === "string" && f.presetId) start = { presetId: f.presetId };
      else {
        error(res, "body.from must be { boardId } or { presetId }");
        return;
      }
    }
    const target = readSlotsTarget(body.target);
    if (target === INVALID_TARGET) {
      error(res, TARGET_ERROR);
      return;
    }
    try {
      const id = await stageController.createBoard(body.name, start, target);
      json(res, { id, boards: stageController.listBoards() }, 201);
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }

  // POST /api/boards/slots — save all: { boards: [{ boardId, slots, target? }] }.
  // Validated together and written together; one bad entry writes nothing.
  if (method === "POST" && pathname === "/api/boards/slots") {
    const body = await bodyOf(req);
    if (!Array.isArray(body.boards)) {
      error(res, "body.boards (array) required");
      return;
    }
    const entries: { boardId: string; slots: Slot[]; target?: SlotsTarget }[] = [];
    for (const [i, raw] of (body.boards as unknown[]).entries()) {
      const e = isRecord(raw) ? raw : {};
      const boardId = typeof e.boardId === "string" && e.boardId ? e.boardId : null;
      const label = boardId ? `Board "${stageController.describeBoard(boardId)}"` : `Entry ${i + 1}`;
      const slots = slotList(e.slots);
      const target = readSlotsTarget(e.target);
      const problem = !boardId
        ? "has no boardId"
        : !slots
          ? "body.slots must be a list of slots"
          : target === INVALID_TARGET
            ? TARGET_ERROR
            : null;
      if (problem) {
        console.warn(`[boards] save-all refused, nothing written: ${scrub(label)}: ${scrub(problem)}`);
        error(res, `${label}: ${problem}`);
        return;
      }
      entries.push({ boardId: boardId!, slots: slots!, ...(target ? { target: target as SlotsTarget } : {}) });
    }
    try {
      json(res, await stageController.saveBoards(entries));
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }

  // GET /api/boards/check?serviceTypeId=&planId= — this plan's check.
  if (method === "GET" && pathname === "/api/boards/check") {
    const serviceTypeId = url.searchParams.get("serviceTypeId");
    const want = serviceTypeId ? { serviceTypeId, planId: url.searchParams.get("planId") || null } : undefined;
    try {
      json(res, await stageController.checkBoardsFor(want));
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }

  // GET /api/boards/:id/targets?serviceTypeId=&planId= — SlotTargetsDTO.
  const targetsMatch = pathname.match(/^\/api\/boards\/([^/]+)\/targets$/);
  if (method === "GET" && targetsMatch) {
    const wantType = url.searchParams.get("serviceTypeId");
    const want = wantType ? { serviceTypeId: wantType, planId: url.searchParams.get("planId") } : undefined;
    try {
      json(res, await stageController.getSlotTargets("board", decodeURIComponent(targetsMatch[1]!), want));
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }

  // DELETE /api/boards/:id/override/:planId — revert one plan to the default.
  const overrideMatch = pathname.match(/^\/api\/boards\/([^/]+)\/override\/([^/]+)$/);
  if (method === "DELETE" && overrideMatch) {
    try {
      json(res, await stageController.clearSlotsOverride(
        "board",
        decodeURIComponent(overrideMatch[1]!),
        decodeURIComponent(overrideMatch[2]!),
      ));
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }

  // POST /api/boards/:id/promote — { planId } — set a plan's layout as the default.
  const promoteMatch = pathname.match(/^\/api\/boards\/([^/]+)\/promote$/);
  if (method === "POST" && promoteMatch) {
    const body = await bodyOf(req);
    if (typeof body.planId !== "string" || !body.planId) {
      error(res, "body.planId (string) required");
      return;
    }
    try {
      json(res, await stageController.promoteSlotsOverride("board", decodeURIComponent(promoteMatch[1]!), body.planId));
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }

  // POST /api/boards/:id/duplicate — { name? }
  const duplicateMatch = pathname.match(/^\/api\/boards\/([^/]+)\/duplicate$/);
  if (method === "POST" && duplicateMatch) {
    const body = await bodyOf(req);
    try {
      const id = await stageController.duplicateBoard(decodeURIComponent(duplicateMatch[1]!), body.name);
      json(res, { id, boards: stageController.listBoards() }, 201);
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }

  // POST /api/boards/:id/copy-from — { fromBoardId?, fromServiceTypeId?, fromPlanId?, target? }
  const copyMatch = pathname.match(/^\/api\/boards\/([^/]+)\/copy-from$/);
  if (method === "POST" && copyMatch) {
    const body = await bodyOf(req);
    const from: { fromBoardId?: string; fromServiceTypeId?: string; fromPlanId?: string } = {};
    for (const k of ["fromBoardId", "fromServiceTypeId", "fromPlanId"] as const) {
      const v = body[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" || !v) {
        error(res, `body.${k} must be a non-empty string`);
        return;
      }
      from[k] = v;
    }
    const target = readSlotsTarget(body.target);
    if (target === INVALID_TARGET) {
      error(res, TARGET_ERROR);
      return;
    }
    try {
      json(res, await stageController.copyIntoBoard(decodeURIComponent(copyMatch[1]!), from, target));
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }

  const boardMatch = pathname.match(/^\/api\/boards\/([^/]+)$/);

  // PATCH /api/boards/:id — { name?, columnWidthIn? (number | null) }
  if (method === "PATCH" && boardMatch) {
    const body = await bodyOf(req);
    const hasName = "name" in body;
    const hasWidth = "columnWidthIn" in body;
    if (!hasName && !hasWidth) {
      error(res, "body.name (string) or body.columnWidthIn (number|null) required");
      return;
    }
    if (hasWidth && body.columnWidthIn !== null && typeof body.columnWidthIn !== "number") {
      error(res, "body.columnWidthIn must be a number or null");
      return;
    }
    try {
      await stageController.updateBoard(decodeURIComponent(boardMatch[1]!), {
        ...(hasName ? { name: body.name } : {}),
        ...(hasWidth ? { columnWidthIn: body.columnWidthIn as number | null } : {}),
      });
      json(res, stageController.listBoards());
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }

  // DELETE /api/boards/:id — { replacement: boardId | null }. Required, so a
  // delete always says what its screens show next.
  if (method === "DELETE" && boardMatch) {
    const body = await bodyOf(req);
    const replacement = "replacement" in body ? body.replacement : undefined;
    if (replacement !== null && (typeof replacement !== "string" || !replacement)) {
      error(res, "body.replacement (a board id, or null for nothing) required");
      return;
    }
    try {
      json(res, await stageController.deleteBoard(decodeURIComponent(boardMatch[1]!), replacement));
    } catch (err) {
      boardFailure(res, err);
    }
    return;
  }
}
