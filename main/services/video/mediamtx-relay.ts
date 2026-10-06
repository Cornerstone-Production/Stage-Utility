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

import { errorMessage } from "../errors.js";
import { planReconcile, relayUsers } from "./reconcile-plan.js";
import { withoutCredentials } from "./redact-url.js";
import { RelayReconcileError, type RelayFeed, type RelayPath, type VideoRelay } from "./relay.js";
import { apiUser, type RelayUser } from "./mediamtx-config.js";

const REQUEST_TIMEOUT_MS = 5000;

/** `source.type` on a runtime path, mapped to the plural the kick endpoint
 *  takes. The only three a push feed of this app can ever be (srt, rtmp,
 *  whip — PUSH_PROTOCOLS in types/video.ts). */
const KICK_ENDPOINT: ReadonlyMap<string, string> = new Map([
  ["rtmpConn", "rtmpconns"],
  ["srtConn", "srtconns"],
  ["webRTCSession", "webrtcsessions"],
]);

interface ConfigPathsListResponse {
  items?: ({ name: string } & Record<string, unknown>)[];
}

interface GlobalConfig {
  authInternalUsers?: RelayUser[];
}

/** MediaMTX's names for the video codecs it can carry (v1.21.1 spells them AV1,
 *  VP9, VP8, H265, H264, M-JPEG, MPEG-4 Video and MPEG-1/2 Video), compared with
 *  everything but letters and digits dropped so a spelling change such as MJPEG
 *  for M-JPEG still counts. Anything else it lists is audio or data. */
const VIDEO_CODECS = new Set(["AV1", "VP9", "VP8", "H265", "H264", "MJPEG", "MPEG4VIDEO", "MPEG12VIDEO"]);

function isVideoCodec(codec: string): boolean {
  return VIDEO_CODECS.has(codec.toUpperCase().replace(/[^A-Z0-9]/g, ""));
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

/** For the users comparison only: the API user's password as the relay
 *  answers it back ("<redacted>", like every non-empty one). It never
 *  changes for the life of a MediaMtxRelay, so unlike a push feed's it needs
 *  no re-patch to stay right, and a reader-only relay still converges. */
function withApiPassRedacted(users: RelayUser[]): RelayUser[] {
  const name = apiUser("").user;
  return users.map((u) => (u.user === name && u.pass ? { ...u, pass: "<redacted>" } : u));
}

/** MediaMTX, driven through its own control API. The only implementation of
 *  VideoRelay; everything else in the app sees relay.ts's interface. Every
 *  call authenticates as the API user (mediamtx-config.ts's apiUser), with
 *  the password its relay was started with. */
export class MediaMtxRelay implements VideoRelay {
  private readonly authorization: string;

  constructor(
    private readonly apiPort: number,
    private readonly apiPassword: string,
  ) {
    this.authorization = `Basic ${Buffer.from(`${apiUser(apiPassword).user}:${apiPassword}`).toString("base64")}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${this.apiPort}${path}`, {
      method,
      headers: body === undefined ? { Authorization: this.authorization } : { Authorization: this.authorization, "Content-Type": "application/json" },
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

    const desiredUsers = relayUsers(feeds, this.apiPassword);
    const currentUsers = global.authInternalUsers ?? [];
    if (!isDeepStrictEqual(canonicalUsers(withApiPassRedacted(desiredUsers)), canonicalUsers(currentUsers))) {
      await this.request("PATCH", "/v3/config/global/patch", { authInternalUsers: desiredUsers });
    }

    // Every path is attempted whatever an earlier one did: a path the relay
    // rejects must not keep the others from being added, replaced or removed.
    // The failures are rethrown together, so the caller still sees a failed
    // reconcile and retries.
    const plan = planReconcile(feeds, current);
    const writes: [string, () => Promise<unknown>][] = [
      ...plan.add.map(([name, conf]): [string, () => Promise<unknown>] => [
        name,
        () => this.request("POST", `/v3/config/paths/add/${encodeURIComponent(name)}`, conf),
      ]),
      ...plan.replace.map(([name, conf]): [string, () => Promise<unknown>] => [
        name,
        () => this.request("POST", `/v3/config/paths/replace/${encodeURIComponent(name)}`, conf),
      ]),
      ...plan.remove.map((name): [string, () => Promise<unknown>] => [
        name,
        () => this.request("DELETE", `/v3/config/paths/delete/${encodeURIComponent(name)}`),
      ]),
    ];
    const failures: { name: string; reason: string }[] = [];
    for (const [name, write] of writes) {
      try {
        await write();
      } catch (err) {
        failures.push({ name, reason: errorMessage(err) });
      }
    }
    if (failures.length > 0) {
      // Names the paths and the reasons, never how many were attempted: a retry
      // only attempts what is still pending, so a count ("1 of 3", then "1 of 1")
      // would make one outage read as a new one to the caller's OutageLog, which
      // keys on the message.
      throw new RelayReconcileError(
        `could not set up relay paths (${failures.map((f) => `${f.name}: ${f.reason}`).join("; ")})`,
        failures.map((f) => f.name),
      );
    }
  }

  async status(): Promise<RelayPath[]> {
    const list = (await this.request("GET", "/v3/paths/list")) as RuntimePathsListResponse;
    return (list.items ?? []).map((item) => {
      // The picture's track, not just the first: a publisher may list its
      // audio first, and an audio track has no size. A track whose size is
      // not known yet (an H.264 stream still waiting for its first frame)
      // falls back to the first VIDEO track, so an audio-first publisher does
      // not report Opus as its picture; only a path with no video track at all
      // falls through to whatever is listed first.
      const track =
        item.tracks2?.find((t) => t.codecProps?.width !== undefined) ??
        item.tracks2?.find((t) => isVideoCodec(t.codec)) ??
        item.tracks2?.[0];
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
    const endpoint = KICK_ENDPOINT.get(item.source.type);
    if (!endpoint) {
      throw new Error(`Cannot kick a publisher of type "${item.source.type}"`);
    }
    await this.request("POST", `/v3/${endpoint}/kick/${encodeURIComponent(item.source.id)}`);
    return true;
  }
}
