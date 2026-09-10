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
  splitToggleLabel,
  togglePairSlug,
} from "../companion-export.js";
import { stateBindingParams, stateBindingProblem } from "../cue-pairs.js";
import { fingerprintParams } from "../companion-fingerprint.js";
import { runCompanionReconcile } from "../companion-reconcile.js";
import { bearerOf, cueTokens, isSameOriginBrowser, refusalReason } from "../cue-tokens.js";
import { CALL_TRIGGER_ID } from "../automation-triggers.js";
import { homeAssistantYaml } from "../home-assistant-yaml.js";
import { cueStates } from "../cue-states.js";
import { cueManifest } from "../cue-manifest.js";
import { stageController } from "../stage-controller.js";
import type { Rule } from "../../types/automation.js";

/** Answer plain text (the Home Assistant config is not JSON). */
function text(
  c: RouteCtx,
  body: string,
  headers: Record<string, string> = { "Content-Type": "text/yaml; charset=utf-8" },
): void {
  if (c.res.headersSent || c.res.writableEnded) return;
  c.res.writeHead(200, headers);
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
    // WHICH way it failed, because "no valid token" is what the log said for
    // an hour while a Home Assistant install had the right token and the wrong
    // header. Never the token itself: a near-miss in the log is a token in the
    // log.
    console.warn(`[cues] refused ${scrub(c.method)} ${scrub(c.pathname)}: ${scrub(refusalReason(c.req.headers.authorization))}`);
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
    //
    // Content-Disposition names the file the download button saves, fixed on
    // purpose: the docs tell the operator to save it as
    // packages/stage_utility.yaml, and a filename that drifted with the server's
    // own name would make that instruction wrong.
    text(c, homeAssistantYaml(automationEngine.listRules(), baseUrlFor(c)), {
      "Content-Type": "text/yaml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="stage_utility.yaml"',
    });
    return;
  }

  if (method === "GET" && pathname === "/api/cues/states") {
    // Open, like the YAML and the token list: it carries cue names, the
    // Companion variable names the operator chose, and on/off. Gating it would
    // need a header a same-origin GET does not send, and the thing polling it
    // is a Home Assistant `rest` sensor that carries no token.
    //
    // Reads Companion on demand and serves the answer for five seconds
    // (cue-states.ts), so a sensor polling every ten seconds costs one round of
    // reads and an install nobody polls costs nothing.
    json(res, await cueStates.read());
    return;
  }

  if (method === "GET" && pathname === "/api/cues/manifest") {
    // Open, like the states route, the YAML and the token list. It carries cue
    // names, room names, on/off and this server's own LAN address — all of
    // which GET /api/automation/rules and GET /api/version already serve to
    // anyone on the LAN — and never a token.
    json(res, await cueManifest());
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
    // Names AND FORMER NAMES. The engine treats the two as one namespace — no
    // rule may take either from another — so an offer whose proposed name is
    // somebody's former name would be shown as available, ticked, and then
    // refused by addRule with the operator having been told it was free. That
    // is the ordinary case after a relabel: a button renamed "Screens ON" and
    // then back to "Projectors ON" is offered as `projectors_on`, which is now
    // the cue's former name.
    const taken = takenCueNames();
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
        // Where this pair's device already reports its own state, or null.
        // The binding lives on the `_on` half, so that half's button is the
        // evidence; the `_off` half is read only when the ON button is a macro
        // that names no device. See companion-state-source.ts.
        stateSource: p.on.stateSource ?? p.off.stateSource,
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
      // Imported as a TOGGLE, this button's cues are named after its pair base,
      // not after its own slug — `record_toggle` becomes `record_on`/
      // `record_off`. Reading `exists` off the slug alone offered an already
      // imported toggle again forever, and taking the offer created a THIRD cue
      // on the same key: a Home Assistant switch and a script fighting over one
      // button. Re-running the import is the ordinary case, so this is the
      // documented path.
      const base = slug ? togglePairSlug(slug, b.label) : "";
      const exists =
        !!slug &&
        (taken.has(slug) || (!!base && (taken.has(`${base}_on`) || taken.has(`${base}_off`))));
      return { ...b, slug, exists };
    });
    // The custom variables Companion has, so the import dialog can offer a pair
    // a state binding without a second request. Empty on an install with none,
    // which is not an error — see customVariableNames.
    json(res, { ok: true, pairs, buttons, customVariables: result.customVariables });
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

/**
 * Every cue name in use, INCLUDING former names.
 *
 * The engine treats the two as one namespace — no rule may take either from
 * another — so an offer or an import that only looked at current names would
 * show a name as free and then be refused by addRule. One copy, for the offer
 * and for the toggle import both.
 */
