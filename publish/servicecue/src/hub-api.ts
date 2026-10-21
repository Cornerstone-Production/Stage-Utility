// hub-api.ts — what the request handler needs from the one Durable Object.
//
// The handler (handle.ts) is written against this and not against the Durable
// Object, so the root test suite can drive every route, refusal and header of the
// real handler with an in-memory hub. The Durable Object (hub.ts) implements it;
// through its stub every call is a promise, which is why every member is.
//
// Types only, and no Workers API: this file is read by the root type-check. A viewer's
// WebSocket handshake is not here: it is a fetch to the object, and the handler is given
// it as its own dependency.

import type { AssetContentType, PublishStatus } from "../../../main/types/servicecue-publish.js";

export interface HubApi {
  /**
   * Store a doc's JSON text, replacing any under that key, and tell the open viewers:
   * a doc that is also a frame (FRAME_DOCS) is sent as that frame, and any other that
   * changed is named on `publish:docs`.
   */
  putDoc(key: string, text: string): Promise<void>;
  /** Remove a doc, and name it on `publish:docs` if it was there. */
  deleteDoc(key: string): Promise<void>;
  /** A doc's JSON text exactly as it was stored, or null when none is. */
  getDoc(key: string): Promise<string | null>;

  putAsset(name: string, type: AssetContentType, body: ArrayBuffer): Promise<void>;
  getAsset(name: string): Promise<{ type: AssetContentType; body: ArrayBuffer } | null>;

  /**
   * Record a heartbeat and tell every viewer, with the build id of the page this
   * deployment serves (null when it carries none). Resolves to the edge's clock at that
   * moment.
   */
  heartbeat(sentAt: number, version: string, build: string | null): Promise<number>;
  /** The edge's clock when the last heartbeat arrived, or null before the first. */
  getHeartbeat(): Promise<number | null>;

  /** Delete every doc and asset not named, and name the docs on `publish:docs`. Resolves to what it deleted. */
  applyManifest(docs: string[], assets: string[]): Promise<{ removedDocs: string[]; removedAssets: string[] }>;
  status(): Promise<PublishStatus>;
}
