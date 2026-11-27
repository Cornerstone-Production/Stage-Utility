// openai-client.ts — the two OpenAI calls photo themes makes, and what each
// failure means to an operator.
//
// Facts this rests on (endpoints, error shapes, the model id) were read from
// OpenAI's own pages on 17 Nov 2026; the private plans repo keeps the notes.
//
// THE KEY NEVER COMES BACK OUT. It goes into one header and nowhere else: no
// failure here carries OpenAI's own `error.message` (which can quote the key
// back, "Incorrect API key provided: sk-…"), only a reason built from the HTTP
// status and OpenAI's error `code` and `type`, each checked against a plain
// identifier shape before it is repeated.

import { readCapped } from "../capped-download.js";
import { isRecord } from "../../types/is-record.js";
import { scrub } from "../scrub.js";

/**
 * The image model every edit asks for. One constant so it can be changed in one
 * place: OpenAI's default snapshot of its current image model.
 */
export const OPENAI_IMAGE_MODEL = "gpt-image-2.6-flare";

/** Portrait, the shape a slot draws. One of the sizes the edits endpoint offers. */
export const EDIT_SIZE = "1024x1536";
/** WebP: a fraction of a PNG's bytes, and every edit rides in every config backup. */
export const EDIT_FORMAT = "webp";
/** Medium quality: a face on a stage display, not a print. */
export const EDIT_QUALITY = "medium";

const PRODUCTION_BASE = "https://api.openai.com/v1";

/** Edits take a while; a test is a cheap read. */
const EDIT_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 15_000;
/** One 1024x1536 WebP, base64 inside JSON, with room to spare. */
const MAX_EDIT_RESPONSE_BYTES = 40 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

let announcedOverride: string | null = null;

/**
 * Where requests go. `STAGE_UTILITY_OPENAI_BASE_URL` points them at a fake
 * server for development and tests; it is logged once, so an install that has
 * it set by mistake says so. Anything that is not an http(s) URL is ignored, and
 * said so.
 */
export function openAiBaseUrl(): string {
  const raw = process.env.STAGE_UTILITY_OPENAI_BASE_URL;
  if (!raw) return PRODUCTION_BASE;
  const url = URL.canParse(raw) ? new URL(raw) : null;
  const usable = url !== null && (url.protocol === "http:" || url.protocol === "https:");
  if (announcedOverride !== raw) {
    announcedOverride = raw;
    if (usable) console.warn(`[photo-theme] OpenAI requests go to ${scrub(raw)} (STAGE_UTILITY_OPENAI_BASE_URL, for development only)`);
    else console.warn(`[photo-theme] ignored STAGE_UTILITY_OPENAI_BASE_URL: not an http(s) address; OpenAI requests go to ${scrub(PRODUCTION_BASE)}`);
  }
  return usable ? raw.replace(/\/+$/, "") : PRODUCTION_BASE;
}

/** What a failure means, and so what is done about it. */
export type FailureKind =
  | "invalid-key"
  | "out-of-credits"
  | "rate-limited"
  | "refused"
  | "forbidden"
  | "bad-request"
  | "server-error"
  | "unreachable"
  | "timeout"
  | "no-image";

export interface OpenAiFailure {
  ok: false;
  kind: FailureKind;
  /** For an operator, never containing anything OpenAI said in words. */
  reason: string;
  /** How long OpenAI asked us to wait, for a rate limit. */
  retryAfterMs?: number;
}

/** An identifier OpenAI uses for `code` and `type`: safe to repeat. */
const IDENT = /^[a-z][a-z0-9_]{0,63}$/;

function ident(v: unknown): string | null {
  return typeof v === "string" && IDENT.test(v) ? v : null;
}

/** `Retry-After` as milliseconds: seconds, or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * What an answer that was not a success means. `body` is the parsed JSON or
 * null; only its `error.code` and `error.type` are read.
 */
