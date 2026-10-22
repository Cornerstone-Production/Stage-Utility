// servicecue-deployer.ts — the server that publishes to the public ServiceCue page keeps the page
// itself up to date.
//
// The Worker and the page it serves are a build of this app, and every build carries a copy
// (build/servicecue/). servicecue-cloudflare.ts is HOW that copy is put on Cloudflare; this is WHEN,
// and what to say about it. The publisher tells this the page's build each time it reads the page's
// status (once a run, then every few minutes), and this decides:
//
//   no token                   nothing: updating is on once an API token is entered, and off once
//                              it is cleared. The server holding the page's address and publishing
//                              token is the one that updates it: there is no other switch.
//   no copy of the page        nothing to deploy: a build whose bundle failed says so on /log
//   the page is this build     nothing. Said once, not at every status read.
//   a service is live          wait, and look again each half minute: a deploy is never made while
//                              Planning Center says a service is live (the rule the recorders keep)
//   the page is NEWER          leave it. The page records the version it was deployed from; one
//                              deployed by a newer server than this is not rolled back by this, so
//                              a dev box pointed at the same page cannot undo it. The button can,
//                              after a confirmation.
//   otherwise                  deploy.
//
// NEWER IS BY THE RUNNING VERSION, NOT deploy.json's. A release that changes nothing the page is
// built from leaves the folder, and its `version`, as an earlier build made it. So the version the
// server compares is package.json's at runtime, and it is what is recorded with an upload (the
// version's message, "Stage Utility 1.28.0") and read back from Cloudflare by the next server that
// asks. A page with no such record (deployed by hand) is not "newer": there is nothing to say it is.
//
// A FAILURE leaves the page as it was (Cloudflare swaps versions atomically) and is recorded for the
// card. It is retried on the publisher's doubling backoff, from a minute to once an hour: each
// attempt is a token check and an upload, not a heartbeat. A 401 or 403 is not retried until the
// token changes. ONE DEPLOY AT A TIME: a request that arrives during one joins it.
//
// The log line is `[servicecue-deploy]`: each decision once, each failure with Cloudflare's code
// and words. Never a token, and not what a token was handed back as.

import { errorMessage } from "./errors.js";
import { shouldRecordLive } from "./live-service-gate.js";
import { MASK } from "./mask.js";
import { plural } from "./plural.js";
import { parseTag, compareTags } from "./release-tags.js";
import { scrub } from "./scrub.js";
import {
  BundleUnavailable,
  CLOUDFLARE_API_ORIGIN,
  CloudflareError,
  cloudflareOrigin,
  createCloudflare,
  readBundle,
  readManifest,
  type CloudflareOrigin,
  type DeployedPage,
} from "./servicecue-cloudflare.js";
import type { DeployCredentials } from "./servicecue-deploy-store.js";
import { backoffMs } from "./servicecue-publisher.js";
import type { DeployError, DeployState, DeployStatus } from "../types/servicecue-publish-status.js";
import type { PcoLiveDTO } from "../types/stage.js";

/** What the publisher asks of this. */
export interface DeployHook {
  /** The page answered its status: this is the build it serves (null from a Worker too old to say). */
  consider(pageBuild: string | null): void;
  /** Publishing stopped or moved: stop looking, and stop waiting. A deploy already under way finishes. */
  stop(): void;
}

export interface DeployTimings {
  /** The wait after the first failure, doubling to `backoffMaxMs`. */
  backoffMinMs: number;
  /** The wait after many: at most one attempt an hour. */
  backoffMaxMs: number;
  /** How often a deploy waiting for a service to end looks again. */
  liveRecheckMs: number;
}

export const DEFAULT_DEPLOY_TIMINGS: DeployTimings = {
  backoffMinMs: 60_000,
  backoffMaxMs: 60 * 60_000,
  liveRecheckMs: 30_000,
};

export interface DeployerDeps {
  /** Where build/servicecue/ is. */
  bundleDir: string;
  /** The version this server runs, as package.json says it: what the no-downgrade rule compares. */
  version(): string;
  /** What Planning Center says is live. */
  live(): PcoLiveDTO | null;
  /** The credentials saved for the page's current address, or null. */
  credentials(): Promise<DeployCredentials | null>;
  /** Cloudflare's API. A test points it at a fake on this machine. */
  apiOrigin?: CloudflareOrigin;
  /** The Worker's name when it is not the bundle's (the one real-deploy script, to a scratch Worker). */
  script?: string;
  timings?: Partial<DeployTimings>;
}

/** What one attempt came to. `deployNow` hands it to the route, which has its own words for each. */
export type DeployOutcome =
  | { kind: "deployed"; uploaded: number; held: number }
  | { kind: "current" }
  | { kind: "off" }
  | { kind: "unchecked" }
  | { kind: "no-bundle"; message: string }
  | { kind: "waiting" }
  | { kind: "newer"; pageVersion: string; runningVersion: string }
  | { kind: "held" }
  | { kind: "backoff" }
  | { kind: "failed"; message: string; code: number | null; status: number | null; step: string };

