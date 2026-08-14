// tsl-service.ts — Pushes live people counts to a Ross multiviewer as on-tile
// text using the TSL UMD 3.1 protocol over TCP.
//
// RossTalk can't set arbitrary multiviewer text — TSL UMD is the protocol that
// overwrites a tile's source label. Each "feed" maps a count (attendance or
// occupancy, building total or one zone) to a TSL display address; on every
// people:count update (and a periodic refresh so the label persists) we format
// the number and send an 18-byte TSL 3.1 packet per feed.
//
// TSL 3.1 packet (zero-dep): [ 0x80|address ][ control ][ 16 ASCII bytes ]
//   header  = display address 0..126 + 0x80
//   control = bits0-3 tally, bits4-5 brightness (11 = full = 0x30), bits6-7 = 0
//   data    = exactly 16 chars in 0x20..0x7E, space-padded

import { clamp } from "./clamp.js";
import * as net from "node:net";

import type { PeopleCountDTO } from "../types/stage.js";
import { ConnectionLifecycle } from "./integration-base.js";
import { sensourceService } from "./sensource-service.js";


const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
/** Re-send the current labels on this cadence so a tile never goes stale/blank. */
const REFRESH_MS = 5000;
const TSL_FULL_BRIGHTNESS = 0x30;
const TSL_DATA_LEN = 16;

export interface TslFeed {
  id: string;
  metric: "attendance" | "occupancy";
  /** null = building total, else a specific zone id. */
  zoneId: string | null;
  /** TSL display address (0..126) of the multiviewer tile. */
  displayIndex: number;
  prefix?: string;
  suffix?: string;
}

export interface TslConfig {
  host: string | null;
  port: number | null;
  feeds: TslFeed[];
}

/** Build a TSL UMD 3.1 display packet (18 bytes). Exported for unit tests.
 *  `label` is clamped to printable ASCII, truncated/space-padded to 16 chars. */
export function buildTsl31Packet(address: number, label: string): Buffer {
  const addr = clamp(Math.floor(address), 0, 126);
  const buf = Buffer.alloc(2 + TSL_DATA_LEN, 0x20); // pre-fill data with spaces
  buf[0] = 0x80 | addr;
  buf[1] = TSL_FULL_BRIGHTNESS; // full brightness, no tally
  for (let i = 0; i < TSL_DATA_LEN; i++) {
    const ch = label.charCodeAt(i);
    // Printable ASCII only (0x20..0x7E); anything else → space.
    buf[2 + i] = ch >= 0x20 && ch <= 0x7e ? ch : 0x20;
  }
  return buf;
}

function valueFor(people: PeopleCountDTO | null, feed: TslFeed): number | null {
  if (!people) return null;
  if (feed.zoneId) {
    const z = people.zones.find((zone) => zone.id === feed.zoneId);
    return z ? z[feed.metric] : null;
  }
  return people.total[feed.metric];
}

function labelFor(feed: TslFeed, value: number | null): string {
  const n = value == null ? "—" : String(value);
  return `${feed.prefix ?? ""}${n}${feed.suffix ?? ""}`;
}

class TslService extends ConnectionLifecycle {
  private host: string | null = null;
  private port: number | null = null;
  private feeds: TslFeed[] = [];

  private socket: net.Socket | null = null;
  private connected = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private backoffAttempt = 0;

  constructor() {
    // No SSE channel: TSL is an OUTPUT (tally to a Ross switcher), so nothing
    // subscribes to it. That is also why scheduleReconnect is overridden below.
    super("tsl", "tsl:status");
  }

  protected get configured(): boolean {
    return !!this.host && !!this.port;
  }

  /** Is a scoreboard connected and being fed people counts right now? Read by
   *  SenSource's poll gate, which otherwise counts only browsers. */
  isSending(): boolean {
    return this.connected && this.feeds.length > 0;
  }

  configure(host: string, port: number, feeds: TslFeed[]): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.feeds = feeds;
    this.resetReport();
    this.restart();
  }

  /** Update only the feed list (e.g. when zones/mappings change). */
  setFeeds(feeds: TslFeed[]): void {
    this.feeds = feeds;
    if (this.connected) this.sendAll(sensourceService.getLatest());
  }

  override start(): void {
    if (this.running || !this.configured) return;
    this.backoffAttempt = 0;
    console.log(`[tsl] connecting ${this.host}:${this.port}`);
    super.start();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        if (this.connected) this.sendAll(sensourceService.getLatest());
      }, REFRESH_MS);
    }
  }

  protected override teardown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }


  /** Called by the broadcaster on every people:count update. */
  onPeopleCount(people: PeopleCountDTO): void {
    if (this.connected) this.sendAll(people);
  }

  /** One-shot reachability test for the Integrations "Test connection" button. */
  async test(host: string, port: number): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port }, () => {
        try {
          sock.write(buildTsl31Packet(0, "STAGE UTILITY"));
        } catch {
          /* ignore */
        }
        sock.end();
        resolve({ ok: true, message: `Connected to ${host}:${port}` });
      });
      sock.setTimeout(5000);
      sock.on("timeout", () => {
        sock.destroy();
        resolve({ ok: false, message: `Timed out connecting to ${host}:${port}` });
      });
      sock.on("error", (err) => resolve({ ok: false, message: err.message }));
    });
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.host || !this.port) return;
    const sock = net.connect({ host: this.host, port: this.port });
    this.socket = sock;
    sock.on("connect", () => {
      this.connected = true;
      this.backoffAttempt = 0;
      this.report("connected", `Sending to ${this.host}:${this.port}`);
      this.sendAll(sensourceService.getLatest());
    });
    sock.on("error", (err) => {
      this.report("error", `Can't reach ${this.host}:${this.port} — ${err.message}`);
    });
    sock.on("close", () => {
      this.connected = false;
      if (this.socket === sock) this.socket = null;
      if (this.running) this.scheduleReconnect();
    });
  }

  private sendAll(people: PeopleCountDTO | null): void {
    const sock = this.socket;
    if (!sock || !this.connected) return;
    for (const feed of this.feeds) {
      const label = labelFor(feed, valueFor(people, feed));
      try {
        sock.write(buildTsl31Packet(feed.displayIndex, label));
      } catch (err) {
        console.error("[tsl] write error:", err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Keeps TSL's own fixed 30s ceiling instead of the base's window-aware cap.
   * Nothing subscribes to a tally output, so the shared cap would read it as
   * "dormant" and stretch retries to 30 minutes — meaning a switcher powered on
   * mid-week could sit dark for half an hour. Deliberate divergence.
   */
  protected override scheduleReconnect(): void {
    if (!this.running) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.backoffAttempt);
    this.backoffAttempt++;
    this.scheduleIn(delay);
  }
}

export const tslService = new TslService();

// A connected scoreboard is watching the counts just as much as a browser is,
// and the SSE subscriber check cannot see it. See addDemandSource.
sensourceService.addDemandSource(() => tslService.isSending());
