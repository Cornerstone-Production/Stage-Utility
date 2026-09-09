// cue-routes.ts — calling a rule by name, and the Companion button pickers.
//
// A cue is an ordinary automation rule whose trigger is "Called by name". These
// routes are the only way one ever runs, and the only routes in this app that
// require a credential: everything else here is LAN-trusted by design, but a cue
// presses real buttons on real gear on behalf of a voice assistant, and "anyone
// who can reach the port" is the wrong audience for that.
//
// Three gates, and the differences are deliberate:
//
//  - `POST /api/cues/<name>` ALWAYS needs a bearer token, browser or not. There
//    is no operator-at-the-console case for it; the console has a Test button.
//  - the management WRITES (mint, revoke, import-pairs, buttons/refresh) need one
//    unless the request is a same-origin browser write — an `Origin` naming
//    this server, which a page on this app's own origin always sends on a POST
//    or DELETE and a page anywhere else cannot forge. (Not `Sec-Fetch-Site`:
//    browsers send that only to HTTPS or localhost, and this app is plain HTTP
//    on a LAN address. See isSameOriginBrowser.)
//  - the management READS (the token LIST and the Home Assistant fragment) are
//    not gated at all, like every other read in this app. A same-origin GET sends
//    no `Origin`, so the only thing they could be gated on is a header curl can
//    type — and neither carries a secret. The list is labels, ids and timestamps
//    (never a hash); the YAML names cues that `GET /api/automation/rules` already
//    serves to anyone, and refers to the token as `!secret`, never by value.
//
// None of this is a perimeter. Rules CRUD is ungated like every other setting, so
// a LAN caller can write a cue and a token alike; the token identifies the caller
// in the log and keeps the CALL route shut to anything that was not handed one.
// The perimeter is the network. See SECURITY.md.
//
// Every route must finish responding before it returns (see RouteCtx).

import { type RouteCtx, error, json, readBody } from "./context.js";
import { errorMessage } from "../errors.js";
import { scrub } from "../scrub.js";
import { automationEngine } from "../automation-engine.js";
import { companionApi } from "../companion-api.js";
import {
  cueSlugs,
  isSuggestedPair,
  singleButtons,
  slugForCue,
} from "../companion-export.js";
import { fingerprintParams } from "../companion-fingerprint.js";
import { runCompanionReconcile } from "../companion-reconcile.js";
import { bearerOf, cueTokens, isSameOriginBrowser } from "../cue-tokens.js";
import { CALL_TRIGGER_ID } from "../automation-triggers.js";
import { homeAssistantYaml } from "../home-assistant-yaml.js";
import { stageController } from "../stage-controller.js";
import type { Rule } from "../../types/automation.js";

/** Answer plain text (the Home Assistant config is not JSON). */
function text(c: RouteCtx, body: string, contentType = "text/yaml; charset=utf-8"): void {
  if (c.res.headersSent || c.res.writableEnded) return;
  c.res.writeHead(200, { "Content-Type": contentType });
  c.res.end(body);
}

/**
 * Identify the caller, or answer 401 and return null.
 *
 * `allowSameOrigin` covers the app's own pages on a WRITE, where the browser
 * sends an `Origin` naming this server. See isSameOriginBrowser.
 */
async function requireCaller(
  c: RouteCtx,
  opts: { allowSameOrigin: boolean },
): Promise<{ id: string; label: string } | null> {
  if (opts.allowSameOrigin && isSameOriginBrowser(c.req.headers)) {
    return { id: "browser", label: "the settings page" };
  }
  const caller = await cueTokens.verify(bearerOf(c.req.headers.authorization));
  if (!caller) {
    console.warn(`[cues] refused ${scrub(c.method)} ${scrub(c.pathname)}: no valid token`);
    error(c.res, "A bearer token is required", 401);
    return null;
  }
  return caller;
}

/** Where Home Assistant should send its calls. A LAN IP, never a name. */
function baseUrlFor(c: RouteCtx): string {
  const lan = stageController.getState().lanUrl;
  if (lan) return lan;
  // Falls back to whatever the caller reached us on, which at worst is the same
  // address they already typed.
  return `http://${c.req.headers.host ?? "localhost:8788"}`;
}

