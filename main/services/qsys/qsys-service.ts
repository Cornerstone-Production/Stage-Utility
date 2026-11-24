// qsys-service.ts — the connection to a Q-SYS Core over QRC.
//
// Owns what QrcClient deliberately does not: Logon, the 30 s keepalive, status,
// reconnect with backoff, and the component/control catalog. `transport`,
// `getCatalog`, `onCatalog` and `refreshCatalog` are the seam the Q-SYS panels of
// a later release build on; nothing in this release calls them outside tests.
// Nothing here ever calls a method that changes the design.

import { errorMessage } from "../errors.js";
import { StatusIntegration } from "../integration-base.js";
import { scrub } from "../scrub.js";
import { QrcClient, QrcError, type QrcTransport } from "./qrc-client.js";
import type { QrcComponent, QrcControl, QrcStatus } from "./qrc-types.js";
import { QSYS_DEFAULT_RATES, type QsysMeterRates, type QsysSettings } from "./qsys-settings.js";

/** The Core drops a connection after 60 s of silence; ping at half that. */
const KEEPALIVE_MS = 30_000;

export interface QsysStatusDto {
  connected: boolean;
  state: "connected" | "reconnecting" | "offline";
  designName: string | null;
  isEmulator: boolean | null;
  catalogAt: number | null;
  rev?: number;
}

export interface QsysCatalog {
  designCode: string;
  components: { name: string; type: string; controls: QrcControl[] }[];
}

const OFFLINE: QsysStatusDto = { connected: false, state: "offline", designName: null, isEmulator: null, catalogAt: null };

export type QsysTestResult =
  | { ok: true; status: QrcStatus; components: number }
  | { ok: false; error: string };

/** What the Integrations card's Test connection says. `message` is the Test
 *  button's answer; `rowMessage` sits beside the row's "Connected" badge, so it
 *  leaves that word out. */
export function qsysTestMessage(result: QsysTestResult): { ok: boolean; message: string; rowMessage: string } {
  if (!result.ok) return { ok: false, message: result.error, rowMessage: result.error };
  const reached = `${result.status.DesignName}${result.status.IsEmulator ? " (emulator)" : ""} — ${result.components} component(s)`;
  return { ok: true, message: `Connected to ${reached}`, rowMessage: reached };
}

/** Logon (when a user is set) then StatusGet on an open transport. */
async function openSession(t: QrcTransport, s: QsysSettings, password: string | null): Promise<QrcStatus> {
  if (s.user) await t.send("Logon", { User: s.user, Password: password ?? "" });
  return (await t.send("StatusGet")) as QrcStatus;
}

/** Code 10: the Core wants a logon it has not had (a wrong one, or none at all). */
const isLogonRefused = (err: unknown): boolean => err instanceof QrcError && err.code === 10;

/** What the operator is told when the Core answers code 10. With no user set the
 *  Core was never sent a name, so "refused the user name" would mislead. */
const logonMessage = (user: string): string =>
  user ? "The Core refused the user name or password" : "The Core requires a logon: set User and Password";

/** A catalog read, and the status it was read against. */
interface CatalogRead {
  status: QrcStatus;
  catalog: QsysCatalog;
}

export class QsysService extends StatusIntegration<QsysStatusDto> {
  private settings: QsysSettings | null = null;
  private password: string | null = null;

  private client: QrcClient | null = null;
  /** The transport handed to other code. Set only once logon, status and the
   *  catalog have been read, so no other code sends on a connection whose design
   *  it does not know yet. */
  private wrapped: QrcTransport | null = null;
  /** Bumped by every teardown, so each connection has its own number. Work started
   *  on one connection (a dial, a catalog read) checks it before it lands. */
  private generation = 0;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

  private catalog: QsysCatalog | null = null;
  private catalogAt: number | null = null;
  /** The catalog read in flight, and the connection it belongs to: a read left
   *  over from an earlier connection is never joined. */
  private refreshing: { generation: number; promise: Promise<CatalogRead> } | null = null;
  /** The latest EngineStatus the Core pushed on this connection, and how many it has pushed. */
  private pushed: QrcStatus | null = null;
  private pushes = 0;
  private readonly catalogListeners: ((c: QsysCatalog) => void)[] = [];

