// probe.ts — ask a camera to describe its stream, without streaming it.
//
// The relay pulls a source only while something shows it, so a pulled feed
// reads Standby until clicked and a wrong address looks like a quiet camera.
// A probe is the cheap question that tells them apart: RTSP DESCRIBE, or a GET
// of an HLS playlist. Pure I/O: no stores, no timers outside one request, no
// logging. The scheduler (probe-scheduler.ts) decides when to ask and what to
// say about the answer.
//
// A credential never leaves this file except on the wire to the camera it
// belongs to: every reason below names the host and port, nothing else.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { spropResolution } from "./h264-sps.js";

/** The whole probe, connect to verdict, including a login retry. */
export const PROBE_TIMEOUT_MS = 5000;

const DEFAULT_RTSP_PORT = 554;
const DEFAULT_RTSPS_PORT = 322;
/** Most of a reply this reads; a camera's SDP or a playlist's head is far smaller. */
const MAX_REPLY_BYTES = 64 * 1024;

export interface ProbeTarget {
  url: string;
  username: string;
  password: string;
}

export type ProbeResult =
  | { state: "ready"; codec?: string; width?: number; height?: number }
  | { state: "failed"; reason: string }
  /** Not asked: the only way to ask is to stream it (SRT). */
  | { state: "unchecked" }
  /** The camera was there but kept answering 406 — see BUSY_RETRIES. Says
   *  nothing either way about the feed, so the scheduler keeps what it had. */
  | { state: "busy" };

/** How a source address is probed, or null when it cannot be cheaply. */
export function probeKind(url: string): "rtsp" | "hls" | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === "rtsp" || scheme === "rtsps") return "rtsp";
  if (scheme === "http" || scheme === "https") return "hls";
  return null;
}

/** A failure with the sentence the operator reads. */
class ProbeFailure extends Error {}

const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

export interface DigestParams {
  username: string;
  password: string;
  realm: string;
  nonce: string;
  method: string;
  uri: string;
  /** "auth" when the camera offered it; absent for the older RFC 2069 form. */
  qop?: string;
  nc?: string;
  cnonce?: string;
}

/** The `response` field of a Digest Authorization header (RFC 2617, MD5). */
export function digestResponse(p: DigestParams): string {
  const ha1 = md5(`${p.username}:${p.realm}:${p.password}`);
  const ha2 = md5(`${p.method}:${p.uri}`);
  if (p.qop) return md5(`${ha1}:${p.nonce}:${p.nc ?? ""}:${p.cnonce ?? ""}:${p.qop}:${ha2}`);
  return md5(`${ha1}:${p.nonce}:${ha2}`);
}

/** The `key="value"` pairs of one WWW-Authenticate challenge. */
function challengeParams(challenge: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of challenge.matchAll(/([a-z0-9_-]+)=(?:"([^"]*)"|([^\s,]*))/gi)) {
    out.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? "");
  }
  return out;
}

/** A value that goes into a header: never a line break, whatever it was typed or sent as. */
const headerSafe = (v: string): string => v.replace(/[\r\n]/g, "");

/** What answering a camera's challenges came to: a header to send, or the one
 *  login method asked for that this check cannot do. */
export type AuthAnswer = { header: string } | { unsupported: string } | null;

/** The Authorization header answering a camera's challenges. Digest (MD5, with
 *  qop=auth or none) is preferred over Basic when both are offered. A Digest
 *  this cannot do (another algorithm, or only auth-int) falls to Basic when
 *  that is offered too, and otherwise says which it was. Null when the camera
 *  offered neither scheme. */
