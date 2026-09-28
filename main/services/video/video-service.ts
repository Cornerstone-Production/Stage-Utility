// main/services/video/video-service.ts — feeds, their status and the relay.
//
// The one owner of `video:state`. Every change goes through here and ends in
// publish(), so the page, every widget and the hello burst see one snapshot.

import { broadcast } from "../broadcaster.js";
import { secretsStore } from "../secrets.js";
import { walkLayoutObjects } from "../view-refs.js";
import { viewsStore } from "../views-store.js";
import { embedSrc } from "./embed.js";
import { FEED_ID_PATTERN, feedIdFor } from "./feed-id.js";
import { externalProtocol, parseFeedInput } from "./feed-input.js";
import { loadFeedsFile, videoFeedsStore } from "./feed-store.js";
import type {
  FeedPlay,
  FeedStatus,
  RelayStatus,
  VideoFeed,
  VideoFeedsFile,
  VideoFeedView,
  VideoSourceKind,
  VideoState,
} from "../../types/video.js";

type Result = { ok: true; feed: VideoFeedView } | { ok: false; error: string };

export const SECRET_SLOT = (feedId: string) => `video:${feedId}`;

/** `current.feeds`, defensively — the same reasoning loadFeedsFile applies to a
 *  disk read: a file written by an older build, or hand-restored, may carry no
 *  `feeds` array at all. */
const feedsOf = (current: VideoFeedsFile): VideoFeed[] => (Array.isArray(current.feeds) ? current.feeds : []);

class VideoService {
  private rev = 0;

  /**
   * The last snapshot computed by init() or publish(). writeHelloBurst is
   * SYNCHRONOUS (see remote-server.ts) and so cannot await state() the way every
   * other caller does; this is what it reads instead. Before init() has run —
   * there is no server yet to hydrate — it is the state a build with no relay
   * always starts at.
   */
  private snapshot: VideoState = {
    rev: 0,
    relay: { state: "off" },
    kinds: [...this.allowedKinds()],
    feeds: [],
  };

  allowedKinds(): ReadonlySet<VideoSourceKind> {
    return new Set<VideoSourceKind>(["embed", "external"]);
  }

  protected relayStatus(): RelayStatus {
    return { state: "off" };
  }

  protected feedStatus(feed: VideoFeed): FeedStatus {
    return { state: feed.source.kind === "embed" ? "embed" : null };
  }

  private play(feed: VideoFeed): FeedPlay {
    const s = feed.source;
    if (s.kind === "embed") return { via: "embed", src: embedSrc(s.player, s.ref) };
    if (s.kind === "external") return { via: "external", url: s.url, protocol: externalProtocol(s.url) };
    const base = `/video/${feed.id}`;
    return { via: "relay", whep: `${base}/whep`, hls: `${base}/index.m3u8` };
  }

  private sourceLine(feed: VideoFeed): string {
    const s = feed.source;
    if (s.kind === "pull" || s.kind === "external") return s.url;
    if (s.kind === "push") return { srt: "SRT", rtmp: "RTMP", whip: "WHIP (OBS)" }[s.protocol];
    return { "youtube-channel": "YouTube channel", "youtube-video": "YouTube video", resi: "Resi" }[s.player];
  }

  view(feed: VideoFeed): VideoFeedView {
    return {
      id: feed.id, name: feed.name, kind: feed.source.kind, source: feed.source,
      sourceLine: this.sourceLine(feed), play: this.play(feed), status: this.feedStatus(feed),
    };
  }

  async state(): Promise<VideoState> {
    const { feeds } = await loadFeedsFile();
    return {
      rev: this.rev,
      relay: this.relayStatus(),
      kinds: [...this.allowedKinds()],
      feeds: feeds.map((f) => this.view(f)),
    };
  }

  /** Synchronous snapshot for writeHelloBurst — see the field comment above. */
  current(): VideoState {
    return this.snapshot;
  }

  /** Computes the first snapshot. Called once at startup, beside the other
   *  service inits (see server.ts). */
  async init(): Promise<void> {
    this.snapshot = await this.state();
  }

  protected async publish(): Promise<void> {
    this.rev++;
    this.snapshot = await this.state();
    broadcast("video:state", this.snapshot);
  }

  async addFeed(body: unknown): Promise<Result> {
    const parsed = parseFeedInput(body, this.allowedKinds());
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const { feeds } = await loadFeedsFile();
    const id = feedIdFor(parsed.name, new Set(feeds.map((f) => f.id)));
    const feed: VideoFeed = { id, name: parsed.name, source: parsed.source };

    // Before the store write: a feed visible with no password behind it is
    // worse than a password saved for a feed that never gets created.
    if (parsed.password) await secretsStore.setSecret(SECRET_SLOT(id), "password", parsed.password);

    await videoFeedsStore.update((current) => ({ ...current, feeds: [...feedsOf(current), feed] }));
    await this.publish();
    return { ok: true, feed: this.view(feed) };
  }

  async updateFeed(id: string, body: unknown): Promise<Result> {
    // Checked with the pattern, then looked up with Array.find on the loaded
    // list — never used as an object key. See feed-id.ts.
    if (!FEED_ID_PATTERN.test(id)) return { ok: false, error: "not-found" };
    const { feeds } = await loadFeedsFile();
    const existing = feeds.find((f) => f.id === id);
    if (!existing) return { ok: false, error: "not-found" };

    const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : existing.name;
    const source = obj.source !== undefined ? obj.source : existing.source;
    // Re-running parseFeedInput is what makes a name-only PATCH ({ name }) valid
    // without a second copy of the name rules: it is this same call with the
    // existing source handed back unchanged.
    const parsed = parseFeedInput({ name, source }, this.allowedKinds());
    if (!parsed.ok) return { ok: false, error: parsed.error };

    // The id never changes on update — it is the layout binding's permanent
    // key (see main/types/video.ts). Only feedIdFor(), at creation, mints one.
    const feed: VideoFeed = { id, name: parsed.name, source: parsed.source };

    if (parsed.password) await secretsStore.setSecret(SECRET_SLOT(id), "password", parsed.password);

    await videoFeedsStore.update((current) => ({
      ...current,
      feeds: feedsOf(current).map((f) => (f.id === id ? feed : f)),
    }));
    await this.publish();
    return { ok: true, feed: this.view(feed) };
  }

  async removeFeed(id: string): Promise<boolean> {
    const { feeds } = await loadFeedsFile();
    if (!feeds.some((f) => f.id === id)) return false;

    await videoFeedsStore.update((current) => ({ ...current, feeds: feedsOf(current).filter((f) => f.id !== id) }));
    await secretsStore.clearSecrets(SECRET_SLOT(id));
    await this.publish();
    return true;
  }

  async usage(id: string): Promise<{ viewId: string; name: string }[]> {
    const out: { viewId: string; name: string }[] = [];
    for (const v of await viewsStore.load()) {
      if (!v.layout) continue;
      let uses = false;
      walkLayoutObjects(v.layout.objects, (o) => {
        // Read structurally: the `video` config member lands in Task 4, and a
        // view written by a newer build may carry types this one does not know.
        const c = o.config as { type: string; feedId?: unknown };
        if (c.type === "video" && c.feedId === id) uses = true;
      });
      if (uses) out.push({ viewId: v.id, name: v.name });
    }
    return out;
  }
}

export const videoService = new VideoService();
