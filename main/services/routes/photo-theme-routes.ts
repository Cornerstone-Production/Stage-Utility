// photo-theme-routes.ts — themed mic slot photos, and the OpenAI key that makes them.
//
// Every route must finish responding before it returns (see RouteCtx).
//
//   GET    /api/openai                                    the connection: method, key hint, state
//   PUT    /api/openai/key                                save the key: { apiKey }
//   DELETE /api/openai/key                                remove it
//   POST   /api/openai/test                               prove it with a cheap call
//
//   GET    /api/photo-themes                              every theme and plan choice
//   POST   /api/photo-themes/themes                       create: { name, prompt }; 201
//   PATCH  /api/photo-themes/themes/:id                   { name?, prompt? }
//   DELETE /api/photo-themes/themes/:id                   with its photos
//   POST   /api/photo-themes/themes/:id/keep-prompt       keep photos made under the old prompt
//   POST   /api/photo-themes/themes/:id/people/:pid/approve
//   POST   /api/photo-themes/themes/:id/people/:pid/keep  keep one made from an older photo
//   POST   /api/photo-themes/themes/:id/people/:pid/redo  { planId?, serviceTypeId? }; 202
//   POST   /api/photo-themes/themes/:id/people/:pid/move  { to }
//   POST   /api/photo-themes/themes/:id/people/:pid/copy  { to }
//   DELETE /api/photo-themes/themes/:id/people/:pid       remove from the theme
//   GET    /api/photo-themes/plans/:planId?serviceTypeId= the plan's people and their photos
//   PATCH  /api/photo-themes/plans/:planId                { serviceTypeId, sortDate?, themeId?, show? }
//   POST   /api/photo-themes/plans/:planId/generate       { serviceTypeId, mode? }; 202
//   POST   /api/photo-themes/plans/:planId/approve-all
//   GET    /api/photo-themes/images/:file                 a stored edit
//
// Every id in a path or body is checked against its shape before anything is
// looked up. The key goes in and never comes out: every answer carries the
// connection's hint, never the key.

import type http from "node:http";

import { storedImageHeaders } from "../image-files.js";
import { isPcoId } from "../pco-path.js";
import { isPersonId, isPlanId, isThemeId, sortDate } from "../photo-themes/book.js";
import { PhotoThemeRefused, photoThemes } from "../photo-themes/service.js";
import { type RouteCtx, error, json, readObjectBody } from "./context.js";

const THEME = /^\/api\/photo-themes\/themes\/([^/]+)$/;
const KEEP_PROMPT = /^\/api\/photo-themes\/themes\/([^/]+)\/keep-prompt$/;
const PERSON = /^\/api\/photo-themes\/themes\/([^/]+)\/people\/([^/]+)$/;
const PERSON_ACTION = /^\/api\/photo-themes\/themes\/([^/]+)\/people\/([^/]+)\/(approve|keep|redo|move|copy)$/;
const PLAN = /^\/api\/photo-themes\/plans\/([^/]+)$/;
const PLAN_ACTION = /^\/api\/photo-themes\/plans\/([^/]+)\/(generate|approve-all)$/;
const IMAGE = /^\/api\/photo-themes\/images\/([^/]+)$/;

/** Answer a refusal with its status, or rethrow anything else for the server's 500. */
function answer(res: http.ServerResponse, err: unknown): void {
  if (err instanceof PhotoThemeRefused) error(res, err.message, err.status);
  else throw err;
}

function themeIdOr400(res: http.ServerResponse, id: string): boolean {
  if (isThemeId(id)) return true;
  error(res, "that is not a theme id");
  return false;
}

function personIdOr400(res: http.ServerResponse, id: string): boolean {
  if (isPersonId(id)) return true;
  error(res, "that is not a Planning Center person id");
  return false;
}

function planIdOr400(res: http.ServerResponse, id: string): boolean {
  if (isPlanId(id)) return true;
  error(res, "that is not a Planning Center plan id");
  return false;
}

