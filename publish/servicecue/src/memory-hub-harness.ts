// memory-hub-harness.ts — HubApi held in memory, for the tests of handle.ts.
//
// The same contract the Durable Object implements, kept in Maps. It records what the
// handler asked of it, so a test can say what was stored without a runtime; what the
// object then sends to viewers is its own, and is shown in workerd (test/) and in
// messages.test.ts. TEST-ONLY: no `.test.` in the name so the runner does not look for
// tests in it.

import { PUBLISH_PROTOCOL_VERSION, type AssetContentType, type HubStatus } from "../../../main/types/servicecue-publish.js";
import type { HubApi } from "./hub-api.js";

export class MemoryHub implements HubApi {
  readonly docs = new Map<string, string>();
  readonly assets = new Map<string, { type: AssetContentType; body: ArrayBuffer }>();
  /** Every putDoc and deleteDoc asked for, in order, as "put <key>" and "delete <key>". */
  readonly calls: string[] = [];
  heartbeatAt: number | null = null;
  heartbeatVersion: string | null = null;
  heartbeatSentAt: number | null = null;
  /** The build id each heartbeat was given. */
  heartbeatBuilds: (string | null)[] = [];
  viewers = 0;
  /** The edge clock the hub reads. */
  clock = 1_000_000;

  async putDoc(key: string, text: string): Promise<void> {
    this.calls.push(`put ${key}`);
    this.docs.set(key, text);
  }
  async deleteDoc(key: string): Promise<void> {
    this.calls.push(`delete ${key}`);
    this.docs.delete(key);
  }
  async getDoc(key: string): Promise<string | null> {
    return this.docs.get(key) ?? null;
  }
  async putAsset(name: string, type: AssetContentType, body: ArrayBuffer): Promise<void> {
    this.assets.set(name, { type, body });
  }
  async getAsset(name: string): Promise<{ type: AssetContentType; body: ArrayBuffer } | null> {
    return this.assets.get(name) ?? null;
  }
  async heartbeat(sentAt: number, version: string, build: string | null): Promise<number> {
    this.heartbeatBuilds.push(build);
    this.heartbeatAt = this.clock;
    this.heartbeatSentAt = sentAt;
    this.heartbeatVersion = version;
    return this.clock;
  }
  async getHeartbeat(): Promise<number | null> {
    return this.heartbeatAt;
  }
  async applyManifest(docs: string[], assets: string[]): Promise<{ removedDocs: string[]; removedAssets: string[] }> {
    const removedDocs = [...this.docs.keys()].filter((k) => !docs.includes(k)).sort();
    const removedAssets = [...this.assets.keys()].filter((k) => !assets.includes(k)).sort();
    for (const k of removedDocs) this.docs.delete(k);
    for (const k of removedAssets) this.assets.delete(k);
    return { removedDocs, removedAssets };
  }
  async status(): Promise<HubStatus> {
    return {
      protocol: PUBLISH_PROTOCOL_VERSION,
      docs: [...this.docs.keys()].sort(),
      assets: [...this.assets.keys()].sort(),
      lastHeartbeat:
        this.heartbeatAt === null
          ? null
          : { at: this.heartbeatAt, sentAt: this.heartbeatSentAt ?? 0, version: this.heartbeatVersion ?? "" },
      viewers: this.viewers,
    };
  }
}
