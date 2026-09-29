// main/services/video/mediamtx-relay.ts — MediaMTX as a loopback REST API:
// making its live paths and publish users match a feed list.
//
// Every call goes to http://127.0.0.1:<apiPort>, the relay's own control API
// (mediamtx-config.ts binds it to 127.0.0.1 only), so nothing here ever
// touches the LAN or credentials on the wire in a log line — a non-2xx
// answer's Error carries only the relay's own `error` text, never the
// request body or URL a caller supplied.
//
// reconcile() patches `authInternalUsers` before adding any path: a push
// feed's device may start dialling the instant its path exists, and the
// relay checks a publisher's credentials against whatever
// `authInternalUsers` holds at that moment — adding the path first would
// let the very first connection race a user that is not there yet.
//
// Two things about `GET /v3/config/global/get`, confirmed against the real
// v1.21.1 binary and not in its docs:
//
// 1. It normalizes a bare IP in `ips` to CIDR ("127.0.0.1" comes back
//    "127.0.0.1/32", "::1" comes back "::1/128"). Comparing the raw values
//    would see READER_USER as changed on every single call and re-patch
//    forever — canonicalUsers() below normalizes both sides the same way
//    before the diff, so a converged reader-only relay makes no writes.
// 2. It redacts a non-empty password to the literal string "<redacted>" —
//    there is no way to read back what a push user's password currently is.
//    So comparing `pass` literally means a push feed's PATCH looks
//    "changed" on every reconcile (desired is a real password; current is
//    always "<redacted>"), and this always re-sends it. That is
//    deliberate, not missed: the alternative — excluding `pass` from the
//    comparison so an unchanged relay makes no writes — would also skip
//    the patch on a GENUINE password rotation (a push feed's "New password"),
//    since nothing else about that user changes. A silently stale
//    publish password is worse than an extra harmless PATCH (every live
//    publisher and reader survives it, observed against the same binary).

import { isDeepStrictEqual } from "node:util";

import { publishUsers, planReconcile } from "./reconcile-plan.js";
import { withoutCredentials } from "./redact-url.js";
import type { RelayFeed, RelayPath, VideoRelay } from "./relay.js";
import type { RelayUser } from "./mediamtx-config.js";

const REQUEST_TIMEOUT_MS = 5000;

/** `source.type` on a runtime path, mapped to the plural the kick endpoint
 *  takes. The only three a push feed of this app can ever be (srt, rtmp,
 *  whip — PUSH_PROTOCOLS in types/video.ts). */
const KICK_ENDPOINT: Record<string, string> = {
  rtmpConn: "rtmpconns",
  srtConn: "srtconns",
  webRTCSession: "webrtcsessions",
};

interface ConfigPathsListResponse {
  items?: ({ name: string } & Record<string, unknown>)[];
}

interface GlobalConfig {
  authInternalUsers?: RelayUser[];
}

interface RuntimePathItem {
  name: string;
  ready: boolean;
  readyTime: string | null;
  source: { type: string; id: string } | null;
  tracks2?: { codec: string; codecProps?: { width?: number; height?: number; profile?: string } }[];
  readers?: unknown[];
}

interface RuntimePathsListResponse {
  items?: RuntimePathItem[];
}

/** A bare IP, canonicalized to the CIDR form the relay itself always
 *  answers with — see the file header. Already-CIDR values pass through
 *  unchanged, so this is safe to apply to both the desired and the
 *  relay-reported side of a comparison. */
function canonicalIp(ip: string): string {
  if (ip.includes("/")) return ip;
  return ip.includes(":") ? `${ip}/128` : `${ip}/32`;
}

function canonicalUsers(users: RelayUser[]): RelayUser[] {
  return users.map((user) => ({ ...user, ips: user.ips.map(canonicalIp) }));
}

/** MediaMTX, driven through its own control API. The only implementation of
 *  VideoRelay; everything else in the app sees relay.ts's interface. */
export class MediaMtxRelay implements VideoRelay {
  constructor(private readonly apiPort: number) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${this.apiPort}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      // JSON.parse's own message quotes the start of the body, which is
      // relay text this module has not vetted — never the Error's message.
      throw new Error(`MediaMTX answered ${res.status}, not JSON`);
    }
    if (!res.ok) {
      const message =
        data !== null && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : `MediaMTX answered ${res.status}`;
      throw new Error(withoutCredentials(message));
    }
    return data;
  }

  async reconcile(feeds: RelayFeed[]): Promise<void> {
    const [pathsList, global] = await Promise.all([
      this.request("GET", "/v3/config/paths/list") as Promise<ConfigPathsListResponse>,
      this.request("GET", "/v3/config/global/get") as Promise<GlobalConfig>,
    ]);

    const current = (pathsList.items ?? []).map((item) => {
      const { name, ...conf } = item;
      return { name, conf };
    });

    const desiredUsers = publishUsers(feeds);
    const currentUsers = global.authInternalUsers ?? [];
    if (!isDeepStrictEqual(canonicalUsers(desiredUsers), canonicalUsers(currentUsers))) {
      await this.request("PATCH", "/v3/config/global/patch", { authInternalUsers: desiredUsers });
    }

    const plan = planReconcile(feeds, current);
    for (const [name, conf] of plan.add) {
      await this.request("POST", `/v3/config/paths/add/${encodeURIComponent(name)}`, conf);
    }
    for (const [name, conf] of plan.replace) {
      await this.request("POST", `/v3/config/paths/replace/${encodeURIComponent(name)}`, conf);
    }
    for (const name of plan.remove) {
      await this.request("DELETE", `/v3/config/paths/delete/${encodeURIComponent(name)}`);
    }
  }

  async status(): Promise<RelayPath[]> {
    const list = (await this.request("GET", "/v3/paths/list")) as RuntimePathsListResponse;
    return (list.items ?? []).map((item) => {
      const track = item.tracks2?.[0];
      return {
        name: item.name,
        ready: item.ready,
        readyTime: item.readyTime ?? null,
        source: item.source ? { type: item.source.type, id: item.source.id } : null,
        video: track
          ? {
              codec: track.codec,
              width: track.codecProps?.width,
              height: track.codecProps?.height,
              profile: track.codecProps?.profile,
            }
          : null,
        readers: item.readers?.length ?? 0,
      };
    });
  }

  playback(feedId: string): { whep: string; hls: string } {
    const base = `/video/${feedId}`;
    return { whep: `${base}/whep`, hls: `${base}/index.m3u8` };
  }

  async kickPublisher(feedId: string): Promise<boolean> {
    const list = (await this.request("GET", "/v3/paths/list")) as RuntimePathsListResponse;
    const item = list.items?.find((path) => path.name === feedId);
    if (!item?.source) return false; // Nobody is publishing to this feed right now.
    const endpoint = KICK_ENDPOINT[item.source.type];
    if (!endpoint) {
      throw new Error(`Cannot kick a publisher of type "${item.source.type}"`);
    }
    await this.request("POST", `/v3/${endpoint}/kick/${encodeURIComponent(item.source.id)}`);
    return true;
  }
}