export async function cueRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method, url } = c;

  // ── Tokens ────────────────────────────────────────────────────────────────

  if (pathname === "/api/cues/tokens" && (method === "GET" || method === "POST")) {
    // The LIST is an open read: labels, ids and last-use times, never a hash.
    // Gating it would need a header a same-origin GET does not send.
    if (method === "GET") {
      json(res, { tokens: await cueTokens.list() });
      return;
    }
    if (!(await requireCaller(c, { allowSameOrigin: true }))) return;
    const body = (await readBody(req)) as Record<string, unknown>;
    if (typeof body.label !== "string" || !body.label.trim()) {
      error(res, "body.label (string) required — it is how you know which token to revoke");
      return;
    }
    try {
      const minted = await cueTokens.mint(body.label);
      // The secret is in this response and nowhere else, ever again.
      json(res, { token: minted.token, secret: minted.secret }, 201);
    } catch (err) {
      error(res, errorMessage(err), 400);
    }
    return;
  }

  const revokeMatch = pathname.match(/^\/api\/cues\/tokens\/([^/]+)$/);
  if (method === "DELETE" && revokeMatch) {
    if (!(await requireCaller(c, { allowSameOrigin: true }))) return;
    const removed = await cueTokens.revoke(revokeMatch[1]!);
    if (!removed) {
      error(res, "No such token", 404);
      return;
    }
    json(res, { ok: true, tokens: await cueTokens.list() });
    return;
  }

  // ── Home Assistant config ─────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/cues/home-assistant.yaml") {
    // Open, like every other read here. It contains cue names — which
    // GET /api/automation/rules already serves to anyone on the LAN — and refers
    // to the token as `!secret stage_utility_token`, never by value.
    text(c, homeAssistantYaml(automationEngine.listRules(), baseUrlFor(c)));
    return;
  }

  // ── Calling a cue ─────────────────────────────────────────────────────────

  const callMatch = pathname.match(/^\/api\/cues\/([^/]+)$/);
  if (method === "POST" && callMatch) {
    // No same-origin exemption. See the header comment.
    const caller = await requireCaller(c, { allowSameOrigin: false });
    if (!caller) return;

    // The confirmation may arrive either way round: Home Assistant's
    // rest_command sends a body easily, a shell sends a query string easily.
    const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const confirm = url.searchParams.get("confirm") ?? (typeof body.confirm === "string" ? body.confirm : null);

    const result = await automationEngine.callByName(callMatch[1]!, {
      caller: caller.label,
      confirm,
    });

    // Recorded AFTER the call, and its failure is carried into the answer rather
    // than logged away: a cue must still fire when secrets.bin cannot be written,
    // but nobody may read a stale "last used" as if it were current.
    if (caller.id !== "browser" && result.status === 200) {
      const touched = await cueTokens.touch(caller.id);
      if (!touched.ok) {
        console.warn(`[cues] ${scrub(touched.detail)}`);
        result.body.detail = `${result.body.detail} (${touched.detail})`;
      }
    }

    json(res, result.body, result.status);
    return;
  }

  // ── Companion buttons ─────────────────────────────────────────────────────

  if (method === "POST" && pathname === "/api/companion/buttons/refresh") {
    if (!(await requireCaller(c, { allowSameOrigin: true }))) return;
    companionApi.invalidate();
    const result = await companionApi.fetchExport({ force: true });
    if (!result.ok) {
      json(res, { ok: false, reason: result.reason, buttons: [] });
      return;
    }
    // Refresh means "read Companion again", and the cues are the reason anybody
    // presses it. Reads the export just cached rather than fetching a second
    // time. Awaited so the answer is not overtaken by the statuses it changed.
    const run = await runCompanionReconcile();
    // A pass that could not write a status is NOT a successful refresh. It
    // answered `ok: true` while a read-only rules file meant nothing had been
    // saved, and the pill on the row still showed what the last good pass found
    // — so there was nothing on screen to notice. `reconcile` carries which
    // cues, so the caller can name them rather than say "something failed".
    const failed = run?.failed ?? [];
    json(res, {
      ok: failed.length === 0,
      buttons: result.buttons,
      cachedAt: result.cachedAt,
      reconcile: { applied: run?.applied ?? 0, failed },
    });
    return;
  }

  if (method === "GET" && pathname === "/api/companion/buttons") {
    const result = await companionApi.fetchExport();
    // 200 with `ok: false` rather than a 5xx: the picker has a real thing to
    // show for "Companion is unreachable" — the three number fields — and a
    // failed request would only give it a toast.
    if (!result.ok) {
      json(res, { ok: false, reason: result.reason, buttons: [] });
      return;
    }
    json(res, { ok: true, buttons: result.buttons, cachedAt: result.cachedAt });
    return;
  }

  if (method === "GET" && pathname === "/api/companion/pairs") {
    const result = await companionApi.fetchExport();
    if (!result.ok) {
      json(res, { ok: false, reason: result.reason, pairs: [] });
      return;
    }
    const taken = new Set(automationEngine.listRules().map((r) => automationEngine.cueNameOf(r)).filter(Boolean));
    // The single buttons are worked out HERE rather than below, because the cue
    // names of the pairs and of the singles are resolved together: uniqueness is
    // a property of the whole offer, and counted per family a lone "House Lights
    // ON" and a "House Lights ON/OFF" pair on another page both come out
    // `house_lights_on`. See cueSlugs.
    const singles = singleButtons(result.buttons, result.pairs);
    const slugs = cueSlugs(result.pairs, singles);
    const pairs = result.pairs.map((p) => {
      const slug = slugs.pairs.get(`${p.page}:${slugForCue(p.base)}`) ?? "";
      return {
        ...p,
        slug,
        // Ticked by default only when the buttons drive a utility device — a
        // projector, a television, a plug, a light. Everything else is offered,
        // unticked. See isSuggestedPair; this used to be a list of one site's
        // page names.
        suggested: isSuggestedPair(p),
        exists: !!slug && (taken.has(`${slug}_on`) || taken.has(`${slug}_off`)),
      };
    });

    // The single buttons come back from the same request, because deciding
    // which buttons are NOT half of a pair needs the pairs — a second endpoint
    // would compute them twice and could disagree with this one.
    //
    // Nothing here is `suggested`. A pair is two buttons that are plainly a
    // thing being turned on and off; a single button is whatever somebody put on
    // a Companion page, and pre-ticking those would arm cues for camera shots
    // and playback macros. The dialog ticks nothing in this section.
    const buttons = singles.map((b) => {
      const slug = slugs.buttons.get(`${b.page}:${b.row}:${b.col}`) ?? "";
      return { ...b, slug, exists: !!slug && taken.has(slug) };
    });
    json(res, { ok: true, pairs, buttons });
    return;
  }

  // ── Importing pairs as rules ──────────────────────────────────────────────

  if (method === "POST" && pathname === "/api/automation/rules/import-pairs") {
    if (!(await requireCaller(c, { allowSameOrigin: true }))) return;
    const body = (await readBody(req)) as Record<string, unknown>;
    // Either key, or both, in ONE request: the dialog offers pairs and single
    // buttons in one list and a single Import button, and two requests would
    // report two half-results for one press.
    const pairs = Array.isArray(body.pairs) ? body.pairs : null;
    const buttons = Array.isArray(body.buttons) ? body.buttons : null;
    if (!pairs && !buttons) {
      error(res, "body.pairs or body.buttons (array) required");
      return;
    }
    const fromPairs = await importPairs(pairs ?? []);
    const fromButtons = await importButtons(buttons ?? []);
    const created = [...fromPairs.created, ...fromButtons.created];
    const skipped = [...fromPairs.skipped, ...fromButtons.skipped];
    // ONE line for the whole import, not one per kind: the operator pressed one
    // button, and two lines reading "0 created" and "3 created" is a puzzle.
    console.log(
      `[cues] import from Companion: ${scrub(created.length)} created, ${scrub(skipped.length)} skipped`,
    );
    json(res, { created, skipped });
    return;
  }
}

