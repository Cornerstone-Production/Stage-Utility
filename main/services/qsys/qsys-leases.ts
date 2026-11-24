// qsys-leases.ts — a momentary press the server lets go of when the page cannot.
//
// A momentary (a Boolean on a panel button) is true while pressed and false on
// release, and the release is the page's to send. A page that stops being able
// to (an iPad asleep mid-press, a dropped connection, a closed tab) would leave
// the control on at the Core, and the page will never send it later: nothing is
// queued or replayed. So a press that lands takes a lease. The page renews it
// about every LEASE_RENEW_MS while the finger stays down; the server writes the
// release itself when no renewal arrives within LEASE_EXPIRE_MS, or at once when
// the pressing page's event stream closes. A release from the page, or any other
// write to the control, ends the lease without a write.
//
// One lease per control: a second press takes it over. The release goes through
// the writer like any write, with every allowlist, type and range check, and is
// its own write-log entry with its cause.

import { addressKey, type QsysAddress } from "../../types/qsys.js";

export const LEASE_RENEW_MS = 1_000;
export const LEASE_EXPIRE_MS = 2_000;

/** Why the server released a momentary. */
export type LeaseEnd = "lease expired" | "stream closed";
/** Why the server wrote a release: a lease ending, or one owed from when the Core could not take it. */
export type ReleaseCause = LeaseEnd | "lease owed";

export interface Lease extends QsysAddress {
  /** The pressing page's event-stream client id; null when it sent none. */
  cid: string | null;
  panelId: string | null;
  device: string;
  remote: string;
}

interface Held extends Lease {
  timer: ReturnType<typeof setTimeout>;
}

export class QsysLeases {
  private readonly held = new Map<string, Held>();

  constructor(private readonly release: (lease: Lease, why: LeaseEnd) => void) {}

  /** A press landed: hold its lease, taking over any other on the same control. */
  hold(lease: Lease): void {
    const k = addressKey(lease);
    const old = this.held.get(k);
    if (old) clearTimeout(old.timer);
    this.held.set(k, { ...lease, timer: this.arm(k) });
  }

  /**
   * Renewal from the pressing page: the same remote address, and the same stream
   * client id when the press named one (two pages behind one address cannot keep
   * each other's press alive). False when no such lease is held.
   */
  renew(a: QsysAddress, remote: string, cid: string | null = null): boolean {
    const k = addressKey(a);
    const lease = this.held.get(k);
    if (!lease || lease.remote !== remote) return false;
    if (lease.cid !== null && lease.cid !== cid) return false;
    clearTimeout(lease.timer);
    lease.timer = this.arm(k);
    return true;
  }

  /** A write to the control (the page's release, or anyone's): the lease ends, nothing is written. */
  cancel(a: QsysAddress): void {
    const k = addressKey(a);
    const lease = this.held.get(k);
    if (!lease) return;
    clearTimeout(lease.timer);
    this.held.delete(k);
  }

  /** The event stream of `cid` closed: release every momentary it holds. */
  streamClosed(cid: string): void {
    for (const [k, lease] of [...this.held]) if (lease.cid === cid) this.end(k, "stream closed");
  }

  has(a: QsysAddress): boolean {
    return this.held.has(addressKey(a));
  }

  /** Forget every lease without releasing; for tests and shutdown. */
  clear(): void {
    for (const lease of this.held.values()) clearTimeout(lease.timer);
    this.held.clear();
  }

  private arm(k: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.end(k, "lease expired"), LEASE_EXPIRE_MS);
  }

  private end(k: string, why: LeaseEnd): void {
    const lease = this.held.get(k);
    if (!lease) return;
    clearTimeout(lease.timer);
    this.held.delete(k);
    const { timer: _timer, ...plain } = lease;
    this.release(plain, why);
  }
}
