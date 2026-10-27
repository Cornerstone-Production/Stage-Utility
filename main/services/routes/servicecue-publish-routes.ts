// servicecue-publish-routes.ts — the settings behind "Public link" on the ServiceCue
// presets page: whether publishing is on, the page address, the token, and a
// connection test.
//
//   GET  /api/servicecue/publish        the settings (the token masked) and how it is going
//   POST /api/servicecue/publish        { enabled?, url?, token? }
//   POST /api/servicecue/publish/test   { url?, token? } → whether the page answers
//   POST /api/servicecue/publish/deploy-credentials   { accountId?, token? }: the Cloudflare account and API
//                                        token the server keeps the page itself up to date with
//   POST /api/servicecue/publish/deploy  { confirmDowngrade? }: "Update the page now"
//
// THE TOKENS ARE WRITE-ONLY. It is stored encrypted with the address it was saved for, never
// returned, and read back only for that address. The app has no login, so anyone on the
// network can reach this route; a saved token that could be sent to an address a stranger
// typed would hand it over. A new address therefore arrives with a new token or leaves with
// none, and a test of another address says to enter one.

import { errorMessage } from "../errors.js";
import { plural } from "../plural.js";
import { isMask, MASK, hasSecretValue } from "../mask.js";
import { scrub } from "../scrub.js";
import { secretsStore } from "../secrets.js";
import { createPushClient, FAILURE_LOG_MAX, failureForLog, problemOf } from "../servicecue-publish-client.js";
import { checkPublishToken, parsePublishUrl, type PublishOrigin } from "../servicecue-publish-rules.js";
import {
  PUBLISH_SECRET_SLOT,
  forgetPublishToken,
  readPublishToken,
  savePublishToken,
  servicecuePublishStore,
} from "../servicecue-publish-store.js";
import { servicecueDeployer, servicecuePublisher } from "../servicecue-publisher-instance.js";
import {
  checkAccountId,
  checkDeployToken,
  forgetDeployCredentials,
  readDeployCredentials,
  saveDeployCredentials,
  DEPLOY_SECRET_SLOT,
} from "../servicecue-deploy-store.js";
import type { PublishSettingsDTO, PublishTestResult } from "../../types/servicecue-publish-status.js";
import { type RouteCtx, json, error, readBody } from "./context.js";

/** The token stored for the page at `url`, masked. */
async function maskedToken(url: string): Promise<string> {
  const parsed = parsePublishUrl(url);
  return parsed.ok && hasSecretValue(await readPublishToken(parsed.origin)) ? MASK : "";
}

async function settingsDto(dropped?: PublishSettingsDTO["dropped"]): Promise<PublishSettingsDTO> {
  const settings = await servicecuePublishStore.load();
  await servicecueDeployer.refresh();
  return {
    enabled: settings.enabled,
    url: settings.url,
    token: await maskedToken(settings.url),
    status: servicecuePublisher.status(),
    deploy: servicecueDeployer.status(),
    ...(dropped ? { dropped } : {}),
  };
}

/** The page's own answer to a status request, as the card reads it. */
async function testPage(origin: PublishOrigin, token: string): Promise<PublishTestResult> {
  const r = await createPushClient({ origin, token }).status();
  if (!r.ok) {
    // The operator asked: said once each time, and with what Node said, which the card does not show.
    console.warn(`[publish] the connection test did not reach the page — ${scrub(failureForLog(r.message, r.detail), FAILURE_LOG_MAX)}`);
    return { ok: false, ...problemOf(r) };
  }
  return { ok: true, message: `Reached the page: it holds ${plural(r.page.docs.length, "document")} and ${plural(r.page.assets.length, "image")}.` };
}

