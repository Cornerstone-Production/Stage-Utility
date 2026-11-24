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
//   POST   /api/photo-themes/themes/:id/people/:pid/approve  { file }: the edit that was shown
//   POST   /api/photo-themes/themes/:id/people/:pid/keep  keep one made from an older photo
//   POST   /api/photo-themes/themes/:id/people/:pid/redo  { planId?, serviceTypeId? }; 202
//   POST   /api/photo-themes/themes/:id/people/:pid/move  { to }
//   POST   /api/photo-themes/themes/:id/people/:pid/copy  { to }
//   DELETE /api/photo-themes/themes/:id/people/:pid       remove from the theme
//   GET    /api/photo-themes/plans/:planId?serviceTypeId= the plan's people and their photos
//   PATCH  /api/photo-themes/plans/:planId                { serviceTypeId, sortDate?, themeId?, show? }
//   POST   /api/photo-themes/plans/:planId/generate       { serviceTypeId, mode? }; 202
//   POST   /api/photo-themes/plans/:planId/approve-all    { people: [{ personId, file }] }: the edits shown
//   GET    /api/photo-themes/images/:file                 a stored edit
//
// Every id in a path or body is checked against its shape before anything is
// looked up. The key goes in and never comes out: every answer carries the
// connection's hint, never the key.

import type http from "node:http";

import { storedImageHeaders } from "../image-files.js";
import { isRecord } from "../is-record.js";
import { isPcoId } from "../pco-path.js";
import { isPersonId, isPlanId, isThemeId, sortDate } from "../photo-themes/book.js";
import { PhotoThemeRefused, photoThemes } from "../photo-themes/service.js";
import { MAX_APPROVE_ALL, THEMED_PHOTO_FILE, type ShownEdit } from "../../types/photo-themes.js";
import { type RouteCtx, error, json, readObjectBody } from "./context.js";

const THEME = /^\/api\/photo-themes\/themes\/([^/]+)$/;
const KEEP_PROMPT = /^\/api\/photo-themes\/themes\/([^/]+)\/keep-prompt$/;
const PERSON = /^\/api\/photo-themes\/themes\/([^/]+)\/people\/([^/]+)$/;
const PERSON_ACTION = /^\/api\/photo-themes\/themes\/([^/]+)\/people\/([^/]+)\/(approve|keep|redo|move|copy)$/;
const PLAN = /^\/api\/photo-themes\/plans\/([^/]+)$/;
const PLAN_ACTION = /^\/api\/photo-themes\/plans\/([^/]+)\/(generate|approve-all)$/;
const IMAGE = /^\/api\/photo-themes\/images\/([^/]+)$/;

/**
 * Run `work` and answer with what it resolves to, or with a refusal's status
 * and reason. Anything else is rethrown for the server's 500: a failed write
 * must not read as a refusal.
 */
async function respond(res: http.ServerResponse, work: () => Promise<unknown>, status = 200): Promise<void> {
  try {
    json(res, await work(), status);
  } catch (err) {
    if (err instanceof PhotoThemeRefused) error(res, err.message, err.status);
    else throw err;
  }
}

function refuse(message: string): never {
  throw new PhotoThemeRefused(message);
}

function themeId(id: string): string {
  return isThemeId(id) ? id : refuse("that is not a theme id");
}

function personId(id: string): string {
  return isPersonId(id) ? id : refuse("that is not a Planning Center person id");
}

function planId(id: string): string {
  return isPlanId(id) ? id : refuse("that is not a Planning Center plan id");
}

function serviceTypeId(v: unknown): string {
  return isPcoId(v) ? v : refuse("serviceTypeId must be a Planning Center id");
}

/** A stored edit's file name, as an approval names the one it was shown. */
function shownFile(v: unknown, what: string): string {
  return typeof v === "string" && THEMED_PHOTO_FILE.test(v) ? v : refuse(`${what} must be the name of the edit that was shown`);
}

/** What an approve-all was shown: each person once, with the file they were shown. */
function shownEdits(v: unknown): ShownEdit[] {
  if (!Array.isArray(v) || v.length === 0) refuse("people must be a list of the edits that were shown");
  if (v.length > MAX_APPROVE_ALL) refuse(`people must name at most ${MAX_APPROVE_ALL} edits`);
  const seen = new Set<string>();
  return v.map((e: unknown, i) => {
    const what = `people[${i}]`;
    if (!isRecord(e)) refuse(`${what} must be {personId, file}`);
    const { personId: pid, file } = e;
    if (!isPersonId(pid)) refuse(`${what}.personId must be a Planning Center person id`);
    if (seen.has(pid)) refuse(`${what} names a person already listed`);
    seen.add(pid);
    return { personId: pid, file: shownFile(file, `${what}.file`) };
  });
}