function takenCueNames(): Set<string> {
  const taken = new Set<string>();
  for (const rule of automationEngine.listRules()) {
    const name = automationEngine.cueNameOf(rule);
    if (name) taken.add(name);
    for (const alias of automationEngine.cueAliasesOf(rule)) taken.add(alias);
  }
  return taken;
}

/**
 * The cooldown every imported cue carries, in seconds.
 *
 * The backstop behind the desired-state check, and it runs after it: a bound
 * pair presses nothing when the device is already where the call asks for (see
 * callByName in automation-engine.ts), and this catches the repeats that check
 * cannot — an unbound pair, a single button, or a second call arriving before
 * the device's own state variable has caught up with the first.
 *
 * Three seconds rather than two because a Home Assistant switch that repeats
 * `turn_on` does so about two seconds apart, which slipped straight through.
 * ONE constant for the pairs import and the single-button import both.
 */
const IMPORT_COOLDOWN_SEC = 3;

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
 * The state binding an offer asks for, as the three params a rule stores.
 *
 * The VALUES come from the offer as well as the variable, because the dialog
 * may have chosen a module variable the button itself named — `power_state` on
 * a kasa plug holds `On`, not `on`, and the comparison is case-sensitive. Every
 * key is blank for an offer with no binding, which stateBindingOf reads as no
 * binding at all.
 *
 * Untrusted, like everything else off the request body: what comes back goes
 * straight into stateBindingProblem, which is the same check the rule editor
 * saves through.
 */
function bindingFromOffer(o: Record<string, unknown>): Record<string, string> {
  const variable = String(o.stateVariable ?? "").trim();
  if (!variable) return stateBindingParams(null);
  return stateBindingParams({
    variable,
    onValue: String(o.stateOnValue ?? "").trim(),
    offValue: String(o.stateOffValue ?? "").trim(),
  });
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
 * Every generated rule carries the `service.is-not-live` condition and a three
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
    // The Companion custom variable this pair's state is read from, chosen in
    // the dialog. Optional; blank is an optimistic pair, as every pair was
    // before this existed.
    const binding = bindingFromOffer(p);

    if (!slug || !on || !off) {
      skipped.push({ name: base || "(unnamed)", why: "incomplete pair" });
      continue;
    }
    // Checked BEFORE either half is created: addRule would refuse the `_on`
    // rule and create the `_off` one, leaving half a pair behind for a typo in
    // a field that is not even the cue's name. Through the SAME check the rule
    // editor saves against, so an inferred binding whose values are "On"/"Off"
    // and a hand-typed one are refused for the same reasons.
    const problem = stateBindingProblem(binding);
    if (problem) {
      skipped.push({ name: slug, why: problem });
      continue;
    }

    // When the slug had to be disambiguated by page (see cueSlugs), the
    // WORDS have to be disambiguated too — otherwise two rules read "Projectors
    // ON" in the list and Home Assistant gets two switches both called
    // "Projectors", which is the same collision moved one system along.
    const pageName = String(p.pageName ?? "").trim();
    const spoken = slug !== slugForCue(base) && pageName ? `${pageName} ${base}` : base;

    await addPairRules({ slug, spoken, binding, buttons: { on, off }, label: base }, {
      created,
      skipped,
    });
  }

  return { created, skipped };
}

/**
 * Create the two rules of one pair, `<slug>_on` and `<slug>_off`.
 *
 * ONE copy, for a real ON/OFF pair and for a toggle button imported as a pair
 * both. A toggle passes the SAME button as both halves — that is the whole
 * difference between the two, and the reason this is not two nearly-identical
 * loops that would drift the first time a default changed.
 *
 * Appends to the caller's result rather than returning its own: a pair whose
 * `_on` half clashes still offers its `_off` half, which is how re-running the
 * import fills in a half somebody deleted.
 */