interface ImportButton {
  page: number;
  row: number;
  col: number;
  label?: string;
  pageId: string;
  actionIds: string[];
}

/** Narrow one untrusted button offer from the request body. */
function asButton(v: unknown): ImportButton | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const page = Number(o.page);
  const row = Number(o.row);
  const col = Number(o.col);
  if (![page, row, col].every((n) => Number.isFinite(n))) return null;
  return {
    page,
    row,
    col,
    label: typeof o.label === "string" ? o.label : undefined,
    // The identity travels with the offer, so an imported cue knows its button
    // from the moment it is created rather than waiting for the first reconcile.
    // Absent from a hand-built request, which the first reconcile then adopts.
    pageId: typeof o.pageId === "string" ? o.pageId : "",
    actionIds: Array.isArray(o.actionIds) ? o.actionIds.filter((x): x is string => typeof x === "string") : [],
  };
}

/**
 * The `companion.press` params for an imported button: the coordinates, the
 * label, and the fingerprint that lets a reconcile follow it.
 *
 * ONE copy, for the pairs import and the single-button import both — this is
 * exactly the shape that lived in one of two places and drifted.
 */
function pressParamsFor(button: ImportButton, fallbackLabel: string): Record<string, string | number> {
  return fingerprintParams(
    {
      page: button.page,
      row: button.row,
      col: button.col,
      pageId: button.pageId,
      label: button.label ?? fallbackLabel,
      actionIds: button.actionIds,
    },
    "in-place",
    new Date().toISOString(),
  );
}

