// qsys-service.ts — the connection to a Q-SYS Core over QRC.
//
// Owns what QrcClient deliberately does not: Logon, the 30 s keepalive, status,
// reconnect with backoff, and the component/control catalog. Tasks that read and
// write controls (bindings, change groups) go through `transport`, which resets
// the keepalive on every send. Nothing here ever calls a method that changes the
// design.

import { errorMessage } from "../errors.js";
import { StatusIntegration } from "../integration-base.js";
import { scrub } from "../scrub.js";
import { QrcClient, QrcError, type QrcTransport } from "./qrc-client.js";
import type { QrcComponent, QrcControl, QrcStatus } from "./qrc-types.js";
import type { QsysSettings } from "./qsys-settings-store.js";

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

/** Logon (when a user is set) then StatusGet on an open transport. */
async function openSession(t: QrcTransport, s: QsysSettings, password: string | null): Promise<QrcStatus> {
  if (s.user) await t.send("Logon", { User: s.user, Password: password ?? "" });
  return (await t.send("StatusGet")) as QrcStatus;
}

const isLogonRefused = (err: unknown): boolean => err instanceof QrcError && err.code === 10;

export class QsysService extends StatusIntegration<QsysStatusDto> {
  private settings: QsysSettings | null = null;
  private password: string | null = null;

  private client: QrcClient | null = null;
  /** Open from the dial until the connection ends. Not exposed: see `wrapped`. */
  private session: QrcTransport | null = null;
  /** The transport handed to other code. Set only once logon, status and the
   *  catalog have been read, so nothing can write before the current state is known. */
  private wrapped: QrcTransport | null = null;
  /** Bumped by every teardown. A connect() that finds it changed was superseded
   *  (stop, or configure -> restart) and must not adopt its client. */
  private generation = 0;
  /** An EngineStatus that arrived while the connect sequence was still reading. */
  private earlyStatus: QrcStatus | null = null;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

  private catalog: QsysCatalog | null = null;
  private catalogAt: number | null = null;
  private refreshing: Promise<QsysCatalog> | null = null;
  private readonly catalogListeners: ((c: QsysCatalog) => void)[] = [];