export function authorizationFor(challenges: readonly string[], target: ProbeTarget, method: string, uri: string): AuthAnswer {
  const basic = challenges.some((c) => /^\s*basic\b/i.test(c));
  const digest = challenges.find((c) => /^\s*digest\b/i.test(c));
  let unsupported: string | null = null;
  if (digest) {
    const params = challengeParams(digest);
    const algorithm = (params.get("algorithm") ?? "MD5").toUpperCase();
    const qopOffered = (params.get("qop") ?? "").split(",").map((q) => q.trim().toLowerCase()).filter(Boolean);
    const realm = params.get("realm");
    const nonce = params.get("nonce");
    if (algorithm !== "MD5") unsupported = `algorithm ${algorithm}`;
    else if (qopOffered.length > 0 && !qopOffered.includes("auth")) unsupported = `qop ${qopOffered.join(", ")}`;
    else if (realm !== undefined && nonce !== undefined) {
      const useQop = qopOffered.includes("auth");
      const nc = "00000001";
      const cnonce = randomBytes(8).toString("hex");
      const user = headerSafe(target.username);
      const realmValue = headerSafe(realm);
      const nonceValue = headerSafe(nonce);
      const response = digestResponse({
        username: user,
        password: target.password,
        realm: realmValue,
        nonce: nonceValue,
        method,
        uri,
        qop: useQop ? "auth" : undefined,
        nc,
        cnonce,
      });
      const fields = [`username="${user}"`, `realm="${realmValue}"`, `nonce="${nonceValue}"`, `uri="${uri}"`, `response="${response}"`];
      if (useQop) fields.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);
      const opaque = params.get("opaque");
      if (opaque !== undefined) fields.push(`opaque="${headerSafe(opaque)}"`);
      return { header: `Digest ${fields.join(", ")}` };
    }
  }
  if (basic) return { header: basicHeader(target) };
  return unsupported ? { unsupported } : null;
}

const basicHeader = (t: ProbeTarget): string => `Basic ${Buffer.from(`${t.username}:${t.password}`).toString("base64")}`;

const LOGIN_REQUIRED = "The camera wants a login · add the username and password";
const LOGIN_REFUSED = "The camera refused the login · check the username and password";
/** The relay checks the certificate too (MediaMTX does unless given a
 *  sourceFingerprint, which this app never sets), so a camera this cannot
 *  trust is one the relay cannot pull: say so rather than report it ready. */
const UNTRUSTED_CERT_REASON = "The camera's certificate is not trusted, so the relay cannot pull it either · use an address without TLS, or give the camera a trusted certificate";

/** Node's codes for a certificate it would not trust: self-signed, an unknown
 *  issuer, expired, or issued for another name. */
const UNTRUSTED_CERT = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** What a connection error says, in the operator's words. */
function describeConnectError(err: unknown, host: string, port: number, connected: boolean): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ECONNREFUSED") return `${host} refused the connection on port ${port}`;
  if (code !== undefined && UNTRUSTED_CERT.has(code)) return UNTRUSTED_CERT_REASON;
  if (connected) return `${host} closed the connection without answering · check the address and path`;
  return `${host} is not reachable`;
}

/** "The camera answered 503 Service Unavailable", the camera's own words kept short and printable. */
function otherStatus(status: number, reason: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 60);
  return `The camera answered ${status}${clean ? ` ${clean}` : ""}`;
}

// ── RTSP ────────────────────────────────────────────────────────────────────

interface RtspReply {
  status: number;
  reason: string;
  /** Lower-cased header names; a header sent twice keeps every value. */
  headers: Map<string, string[]>;
  body: string;
}

/** One request on one connection, reading exactly one reply. */
function rtspExchange(
  secure: boolean,
  host: string,
  port: number,
  request: string,
  deadline: number,
): Promise<RtspReply> {
  return new Promise<RtspReply>((resolve, reject) => {
    let connected = false;
    let settled = false;
    let socket: net.Socket;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const onConnect = (): void => {
      connected = true;
      socket.write(request);
    };
    const connectHost = host.replace(/^\[|\]$/g, "");
    socket = secure
      ? tls.connect(
          {
            host: connectHost,
            port,
            ...(net.isIP(connectHost) === 0 ? { servername: connectHost } : {}),
          },
          onConnect,
        )
      : net.connect({ host: connectHost, port }, onConnect);
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new ProbeFailure(
              connected
                ? `No answer from ${host} for this path · check the address and path`
                : `${host} is not reachable`,
            ),
          ),
        ),
      Math.max(1, deadline - Date.now()),
    );

    const chunks: Buffer[] = [];
    let total = 0;
    const tryParse = (final: boolean): RtspReply | null => {
      const raw = Buffer.concat(chunks);
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) return null;
      const head = raw.subarray(0, end).toString("latin1").split("\r\n");
      const m = /^RTSP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(head[0] ?? "");
      if (!m) throw new ProbeFailure(`${host} answered, but not with RTSP · check the address`);
      const headers = new Map<string, string[]>();
      for (const line of head.slice(1)) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        const name = line.slice(0, i).trim().toLowerCase();
        headers.set(name, [...(headers.get(name) ?? []), line.slice(i + 1).trim()]);
      }
      const length = Number(headers.get("content-length")?.[0] ?? 0);
      const body = raw.subarray(end + 4);
      if (body.length < length && !final) return null;
      return { status: Number(m[1]), reason: m[2] ?? "", headers, body: body.subarray(0, length || undefined).toString("utf8") };
    };
    const consume = (final: boolean): void => {
      try {
        const reply = tryParse(final);
        if (reply) finish(() => resolve(reply));
      } catch (err) {
        finish(() => reject(err));
      }
    };
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX_REPLY_BYTES) {
        finish(() => reject(new ProbeFailure(`${host} answered with more than a camera should · check the address`)));
        return;
      }
      consume(false);
    });
    socket.on("error", (err) => finish(() => reject(new ProbeFailure(describeConnectError(err, host, port, connected)))));
    socket.on("close", () => {
      if (settled) return;
      consume(true);
      finish(() => reject(new ProbeFailure(describeConnectError(null, host, port, connected))));
    });
  });
}