/**
 * Turn chosen ON/OFF pairs into two rules each.
 *
 * Every generated rule carries the `service.is-not-live` condition and a two
 * second cooldown, and both are the point of importing rather than hand-writing:
 * a cue that somebody can say during a service, twice, is the failure mode this
 * whole feature has to not have. They stay editable afterwards — the import sets
 * the defaults, it does not own the rule.
 *
 * A name already in use is SKIPPED and reported, never overwritten. Re-running
 * the import after adding a button to Companion is the ordinary case, and it
 * must not rewrite rules somebody has since edited.
 */
interface ImportResult {
  created: string[];
  skipped: { name: string; why: string }[];
}

async function importPairs(raw: unknown[]): Promise<ImportResult> {
  const created: string[] = [];
  const skipped: { name: string; why: string }[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;
    const base = String(p.base ?? "").trim();
    const on = asButton(p.on);
    const off = asButton(p.off);
    const slug = typeof p.slug === "string" && p.slug ? slugForCue(p.slug) : slugForCue(base);

    if (!slug || !on || !off) {
      skipped.push({ name: base || "(unnamed)", why: "incomplete pair" });
      continue;
    }

    // When the slug had to be disambiguated by page (see cueSlugs), the
    // WORDS have to be disambiguated too — otherwise two rules read "Projectors
    // ON" in the list and Home Assistant gets two switches both called
    // "Projectors", which is the same collision moved one system along.
    const pageName = String(p.pageName ?? "").trim();
    const spoken = slug !== slugForCue(base) && pageName ? `${pageName} ${base}` : base;

    for (const [suffix, button] of [["on", on], ["off", off]] as const) {
      const name = `${slug}_${suffix}`;
      const rule: Omit<Rule, "id"> = {
        name: `${spoken} ${suffix.toUpperCase()}`,
        enabled: true,
        trigger: {
          id: CALL_TRIGGER_ID,
          params: { name, says: `${spoken} ${suffix}` },
        },
        conditions: [{ id: "service.is-not-live", params: {} }],
        action: {
          id: "companion.press",
          params: pressParamsFor(button, `${base} ${suffix.toUpperCase()}`),
        },
        cooldownSec: 2,
        oncePerService: false,
      };
      try {
        // addRule is what enforces uniqueness, so a duplicate is refused by the
        // same check the rule editor goes through rather than by a second copy
        // of it here.
        await automationEngine.addRule(rule);
        created.push(name);
      } catch (err) {
        skipped.push({ name, why: errorMessage(err) });
      }
    }
  }

  return { created, skipped };
}

/**
 * Turn chosen single buttons into ONE cue each.
 *
 * The same defaults as a pair's two halves — `service.is-not-live` and a two
 * second cooldown — for the same reason: a cue somebody can say during a
 * service, twice, is the failure mode this feature has to not have.
 *
 * Unlike a pair there is no ON/OFF to speak, so the cue's name, its spoken
 * words and its `says` are all the button's own label. A slug that had to be
 * disambiguated by page carries the page name in the WORDS too, exactly as a
 * pair's do — otherwise two cues both read "Record" in the rules list and Home
 * Assistant gets two scripts with one alias.
 */
async function importButtons(raw: unknown[]): Promise<ImportResult> {
  const created: string[] = [];
  const skipped: { name: string; why: string }[] = [];

  for (const entry of raw) {
    const button = asButton(entry);
    const o = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const label = String(o.label ?? "").trim();
    const slug = typeof o.slug === "string" && o.slug ? slugForCue(o.slug) : slugForCue(label);

    if (!button || !slug) {
      skipped.push({ name: label || "(unnamed)", why: "no usable cue name for this button" });
      continue;
    }

    const pageName = String(o.pageName ?? "").trim();
    const spoken = slug !== slugForCue(label) && pageName ? `${pageName} ${label}` : label;

    const rule: Omit<Rule, "id"> = {
      name: spoken,
      enabled: true,
      trigger: { id: CALL_TRIGGER_ID, params: { name: slug, says: spoken } },
      conditions: [{ id: "service.is-not-live", params: {} }],
      action: { id: "companion.press", params: pressParamsFor(button, label) },
      cooldownSec: 2,
      oncePerService: false,
    };
    try {
      // addRule enforces uniqueness, so a name already in use is refused by the
      // same check the rule editor goes through.
      await automationEngine.addRule(rule);
      created.push(slug);
    } catch (err) {
      skipped.push({ name: slug, why: errorMessage(err) });
    }
  }

  return { created, skipped };
}