export async function photoThemeRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method, url } = c;
  if (!pathname.startsWith("/api/openai") && !pathname.startsWith("/api/photo-themes")) return;
  /** The JSON object body, or null having answered 400. */
  const body = () => readObjectBody(req, res);

  // ── The OpenAI connection ────────────────────────────────────────────────

  if (pathname === "/api/openai" && method === "GET") return respond(res, async () => photoThemes.connection.status());
  if (pathname === "/api/openai/key" && method === "PUT") {
    const b = await body();
    if (b) await respond(res, () => photoThemes.connection.saveKey(b.apiKey));
    return;
  }
  if (pathname === "/api/openai/key" && method === "DELETE") return respond(res, () => photoThemes.connection.clearKey());
  if (pathname === "/api/openai/test" && method === "POST") return respond(res, () => photoThemes.connection.test());

  // ── Themes ───────────────────────────────────────────────────────────────

  if (pathname === "/api/photo-themes" && method === "GET") return respond(res, async () => photoThemes.state());

  if (pathname === "/api/photo-themes/themes" && method === "POST") {
    const b = await body();
    if (b) await respond(res, () => photoThemes.createTheme({ name: b.name, prompt: b.prompt }), 201);
    return;
  }

  const theme = THEME.exec(pathname);
  if (theme && method === "DELETE") return respond(res, () => photoThemes.deleteTheme(themeId(theme[1]!)));
  if (theme && method === "PATCH") {
    if (!isThemeId(theme[1])) return respond(res, async () => themeId(theme[1]!));
    const b = await body();
    if (b) await respond(res, () => photoThemes.updateTheme(theme[1]!, { name: b.name, prompt: b.prompt }));
    return;
  }

  const keepPrompt = KEEP_PROMPT.exec(pathname);
  if (keepPrompt && method === "POST") return respond(res, () => photoThemes.keepPrompt(themeId(keepPrompt[1]!)));

  const person = PERSON.exec(pathname);
  if (person && method === "DELETE") {
    return respond(res, async () => {
      await photoThemes.remove(themeId(person[1]!), personId(person[2]!));
      return { removed: true };
    });
  }

  const action = PERSON_ACTION.exec(pathname);
  if (action && method === "POST") {
    const [, rawTheme, rawPerson, verb] = action as unknown as [string, string, string, string];
    if (!isThemeId(rawTheme) || !isPersonId(rawPerson)) return respond(res, async () => [themeId(rawTheme), personId(rawPerson)]);
    if (verb === "keep") return respond(res, () => photoThemes.keep(rawTheme, rawPerson));
    const b = await body();
    if (!b) return;
    if (verb === "approve") return respond(res, () => photoThemes.approve(rawTheme, rawPerson, shownFile(b.file, "file")));
    if (verb === "redo") {
      return respond(
        res,
        () => {
          let from: { planId: string; serviceTypeId: string } | null = null;
          if (b.planId !== undefined || b.serviceTypeId !== undefined) {
            if (!isPlanId(b.planId) || !isPcoId(b.serviceTypeId)) refuse("planId and serviceTypeId must both be Planning Center ids, or both absent");
            from = { planId: b.planId, serviceTypeId: b.serviceTypeId };
          }
          return photoThemes.redo(rawTheme, rawPerson, from);
        },
        202,
      );
    }
    return respond(res, async () => {
      if (!isThemeId(b.to)) refuse("to must be a theme id");
      await photoThemes.transfer(rawTheme, rawPerson, b.to, verb === "move" ? "move" : "copy");
      return { [verb === "move" ? "moved" : "copied"]: true };
    });
  }

  // ── Plans ────────────────────────────────────────────────────────────────

  const plan = PLAN.exec(pathname);
  if (plan && method === "GET") {
    return respond(res, () => photoThemes.planPeople(planId(plan[1]!), serviceTypeId(url.searchParams.get("serviceTypeId"))));
  }
  if (plan && method === "PATCH") {
    if (!isPlanId(plan[1])) return respond(res, async () => planId(plan[1]!));
    const b = await body();
    if (!b) return;
    return respond(res, () => {
      const st = serviceTypeId(b.serviceTypeId);
      if (b.themeId !== undefined && b.themeId !== null && !isThemeId(b.themeId)) refuse("themeId must be a theme id or null");
      if (b.show !== undefined && b.show !== "original" && b.show !== "themed") refuse('show must be "original" or "themed"');
      if (b.themeId === undefined && b.show === undefined) refuse("send a themeId, a show or both");
      return photoThemes.choosePlan(plan[1]!, {
        serviceTypeId: st,
        sortDate: b.sortDate === undefined ? undefined : sortDate(b.sortDate),
        ...(b.themeId !== undefined ? { themeId: b.themeId as string | null } : {}),
        ...(b.show !== undefined ? { show: b.show as "original" | "themed" } : {}),
      });
    });
  }

  const planAction = PLAN_ACTION.exec(pathname);
  if (planAction && method === "POST") {
    const [, rawPlan, verb] = planAction as unknown as [string, string, string];
    if (!isPlanId(rawPlan)) return respond(res, async () => planId(rawPlan));
    const b = await body();
    if (!b) return;
    if (verb === "approve-all") return respond(res, () => photoThemes.approveAll(rawPlan, shownEdits(b.people)));
    return respond(
      res,
      () => {
        const st = serviceTypeId(b.serviceTypeId);
        const mode = b.mode ?? "missing";
        if (mode !== "missing" && mode !== "all") refuse('mode must be "missing" or "all"');
        return photoThemes.generate(rawPlan, st, mode);
      },
      202,
    );
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
