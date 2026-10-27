// servicecue-deployer.ts — the server that publishes to the public ServiceCue page keeps the page
// itself up to date.
//
// servicecue-cloudflare.ts is HOW the copy every build carries (build/servicecue/) is put on
// Cloudflare; this is WHEN. The publisher tells this the page's build each time it reads the page's
// status (once a run, then every few minutes), and this decides:
//
//   no token                   nothing: updating is on while an API token is stored for the page
//   no copy of the page        nothing to deploy
//   the page is this build     nothing; what Cloudflare holds about it is read once
//   a service is live, the     wait, and look again each half minute. The app updater's own test
//   service window is open,    (stageController.isServiceLive(): Planning Center in any live mode,
//   or neither is known        the preservice countdown and a service parked between items
//                              included), and the window around a service the Mac helpers wait
//                              out (serviceWindow.activeUntil()). After a restart, and while
//                              Planning Center cannot be reached, the times are unknown. Update the
//                              page now goes ahead of the window and of unknown, never of live
//   the page was deployed      leave it: from a NEWER version, or from the same version by another
//   by someone else's build    build (two servers at one version would otherwise undo each other).
//                              Only "Update the page now", confirmed, replaces it
//   otherwise                  deploy
//
// The version compared is the RUNNING one (package.json), never deploy.json's, which a release that
// changes nothing the page is built from leaves stale. It is recorded with each upload and read
// back from Cloudflare. A page with no such record (deployed by hand) is deployed over.
//
// A failure leaves the page as it was and is retried on the publisher's doubling backoff, a minute to
// once an hour; a 401 or 403 is not retried until the credentials change. A deploy that succeeds but
// leaves the page serving the old build means the Worker is not the page: auto deploys stop until the
// credentials or the bundle change. One deploy at a time: a request during one joins it.
//
// Log lines are `[servicecue-deploy]`, each decision once. Never a token.

import { clockOf } from "./app-timezone.js";
import { errorMessage } from "./errors.js";
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
} from "./servicecue-cloudflare.js";
import type { DeployCredentials } from "./servicecue-deploy-store.js";
import { backoffMs } from "./servicecue-publisher.js";
import type { DeployError, DeployState, DeployStatus } from "../types/servicecue-publish-status.js";

/** What the publisher asks of this. */
export interface DeployHook {
  /** The page answered its status: this is the build it serves (null from a Worker too old to say). */
  consider(pageBuild: string | null): void;
  /** Publishing stopped or moved: stop looking, and stop waiting. A deploy already under way finishes. */
  stop(): void;
  /** Called after every deploy that went through, on the server's own account or asked for: publishing held by the old Worker starts again. */
  onDeployed(listener: () => void): void;
}

export interface DeployTimings {
  /** The wait after the first failure, doubling to `backoffMaxMs`. */
  backoffMinMs: number;
  /** The wait after many: at most one attempt an hour. */
  backoffMaxMs: number;
  /** How often a deploy waiting for a service to end looks again. */
  liveRecheckMs: number;
  /** How long after its own deploy a page still showing the old build is not yet a problem. */
  justDeployedMs: number;
  /** At most one "Update the page now" that deploys in this long. */
  nowEveryMs: number;
}

export const DEFAULT_DEPLOY_TIMINGS: DeployTimings = {
  backoffMinMs: 60_000,
  backoffMaxMs: 60 * 60_000,
  liveRecheckMs: 30_000,
  justDeployedMs: 2 * 60_000,
  nowEveryMs: 60_000,
};

export interface DeployerDeps {
  /** Where build/servicecue/ is. */
  bundleDir: string;
  /** The version this server runs, as package.json says it. */
  version(): string;
  /** Is Planning Center reporting a service live? The app updater's test: stageController.isServiceLive(). */
  serviceLive(): boolean;
  /** When the service window open now closes, or null outside one: serviceWindow.activeUntil(). */
  windowCloses(): number | null;
  /** Are the service times and the live state known well enough to say nothing is live? False just after a restart. */
  serviceTimesKnown(): boolean;
  /** The credentials saved for the page's current address, or null. */
  credentials(): Promise<DeployCredentials | null>;
  /** Cloudflare's API. A test points it at a fake on this machine. */
  apiOrigin?: CloudflareOrigin;
  timings?: Partial<DeployTimings>;
}