  constructor() {
    super("qsys", "qsys:status", OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.settings?.enabled && !!this.settings.host && this.settings.port > 0;
  }

  /** `s` arrives trimmed: the manager reads host through hostPortOf and trims user. */
  configure(s: QsysSettings, password: string | null): void {
    this.settings = s;
    this.password = password;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[qsys] connecting to ${scrub(this.settings!.host)}:${this.settings!.port}`);
    super.start();
  }

  /** Drop the connection and everything read on it. Also how a failed connection ends. */
  protected override teardown(): void {
    this.generation++;
    this.clearKeepalive();
    const client = this.client;
    this.client = null;
    this.wrapped = null;
    this.catalog = null;
    this.catalogAt = null;
    this.pushed = null;
    this.pushes = 0;
    // Deliberate: detach first so the close is not read as a lost connection.
    client?.close();
  }

  get transport(): QrcTransport | null {
    return this.wrapped;
  }

  /** The configured meter rates. A change reconfigures (and so reconnects) the service. */
  get meterRates(): QsysMeterRates {
    return {
      volunteerMeterHz: this.settings?.volunteerMeterHz ?? QSYS_DEFAULT_RATES.volunteerMeterHz,
      staffMeterHz: this.settings?.staffMeterHz ?? QSYS_DEFAULT_RATES.staffMeterHz,
    };
  }

  getStatus(): QsysStatusDto {
    return this.getLatest();
  }

  /** The catalog of the live connection; null whenever not connected, so a non-null
   *  catalog never outlives the connection it was read on. */
  getCatalog(): QsysCatalog | null {
    return this.catalog;
  }

  onCatalog(cb: (c: QsysCatalog) => void): void {
    this.catalogListeners.push(cb);
  }

  /** Read every component and its controls. Concurrent callers share one read. */
  refreshCatalog(): Promise<QsysCatalog> {
    const t = this.wrapped;
    if (!t) return Promise.reject(new Error("Q-SYS Core is not connected"));
    return this.loadCatalog(t).then((r) => r.catalog);
  }

  /** One read at a time per connection: callers on the same connection share it,
   *  and a read left over from an earlier connection is never joined. */
  private loadCatalog(t: QrcTransport, status?: QrcStatus): Promise<CatalogRead> {
    const generation = this.generation;
    if (this.refreshing?.generation === generation) return this.refreshing.promise;
    const promise: Promise<CatalogRead> = this.readCatalog(t, generation, status).finally(() => {
      if (this.refreshing?.promise === promise) this.refreshing = null;
    });
    this.refreshing = { generation, promise };
    return promise;
  }

  /** One-shot check for the Integrations "Test connection" button. Touches no instance state. */
  async test(s: QsysSettings, password: string | null): Promise<QsysTestResult> {
    let client: QrcClient | null = null;
    try {
      client = await QrcClient.connect(s.host, s.port);
      const status = await openSession(client, s, password);
      const components = (await client.send("Component.GetComponents")) as QrcComponent[];
      return { ok: true, status, components: components.length };
    } catch (err) {
      return { ok: false, error: isLogonRefused(err) ? logonMessage(s.user) : errorMessage(err) };
    } finally {
      client?.close();
    }
  }

  protected async connect(): Promise<void> {
    const s = this.settings;
    if (!this.running || !s) return;
    const gen = this.generation;
    let client: QrcClient;
    try {
      client = await QrcClient.connect(s.host, s.port);
    } catch (err) {
      // Stopped or reconfigured while dialling: nothing to report.
      if (gen !== this.generation || !this.running) return;
      this.failed(err);
      return;
    }
    if (gen !== this.generation || !this.running) {
      client.close();
      return;
    }
    // Register before any further await: the Core pushes EngineStatus the moment
    // the socket opens, and the client only delivers to handlers already there.
    this.client = client;
    client.onNotification((method, params) => this.onNotification(client, method, params));
    client.onClose((err) => this.onClosed(client, err));
    const transport = this.wrap(client);
    this.armKeepalive(client);
    try {
      const status = await openSession(transport, s, this.password);
      if (!this.live(client)) return;
      const { catalog } = await this.loadCatalog(transport, status);
      if (!this.live(client)) return;
      this.wrapped = transport;
      this.resetBackoff();
      this.announce(status, catalog);
      console.log(
        `[qsys] connected to ${scrub(status.DesignName)} (${catalog.components.length} components, emulator=${status.IsEmulator === true})`,
      );
      // A push that arrived while the sequence was reading is compared now.
      this.checkDesign();
    } catch (err) {
      if (!this.live(client)) return;
      this.failed(err);
    }
  }

  /** True while `client` is the current connection. `client.close()` on every
   *  stale return is the caller's job when it owns an unadopted client; an adopted
   *  one is closed by teardown(). */
  private live(client: QrcClient): boolean {
    return this.running && this.client === client;
  }

  private wrap(client: QrcClient): QrcTransport {
    return {
      send: (method, params) => {
        // A transport kept past its connection must not re-arm the live one's
        // keepalive for a client that is gone: the live connection would go silent.
        if (this.live(client)) this.armKeepalive(client);
        return client.send(method, params);
      },
      onNotification: (cb) => client.onNotification(cb),
      close: () => client.close(),
    };
  }

  private armKeepalive(client: QrcClient): void {
    this.clearKeepalive();
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      if (!this.live(client)) return;
      client.send("NoOp").then(
        () => this.armKeepalive(client),
        (err: unknown) => {
          if (this.live(client)) this.lost(err);
        },
      );
    }, KEEPALIVE_MS);
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  /** Read the catalog against `status` (the connect sequence has one) or a fresh
   *  StatusGet. Lands only if `generation` is still the live connection's. */
  private async readCatalog(t: QrcTransport, generation: number, given?: QrcStatus): Promise<CatalogRead> {
    const seen = this.pushes;
    const status = given ?? ((await t.send("StatusGet")) as QrcStatus);
    const list = (await t.send("Component.GetComponents")) as QrcComponent[];
    if (!Array.isArray(list)) throw new Error("the Core's component list was not a list");
    const components: QsysCatalog["components"] = [];
    // Sequential: designs here are small, and a burst would crowd the Core.
    for (const c of list) {
      const reply = (await t.send("Component.GetControls", { Name: c.Name })) as { Controls: QrcControl[] };
      if (!Array.isArray(reply?.Controls)) throw new Error(`the Core's control list for ${scrub(c.Name)} was not a list`);
      components.push({ name: c.Name, type: c.Type, controls: reply.Controls });
    }
    const catalog = { designCode: status.DesignCode, components };
    if (generation !== this.generation) return { status, catalog };
    this.catalog = catalog;
    this.catalogAt = Date.now();
    // This read is done: a check below may start the next one, and must not see
    // this one as still in flight.
    this.refreshing = null;
    // Once connected, every read that lands is announced, whoever asked for it.
    // During the connect sequence, connect() announces.
    if (this.wrapped) this.announce(status, catalog);
    // The Core pushed again while this read ran: that push may name a newer design.
    if (this.pushes !== seen) this.checkDesign();
    return { status, catalog };
  }