/** Put a secrets slot back as it was (or empty), after a write that failed: a failure to do so is said, and the original failure still reaches the caller. */
async function restoreSlot(slot: string, previous: Record<string, string>, what: string): Promise<void> {
  const put = Object.keys(previous).length > 0 ? secretsStore.setSecrets(slot, previous) : secretsStore.clearSecrets(slot);
  await put.catch((e: unknown) => console.error(`[publish] could not put the saved ${scrub(what)} back: ${scrub(errorMessage(e))}`));
}

/** The message for the first of `fields` that `body` carries as the wrong type, or null. */
function wrongType(body: Record<string, unknown>, fields: readonly (readonly [string, "string" | "boolean"])[]): string | null {
  for (const [name, type] of fields) {
    if (body[name] !== undefined && typeof body[name] !== type) return `${name} ${type === "string" ? "must be a string" : "must be true or false"}`;
  }
  return null;
}

/** What a request says to do with a saved token: leave it (no token, or the mask), clear it, replace it, or it cannot be used. */
type TokenEdit = { kind: "keep" } | { kind: "clear" } | { kind: "set"; text: string } | { kind: "invalid"; message: string };

function tokenEdit(raw: string | undefined, check: (text: string) => string | null): TokenEdit {
  if (raw === undefined || isMask(raw)) return { kind: "keep" };
  const text = raw.trim();
  if (text === "") return { kind: "clear" };
  const message = check(text);
  return message ? { kind: "invalid", message } : { kind: "set", text };
}

/** Two requests that change the settings at once would each read the settings before either wrote them. */
let writing: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = writing.then(work, work);
  writing = run.catch(() => undefined);
  return run;
}

export async function serviceCuePublishRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;

  if (method === "GET" && pathname === "/api/servicecue/publish") {
    json(res, await settingsDto());
    return;
  }

  if (method === "POST" && pathname === "/api/servicecue/publish") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const wrong = wrongType(body, [["enabled", "boolean"], ["url", "string"], ["token", "string"]]);
    if (wrong) {
      error(res, wrong);
      return;
    }
    await serialized(() => saveSettings(c, body as SaveBody));
    return;
  }

  if (method === "POST" && pathname === "/api/servicecue/publish/deploy-credentials") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const wrong = wrongType(body, [["accountId", "string"], ["token", "string"]]);
    if (wrong) {
      error(res, wrong);
      return;
    }
    await serialized(() => saveDeployCredentialsFrom(c, body as DeployCredentialsBody));
    return;
  }

  if (method === "POST" && pathname === "/api/servicecue/publish/deploy") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const wrong = wrongType(body, [["confirmDowngrade", "boolean"]]);
    if (wrong) {
      error(res, wrong);
      return;
    }
    await deployNow(c, body.confirmDowngrade === true);
    return;
  }

  if (method === "POST" && pathname === "/api/servicecue/publish/test") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const saved = await servicecuePublishStore.load();
    const parsed = parsePublishUrl(typeof body.url === "string" && body.url.trim() !== "" ? body.url : saved.url);
    if (!parsed.ok) {
      json(res, { ok: false, kind: "config", message: parsed.message } satisfies PublishTestResult);
      return;
    }
    const typed = typeof body.token === "string" && hasSecretValue(body.token) && !isMask(body.token) ? body.token.trim() : null;
    const why = typed === null ? null : checkPublishToken(typed);
    if (why) {
      json(res, { ok: false, kind: "config", message: why } satisfies PublishTestResult);
      return;
    }
    // Never a typed address with the saved token: the saved one is read back only for the address it was saved for.
    const token = typed ?? (await readPublishToken(parsed.origin)).trim();
    if (!token) {
      const savedParsed = parsePublishUrl(saved.url);
      const message =
        typed === null && savedParsed.ok && savedParsed.origin !== parsed.origin
          ? "Enter the publishing token to test a different address."
          : "Enter the publishing token.";
      json(res, { ok: false, kind: "config", message } satisfies PublishTestResult);
      return;
    }
    json(res, await testPage(parsed.origin, token));
    return;
  }
}