/** What an attempt made on the server's own account came to, and nothing a request can be answered with. */
type AutoOnly = { kind: "unchecked" } | { kind: "held" } | { kind: "backoff" } | { kind: "waiting-auto" };

/** What "Update the page now" is answered with. */
export type DeployNowOutcome =
  | { kind: "deployed"; uploaded: number; held: number; /** It went ahead on the explicit request with the service state unknown (never with a service known to be live). */ serviceStateUnknown?: true }
  | { kind: "current" }
  | { kind: "off" }
  | { kind: "no-bundle"; message: string }
  | { kind: "waiting" }
  | { kind: "newer"; pageVersion: string; runningVersion: string }
  | { kind: "other-build"; pageBuild: string | null; version: string }
  | { kind: "limited"; retryAfterSec: number }
  | { kind: "failed"; message: string; code: number | null; status: number | null; step: string };

type DeployOutcome = DeployNowOutcome | AutoOnly;

const isNowOutcome = (o: DeployOutcome): o is DeployNowOutcome => o.kind !== "unchecked" && o.kind !== "held" && o.kind !== "backoff" && o.kind !== "waiting-auto";

/** What the last decision was made for, so the same question is not put to Cloudflare at every status read. Reset when the credentials change. */
interface Memo {
  kind: "current" | "newer" | "other-build" | "deployed" | "broken";
  /** Reads of the page past the grace that still showed another build than the one deployed. */
  strikes?: number;
  /** The credentials, the page's build, ours and the running version: the question. */
  key: string;
  /** The build of ours it is about. */
  build: string;
  at: number;
  /** What a repeated question is answered with, for the two refusals. */
  answer?: DeployNowOutcome;
}

/** Is `running` older than `deployed`, by semver precedence? A version that cannot be read is older: nothing is deployed over a page on a guess. */
export function isOlderVersion(running: string, deployed: string): boolean {
  const a = parseTag(`v${running}`);
  const b = parseTag(`v${deployed}`);
  if (!a || !b) return true;
  return compareTags(a, b) < 0;
}

/** The most of one decision's line that reaches the log: scrub's usual 200 would cut Cloudflare's words short. */
const SAID_MAX = 600;

export class ServiceCueDeployer implements DeployHook {
  private readonly timings: DeployTimings;
  private readonly apiOrigin: CloudflareOrigin;

  private creds: DeployCredentials | null = null;
  /** Bumped when the credentials change: an attempt that began before it has its failure ignored. */
  private generation = 0;
  /** What the publisher last read from the page. Undefined: nothing, so nothing is decided. */
  private read: { build: string | null; /** Set by this process after its own deploy, not read from the page. */ assumed?: true } | undefined;
  private inflight: Promise<DeployOutcome> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // How it is going. `state` and these are what the card draws.
  private state: DeployState = "off";
  /** Why `state` is "waiting": read only while it is. */
  private waitingFor: "live" | "unknown" | "window" = "live";
  /** When the service window closes, while waiting for it. */
  private waitingUntil: number | null = null;
  private bundle: { build: string; version: string } | null = null;
  private noBundle: string | null = null;
  private page: DeployStatus["page"] = null;
  private files: DeployStatus["files"] = null;
  private error: DeployError | null = null;

  private failures = 0;
  private memo: Memo | null = null;
  private lastNowDeployAt = 0;
  /** The last decision logged, so a status read that changes nothing says nothing. */
  private said = "";
  private readonly deployedListeners: (() => void)[] = [];

  constructor(private readonly deps: DeployerDeps) {
    this.timings = { ...DEFAULT_DEPLOY_TIMINGS, ...deps.timings };
    this.apiOrigin = deps.apiOrigin ?? cloudflareOrigin(CLOUDFLARE_API_ORIGIN);
  }

  // ── What the publisher and the routes ask ──────────────────────────────────

