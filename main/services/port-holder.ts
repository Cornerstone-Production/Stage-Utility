// port-holder.ts — identifying what is on the other end of a bound port, and
// whether this process is running from the wrong data directory.
//
// Grew out of a production incident: a stale systemd unit from an old install
// started a second copy of this server with no STAGE_UTILITY_DATA set, so it
// ran from an empty home-directory data folder and won the race for the main
// port. The real service sat retrying for a minute, logging only a pid and a
// user — nothing said the holder was ANOTHER STAGE UTILITY running from the
// wrong place, and working that out cost an hour of remote diagnosis. Both
// checks below exist to say that on the log line, not make an operator infer it.

import { execFileSync } from "node:child_process";
import * as http from "node:http";

/**
 * True only for loopback addresses — the shapes Node reports on
 * `req.socket.remoteAddress`. A filesystem path (the data directory) must
 * never be readable from anywhere else.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Extra fields available only to a loopback caller of GET /api/version. */
export interface LoopbackVersionExtras {
  dataDir: string;
  pid: number;
}

/**
 * The JSON payload for GET /api/version. Any address that is not loopback
 * gets exactly `{ version }` and nothing else — everything else is a
 * filesystem path or a pid, neither of which belongs on the LAN.
 */
export function buildVersionPayload(
  version: string,
  remoteAddress: string | undefined,
  extras: LoopbackVersionExtras,
): { version: string } | ({ version: string } & LoopbackVersionExtras) {
  if (!isLoopbackAddress(remoteAddress)) return { version };
  return { version, dataDir: extras.dataDir, pid: extras.pid };
}

/**
 * Who holds a port, as parts, for each caller to phrase for its own audience
 * (holderPhrase below): a log line may name a pid and a data directory,
 * anything a LAN client reads names the program only — the same line
 * buildVersionPayload draws for /api/version.
 */
export type PortHolder =
  | { kind: "stage-utility"; version: string; pid: number | null; dataDir: string | null }
  | { kind: "process"; program: string | null; pid: number | null }
  | { kind: "unknown" };

/** ss's own connection-state column, never a program name: an unprivileged
 *  `ss` asked about another user's socket prints the state and the other
 *  columns with no "users:(())" at all. */
const SS_STATE_TOKENS = new Set([
  "LISTEN",
  "ESTAB",
  "SYN-SENT",
  "SYN-RECV",
  "FIN-WAIT-1",
  "FIN-WAIT-2",
  "TIME-WAIT",
  "CLOSE",
  "CLOSE-WAIT",
  "LAST-ACK",
  "CLOSING",
  "UNCONN",
]);

/** One lsof, ss or netstat listing line, as parts. */
export function parseHolderLine(line: string): PortHolder {
  // ss -lptn / -lpun: `...users:(("node",pid=43580,fd=12))`. Checked first:
  // its leading "LISTEN 0 128" columns would otherwise read as lsof's shape.
  const ss = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (ss) return { kind: "process", program: ss[1]!, pid: Number(ss[2]) };
  // netstat -ano: `TCP  0.0.0.0:1935  0.0.0.0:0  LISTENING  4321`, or UDP
  // with no state column — a pid, and no program.
  const netstat = line.match(/^\s*(?:TCP|UDP)\s+\S+\s+\S+\s+(?:[A-Z_]+\s+)?(\d+)\s*$/i);
  if (netstat) return { kind: "process", program: null, pid: Number(netstat[1]) };
  // lsof -nP: `COMMAND  PID  USER ...`, a space in the command escaped \x20.
  const lsof = line.match(/^(\S+)\s+(\d+)\s/);
  if (lsof && !SS_STATE_TOKENS.has(lsof[1]!)) return { kind: "process", program: lsof[1]!.replace(/\\x20/g, " "), pid: Number(lsof[2]) };
  return { kind: "unknown" };
}

/** The line of a listing that names `port` as its own — never one only
 *  connected to it (`lsof -iUDP:<port>` lists a client sending to the port
 *  as `<local>-><remote>:<port>`), and never a longer port that merely starts
 *  with the same digits. */
export function pickHolderLine(output: string, port: number): string | null {
  const own = new RegExp(`[:.]${port}(?!\\d)`);
  const line = output.split("\n").find((l) => !l.includes("->") && own.test(l));
  return line?.trim() || null;
}

/** "another Stage Utility (version …, pid …, data directory …)", "node (pid
 *  43580)" for a log line; "another Stage Utility", "node" for anything a
 *  LAN client reads. */
export function holderPhrase(holder: PortHolder, audience: "log" | "lan"): string {
  switch (holder.kind) {
    case "stage-utility":
      return audience === "lan" ? "another Stage Utility" : `another Stage Utility (${stageUtilityFacts(holder)})`;
    case "process":
      if (audience === "lan") return holder.program ?? "another program";
      if (holder.program !== null && holder.pid !== null) return `${holder.program} (pid ${holder.pid})`;
      if (holder.program !== null) return holder.program;
      return holder.pid !== null ? `a program with pid ${holder.pid}` : "another program";
    case "unknown":
      return "a program that could not be identified";
  }
}

