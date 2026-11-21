// openai-connection.ts — the server's OpenAI API key, and how the connection stands.
//
// The key is a credential like a Planning Center secret, kept in secrets.bin under
// its own slot. secrets.bin never leaves the box (a config snapshot does not carry
// it), and the key never leaves this module except into the one header a call
// sends: what anything else is given is a hint, `sk-…3f2a`.
//
// How the connection stands is an observation, kept in memory: the last test or
// edit says whether the key works, and an edit is the only thing that can say the
// credits ran out (listing the models works either way).

import { secretsStore } from "../secrets.js";
import { scrub } from "../scrub.js";
import type { OpenAiConnectionDTO, OpenAiState } from "../../types/photo-themes.js";
import { PhotoThemeRefused } from "./book.js";
import { testKey, type FailureKind, type OpenAiFailure } from "./openai-client.js";

/** The secrets.bin slot. Not an integration id: OpenAI is not an integration card. */
export const OPENAI_SECRET_SLOT = "openai";
const KEY_FIELD = "apiKey";

/**
 * A key as a save takes it: 20 to 512 printable ASCII characters with no space.
 * The shape matters beyond tidiness: a key goes into an HTTP header, and a
 * character a header cannot carry would fail inside fetch with an error that
 * might quote it.
 */
const KEY_SHAPE = /^[\x21-\x7e]{20,512}$/;

export function keyProblem(v: unknown): string | null {
  if (typeof v !== "string") return "apiKey must be text";
  if (!KEY_SHAPE.test(v.trim())) return "That does not look like an OpenAI API key: it should be one line of letters, numbers and dashes, like sk-…";
  return null;
}

/** The key masked to its last four characters. */
export function keyHint(key: string): string {
  const tail = key.slice(-4);
  return key.startsWith("sk-") ? `sk-…${tail}` : `…${tail}`;
}

/** Failure kinds that say something about the connection rather than one photo. */
const CONNECTION_STATE = new Map<FailureKind, OpenAiState>([
  ["invalid-key", "invalid-key"],
  ["out-of-credits", "out-of-credits"],
  ["forbidden", "forbidden"],
  ["unreachable", "unreachable"],
  ["timeout", "unreachable"],
]);

export class OpenAiConnection {
  private state: OpenAiState = "not-connected";
  private reason: string | null = null;
  private checkedAt: string | null = null;
  private hint: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Read the saved key's hint. Call once, at boot. */
  async start(): Promise<void> {
    const key = await this.apiKey();
    this.hint = key ? keyHint(key) : null;
    this.state = key ? "unchecked" : "not-connected";
  }

  /** The key, for the one header that carries it. Null when none is saved. */
  async apiKey(): Promise<string | null> {
    const key = (await secretsStore.getSecrets(OPENAI_SECRET_SLOT))[KEY_FIELD];
    return key ? key : null;
  }

  status(): OpenAiConnectionDTO {
    return {
      method: this.hint ? "api-key" : null,
      hint: this.hint,
      state: this.state,
      reason: this.reason,
      checkedAt: this.checkedAt,
    };
  }

  /** Whether an edit can be tried at all: a key is saved and OpenAI has not rejected it. */
  usable(): { ok: true } | { ok: false; reason: string } {
    if (!this.hint) return { ok: false, reason: "OpenAI is not connected: add an API key in Integrations" };
    if (this.state === "invalid-key") return { ok: false, reason: "OpenAI rejected the saved API key: save a new one in Integrations" };
    return { ok: true };
  }

  /** Save a key, replacing any. Throws PhotoThemeRefused for one that cannot be a key. */
  async saveKey(raw: unknown): Promise<OpenAiConnectionDTO> {
    const problem = keyProblem(raw);
    if (problem) throw new PhotoThemeRefused(problem);
    const key = (raw as string).trim();
    await secretsStore.setSecrets(OPENAI_SECRET_SLOT, { [KEY_FIELD]: key });
    this.hint = keyHint(key);
    this.set("unchecked", null);
    console.log("[photo-theme] OpenAI API key saved");
    return this.status();
  }

  async clearKey(): Promise<OpenAiConnectionDTO> {
    await secretsStore.clearSecrets(OPENAI_SECRET_SLOT);
    this.hint = null;
    this.set("not-connected", null);
    console.log("[photo-theme] OpenAI API key removed");
    return this.status();
  }

  /** Prove the key with a cheap call. */
  async test(fetchImpl?: typeof fetch): Promise<OpenAiConnectionDTO> {
    const apiKey = await this.apiKey();
    if (!apiKey) {
      this.set("not-connected", null);
      return this.status();
    }
    const result = await testKey({ apiKey, fetchImpl });
    if (result.ok) {
      // Listing models cannot see credits, so an edit's "out of credits" stands.
      if (this.state === "out-of-credits") this.set("out-of-credits", "The key works, but its credits were used up at the last edit");
      else this.set("connected", null);
    } else {
      this.recordFailure(result, "test");
      if (!CONNECTION_STATE.has(result.kind)) this.set("unreachable", result.reason);
    }
    return this.status();
  }

  /** An edit worked. */
  recordSuccess(): void {
    if (this.state !== "connected") this.set("connected", null);
    else this.checkedAt = new Date(this.now()).toISOString();
  }

  /** An edit or test failed: record what it says about the connection, and log a change. */
  recordFailure(failure: OpenAiFailure, during: "test" | "edit"): void {
    const next = CONNECTION_STATE.get(failure.kind);
    if (!next) return;
    if (next !== this.state) {
      console.warn(`[photo-theme] OpenAI connection failing during ${scrub(during)}: ${scrub(failure.reason)}`);
    }
    this.set(next, failure.reason);
  }

  private set(state: OpenAiState, reason: string | null): void {
    this.state = state;
    this.reason = reason;
    this.checkedAt = state === "not-connected" || state === "unchecked" ? null : new Date(this.now()).toISOString();
  }
}