  consider(pageBuild: string | null): void {
    this.read = { build: pageBuild };
    void this.begin("auto", false);
  }

  onDeployed(listener: () => void): void {
    this.deployedListeners.push(listener);
  }

  stop(): void {
    this.clearTimer();
    this.read = undefined;
    if (this.state !== "updating") this.state = this.restState();
  }

  /** What the card says when nothing is under way: what the last decision left, and only then that the page has not been read. */
  private restState(): DeployState {
    if (this.error?.refused || this.memo?.kind === "broken") return "failed";
    switch (this.memo?.kind) {
      case "newer":
        return "newer";
      case "other-build":
        return "other-build";
      case "current":
      case "deployed":
        return "current";
    }
    if (this.error) return "failed";
    return this.creds ? "unchecked" : "off";
  }

  /**
   * The explicit "Update the page now": deploys over an older page or another build's, but over a
   * newer page, or the same version's other build, only with `confirmDowngrade`. A page that is
   * already this build is not uploaded again, and at most one request in `nowEveryMs` deploys.
   * Joins a deploy already under way.
   */
  async deployNow(opts: { confirmDowngrade?: boolean } = {}): Promise<DeployNowOutcome> {
    // An attempt of the server's own that is under way answers first; this makes its own when that settles, at most a few times.
    for (let turn = 0; turn < 3; turn++) {
      if (this.inflight) {
        const joined = await this.inflight;
        if (joined.kind === "deployed" || joined.kind === "current") return joined;
      }
      const outcome = await this.begin("now", opts.confirmDowngrade === true);
      if (isNowOutcome(outcome)) return outcome;
    }
    return { kind: "failed", message: "another attempt was under way each time: try again", code: null, status: null, step: "deploy" };
  }