  constructor() {
    super("qsys", "qsys:status", OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.settings?.enabled && !!this.settings.host && this.settings.port > 0;
  }

  configure(s: QsysSettings, password: string | null): void {
    this.settings = { ...s, host: s.host.trim(), user: s.user.trim() };
    this.password = password;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[qsys] connecting to ${scrub(this.settings!.host)}:${this.settings!.port}`);
    super.start();
  }

  protected override teardown(): void {
    this.generation++;
    this.clearKeepalive();
    const client = this.client;
    this.client = null;
    this.session = null;
    this.wrapped = null;
    this.catalog = null;
    this.earlyStatus = null;
    this.catalogAt = null;
    // Deliberate: detach first so the close is not read as a lost connection.
    client?.close();
  }

  get transport(): QrcTransport | null {
    return this.wrapped;
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
    return this.loadCatalog(t);
  }

  /** One read at a time: concurrent callers share it. */
  private loadCatalog(t: QrcTransport): Promise<QsysCatalog> {
    this.refreshing ??= this.readCatalog(t).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** One-shot check for the Integrations "Test connection" button. Touches no instance state. */
  async test(s: QsysSettings, password: string | null): Promise<QsysTestResult> {
    let client: QrcClient | null = null;
    try {
      client = await QrcClient.connect(s.host.trim(), s.port);
      const status = await openSession(client, { ...s, user: s.user.trim() }, password);
      const components = (await client.send("Component.GetComponents")) as QrcComponent[];
      return { ok: true, status, components: components.length };
    } catch (err) {
      return { ok: false, error: isLogonRefused(err) ? "The Core refused the user name or password" : errorMessage(err) };
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
      this.failed(err, null);
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
    this.session = transport;
    this.armKeepalive(client);
    try {
      const status = await openSession(transport, s, this.password);
      if (!this.live(client)) return;
      const catalog = await this.loadCatalog(transport);
      if (!this.live(client)) return;
      this.wrapped = transport;
      this.resetBackoff();
      this.catalogAt = Date.now();
      this.publishConnected(status);
      this.report("connected", `Connected to ${status.DesignName}`);
      console.log(
        `[qsys] connected to ${scrub(status.DesignName)} (${catalog.components.length} components, emulator=${status.IsEmulator})`,
      );
      for (const cb of this.catalogListeners) this.notifyCatalog(cb, catalog);
      const early = this.earlyStatus;
      this.earlyStatus = null;
      if (early) this.onNotification(client, "EngineStatus", early);
    } catch (err) {
      if (!this.live(client)) return;
      this.failed(err, client);
    }
  }

  /** True while `client` is the current connection. `client.close()` on every
   *  stale return is the caller's job when it owns an unadopted client; an adopted
   *  one is closed by teardown() or failed(). */
  private live(client: QrcClient): boolean {
    return this.running && this.client === client;
  }

  private wrap(client: QrcClient): QrcTransport {
    return {
      send: (method, params) => {
        this.armKeepalive(client);
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
          if (this.live(client)) this.lost(client, err);
        },
      );
    }, KEEPALIVE_MS);
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private async readCatalog(t: QrcTransport): Promise<QsysCatalog> {
    const status = (await t.send("StatusGet")) as QrcStatus;
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
    // Only the live connection's read may land: a superseded one is dropped.
    if (this.session === t) {
      this.catalog = catalog;
      this.catalogAt = Date.now();
    }
    return catalog;
  }

  private notifyCatalog(cb: (c: QsysCatalog) => void, catalog: QsysCatalog): void {
    try {
      cb(catalog);
    } catch (err) {
      console.warn(`[qsys] catalog listener threw: ${scrub(errorMessage(err))}`);
    }
  }

  private onNotification(client: QrcClient, method: string, params: unknown): void {
    if (method !== "EngineStatus" || !this.live(client) || !params || typeof params !== "object") return;
    const status = params as QrcStatus;
    // While the connect sequence is reading it owns the catalog; remember the
    // latest push and compare once it is done.
    if (!this.wrapped) {
      this.earlyStatus = status;
      return;
    }
    if (!this.catalog || status.DesignCode === this.catalog.designCode) return;
    console.log("[qsys] design changed, refreshing catalog");
    this.refreshCatalog().then(
      (catalog) => {
        if (!this.live(client)) return;
        this.publishConnected(status);
        for (const cb of this.catalogListeners) this.notifyCatalog(cb, catalog);
      },
      (err: unknown) => {
        if (this.live(client)) this.lost(client, err);
      },
    );
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
    this.lost(client, err ?? new Error("connection closed"));
  }

  /** A live connection failed: say so, drop it, and try again. */
  private lost(client: QrcClient, err: unknown): void {
    console.warn(`[qsys] connection lost: ${scrub(errorMessage(err))}`);
    this.failed(err, client, true);
  }

  /** A connection attempt, or a connection, failed: report, tear down, schedule a retry. */
  private failed(err: unknown, client: QrcClient | null, alreadyLogged = false): void {
    if (isLogonRefused(err)) {
      console.warn("[qsys] logon refused");
      this.report("error", "The Core refused the user name or password");
    } else {
      if (!alreadyLogged && this.attempt === 0) console.warn(`[qsys] ${scrub(this.settings?.host)} connection failed: ${scrub(errorMessage(err))}`);
      this.report("error", err instanceof QrcError ? `The Core answered with an error: ${err.message}` : `Can't reach the Core: ${errorMessage(err)}`);
    }
    if (client) {
      this.clearKeepalive();
      this.client = null;
      this.session = null;
      this.wrapped = null;
      this.earlyStatus = null;
      client.close();
    }
    this.catalog = null;
    this.catalogAt = null;
    this.emitIfChanged({ ...OFFLINE, state: "reconnecting" });
    this.scheduleReconnect();
  }

  /** stop() lands on offline, not reconnecting. */
  protected override goOffline(): void {
    this.emitIfChanged(OFFLINE);
  }
}

export const qsysService = new QsysService();