/** Is Planning Center reporting a service live? The recorders' own test with a record open: an item is current, and the plan's SERVICE END has not been passed. */
export function serviceIsLive(live: PcoLiveDTO | null): boolean {
  return live !== null && shouldRecordLive(live, true) && live.serviceEnded !== true;
}

/**
 * Is `running` older than `deployed`, by semver precedence (a prerelease is older than its release)?
 * A version that cannot be read is older: nothing is deployed over a page on a guess.
 */
export function isOlderVersion(running: string, deployed: string): boolean {
  const a = parseTag(`v${running}`);
  const b = parseTag(`v${deployed}`);
  if (!a || !b) return true;
  return compareTags(a, b) < 0;
}

/** The most of one decision's line that reaches the log: scrub's usual 200 would cut Cloudflare's words short. */
const SAID_MAX = 600;

/** How long after a deploy of its own this ignores a page that still says it serves the old build. */
const JUST_DEPLOYED_MS = 2 * 60_000;

export class ServiceCueDeployer implements DeployHook {
  private readonly timings: DeployTimings;
  private readonly apiOrigin: CloudflareOrigin;

  private creds: DeployCredentials | null = null;
  /** What the publisher last read from the page. Undefined: nothing, so nothing is decided. */
  private read: { build: string | null } | undefined;
  private inflight: Promise<DeployOutcome> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // How it is going. `state` and these are what the card draws.
  private state: DeployState = "off";
  private bundle: { build: string; version: string } | null = null;
  private noBundle: string | null = null;
  private page: DeployStatus["page"] = null;
  private files: DeployStatus["files"] = null;
  private waiting: DeployStatus["waiting"] = null;
  private error: DeployError | null = null;

  private failures = 0;
  private retryAt = 0;
  /** The token was refused: nothing on its own until it changes. */
  private held = false;
  /** The last decision logged, so a status read that changes nothing says nothing. */
  private said = "";
  /** What the page's deployed version was read for, so a page that is current is read about once. */
  private shownFor = "";
  /** What the last "newer" was decided for: the same question is not put to Cloudflare at every status read. */
  private newerFor = "";
  /** The last deploy this process made: the page may still report the old build for a moment after it. */
  private lastDeploy: { build: string; at: number } | null = null;

  constructor(private readonly deps: DeployerDeps) {
    this.timings = { ...DEFAULT_DEPLOY_TIMINGS, ...deps.timings };
    this.apiOrigin = deps.apiOrigin ?? cloudflareOrigin(CLOUDFLARE_API_ORIGIN);
  }

  // ── What the publisher and the routes ask ──────────────────────────────────

  consider(pageBuild: string | null): void {
    this.read = { build: pageBuild };
    void this.begin("auto", false);
  }

  stop(): void {
    this.clearTimer();
    this.read = undefined;
    if (this.state !== "updating") this.state = this.creds ? "unchecked" : "off";
  }

  /**
   * The explicit "Update the page now". Deploys even when the page is the build this server has,
   * for a card that says it is stale; and, with `confirmDowngrade`, over a newer page. Joins a
   * deploy already under way. Never during a live service.
   */
  async deployNow(opts: { confirmDowngrade?: boolean } = {}): Promise<DeployOutcome> {
    if (this.inflight) {
      const joined = await this.inflight;
      if (joined.kind === "deployed" || joined.kind === "current") return joined;
    }
    return this.begin("now", opts.confirmDowngrade === true);
  }

  /** The token or the account changed, or went: every hold is off, and the page is looked at again. */
  async credentialsChanged(): Promise<void> {
    this.clearTimer();
    this.failures = 0;
    this.retryAt = 0;
    this.held = false;
    this.error = null;
    this.shownFor = "";
    this.newerFor = "";
    this.said = "";
    await this.refresh();
    if (this.creds) console.log("[servicecue-deploy] a Cloudflare API token is set for this page: it is kept up to date from this server");
    else console.log("[servicecue-deploy] the Cloudflare API token was cleared: the page is no longer updated from this server");
    this.said = this.creds ? "" : "no-token";
    if (this.read !== undefined) void this.begin("auto", false);
  }

  /** Resolves once no attempt is under way. Public for tests, which wait on it. */
  async settled(): Promise<void> {
    while (this.inflight) await this.inflight;
  }