  /** The token or the account changed, or went: every hold is off, and the page is looked at again. */
  async credentialsChanged(): Promise<void> {
    this.generation += 1;
    this.clearTimer();
    this.failures = 0;
    this.error = null;
    this.memo = null;
    this.said = "";
    await this.refresh();
    this.log("info", this.creds ? "a Cloudflare API token is set for this page: it is kept up to date from this server" : "the Cloudflare API token was cleared: the page is no longer updated from this server");
    this.said = this.creds ? "" : "no-token";
    // After an attempt that began under the old credentials, which would otherwise be joined and say nothing new.
    if (this.read !== undefined) void this.settled().then(() => this.begin("auto", false));
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
      this.log("warn", `the Cloudflare credentials could not be read: ${errorMessage(err)}`);
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
      waitingFor: this.state === "waiting" ? this.waitingFor : null,
      waitingUntil: this.state === "waiting" && this.waitingFor === "window" ? this.waitingUntil : null,
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

  /** The one place a line reaches the log: whatever it was built from (a build id, Cloudflare's words) is scrubbed here, whole. */
  private log(level: "info" | "warn", line: string): void {
    if (level === "warn") console.warn(`[servicecue-deploy] ${scrub(line, SAID_MAX)}`);
    else console.log(`[servicecue-deploy] ${scrub(line, SAID_MAX)}`);
  }

  /** Each decision once, until it changes. */
  private say(key: string, line: string): void {
    if (this.said === key) return;
    this.said = key;
    this.log("info", line);
  }

  /** Never rejects: a failure is the outcome, and is recorded on the card and the log. */
  private async attempt(mode: "auto" | "now", confirm: boolean): Promise<DeployOutcome> {
    const generation = this.generation;
    // A request's own attempt leaves a pending wait for the service to end, or a retry, as it is.
    if (mode === "auto") this.clearTimer();
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
    const memo = this.memo?.build === manifest.build ? this.memo : null;

    // On its own account, nothing is decided before the page has been read, or while a refusal or the backoff says wait.
    if (mode === "auto") {
      const held = (outcome: AutoOnly): AutoOnly => {
        if (this.state !== "updating") this.state = this.restState();
        return outcome;
      };
      if (this.read === undefined) return held({ kind: "unchecked" });
      if (this.error?.refused) return held({ kind: "held" });
      if (this.error?.retryAt && Date.now() < this.error.retryAt) {
        // A timer may fire a moment before the wait is up: it is set again for what is left, not forgotten.
        if (this.timer === null) this.arm(this.error.retryAt - Date.now());
        return held({ kind: "backoff" });
      }
    }

    const running = this.deps.version();
    // What the page serves: the publisher's last read, or, with none, what is known to be there.
    const pageBuild = this.servedBuild(memo);
    // The page's own word that it is this build lifts anything held against the Worker, before any hold is asked.
    if (pageBuild === manifest.build) return this.current(creds, manifest.name, manifest.build, generation);

    // A page read with no build is no evidence either way: a Worker whose asset read threw says so.
    const evidence = pageBuild !== null && pageBuild !== undefined;
    if (mode === "auto" && memo?.kind === "broken") {
      this.state = "failed";
      return { kind: "held" };
    }
    // Deployed by this process a moment ago: the page may still say the old build.
    if (mode === "auto" && memo?.kind === "deployed" && (!evidence || Date.now() - memo.at < this.timings.justDeployedMs)) {
      this.state = this.restState();
      return { kind: "current" };
    }

    const live = this.deps.serviceLive();
    const unknown = !this.deps.serviceTimesKnown();
    const windowCloses = this.deps.windowCloses();
    // A live service always waits. Unknown (just after a restart, or while Planning Center cannot be reached), and the window around a service, wait on its own account, and go ahead when somebody asks.
    if (live || (mode === "auto" && (unknown || windowCloses !== null))) {
      return this.wait(mode, live ? "live" : unknown ? "unknown" : "window", windowCloses, `build ${pageBuild ?? "unknown"} to ${manifest.build}`);
    }

    try {
      const client = createCloudflare({ origin: this.apiOrigin, accountId: creds.accountId, token: creds.token, script: manifest.name });
      // Past the grace the page still shows another build: the second such read asks Cloudflare what the Worker holds.
      if (mode === "auto" && memo?.kind === "deployed") {
        memo.strikes = (memo.strikes ?? 0) + 1;
        if (memo.strikes < 2) {
          this.state = this.restState();
          return { kind: "current" };
        }
        const holds = await client.deployedPage();
        if (holds.build === manifest.build) return this.notThePage(manifest.name, manifest.build, pageBuild ?? null, creds.accountId, running);
        // Another server's build is there now: that is the newer and other-build cases below, not a Worker that is not the page.
        this.memo = null;
      }
      const key = `${creds.accountId}|${pageBuild ?? ""}|${manifest.build}|${running}`;
      if (mode === "auto" && (memo?.kind === "newer" || memo?.kind === "other-build") && memo.key === key && memo.answer) {
        this.state = memo.answer.kind === "newer" ? "newer" : "other-build";
        return memo.answer;
      }
      await client.verifyToken();
      const deployed = await client.deployedPage();
      this.page = { build: pageBuild ?? deployed.build, version: deployed.version, at: deployed.at };
      const older = deployed.version !== null && isOlderVersion(running, deployed.version);
      // The same version from another build: two servers at one version would flip the page between them.
      const otherBuild = deployed.version !== null && !older && !isOlderVersion(deployed.version, running) && deployed.build !== null && deployed.build !== manifest.build;
      const confirmed = mode === "now" && confirm;
      if ((older || otherBuild) && !confirmed) {
        const answer: DeployNowOutcome = older
          ? { kind: "newer", pageVersion: deployed.version as string, runningVersion: running }
          : { kind: "other-build", pageBuild: deployed.build, version: deployed.version as string };
        this.state = answer.kind === "newer" ? "newer" : "other-build";
        this.memo = { kind: answer.kind as "newer" | "other-build", key, build: manifest.build, at: Date.now(), answer };
        this.error = null;
        this.say(
          `${answer.kind}:${key}`,
          older
            ? `the page was deployed from ${deployed.version}, newer than this server's ${running}, so it is left as it is`
            : `the page is build ${deployed.build} of ${running}, this server's own version but another build than its ${manifest.build}, so it is left as it is`,
        );
        return answer;
      }
      if (mode === "now") {
        const wait = this.lastNowDeployAt + this.timings.nowEveryMs - Date.now();
        if (wait > 0) return { kind: "limited", retryAfterSec: Math.ceil(wait / 1000) };
      }
      // The checks above can take a minute: a service that went live meanwhile is still waited out.
      if (mode === "auto") {
        const nowLive = this.deps.serviceLive();
        const nowWindow = this.deps.windowCloses();
        if (nowLive || nowWindow !== null || !this.deps.serviceTimesKnown()) {
          return this.wait(mode, nowLive ? "live" : nowWindow !== null ? "window" : "unknown", nowWindow, `build ${pageBuild ?? "unknown"} to ${manifest.build}`);
        }
      }
      this.state = "updating";
      this.files = null;
      this.say(
        `deploy:${manifest.build}:${running}`,
        `deploying build ${manifest.build} as ${running}: the page ${pageBuild === null || pageBuild === undefined ? "reports no build" : `serves build ${pageBuild}`}${mode === "now" ? ", and the update was asked for" : ""}${confirmed && (older || otherBuild) ? ", over a page left alone until now, as confirmed" : ""}${mode === "now" && unknown ? ", with the service state unknown, as asked (no service is known to be live)" : ""}`,
      );
      const files = await client.deploy(readBundle(this.deps.bundleDir, manifest), running, (plan) => {
        this.files = plan;
        this.log("info", `${plural(plan.uploaded, "file")} to upload, ${plan.held} already on Cloudflare`);
      });
      if (mode === "now") this.lastNowDeployAt = Date.now();
      return this.deployed(manifest.build, running, key, files, mode === "now" && unknown);
    } catch (err) {
      return this.failedWith(err, generation);
    }
  }

  /** Not now: a service is live, its window is open, or neither is known. Looked at again each half minute on its own account. */
  private wait(mode: "auto" | "now", why: "live" | "unknown" | "window", windowCloses: number | null, change: string): DeployOutcome {
    this.state = "waiting";
    this.waitingFor = why;
    this.waitingUntil = why === "window" ? windowCloses : null;
    this.say(
      `waiting:${change}:${why}`,
      why === "live"
        ? `a service is live, so the page is not updated now (${change}); it will be when the service ends`
        : why === "window"
          ? `the service window is open until ${clockOf(windowCloses ?? Date.now())}, so the page is not updated now (${change}); it will be when the window closes`
          : `the service times are not known (the server has just started, or Planning Center cannot be reached), so the page is not updated now; it will be once they are (${change})`,
    );
    if (mode === "auto") this.arm(this.timings.liveRecheckMs);
    return why === "live" ? { kind: "waiting" } : { kind: "waiting-auto" };
  }

  /** The build the page serves, as far as is known: undefined when nothing says. */
  private servedBuild(memo: Memo | null): string | null | undefined {
    if (this.read) return this.read.build;
    return memo?.kind === "deployed" || memo?.kind === "current" ? memo.build : undefined;
  }

  private noCopy(err: unknown): DeployNowOutcome {
    const message = errorMessage(err);
    this.state = "no-bundle";
    this.bundle = null;
    this.noBundle = scrub(message, 300);
    this.say(`no-bundle:${message}`, `nothing to deploy: ${message}`);
    return { kind: "no-bundle", message: this.noBundle };
  }

  /** The page serves this server's build. What Cloudflare holds about it is read once, for the card's "deployed at". */
  private async current(creds: DeployCredentials, name: string, build: string, generation: number): Promise<DeployOutcome> {
    const key = `${creds.accountId}|${build}`;
    if (this.memo?.kind === "deployed" && this.memo.build === build) {
      // This process put it there, and what it was told is what it assumed: only the page's own word that it is this build ends the watch for a Worker that is not the page.
      if (this.read && !this.read.assumed) this.memo = { kind: "current", key, build, at: Date.now() };
    } else if (!(this.memo?.kind === "current" && this.memo.key === key)) {
      try {
        const deployed = await createCloudflare({ origin: this.apiOrigin, accountId: creds.accountId, token: creds.token, script: name }).deployedPage();
        this.page = { build, version: deployed.version, at: deployed.at };
        this.memo = { kind: "current", key, build, at: Date.now() };
        this.error = null;
        this.failures = 0;
      } catch (err) {
        // The page is current whatever this read says; the failure is on the card, and a refused token is held.
        const outcome = this.failedWith(err, generation, true);
        this.page = { build, version: null, at: null };
        if (this.generation === generation) this.state = this.error?.refused ? "failed" : "current";
        return outcome;
      }
    }
    this.state = "current";
    this.say(`current:${build}`, `the page is current: build ${build}${this.page?.version ? `, deployed from ${this.page.version}` : ""}`);
    return { kind: "current" };
  }

  private deployed(build: string, version: string, key: string, files: { uploaded: number; held: number }, serviceStateUnknown: boolean): DeployNowOutcome {
    this.state = "current";
    this.page = { build, version, at: Date.now() };
    this.files = files;
    this.error = null;
    this.failures = 0;
    this.memo = { kind: "deployed", key, build, at: Date.now() };
    // Until the publisher reads the page again, it is what was deployed.
    if (this.read !== undefined) this.read = { build, assumed: true };
    this.log("info", `deployed build ${build} as ${version}: ${plural(files.uploaded, "file")} uploaded, ${files.held} already on Cloudflare`);
    this.said = `current:${build}`;
    for (const listener of this.deployedListeners) listener();
    return { kind: "deployed", ...files, ...(serviceStateUnknown ? { serviceStateUnknown: true as const } : {}) };
  }

  /** A deploy went through and the page still serves another build: the Worker is not the page. Nothing more is deployed on its own. */
  private notThePage(name: string, build: string, serves: string | null, accountId: string, running: string): DeployNowOutcome {
    const message = `deployed build ${build} to Worker '${name}', but the page still serves ${serves ?? "no build"}: is that Worker the page?`;
    this.memo = { kind: "broken", key: `${accountId}|${serves ?? ""}|${build}|${running}`, build, at: Date.now() };
    this.state = "failed";
    this.error = { message, code: null, status: null, step: "check the page", at: Date.now(), refused: false, retryAt: null };
    this.say(`broken:${build}`, `${message} Nothing more is deployed on its own until the credentials or the bundle change.`);
    return { kind: "failed", message, code: null, status: null, step: "check the page" };
  }

  /** The failure goes to the card, the log and the caller. Retried on the backoff, unless the token was refused; ignored when the credentials changed under the attempt. */
  private failedWith(err: unknown, generation: number, read = false): DeployNowOutcome {
    if (err instanceof BundleUnavailable) return this.noCopy(err);
    const failure = err instanceof CloudflareError ? err : new CloudflareError(errorMessage(err), null, null, "deploy");
    const where = read ? "reading what is deployed failed" : "the update failed";
    const outcome = { kind: "failed", message: scrub(failure.message, 300), code: failure.code, status: failure.status, step: failure.step } as const;
    if (generation !== this.generation) {
      this.log("warn", `${where} ${failure.describe()}; that was with credentials since replaced, so it is ignored`);
      if (this.state === "updating") this.state = this.creds ? "unchecked" : "off";
      return outcome;
    }
    this.failures += 1;
    const refused = failure.refused;
    const wait = backoffMs(this.failures, this.timings.backoffMinMs, this.timings.backoffMaxMs);
    this.error = { message: outcome.message, code: failure.code, status: failure.status, step: failure.step, at: Date.now(), refused, retryAt: refused ? null : Date.now() + wait };
    if (!read || refused) this.state = "failed";
    this.files = null;
    this.said = "";
    this.log(
      "warn",
      `${where} ${failure.describe()}. The page is unchanged. ${refused ? "Not trying again until the token changes." : `Trying again in ${Math.round(wait / 1000)} s (attempt ${this.failures}).`}`,
    );
    if (!refused && this.read !== undefined) this.arm(wait);
    return outcome;
  }
}