  private announce(status: QrcStatus, catalog: QsysCatalog): void {
    this.publishConnected(status);
    this.report("connected", `Connected to ${status.DesignName}`);
    for (const cb of this.catalogListeners) {
      try {
        cb(catalog);
      } catch (err) {
        console.warn(`[qsys] catalog listener threw: ${scrub(errorMessage(err))}`);
      }
    }
  }

  private onNotification(client: QrcClient, method: string, params: unknown): void {
    if (method !== "EngineStatus" || !this.live(client) || !params || typeof params !== "object") return;
    this.pushed = params as QrcStatus;
    this.pushes++;
    this.checkDesign();
  }

  /**
   * Read the catalog again if the latest push names a design other than the one
   * read. Waits while the connect sequence owns the catalog (connect() calls this
   * when it is done) and while a read is in flight (that read calls this when it
   * lands, if a push arrived meanwhile), so a push is never lost to a read that
   * started before it.
   */
  private checkDesign(): void {
    const client = this.client;
    const t = this.wrapped;
    if (!client || !t || !this.pushed || !this.catalog) return;
    if (this.pushed.DesignCode === this.catalog.designCode) return;
    if (this.refreshing?.generation === this.generation) return;
    console.log("[qsys] design changed, refreshing catalog");
    this.loadCatalog(t).catch((err: unknown) => {
      if (this.live(client)) this.lost(err);
    });
  }

  private publishConnected(status: Pick<QrcStatus, "DesignName" | "IsEmulator">): void {
    this.emitIfChanged({
      connected: true,
      state: "connected",
      designName: status.DesignName,
      isEmulator: status.IsEmulator,
      catalogAt: this.catalogAt,
    });
  }

  private onClosed(client: QrcClient, err: Error | null): void {
    if (!this.live(client)) return;
    this.lost(err ?? new Error("connection closed"));
  }

  /** A live connection failed: say so, drop it, and try again. */
  private lost(err: unknown): void {
    console.warn(`[qsys] connection lost: ${scrub(errorMessage(err))}`);
    this.failed(err, true);
  }

  /** A connection attempt, or a connection, failed: report, tear down, schedule a retry.
   *  Logs only the first failure in a run of them; the backoff retries quietly. */
  private failed(err: unknown, alreadyLogged = false): void {
    const first = !alreadyLogged && this.attempt === 0;
    if (isLogonRefused(err)) {
      const user = this.settings?.user ?? "";
      if (first) console.warn(user ? "[qsys] logon refused" : "[qsys] logon required, and no user is set");
      this.report("error", logonMessage(user));
    } else {
      if (first) console.warn(`[qsys] ${scrub(this.settings?.host)} connection failed: ${scrub(errorMessage(err))}`);
      this.report("error", err instanceof QrcError ? `The Core answered with an error: ${err.message}` : `Can't reach the Core: ${errorMessage(err)}`);
    }
    this.teardown();
    this.emitIfChanged({ ...OFFLINE, state: "reconnecting" });
    this.scheduleReconnect();
  }

  /** stop() lands on offline, not reconnecting. */
  protected override goOffline(): void {
    this.emitIfChanged(OFFLINE);
  }
}

export const qsysService = new QsysService();