const VIDEO_CODEC_LABEL: Record<string, string> = { H264: "H264", H265: "H265", HEVC: "H265" };

/** The first video section's codec and, for H.264, its resolution. */
export function parseSdp(sdp: string): { codec?: string; width?: number; height?: number } {
  const lines = sdp.split(/\r?\n/);
  let inVideo = false;
  let payload: string | null = null;
  let codec: string | undefined;
  let sprop: string | undefined;
  for (const line of lines) {
    if (line.startsWith("m=")) {
      if (inVideo) break;
      const m = /^m=video\s+\S+\s+\S+\s+(\d+)/.exec(line);
      if (m) {
        inVideo = true;
        payload = m[1]!;
      }
      continue;
    }
    if (!inVideo || payload === null) continue;
    const rtpmap = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(line);
    if (rtpmap && rtpmap[1] === payload) {
      const name = rtpmap[2]!.toUpperCase();
      codec = VIDEO_CODEC_LABEL[name] ?? name;
    }
    const fmtp = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
    if (fmtp && fmtp[1] === payload) {
      const found = /sprop-parameter-sets=([^;\s]+)/i.exec(fmtp[2]!);
      if (found) sprop = found[1];
    }
  }
  const out: { codec?: string; width?: number; height?: number } = {};
  if (codec) out.codec = codec;
  if (codec === "H264" && sprop) {
    const size = spropResolution(sprop);
    if (size) Object.assign(out, size);
  }
  return out;
}

/** Where an RTSP address goes: its host, port (554, or 322 for rtsps) and the
 *  URI to ask for, which never carries userinfo. */
export function rtspEndpoint(url: string): { secure: boolean; host: string; port: number; uri: string } {
  const u = new URL(url);
  const secure = u.protocol === "rtsps:";
  const port = u.port ? Number(u.port) : secure ? DEFAULT_RTSPS_PORT : DEFAULT_RTSP_PORT;
  return { secure, host: u.hostname, port, uri: `${u.protocol}//${u.host}${u.pathname}${u.search}` };
}

/**
 * How many more times a DESCRIBE answered 406 is asked again, and the base of
 * the jittered wait between asks. An encoder seen on site (a Magewell) answers
 * one DESCRIBE at a time and 406 to any other in flight: two servers checking
 * the same camera, or a check landing while the relay dials it. That is the
 * camera busy, not the camera down, and must never read as Not answering.
 */
const BUSY_RETRIES = 2;
const BUSY_WAIT_MS = 250;

