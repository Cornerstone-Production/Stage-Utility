// How each state the OpenAI connection can be in reads, said the same way on the
// Integrations card and in the Theme photos panel.

import type { OpenAiState } from "@main/types/photo-themes";

export type Tone = "ok" | "warn" | "bad" | "off";

/** How each state the server can report reads. Exhaustive: a state added on the server
 *  does not compile until it is worded here. `reason` is the server's own words, and
 *  wins where it has any. */
export const STATES: Record<OpenAiState, { tone: Tone; title: string; detail: string }> = {
  "not-connected": { tone: "off", title: "Not connected", detail: "No API key is saved. Add one to use Theme photos." },
  unchecked: { tone: "off", title: "Key saved", detail: "The key has not been used yet. Test it to check it works." },
  connected: { tone: "ok", title: "Connected", detail: "Using the API key." },
  "invalid-key": { tone: "bad", title: "Not connected", detail: "OpenAI rejected the saved API key. Save a new one." },
  "out-of-credits": {
    tone: "warn",
    title: "Connected, out of credits",
    detail: "Using the API key, but its credits are used up. Edits will fail until credits are added or the plan renews.",
  },
  forbidden: {
    tone: "warn",
    title: "Image edits refused",
    detail: "OpenAI refused this key access to image edits. The organization may need verifying.",
  },
  unreachable: { tone: "warn", title: "Could not reach OpenAI", detail: "The last request did not get an answer. Test the key to try again." },
};