  /** What is saved, read again: the card asks before it draws. */
  async refresh(): Promise<void> {
    try {
      this.creds = await this.deps.credentials();
      if (this.error?.step === "read the credentials") this.error = null;
    } catch (err) {
      // Said on the card as a failed read, and the stored credentials are not touched.
      this.creds = null;
      this.error = { message: scrub(`the Cloudflare credentials could not be read: ${errorMessage(err)}`, 300), code: null, status: null, step: "read the credentials", at: Date.now(), refused: false, retryAt: null };
      console.error(`[servicecue-deploy] the Cloudflare credentials could not be read: ${scrub(errorMessage(err))}`);
    }
    if (!this.creds && this.state !== "updating") this.state = "off";
    else if (this.creds && this.state === "off") this.state = "unchecked";
  }

  status(): DeployStatus {
    return {
      state: this.state,
      accountId: this.creds?.accountId ?? "",
      token: this.creds ? MASK : "",
      bundle: this.bundle,
      noBundle: this.noBundle,
      runningVersion: this.deps.version(),
      page: this.page,
      files: this.files,
      waiting: this.waiting,
      error: this.error,
      now: Date.now(),
    };
  }

  // ── One attempt at a time ──────────────────────────────────────────────────

  private begin(mode: "auto" | "now", confirm: boolean): Promise<DeployOutcome> {
    if (this.inflight) return this.inflight;
    const attempt: Promise<DeployOutcome> = this.attempt(mode, confirm).finally(() => {
      if (this.inflight === attempt) this.inflight = null;
    });
    this.inflight = attempt;
    return attempt;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.begin("auto", false), ms);
    this.timer.unref?.();
  }

  /** Each decision once, until it changes. */
  private say(key: string, line: string): void {
    if (this.said === key) return;
    this.said = key;
    console.log(`[servicecue-deploy] ${scrub(line, SAID_MAX)}`);
  }

  /** Never rejects: a failure is the outcome, and is recorded on the card and the log. */
  private async attempt(mode: "auto" | "now", confirm: boolean): Promise<DeployOutcome> {
    this.clearTimer();
    await this.refresh();
    const creds = this.creds;
    if (!creds) {
      this.say("no-token", "no Cloudflare API token is set for this page, so it is not updated from this server");
      return { kind: "off" };
    }

    let manifest;
    try {
      manifest = readManifest(this.deps.bundleDir);
    } catch (err) {
      return this.noCopy(err);
    }
    this.bundle = { build: manifest.build, version: manifest.version };
    this.noBundle = null;

    // What the publisher has read, and nothing has been decided without it, except by the button.
    if (mode === "auto") {
      if (this.read === undefined) {
        if (this.state !== "updating") this.state = this.error ? "failed" : "unchecked";
        return { kind: "unchecked" };
      }
      if (this.held) return { kind: "held" };
      if (Date.now() < this.retryAt) return { kind: "backoff" };
    }

    const running = this.deps.version();
    const client = createCloudflare({ origin: this.apiOrigin, accountId: creds.accountId, token: creds.token, script: this.deps.script ?? manifest.name });
    const pageBuild = this.read?.build ?? null;

    // The page is this build: nothing to deploy, and once per build, what Cloudflare says about it.
    if (this.read !== undefined && pageBuild === manifest.build) {
      return this.current(client, creds, manifest.build, pageBuild);
    }
    // Just deployed by this process: a status read in the next moments may still show the old build.
    if (mode === "auto" && this.lastDeploy?.build === manifest.build && Date.now() - this.lastDeploy.at < JUST_DEPLOYED_MS) {
      return { kind: "current" };
    }

    if (serviceIsLive(this.deps.live())) {
      this.state = "waiting";
      this.waiting = "service-live";
      this.say(`waiting:${manifest.build}`, `a service is live, so the page is not updated now (build ${scrub(pageBuild ?? "unknown")} to ${scrub(manifest.build)}); it will be when the service ends`);
      if (mode === "auto") this.arm(this.timings.liveRecheckMs);
      return { kind: "waiting" };
    }
    this.waiting = null;

    const newerKey = `${creds.accountId}:${pageBuild}:${manifest.build}:${running}`;
    if (mode === "auto" && this.state === "newer" && this.newerFor === newerKey && this.page?.version) {
      return { kind: "newer", pageVersion: this.page.version, runningVersion: running };
    }

    try {
      await client.verifyToken();
      const deployed = await client.deployedPage();
      this.page = { build: pageBuild ?? deployed.build, version: deployed.version, at: deployed.at };
      const older = deployed.version !== null && isOlderVersion(running, deployed.version);
      if (older && !(mode === "now" && confirm)) {
        this.state = "newer";
        this.newerFor = newerKey;
        this.error = null;
        this.say(`newer:${newerKey}`, `the page was deployed from ${scrub(deployed.version)}, newer than this server's ${scrub(running)}, so it is left as it is`);
        return { kind: "newer", pageVersion: deployed.version as string, runningVersion: running };
      }
      this.newerFor = "";
      this.state = "updating";
      this.files = null;
      this.say(
        `deploy:${manifest.build}:${running}`,
        `deploying build ${scrub(manifest.build)} as ${scrub(running)}: the page ${pageBuild === null ? "reports no build" : `serves build ${scrub(pageBuild)}`}${mode === "now" ? ", and the update was asked for" : ""}${older ? ", over a newer page, as confirmed" : ""}`,
      );
      const loaded = readBundle(this.deps.bundleDir);
      const files = await client.deploy(loaded, running, (plan) => {
        this.files = plan;
        console.log(`[servicecue-deploy] ${scrub(plural(plan.uploaded, "file"))} to upload, ${scrub(plan.held)} already on Cloudflare`);
      });
      return this.deployed(manifest.build, running, files);
    } catch (err) {
      return this.failedWith(err);
    }
  }

  private noCopy(err: unknown): DeployOutcome {
    const message = err instanceof BundleUnavailable ? err.message : `the bundle could not be read: ${errorMessage(err)}`;
    this.state = "no-bundle";
    this.bundle = null;
    this.noBundle = scrub(message, 300);
    this.say(`no-bundle:${message}`, `nothing to deploy: ${scrub(message, 400)}`);
    return { kind: "no-bundle", message: this.noBundle };
  }

  /** The page serves this server's build. What Cloudflare holds about it is read once, for the card's "deployed at". */
  private async current(client: ReturnType<typeof createCloudflare>, creds: DeployCredentials, build: string, pageBuild: string | null): Promise<DeployOutcome> {
    this.waiting = null;
    const key = `${creds.accountId}:${build}`;
    if (this.shownFor !== key) {
      let deployed: DeployedPage;
      try {
        deployed = await client.deployedPage();
      } catch (err) {
        // The page is current whatever this read says; the failure is on the card, and a refused token is held.
        const outcome = this.failedWith(err, true);
        this.page = { build: pageBuild, version: null, at: null };
        this.state = this.held ? "failed" : "current";
        return outcome;
      }
      this.page = { build: pageBuild, version: deployed.version, at: deployed.at };
      this.shownFor = key;
      this.error = null;
      this.failures = 0;
    }
    this.state = "current";
    this.say(`current:${build}`, `the page is current: build ${scrub(build)}${this.page?.version ? `, deployed from ${scrub(this.page.version)}` : ""}`);
    return { kind: "current" };
  }

  private deployed(build: string, version: string, files: { uploaded: number; held: number }): DeployOutcome {
    this.state = "current";
    this.page = { build, version, at: Date.now() };
    this.files = files;
    this.waiting = null;
    this.error = null;
    this.failures = 0;
    this.retryAt = 0;
    this.held = false;
    this.shownFor = `${this.creds?.accountId ?? ""}:${build}`;
    this.lastDeploy = { build, at: Date.now() };
    console.log(`[servicecue-deploy] deployed build ${scrub(build)} as ${scrub(version)}: ${scrub(plural(files.uploaded, "file"))} uploaded, ${scrub(files.held)} already on Cloudflare`);
    this.said = `current:${build}`;
    return { kind: "deployed", ...files };
  }

  /** The failure goes to the card, the log and the caller. Retried on the backoff, unless the token was refused. `quiet`: what failed was a read, not a deploy. */
  private failedWith(err: unknown, read = false): DeployOutcome {
    if (err instanceof BundleUnavailable) return this.noCopy(err);
    const failure = err instanceof CloudflareError ? err : new CloudflareError(errorMessage(err), null, null, "deploy");
    this.failures += 1;
    const refused = failure.refused;
    const wait = backoffMs(this.failures, this.timings.backoffMinMs, this.timings.backoffMaxMs);
    this.held = refused;
    this.retryAt = refused ? 0 : Date.now() + wait;
    this.error = {
      message: scrub(failure.message, 300),
      code: failure.code,
      status: failure.status,
      step: failure.step,
      at: Date.now(),
      refused,
      retryAt: refused ? null : this.retryAt,
    };
    if (!read || refused) this.state = "failed";
    this.files = null;
    this.waiting = null;
    this.said = "";
    const where = `${read ? "reading what is deployed" : "the update"} failed at "${failure.step}"`;
    const code = `${failure.status === null ? "no answer" : `HTTP ${failure.status}`}${failure.code === null ? "" : `, code ${failure.code}`}`;
    console.warn(
      `[servicecue-deploy] ${scrub(where)} (${scrub(code)}): ${scrub(failure.message, 400)}. The page is unchanged. ${
        refused ? "Not trying again until the token changes." : `Trying again in ${scrub(Math.round(wait / 1000))} s (attempt ${scrub(this.failures)}).`
      }`,
    );
    if (!refused && this.read !== undefined) this.arm(wait);
    return { kind: "failed", message: this.error.message, code: failure.code, status: failure.status, step: failure.step };
  }
}
