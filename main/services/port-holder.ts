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
 * Best-effort "who is holding this port", for the log only.
 *
 * Fixed argument vectors, no shell, no interpolation of anything a request can
 * reach — the port is a number this process chose. Any failure is silent: this
 * runs while something has already gone wrong, and it must not become a second
 * problem.
 */
export function rawPortHolder(port: number): string {
  const probes: [string, string[]][] =
    process.platform === "win32"
      ? [["netstat", ["-ano", "-p", "TCP"]]]
      : [
          ["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]],
          ["ss", ["-lptn", `sport = :${port}`]],
        ];
  for (const [cmd, args] of probes) {
    try {
      const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      const line = out.split("\n").find((l: string) => l.includes(String(port)));
      if (line?.trim()) return line.trim();
    } catch {
      // Tool missing or nothing listening — try the next one.
    }
  }
  return "could not determine which process holds it";
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

/**
 * Ask whatever is listening on `port` if it is another Stage Utility, by
 * GETting its own `/api/version` over loopback. If it answers with a
 * recognisable payload, name it — version, and pid/data directory when the
 * holder chose to include them (only a loopback caller gets those, see
 * `buildVersionPayload`). Otherwise fall back to the generic lsof/ss text.
 */
export async function describePortHolder(port: number): Promise<string> {
  const body = await probeVersion(port);
  if (body && typeof body.version === "string") {
    const parts = [`version ${body.version}`];
    if (typeof body.pid === "number") parts.push(`pid ${body.pid}`);
    if (typeof body.dataDir === "string") parts.push(`data directory ${body.dataDir}`);
    return (
      `another Stage Utility is already serving :${port} — ${parts.join(", ")}. ` +
      `If that is not the service you expect, find what started it: ` +
      `systemctl list-unit-files --state=enabled (Linux) or launchctl list (macOS).`
    );
  }
  return rawPortHolder(port);
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