/** What POST /api/servicecue/publish may carry, once its types have been checked. */
interface SaveBody {
  enabled?: boolean;
  url?: string;
  token?: string;
}

/** What POST /api/servicecue/publish/deploy-credentials may carry, once its types have been checked. */
interface DeployCredentialsBody {
  accountId?: string;
  token?: string;
}

/**
 * POST /api/servicecue/publish/deploy-credentials, one at a time with the other settings writes.
 *
 * The pair is saved for the page's address, and read back only for it. A token of "" clears both: updating
 * the page from this server is on exactly while a token is stored. A token of the mask, or none, leaves the
 * stored one; an account ID typed alone changes the account and keeps the token.
 */
async function saveDeployCredentialsFrom(c: RouteCtx, body: DeployCredentialsBody): Promise<void> {
  const { res } = c;
  const parsed = parsePublishUrl((await servicecuePublishStore.load()).url);
  if (!parsed.ok) {
    error(res, "Set the page address first: the Cloudflare token is saved for that address.");
    return;
  }
  const before = await readDeployCredentials(parsed.origin);

  let accountId = before?.accountId ?? "";
  if (typeof body.accountId === "string") {
    const text = body.accountId.trim();
    const why = text === "" ? null : checkAccountId(text);
    if (why) {
      error(res, why);
      return;
    }
    accountId = text.toLowerCase();
  }
  let token = before?.token ?? "";
  let clear = typeof body.accountId === "string" && accountId === "";
  const edit = tokenEdit(body.token, checkDeployToken);
  if (edit.kind === "invalid") {
    error(res, edit.message);
    return;
  }
  if (edit.kind === "clear") clear = true;
  else if (edit.kind === "set") token = edit.text;
  if (!clear && (token === "" || accountId === "")) {
    error(res, "Enter the Cloudflare account ID and the API token together.");
    return;
  }

  const previous = await secretsStore.getSecrets(DEPLOY_SECRET_SLOT);
  try {
    if (clear) {
      if (Object.keys(previous).length > 0) await forgetDeployCredentials();
    } else {
      await saveDeployCredentials(parsed.origin, { accountId, token });
    }
  } catch (err) {
    await restoreSlot(DEPLOY_SECRET_SLOT, previous, "Cloudflare credentials");
    throw err;
  }
  await servicecueDeployer.credentialsChanged();
  json(res, await settingsDto());
}

/** POST /api/servicecue/publish/deploy: the card's "Update the page now". Every outcome has its status and code; the compiler holds this to all of them. */
async function deployNow(c: RouteCtx, confirmDowngrade: boolean): Promise<void> {
  const { res } = c;
  const outcome = await servicecueDeployer.deployNow({ confirmDowngrade });
  const dto = await settingsDto();
  const refuse = (message: string, status: number, code: string, more: Record<string, unknown> = {}) => json(res, { error: message, code, ...more, deploy: dto.deploy }, status);
  switch (outcome.kind) {
    case "deployed":
      // Went ahead on the request with no word from Planning Center about whether a service is live (never when one is known to be): the answer says so.
      json(res, outcome.serviceStateUnknown ? { ...dto, serviceState: "unknown" } : dto);
      return;
    case "current":
      json(res, { ...dto, already: "current" });
      return;
    case "off":
      refuse("Enter the Cloudflare account ID and API token first.", 400, "no-token");
      return;
    case "no-bundle":
      refuse(outcome.message, 409, "no-bundle");
      return;
    case "waiting":
      refuse("A service is live. The page is not updated during one: it updates when the service ends.", 409, "service-live");
      return;
    case "newer":
      refuse(
        `The page was deployed from ${outcome.pageVersion}, which is newer than this server's ${outcome.runningVersion}. It is not rolled back unless the request says confirmDowngrade: true.`,
        409,
        "newer",
        { pageVersion: outcome.pageVersion, runningVersion: outcome.runningVersion },
      );
      return;
    case "other-build":
      refuse(
        `The page is build ${outcome.pageBuild ?? "unknown"} of this server's own version ${outcome.version}, deployed by another server. It is not replaced unless the request says confirmDowngrade: true.`,
        409,
        "other-build",
        { pageBuild: outcome.pageBuild, pageVersion: outcome.version },
      );
      return;
    case "limited":
      res.setHeader("Retry-After", String(outcome.retryAfterSec));
      refuse(`The page was updated a moment ago. Try again in ${outcome.retryAfterSec} seconds.`, 429, "too-soon", { retryAfterSec: outcome.retryAfterSec });
      return;
    case "failed":
      refuse(`The page could not be updated: ${outcome.message}. It is unchanged.`, 502, "failed");
      return;
  }
}

