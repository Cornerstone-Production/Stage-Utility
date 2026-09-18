// youtube-connect.ts — Google's OAuth 2.0 device flow for the YouTube "My
// broadcasts" mode: a code the operator types at google.com/device from a
// phone, in place of a refresh token minted by hand in the OAuth Playground.
//
// ONE PENDING ATTEMPT AT MOST, held in module state rather than persisted — a
// restart forgets it and the operator presses Connect again, which is fine:
// the device code is only useful for the few minutes someone is actually
// typing it in. What IS persisted, through integration-manager's normal
// setConfig path, is the outcome: the refresh token (a secret) and the
// channel title (ordinary config).
//
// Every request Google answers is read for its `error` field before anything
// else, because the pending case is not a failure — `authorization_pending`
// arrives on every poll until the operator finishes on their phone, and
// treating it as one would end the attempt the moment it started.

import { scrub } from "./scrub.js";
import { integrationManager } from "./integration-manager.js";

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const REQUEST_TIMEOUT_MS = 10_000;
/** Google's own floor is looser than this in practice, but polling faster than
 *  every 5 seconds is a good way to earn a `slow_down`. */
const MIN_INTERVAL_S = 5;
/** `slow_down` means "you are polling too fast" — this is by how much the
 *  interval widens each time it is said. */
const SLOW_DOWN_STEP_MS = 5_000;

export interface ConnectStatus {
  status: "idle" | "pending" | "connected" | "error";
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: number;
  message?: string;
  channelTitle?: string | null;
}

/** I/O the state machine needs, injected so a test never touches the network,
 *  a real clock, or integration-manager's config store. Mutable, like the
 *  equivalent `stateProbeDeps` — a test overwrites a function here and
 *  restores it in `afterEach`. */
export const youtubeConnectDeps: {
  now: () => number;
  fetch: typeof fetch;
  /** Runs `fn` after `ms`; returns a canceller. Never keeps the process alive. */
  schedule: (fn: () => void, ms: number) => () => void;
  /** Stores the result of a successful attempt, through setConfig's ordinary
   *  secret path, and runs the integration's test. */
  saveConnection: (refreshToken: string, channelTitle: string) => Promise<void>;
  /** Clears the stored refresh token and channel title, and stops the poll. */
  clearConnection: () => Promise<void>;
  /** Whether a refresh token is on file right now, read from storage rather
   *  than from this module's own memory — see getYouTubeConnectionInfo. */
  connectionInfo: () => Promise<{ connected: boolean; channelTitle: string | null }>;
} = {
  now: () => Date.now(),
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  },
  saveConnection: (refreshToken, channelTitle) => integrationManager.saveYouTubeConnection(refreshToken, channelTitle),
  clearConnection: () => integrationManager.setConfig("youtube", { refreshToken: "", channelTitle: "" }).then(() => undefined),
  connectionInfo: () => integrationManager.getYouTubeConnectionInfo(),
};

interface Attempt {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
  clientId: string;
  clientSecret: string;
}

let attempt: Attempt | null = null;
let lastError: string | null = null;
let pollCancel: (() => void) | null = null;

function stopPolling(): void {
  pollCancel?.();
  pollCancel = null;
}

function schedulePoll(delayMs: number): void {
  stopPolling();
  pollCancel = youtubeConnectDeps.schedule(() => void doPoll(), delayMs);
}

/** Google's device/code error, mapped to a sentence an operator can act on.
 *  Used at the START step only — the one place a wrong client TYPE (Web /
 *  Desktop rather than TV & Limited Input) shows up. */
function describeStartError(body: { error?: string; error_description?: string }): string {
  if (body.error === "invalid_client" || body.error === "unauthorized_client") {
    return "This OAuth client cannot use the device flow. Create one of type TVs and Limited Input devices.";
  }
  return body.error_description || body.error || "Google did not explain the error";
}

export async function start(clientId: string, clientSecret: string): Promise<ConnectStatus> {
  stopPolling();
  attempt = null;
  lastError = null;

  const res = await youtubeConnectDeps.fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !body.device_code || !body.user_code) {
    const message = describeStartError(body);
    lastError = message;
    console.warn(`[youtube] connect: ${scrub(message)}`);
    return { status: "error", message };
  }

  const expiresInS = body.expires_in ?? 1800;
  const expiresAt = youtubeConnectDeps.now() + expiresInS * 1000;
  const intervalMs = Math.max(MIN_INTERVAL_S, body.interval ?? MIN_INTERVAL_S) * 1000;
  attempt = {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl: body.verification_url || "https://www.google.com/device",
    expiresAt,
    intervalMs,
    clientId,
    clientSecret,
  };
  console.log(
    `[youtube] connect: code issued, waiting at google.com/device (expires in ${scrub(String(Math.round(expiresInS / 60)))} min)`,
  );
  schedulePoll(attempt.intervalMs);
  return {
    status: "pending",
    userCode: attempt.userCode,
    verificationUrl: attempt.verificationUrl,
    expiresAt: attempt.expiresAt,
  };
}