export function mapFailure(status: number, body: unknown, retryAfter: string | null): OpenAiFailure {
  const err = isRecord(body) && isRecord(body.error) ? body.error : {};
  const code = ident(err.code);
  const type = ident(err.type);
  // On the code, whatever the status: OpenAI documents the refusal by its body.
  if (code === "moderation_blocked") {
    return { ok: false, kind: "refused", reason: "Refused under OpenAI's content policy" };
  }
  if (status === 401) return { ok: false, kind: "invalid-key", reason: "OpenAI rejected the API key" };
  if (code === "credit_balance_exhausted" || code === "insufficient_quota" || type === "insufficient_quota") {
    return { ok: false, kind: "out-of-credits", reason: "Out of API credits" };
  }
  if (status === 429) {
    const wait = retryAfterMs(retryAfter);
    return {
      ok: false,
      kind: "rate-limited",
      reason: "Rate limited by OpenAI; try again in a minute",
      ...(wait !== null ? { retryAfterMs: wait } : {}),
    };
  }
  if (status === 403) {
    return {
      ok: false,
      kind: "forbidden",
      reason: "OpenAI refused access to image edits; the organization may need verifying for image models",
    };
  }
  if (status >= 500) return { ok: false, kind: "server-error", reason: `OpenAI had a problem (HTTP ${status})` };
  return {
    ok: false,
    kind: "bad-request",
    reason: `OpenAI refused the request (HTTP ${status}${code ? `, ${code}` : ""})`,
  };
}

/** A fetch that threw: a timeout, or no route to OpenAI. Never the error's text. */
function networkFailure(err: unknown): OpenAiFailure {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { ok: false, kind: "timeout", reason: "OpenAI did not answer in time" };
  }
  return { ok: false, kind: "unreachable", reason: "Could not reach OpenAI" };
}

async function readJson(res: Response, cap: number): Promise<unknown> {
  const bytes = await readCapped(res, cap);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

/** Calls OpenAI with one key. Built per call, so nothing holds the key between them. */
export interface OpenAiCall {
  apiKey: string;
  /** Tests: the fetch to use. */
  fetchImpl?: typeof fetch;
}

/** A cheap call that proves the key: list the models. */
export async function testKey({ apiKey, fetchImpl = fetch }: OpenAiCall): Promise<{ ok: true } | OpenAiFailure> {
  let res: Response;
  try {
    res = await fetchImpl(`${openAiBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (err) {
    return networkFailure(err);
  }
  if (res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: true };
  }
  return mapFailure(res.status, await readJson(res, MAX_ERROR_BODY_BYTES).catch(() => null), res.headers.get("retry-after"));
}

export interface EditRequest extends OpenAiCall {
  prompt: string;
  /** The original photo, as PNG. */
  png: Buffer;
}

/**
 * Edit one photo. Resolves with the edited image's bytes, or the failure; never
 * rejects for anything OpenAI or the network did.
 */
export async function editImage(req: EditRequest): Promise<{ ok: true; bytes: Buffer } | OpenAiFailure> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const form = new FormData();
  form.set("model", OPENAI_IMAGE_MODEL);
  form.set("prompt", req.prompt);
  form.set("size", EDIT_SIZE);
  form.set("quality", EDIT_QUALITY);
  form.set("output_format", EDIT_FORMAT);
  form.set("n", "1");
  form.set("image", new Blob([new Uint8Array(req.png)], { type: "image/png" }), "photo.png");
  let res: Response;
  try {
    res = await fetchImpl(`${openAiBaseUrl()}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${req.apiKey}` },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
  } catch (err) {
    return networkFailure(err);
  }
  let body: unknown;
  try {
    body = await readJson(res, res.ok ? MAX_EDIT_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES);
  } catch (err) {
    return networkFailure(err);
  }
  if (!res.ok) return mapFailure(res.status, body, res.headers.get("retry-after"));
  const first = isRecord(body) && Array.isArray(body.data) ? body.data[0] : undefined;
  const b64 = isRecord(first) && typeof first.b64_json === "string" ? first.b64_json : null;
  const bytes = b64 ? Buffer.from(b64, "base64") : null;
  if (!bytes || bytes.length === 0) return { ok: false, kind: "no-image", reason: "OpenAI answered without an image" };
  return { ok: true, bytes };
}