/** The listing line for whoever holds `port`, or null. Fixed argument
 *  vectors, no shell, no interpolation of anything a request can reach — the
 *  port is a number this process chose. Any failure is silent: this runs
 *  while something has already gone wrong, and it must not become a second
 *  problem. */
function holderLine(port: number, proto: "tcp" | "udp"): string | null {
  const probes: [string, string[]][] =
    process.platform === "win32"
      ? [["netstat", ["-ano", "-p", proto.toUpperCase()]]]
      : proto === "tcp"
        ? [
            ["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]],
            ["ss", ["-lptn", `sport = :${port}`]],
          ]
        : [
            ["lsof", ["-nP", `-iUDP:${port}`]],
            ["ss", ["-lpun", `sport = :${port}`]],
          ];
  for (const [cmd, args] of probes) {
    try {
      const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      const line = pickHolderLine(out, port);
      if (line) return line;
    } catch {
      // Tool missing or nothing listening — try the next one.
    }
  }
  return null;
}

/** Best-effort "who is holding this port", for the log only: the raw
 *  listing line. */
export function rawPortHolder(port: number, proto: "tcp" | "udp" = "tcp"): string {
  return holderLine(port, proto) ?? "could not determine which process holds it";
}

const PROBE_TIMEOUT_MS = 1500;

interface ProbedVersion {
  version?: unknown;
  pid?: unknown;
  dataDir?: unknown;
}

function probeVersion(port: number): Promise<ProbedVersion | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ProbedVersion | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/version", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return finish(null);
          try {
            finish(JSON.parse(data));
          } catch {
            finish(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
  });
}

type StageUtilityHolder = Extract<PortHolder, { kind: "stage-utility" }>;

/** The probed /api/version body as a holder, or null when it is not one. */
function asStageUtility(body: ProbedVersion | null): StageUtilityHolder | null {
  if (!body || typeof body.version !== "string") return null;
  return {
    kind: "stage-utility",
    version: body.version,
    pid: typeof body.pid === "number" ? body.pid : null,
    dataDir: typeof body.dataDir === "string" ? body.dataDir : null,
  };
}

/** "version 1.2.3, pid 42, data directory /var/lib/stage-utility", for a log line. */
function stageUtilityFacts(holder: StageUtilityHolder): string {
  const parts = [`version ${holder.version}`];
  if (holder.pid !== null) parts.push(`pid ${holder.pid}`);
  if (holder.dataDir !== null) parts.push(`data directory ${holder.dataDir}`);
  return parts.join(", ");
}

/** Who holds `port`, as parts: another Stage Utility if it answers
 *  /api/version on it (TCP only — there is no HTTP to ask over UDP), else
 *  whatever lsof, ss or netstat names. */
export async function portHolder(port: number, proto: "tcp" | "udp"): Promise<PortHolder> {
  const stageUtility = asStageUtility(proto === "tcp" ? await probeVersion(port) : null);
  if (stageUtility) return stageUtility;
  const line = holderLine(port, proto);
  return line ? parseHolderLine(line) : { kind: "unknown" };
}

/**
 * The main port's holder as one log sentence (remote-server.ts): another
 * Stage Utility if it answers `/api/version` over loopback — version, and
 * pid/data directory when the holder included them (only a loopback caller
 * gets those, see `buildVersionPayload`) — else the raw lsof/ss text. No
 * version probe for a UDP port: there is no HTTP to ask over it.
 */
export async function describePortHolder(port: number, proto: "tcp" | "udp" = "tcp"): Promise<string> {
  const stageUtility = asStageUtility(proto === "tcp" ? await probeVersion(port) : null);
  if (stageUtility) {
    return (
      `another Stage Utility is already serving :${port} — ${stageUtilityFacts(stageUtility)}. ` +
      `If that is not the service you expect, find what started it: ` +
      `systemctl list-unit-files --state=enabled (Linux) or launchctl list (macOS).`
    );
  }
  return rawPortHolder(port, proto);
}

/**
 * Where the one-line installer puts the data directory, by platform — see
 * `install.sh`'s `DATA=` assignment. Used only to catch a second copy running
 * from the home-directory default while an installed service also has one.
 */
export const SYSTEM_DATA_DIRS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  linux: "/var/lib/stage-utility",
  darwin: "/usr/local/var/stage-utility",
};

/**
 * A one-line warning when this process resolved the home-directory default
 * data dir while the platform's installed-service data dir also holds a
 * configuration — the shape of the incident this file exists for: a second
 * copy started by hand (or a leftover unit) racing the real service.
 *
 * Never warns when `STAGE_UTILITY_DATA` was set explicitly (the operator
 * chose this path on purpose), when the resolved dir already IS the system
 * dir, or when the system dir has no `settings.json` (nothing to collide
 * with).
 */
export function wrongDataDirWarning(
  resolved: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  systemDirHasSettings: boolean,
): string | null {
  if (env.STAGE_UTILITY_DATA) return null;
  const systemDir = SYSTEM_DATA_DIRS[platform];
  if (!systemDir) return null;
  if (resolved === systemDir) return null;
  if (!systemDirHasSettings) return null;
  return (
    `[server] running from ${resolved} while ${systemDir} also holds a configuration. ` +
    `If this box normally runs as a service, this is probably a second copy started by ` +
    `hand or by a leftover unit — stop it and start the service (systemctl start stage-utility).`
  );
}