function endWithError(message: string, logLine: string): void {
  attempt = null;
  lastError = message;
  console.warn(`[youtube] connect: ${scrub(logLine)}`);
}

async function finishSuccess(accessToken: string, refreshToken: string): Promise<void> {
  let channelTitle: string | null;
  try {
    const res = await youtubeConnectDeps.fetch(CHANNELS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      items?: { snippet?: { title?: string } }[];
    };
    channelTitle = body.items?.[0]?.snippet?.title ?? null;
  } catch {
    // The refresh token is the thing that matters; a channel name it could not
    // fetch just stays unknown until the next Connect, per the descriptor doc.
    channelTitle = null;
  }

  attempt = null;
  lastError = null;
  await youtubeConnectDeps.saveConnection(refreshToken, channelTitle ?? "");
  console.log(
    `[youtube] connect: approved, refresh token stored for ${scrub(channelTitle ?? "an unnamed channel")}`,
  );
}

async function doPoll(): Promise<void> {
  const a = attempt;
  if (!a) return;

  if (youtubeConnectDeps.now() >= a.expiresAt) {
    endWithError("The code expired; press Connect again", "code expired");
    return;
  }

  let body: {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  try {
    const res = await youtubeConnectDeps.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: a.clientId,
        client_secret: a.clientSecret,
        device_code: a.deviceCode,
        grant_type: GRANT_TYPE,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = (await res.json().catch(() => ({}))) as typeof body;
  } catch {
    // A network blip does not end an attempt the operator's code is still
    // good for at Google — poll again at the same interval rather than
    // reporting an error over what may be a one-off DNS hiccup.
    schedulePoll(a.intervalMs);
    return;
  }

  if (body.access_token && body.refresh_token) {
    await finishSuccess(body.access_token, body.refresh_token);
    return;
  }

  switch (body.error) {
    case "authorization_pending":
      schedulePoll(a.intervalMs);
      return;
    case "slow_down":
      a.intervalMs += SLOW_DOWN_STEP_MS;
      schedulePoll(a.intervalMs);
      return;
    case "access_denied":
      endWithError("You declined the request in Google", "declined in Google");
      return;
    case "expired_token":
      endWithError("The code expired; press Connect again", "code expired");
      return;
    default: {
      const message = body.error_description || body.error || "Google did not explain the error";
      endWithError(message, message);
      return;
    }
  }
}

export async function status(): Promise<ConnectStatus> {
  if (attempt) {
    return {
      status: "pending",
      userCode: attempt.userCode,
      verificationUrl: attempt.verificationUrl,
      expiresAt: attempt.expiresAt,
    };
  }
  // Storage, before the stale error. A refresh token can land without ever
  // going through this module — the "Paste a token instead" disclosure writes
  // straight through integration-manager's setConfig — so a failed attempt
  // from five minutes ago must not keep reporting "error" over a token that
  // arrived afterward. `lastError` is only ever the right answer once nothing
  // is actually connected.
  const info = await youtubeConnectDeps.connectionInfo();
  if (info.connected) return { status: "connected", channelTitle: info.channelTitle };
  if (lastError) return { status: "error", message: lastError };
  return { status: "idle" };
}

/** DELETE with no `disconnect` flag: give up on a pending attempt. A no-op
 *  when nothing is pending. */
export function cancel(): void {
  if (!attempt) {
    lastError = null;
    return;
  }
  stopPolling();
  attempt = null;
  lastError = null;
  console.log("[youtube] connect: cancelled");
}

/** DELETE with `{ disconnect: true }`: clear the stored refresh token and
 *  channel title, and stop the service. Through the same setConfig path every
 *  integration write uses, so the refresh token leaves secrets.bin the same
 *  way it arrived. */
export async function disconnect(): Promise<void> {
  stopPolling();
  attempt = null;
  lastError = null;
  await youtubeConnectDeps.clearConnection();
  console.log("[youtube] disconnected, refresh token cleared");
}

/** Test-only: the module holds a singleton attempt, and nothing else resets
 *  it between test files. */
export function __resetForTests(): void {
  stopPolling();
  attempt = null;
  lastError = null;
}