async function addPairRules(
  pair: {
    slug: string;
    /** The words, already disambiguated by page where it was needed. */
    spoken: string;
    /**
     * The binding params for the `_on` half — every key blank for an optimistic
     * pair. See bindingFromOffer.
     */
    binding: Record<string, string>;
    buttons: { on: ImportButton; off: ImportButton };
    /** The button label to fall back on when the offer carried none. */
    label: string;
  },
  out: ImportResult,
): Promise<void> {
  for (const suffix of ["on", "off"] as const) {
    const name = `${pair.slug}_${suffix}`;
    const rule: Omit<Rule, "id"> = {
      name: `${pair.spoken} ${suffix.toUpperCase()}`,
      enabled: true,
      trigger: {
        id: CALL_TRIGGER_ID,
        params: {
          name,
          says: `${pair.spoken} ${suffix}`,
          // On the `_on` half only; the `_off` half inherits it by name. See
          // cue-pairs.ts.
          //
          // The VALUES travel with it. A custom variable an operator's own
          // buttons set holds "on"/"off" and needs neither, but an INFERRED
          // module variable holds `On`/`Off` — or `On-Air`/`Off-Air` — and the
          // comparison is case-sensitive, so a binding imported without them is
          // a pair that reads unknown forever with nothing on screen saying why.
          ...(suffix === "on" && pair.binding.stateVariable ? pair.binding : {}),
        },
      },
      conditions: [{ id: "service.is-not-live", params: {} }],
      action: {
        id: "companion.press",
        params: pressParamsFor(pair.buttons[suffix], `${pair.label} ${suffix.toUpperCase()}`),
      },
      cooldownSec: IMPORT_COOLDOWN_SEC,
      oncePerService: false,
    };
    try {
      // addRule is what enforces uniqueness, so a duplicate is refused by the
      // same check the rule editor goes through rather than by a second copy
      // of it here.
      await automationEngine.addRule(rule);
      out.created.push(name);
    } catch (err) {
      out.skipped.push({ name, why: errorMessage(err) });
    }
  }
}

/**
 * Turn chosen single buttons into ONE cue each.
 *
 * The same defaults as a pair's two halves — `service.is-not-live` and a three
 * second cooldown — for the same reason: a cue somebody can say during a
 * service, twice, is the failure mode this feature has to not have.
 *
 * Unlike a pair there is no ON/OFF to speak, so the cue's name, its spoken
 * words and its `says` are all the button's own label. A slug that had to be
 * disambiguated by page carries the page name in the WORDS too, exactly as a
 * pair's do — otherwise two cues both read "Record" in the rules list and Home
 * Assistant gets two scripts with one alias.
 *
 * UNLESS the offer carries a `stateVariable`, which says the button is a TOGGLE.
 * Then it becomes a PAIR whose two halves press the same button, and the
 * variable is what tells the two directions apart. A toggle imported as one cue
 * is a Home Assistant `script`, which HomeKit shows as a momentary switch that
 * snaps back — so every tap pressed the toggle again and the light ended up
 * whichever way the taps happened to land.
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

    // A toggle: one button that is both directions, told apart by a variable.
    const binding = bindingFromOffer(o);
    if (binding.stateVariable) {
      // Checked BEFORE either half is created, exactly as the pairs import
      // does: a typo in a field that is not even the cue's name must not leave
      // half a pair behind.
      const problem = stateBindingProblem(binding);
      if (problem) {
        skipped.push({ name: slug, why: problem });
        continue;
      }
      // The DIRECTION word comes off the label first — "VCR Light ON" is a
      // toggle for the VCR light, and a pair named after the whole label would
      // have an off cue called `vcr_light_on_off`. The slug is stripped the same
      // way rather than re-slugged, so a page disambiguation the offer already
      // carries survives.
      //
      // No emptiness check on what comes back: slugForCue has already
      // normalised the slug above, so it cannot be a bare `_on` that strips to
      // nothing — and if it ever were, addRule refuses `_on` as a cue name and
      // the button is reported skipped with the reason, which is a better
      // answer than a second copy of that rule here.
      const { base } = splitToggleLabel(label);
      const pairSlug = togglePairSlug(slug, label);
      const spokenBase =
        spoken === label ? base : `${spoken.slice(0, spoken.length - label.length)}${base}`;
      // ALL OR NOTHING, unlike a real ON/OFF pair, where a half that clashes is
      // reported and the other half still lands — which is how somebody
      // re-imports a half they deleted. A toggle cannot do that: the binding
      // lives on the `_on` half, so a surviving `_off` half alone is an UNBOUND
      // cue that then pairs itself with whatever unrelated `<base>_on` was
      // already there, and the generated switch turns that stranger on and this
      // button off.
      const taken = takenCueNames();
      const clash = ["on", "off"].map((half) => `${pairSlug}_${half}`).find((n) => taken.has(n));
      if (clash) {
        skipped.push({
          name: clash,
          why: `"${clash}" is already used — a toggle is imported as a whole pair or not at all`,
        });
        continue;
      }
      await addPairRules(
        {
          slug: pairSlug,
          spoken: spokenBase,
          binding,
          // The SAME button both ways: that is what a toggle is.
          buttons: { on: button, off: button },
          label: base,
        },
        { created, skipped },
      );
      continue;
    }

    const rule: Omit<Rule, "id"> = {
      name: spoken,
      enabled: true,
      trigger: { id: CALL_TRIGGER_ID, params: { name: slug, says: spoken } },
      conditions: [{ id: "service.is-not-live", params: {} }],
      action: { id: "companion.press", params: pressParamsFor(button, label) },
      cooldownSec: IMPORT_COOLDOWN_SEC,
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