async function probeRtsp(target: ProbeTarget, deadline: number): Promise<ProbeResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await describeOnce(target, deadline);
    if (result.state !== "busy" || attempt >= BUSY_RETRIES) return result;
    const wait = BUSY_WAIT_MS * (attempt + 1) + Math.random() * BUSY_WAIT_MS;
    if (Date.now() + wait >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

async function describeOnce(target: ProbeTarget, deadline: number): Promise<ProbeResult> {
  const { secure, host, port, uri } = rtspEndpoint(target.url);
  let cseq = 0;
  const describe = (authorization: string | null): Promise<RtspReply> => {
    cseq++;
    const lines = [
      `DESCRIBE ${uri} RTSP/1.0`,
      `CSeq: ${cseq}`,
      "Accept: application/sdp",
      "User-Agent: StageUtility-probe",
      ...(authorization ? [`Authorization: ${authorization}`] : []),
      "",
      "",
    ];
    return rtspExchange(secure, host, port, lines.join("\r\n"), deadline);
  };

  let reply = await describe(null);
  if (reply.status === 401) {
    if (!target.username) throw new ProbeFailure(LOGIN_REQUIRED);
    const answer = authorizationFor(reply.headers.get("www-authenticate") ?? [], target, "DESCRIBE", uri);
    if (answer && "unsupported" in answer) throw new ProbeFailure(`The camera asks for a login method this check can't use (${answer.unsupported})`);
    if (!answer) throw new ProbeFailure(LOGIN_REFUSED);
    reply = await describe(answer.header);
    if (reply.status === 401) throw new ProbeFailure(LOGIN_REFUSED);
  }
  if (reply.status === 200) return { state: "ready", ...parseSdp(reply.body) };
  if (reply.status === 406) return { state: "busy" };
  if (reply.status === 404) throw new ProbeFailure(`No stream at this path on ${host} · check the path`);
  throw new ProbeFailure(otherStatus(reply.status, reply.reason));
}

// ── HLS ─────────────────────────────────────────────────────────────────────

function probeHls(target: ProbeTarget, deadline: number): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve, reject) => {
    const u = new URL(target.url);
    const secure = u.protocol === "https:";
    const host = u.hostname;
    const port = u.port ? Number(u.port) : secure ? 443 : 80;
    let connected = false;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      fn();
    };
    const headers: Record<string, string> = { "user-agent": "StageUtility-probe", accept: "*/*" };
    if (target.username) headers.authorization = basicHeader(target);
    const options = {
      // As rtspExchange does: node wants the bare address, the message the bracketed one.
      host: host.replace(/^\[|\]$/g, ""),
      port,
      method: "GET",
      // The request path, never the credentialed form.
      path: `${u.pathname}${u.search}`,
      headers,
      // One connection per check, closed after it. On the default agent a
      // finished response puts the socket back in a keep-alive pool, where
      // req.destroy() can no longer reach it and the camera holds it open.
      agent: false,
    };
    const req = (secure ? https : http).request(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        res.resume();
        finish(() => {
          if (status === 401) reject(new ProbeFailure(target.username ? LOGIN_REFUSED : LOGIN_REQUIRED));
          else if (status === 404) reject(new ProbeFailure(`No stream at this path on ${host} · check the path`));
          else reject(new ProbeFailure(otherStatus(status, res.statusMessage ?? "")));
        });
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const done = (): void => {
        const text = Buffer.concat(chunks).toString("utf8");
        finish(() => {
          if (!text.replace(/^\uFEFF/, "").startsWith("#EXTM3U")) {
            reject(new ProbeFailure(`${host} answered, but not with a playlist · check the path`));
            return;
          }
          const res1 = /RESOLUTION=(\d+)x(\d+)/i.exec(text);
          resolve(res1 ? { state: "ready", width: Number(res1[1]), height: Number(res1[2]) } : { state: "ready" });
        });
      };
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        // A live playlist is a few KB. Past the cap this is not one.
        if (total > MAX_REPLY_BYTES) finish(() => reject(new ProbeFailure(`${host} answered with more than a camera should · check the address`)));
      });
      res.on("end", done);
      res.on("error", (err) => finish(() => reject(new ProbeFailure(describeConnectError(err, host, port, true)))));
    });
    req.on("socket", (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once("connect", () => (connected = true));
    });
    req.on("error", (err) => finish(() => reject(new ProbeFailure(describeConnectError(err, host, port, connected)))));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new ProbeFailure(
              connected ? `No answer from ${host} for this path · check the address and path` : `${host} is not reachable`,
            ),
          ),
        ),
      Math.max(1, deadline - Date.now()),
    );
    req.end();
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Ask the camera about its stream. Never throws: a failure is the result,
 * with a sentence an operator can act on. `timeoutMs` is for tests.
 */
export async function probeFeed(target: ProbeTarget, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const kind = probeKind(target.url);
  if (kind === null) return { state: "unchecked" };
  const deadline = Date.now() + timeoutMs;
  try {
    return kind === "rtsp" ? await probeRtsp(target, deadline) : await probeHls(target, deadline);
  } catch (err) {
    if (err instanceof ProbeFailure) return { state: "failed", reason: err.message };
    // A URL that does not parse, or anything unforeseen: still a result the
    // caller can show, and the address is the only thing this can be about.
    return { state: "failed", reason: "The address could not be checked · check it is a full address" };
  }
}