/** POST /api/servicecue/publish, one at a time. */
async function saveSettings(c: RouteCtx, body: SaveBody): Promise<void> {
  const { res } = c;
  const before = await servicecuePublishStore.load();
  const beforeParsed = parsePublishUrl(before.url);
  const hadToken = beforeParsed.ok && hasSecretValue(await readPublishToken(beforeParsed.origin));

  let url = before.url;
  if (typeof body.url === "string") {
    if (body.url.trim() === "") {
      url = "";
    } else {
      const parsed = parsePublishUrl(body.url);
      if (!parsed.ok) {
        error(res, parsed.message);
        return;
      }
      url = parsed.origin;
    }
  }
  const target = parsePublishUrl(url);

  const edit = tokenEdit(body.token, checkPublishToken);
  if (edit.kind === "invalid") {
    error(res, edit.message);
    return;
  }
  const newToken = edit.kind === "set" ? edit.text : null;
  let clearToken = edit.kind === "clear";
  // The token belongs to the address it was saved for. Another address with no token in the same request leaves with none.
  const sameAddress = beforeParsed.ok && target.ok && target.origin === beforeParsed.origin;
  if (!sameAddress && newToken === null) clearToken = true;
  if (newToken !== null && !target.ok) {
    error(res, "Enter the page address with the token: a token is saved for one address.");
    return;
  }
  const willHaveToken = newToken !== null || (hadToken && sameAddress && !clearToken);

  // An address cleared in this very request switches publishing off with it: there is nowhere left to send to.
  // Asking to switch on with none is refused.
  const clearedAddress = typeof body.url === "string" && url === "";
  const enabled = clearedAddress ? false : (body.enabled ?? before.enabled);
  if (enabled && (!target.ok || !willHaveToken)) {
    error(res, "Fill in the page address and the publishing token first.");
    return;
  }

  // The token and its address in one write, then the settings. If the second fails the first is put back, so a token
  // is never left beside an address it was not saved for; and a token read back for any address but its own reads as none.
  const previous = await secretsStore.getSecrets(PUBLISH_SECRET_SLOT);
  // The Cloudflare credentials are for the page they were saved with, too: another address leaves with none.
  const previousDeploy = await secretsStore.getSecrets(DEPLOY_SECRET_SLOT);
  const dropDeploy = !sameAddress && Object.keys(previousDeploy).length > 0;
  try {
    if (newToken !== null && target.ok) await savePublishToken(target.origin, newToken);
    else if (clearToken && Object.keys(previous).length > 0) await forgetPublishToken();
    if (dropDeploy) await forgetDeployCredentials();
    await servicecuePublishStore.save({ enabled, url });
  } catch (err) {
    await restoreSlot(PUBLISH_SECRET_SLOT, previous, "token");
    if (dropDeploy) await restoreSlot(DEPLOY_SECRET_SLOT, previousDeploy, "Cloudflare credentials");
    throw err;
  }
  if (dropDeploy) await servicecueDeployer.credentialsChanged();

  const { dropped } = await servicecuePublisher.apply({ dropCopy: before.enabled && !enabled });
  json(res, await settingsDto(dropped));
}