export async function photoThemeRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method, url } = c;
  if (!pathname.startsWith("/api/openai") && !pathname.startsWith("/api/photo-themes")) return;

  // ── The OpenAI connection ────────────────────────────────────────────────

  if (pathname === "/api/openai" && method === "GET") {
    json(res, photoThemes.connection.status());
    return;
  }
  if (pathname === "/api/openai/key" && method === "PUT") {
    const body = await readObjectBody(req, res);
    if (!body) return;
    try {
      json(res, await photoThemes.connection.saveKey(body.apiKey));
    } catch (err) {
      answer(res, err);
    }
    return;
  }
  if (pathname === "/api/openai/key" && method === "DELETE") {
    json(res, await photoThemes.connection.clearKey());
    return;
  }
  if (pathname === "/api/openai/test" && method === "POST") {
    json(res, await photoThemes.connection.test());
    return;
  }

  // ── Themes ───────────────────────────────────────────────────────────────

  if (pathname === "/api/photo-themes" && method === "GET") {
    json(res, photoThemes.state());
    return;
  }

  if (pathname === "/api/photo-themes/themes" && method === "POST") {
    const body = await readObjectBody(req, res);
    if (!body) return;
    try {
      json(res, await photoThemes.createTheme({ name: body.name, prompt: body.prompt }), 201);
    } catch (err) {
      answer(res, err);
    }
    return;
  }

  const theme = THEME.exec(pathname);
  if (theme && (method === "PATCH" || method === "DELETE")) {
    const id = theme[1]!;
    if (!themeIdOr400(res, id)) return;
    try {
      if (method === "DELETE") {
        json(res, await photoThemes.deleteTheme(id));
      } else {
        const body = await readObjectBody(req, res);
        if (!body) return;
        json(res, await photoThemes.updateTheme(id, { name: body.name, prompt: body.prompt }));
      }
    } catch (err) {
      answer(res, err);
    }
    return;
  }

  const keepPrompt = KEEP_PROMPT.exec(pathname);
  if (keepPrompt && method === "POST") {
    const id = keepPrompt[1]!;
    if (!themeIdOr400(res, id)) return;
    try {
      json(res, await photoThemes.keepPrompt(id));
    } catch (err) {
      answer(res, err);
    }
    return;
  }

  const person = PERSON.exec(pathname);
  if (person && method === "DELETE") {
    const [, id, pid] = person as unknown as [string, string, string];
    if (!themeIdOr400(res, id) || !personIdOr400(res, pid)) return;
    try {
      await photoThemes.remove(id, pid);
      json(res, { removed: true });
    } catch (err) {
      answer(res, err);
    }
    return;
  }

  const action = PERSON_ACTION.exec(pathname);
  if (action && method === "POST") {
    const [, id, pid, verb] = action as unknown as [string, string, string, string];
    if (!themeIdOr400(res, id) || !personIdOr400(res, pid)) return;
    try {
      if (verb === "approve") {
        json(res, await photoThemes.approve(id, pid));
      } else if (verb === "keep") {
        json(res, await photoThemes.keep(id, pid));
      } else if (verb === "redo") {
        const body = await readObjectBody(req, res);
        if (!body) return;
        let from: { planId: string; serviceTypeId: string } | null = null;
        if (body.planId !== undefined || body.serviceTypeId !== undefined) {
          if (!isPlanId(body.planId) || !isPcoId(body.serviceTypeId)) {
            error(res, "planId and serviceTypeId must both be Planning Center ids, or both absent");
            return;
          }
          from = { planId: body.planId, serviceTypeId: body.serviceTypeId };
        }
        json(res, await photoThemes.redo(id, pid, from), 202);
      } else {
        const body = await readObjectBody(req, res);
        if (!body) return;
        if (!isThemeId(body.to)) {
          error(res, "to must be a theme id");
          return;
        }
        await photoThemes.transfer(id, pid, body.to, verb === "move" ? "move" : "copy");
        json(res, { [verb === "move" ? "moved" : "copied"]: true });
      }
    } catch (err) {
      answer(res, err);
    }
    return;
  }

  // ── Plans ────────────────────────────────────────────────────────────────

  const plan = PLAN.exec(pathname);
  if (plan && method === "GET") {
    const planId = plan[1]!;
    if (!planIdOr400(res, planId)) return;
    const serviceTypeId = url.searchParams.get("serviceTypeId");
    if (!isPcoId(serviceTypeId)) {
      error(res, "serviceTypeId must be a Planning Center id");
      return;
    }
    json(res, await photoThemes.planPeople(planId, serviceTypeId));
    return;
  }
  if (plan && method === "PATCH") {
    const planId = plan[1]!;
    if (!planIdOr400(res, planId)) return;
    const body = await readObjectBody(req, res);
    if (!body) return;
    if (!isPcoId(body.serviceTypeId)) {
      error(res, "serviceTypeId must be a Planning Center id");
      return;
    }
    if (body.themeId !== undefined && body.themeId !== null && !isThemeId(body.themeId)) {
      error(res, "themeId must be a theme id or null");
      return;
    }
    if (body.show !== undefined && body.show !== "original" && body.show !== "themed") {
      error(res, 'show must be "original" or "themed"');
      return;
    }
    if (body.themeId === undefined && body.show === undefined) {
      error(res, "send a themeId, a show or both");
      return;
    }
    try {
      json(
        res,
        await photoThemes.choosePlan(planId, {
          serviceTypeId: body.serviceTypeId,
          sortDate: body.sortDate === undefined ? undefined : sortDate(body.sortDate),
          ...(body.themeId !== undefined ? { themeId: body.themeId as string | null } : {}),
          ...(body.show !== undefined ? { show: body.show as "original" | "themed" } : {}),
        }),
      );
    } catch (err) {
      answer(res, err);
    }
    return;
  }

  const planAction = PLAN_ACTION.exec(pathname);
  if (planAction && method === "POST") {
    const [, planId, verb] = planAction as unknown as [string, string, string];
    if (!planIdOr400(res, planId)) return;
    try {
      if (verb === "approve-all") {
        json(res, await photoThemes.approveAll(planId));
        return;
      }
      const body = await readObjectBody(req, res);
      if (!body) return;
      if (!isPcoId(body.serviceTypeId)) {
        error(res, "serviceTypeId must be a Planning Center id");
        return;
      }
      const mode = body.mode ?? "missing";
      if (mode !== "missing" && mode !== "all") {
        error(res, 'mode must be "missing" or "all"');
        return;
      }
      json(res, await photoThemes.generate(planId, body.serviceTypeId, mode), 202);
    } catch (err) {
      answer(res, err);
    }
    return;
  }

  const image = IMAGE.exec(pathname);
  if (image && method === "GET") {
    const found = await photoThemes.readImage(image[1]!);
    if (!found) {
      error(res, "no such photo", 404);
      return;
    }
    res.writeHead(200, storedImageHeaders(found.mime, "public, max-age=31536000, immutable"));
    res.end(found.data);
    return;
  }
}
