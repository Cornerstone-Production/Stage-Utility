// feed-editor.tsx — the narrow right pane of the Video feeds page: a live
// picture of the selected feed, its Name and Source, whatever fields that
// source needs, Save / Cancel / Delete, and which layouts use it.
//
// The Source select offers exactly video:state's `kinds` (the kinds this
// build accepts; see allowedKinds() in main/services/video/video-service.ts).
// draftSource() switches over every VideoSourceKind, so a new kind does not
// compile until it has a field group here.

import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "@main/services/errors";
import {
  EMBED_PLAYERS,
  PUSH_PROTOCOL_LABEL,
  PUSH_PROTOCOLS,
  type EmbedPlayer,
  type KickResult,
  type PushProtocol,
  type VideoFeedView,
  type VideoSource,
  type VideoSourceKind,
} from "@main/types/video";

import {
  Button,
  confirm,
  ErrorNote,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StackedField,
} from "../../components/ui";
import { Segmented } from "../../editor/inspector-rows";
import { invoke } from "../../lib/api";
import { logReadFailure } from "../../lib/client-log";
import { VideoObject } from "../../main/video/video-object";
import { bFramesSentence, isObsWhipFeed } from "./b-frames-copy";
import { SIDE_PANE } from "./side-pane";

const KIND_LABEL: Record<VideoSourceKind, string> = {
  pull: "Pull from a device (RTSP, SRT, HLS)",
  push: "The device pushes to Stage Utility (SRT, RTMP, WHIP)",
  embed: "YouTube or Resi player",
  external: "Another WebRTC or HLS address",
};

/** The description under "Paste this into the device" — OBS needs the
 *  Bearer Token pointer; SRT and RTMP carry the password in the address
 *  itself, so the same sentence covers both. */
const PUSH_DESCRIPTION: Record<PushProtocol, string> = {
  srt: "The password is part of the address. Anything that pushes without it is refused.",
  rtmp: "The password is part of the address. Anything that pushes without it is refused.",
  whip: "In OBS: Settings, Stream, Service WHIP. Use the password below as the Bearer Token.",
};

/**
 * The design's warning callout for a relay feed playing over HLS instead of
 * WebRTC — null for anything else, including "delayed" via an embed/
 * external source, which this build never reports.
 *
 * `<b>Delayed a few seconds.</b>` then the shared B-frames sentence
 * (b-frames-copy.ts, also used by the list row's own hint), then — WHIP
 * only — the OBS-specific fix. A pull camera, or a push feed on SRT/RTMP,
 * gets no third sentence at all: the design's copy for that case is exactly
 * the shared sentence, nothing more, since neither is necessarily OBS (a
 * Magewell, ProPresenter's own output, anything else that can push or be
 * pulled from).
 */
export function delayWarning(feed: VideoFeedView): { headline: string; body: string } | null {
  const status = feed.status;
  if (status.state !== "delayed") return null;
  const isObsWhip = isObsWhipFeed(feed);
  if (status.delayedBecause === "b-frames") {
    const fix = isObsWhip ? " In OBS: Settings, Output, Streaming, set Profile to baseline, or Keyframe interval 1 s with B-frames 0." : "";
    return { headline: "Delayed a few seconds.", body: `${bFramesSentence(isObsWhip)}${fix}` };
  }
  return {
    headline: "Delayed a few seconds.",
    body: `${status.codec ?? "This"} video is not supported over WebRTC, so screens see it over HLS instead.`,
  };
}

const EMBED_PLAYER_LABEL: Record<EmbedPlayer, string> = {
  "youtube-channel": "YouTube, the channel's current live stream",
  "youtube-video": "YouTube, one video or stream",
  resi: "Resi embed",
};

/** What the editor says under an embed's fields: whose player it is, and why
 *  it is not for the stage. Resi's delay is not stated because nothing here
 *  has measured it. */
const EMBED_CALLOUT: Record<EmbedPlayer, string> = {
  "youtube-channel":
    "Plays in YouTube's own player, 5 to 15 seconds behind, and only while the stream is public or unlisted. Good for a lobby, not for the stage.",
  "youtube-video":
    "Plays in YouTube's own player, 5 to 15 seconds behind, and only while the stream is public or unlisted. Good for a lobby, not for the stage.",
  resi: "Plays in Resi's own player. Good for a lobby, not for the stage.",
};

/** The field label under the Player select follows the player, per the approved design. */
const EMBED_FIELD_LABEL: Record<EmbedPlayer, string> = {
  "youtube-channel": "Channel",
  "youtube-video": "Video",
  resi: "Embed code",
};

interface Draft {
  name: string;
  kind: VideoSourceKind;
  pullUrl: string;
  pullUsername: string;
  /** Never seeded from the feed: a stored password is never sent to the
   *  client (see main/types/video.ts's VideoSource comment), so this always
   *  starts blank. Whether it is SENT on Save is a separate question — see
   *  pullPasswordTouched below. */
  pullPassword: string;
  pushProtocol: PushProtocol;
  embedPlayer: EmbedPlayer;
  embedRef: string;
  externalUrl: string;
}

function draftFrom(feed: VideoFeedView | null, kinds: readonly VideoSourceKind[]): Draft {
  return {
    name: feed?.name ?? "",
    kind: feed?.source.kind ?? kinds[0] ?? "embed",
    pullUrl: feed?.source.kind === "pull" ? feed.source.url : "",
    pullUsername: feed?.source.kind === "pull" ? feed.source.username : "",
    pullPassword: "",
    pushProtocol: feed?.source.kind === "push" ? feed.source.protocol : "srt",
    embedPlayer: feed?.source.kind === "embed" ? feed.source.player : "youtube-channel",
    embedRef: feed?.source.kind === "embed" ? feed.source.ref : "",
    externalUrl: feed?.source.kind === "external" ? feed.source.url : "",
  };
}

/**
 * The picture is one fixed LayoutObject pointed at whichever feed is
 * selected — built the way the layout editor's own inspector builds a Video
 * object's config (renderer/editor/inspector.tsx's VideoConfig: `fit:
 * "contain"`, `whenOffline: "message"`), so this preview is exactly what a
 * screen would show, with the name tag off since the editor already draws
 * the feed's name above it.
 */
function pictureFor(feedId: string | null): { o: LayoutObject; config: Extract<LayoutObjectConfig, { type: "video" }> } {
  const config: Extract<LayoutObjectConfig, { type: "video" }> = {
    type: "video",
    feedId,
    fit: "contain",
    showLabel: false,
    whenOffline: "message",
  };
  return { o: { id: "video-feeds-preview", x: 0, y: 0, w: 1, h: 1, z: 0, config }, config };
}

/** "Used by 2 layouts: Stage confidence, Home." — or 1 layout, or none. */
export function usedBy(layouts: readonly { name: string }[]): string {
  if (layouts.length === 0) return "Not used by any layout.";
  const noun = layouts.length === 1 ? "layout" : "layouts";
  return `Used by ${layouts.length} ${noun}: ${layouts.map((l) => l.name).join(", ")}.`;
}

export interface FeedEditorProps {
  /** The feed being edited, or null when creating one (see `isNew`). */
  feed: VideoFeedView | null;
  /** True when there is no saved feed yet — Save calls video:addFeed rather
   *  than video:updateFeed, and there is nothing yet for Delete to remove. */
  isNew: boolean;
  /** video:state's `kinds` — the Source select offers exactly these. */
  kinds: readonly VideoSourceKind[];
  appLogo: string | null;
  appLogoMonochrome: boolean;
  onSaved: (feed: VideoFeedView) => void;
  onDeleted: () => void;
  /**
   * Cancel happened. Always called, whether or not this draft was a new
   * feed: it is a no-op on the caller's side when it wasn't (creatingNew was
   * already false), and it is what lets Cancel on a fresh draft exit back to
   * whatever was selected before "Add feed" — see video-feeds-route.tsx.
   */
  onCancelNew: () => void;
  /** `video:state`'s `relay.state === "running"` — the push editor's "did
   *  not take effect" notes are gated on it, so they never fire merely
   *  because no relay is running (video switched off, say). */
  relayRunning: boolean;
  /** A new feed's typed name and address as they change, for the list's
   *  draft row. Only called while `isNew`. */
  onDraftChange?: (draft: DraftRow) => void;
}

/** What the list's draft row shows of a feed that is not saved yet: the
 *  typed name and the address-like field for the chosen source ("" for a
 *  push feed, whose address only exists once saved). */
export interface DraftRow {
  name: string;
  source: string;
}

function draftRowOf(d: Draft): DraftRow {
  return { name: d.name.trim(), source: draftAddress(d).trim() };
}

function draftAddress(d: Draft): string {
  switch (d.kind) {
    case "pull":
      return d.pullUrl;
    case "external":
      return d.externalUrl;
    case "embed":
      return d.embedRef;
    case "push":
      return "";
  }
}

/** What Save sends for the draft's chosen kind. */
function draftSource(d: Draft): VideoSource {
  switch (d.kind) {
    case "pull":
      return { kind: "pull", url: d.pullUrl, username: d.pullUsername };
    case "push":
      return { kind: "push", protocol: d.pushProtocol };
    case "embed":
      return { kind: "embed", player: d.embedPlayer, ref: d.embedRef };
    case "external":
      return { kind: "external", url: d.externalUrl };
  }
}

export function FeedEditor({ feed, isNew, kinds, appLogo, appLogoMonochrome, onSaved, onDeleted, onCancelNew, relayRunning, onDraftChange }: FeedEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(feed, kinds));
  useEffect(() => {
    if (isNew) onDraftChange?.(draftRowOf(draft));
  }, [isNew, draft, onDraftChange]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True once the operator has typed into the pull Password field this
   *  session. The field always starts blank (a stored password is never
   *  sent to the client), so a blank Save must LEAVE an existing password
   *  alone rather than clear it — only an edit, even one that ends back at
   *  "", counts as the operator's own choice to change or clear it. */
  const [pullPasswordTouched, setPullPasswordTouched] = useState(false);

  function handleCancel() {
    onCancelNew();
    setDraft(draftFrom(feed, kinds));
    setPullPasswordTouched(false);
    setError(null);
  }

  async function handleSave() {
    if (draft.name.trim() === "") {
      setError("Give the feed a name");
      return;
    }
    const source = draftSource(draft);
    // The server answers an empty address with a bare "invalid" and accepts a
    // scheme-only one ("rtsp://") as a feed that can never play; the empty
    // field used to be pre-filled with that scheme, so both are caught here.
    if ((source.kind === "pull" || source.kind === "external") && /^([a-z][a-z0-9+.-]*:\/\/)?$/i.test(source.url.trim())) {
      setError("Enter the address, including what comes after the scheme (for example rtsp://192.0.2.10/stream)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: draft.name.trim(), source };
      // Only sent when the operator actually touched the field — see
      // pullPasswordTouched's own comment. "" is how updateFeed clears a
      // stored password; leaving the key out entirely is how it is told to
      // leave the existing one alone.
      if (draft.kind === "pull" && pullPasswordTouched) body.password = draft.pullPassword;
      // Nothing reads as saved until this resolves: onSaved only fires with
      // the server's own view of the feed, never the local draft.
      const result =
        isNew || !feed
          ? await invoke<{ feed: VideoFeedView }>("video:addFeed", body)
          : await invoke<{ feed: VideoFeedView }>("video:updateFeed", { id: feed.id, patch: body });
      onSaved(result.feed);
      setDraft((d) => ({ ...d, pullPassword: "" }));
      setPullPasswordTouched(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** Clears a pull feed's stored password immediately — sends
   *  `password: ""` on its own, rather than waiting for the operator to
   *  also press Save. Only shown while a password IS stored and the
   *  operator has not started typing a replacement (see the field's own
   *  render below). */
  async function handleClearPullPassword() {
    if (!feed) return;
    setError(null);
    try {
      const result = await invoke<{ feed: VideoFeedView }>("video:updateFeed", { id: feed.id, patch: { password: "" } });
      onSaved(result.feed);
      setDraft((d) => ({ ...d, pullPassword: "" }));
      setPullPasswordTouched(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleDelete() {
    if (!feed) return;
    setError(null);
    setDeleting(true);
    try {
      // Usage first, and the confirm before the delete: an operator deciding
      // whether to break two layouts needs that fact BEFORE being asked, not
      // a toast that flashes past after the feed is already gone.
      const usage = await invoke<{ layouts: { viewId: string; name: string }[] }>("video:feedUsage", { id: feed.id });
      const message = usedBy(usage.layouts);
      const ok = await confirm({
        title: `Delete "${feed.name}"?`,
        message,
        // "Delete", not "Delete feed": the row's own trigger already reads
        // "Delete feed" (the approved design's action copy), and this is the
        // confirm dialog's OWN action button, a distinct control from that
        // trigger.
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      await invoke("video:removeFeed", { id: feed.id });
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  const picture = pictureFor(feed?.id ?? null);
  const warning = !isNew && feed ? delayWarning(feed) : null;

  return (
    <aside aria-label="Feed settings" className={SIDE_PANE}>
      <h2 className="text-subheadline font-semibold text-fg">{isNew ? "New feed" : feed?.name}</h2>

      <div className="aspect-video w-full overflow-hidden rounded-[10px] bg-black">
        {/* This preview is the feed editor, never a real kiosk display, so it
            must never refuse a B-frame feed over some wall's own "Use HLS on
            this screen" switch. */}
        <VideoObject o={picture.o} config={picture.config} appLogo={appLogo} appLogoMonochrome={appLogoMonochrome} allowHls />
      </div>

      {warning && (
        <p className="rounded-lg bg-warn-9/14 px-2.5 py-2 text-caption1 text-warn-11">
          <b>{warning.headline}</b> {warning.body}
        </p>
      )}

      <StackedField label="Name" description="What layouts and Home show. Renaming keeps every layout using it.">
        <Input aria-label="Name" placeholder="New feed" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </StackedField>

      <StackedField label="Source">
        <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as VideoSourceKind })}>
          <SelectTrigger aria-label="Source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </StackedField>

      {draft.kind === "pull" && (
        <>
          <StackedField
            label="Address"
            description="An RTSP, SRT or HLS address the relay fetches. It only fetches while something is showing this feed."
          >
            <Input
              aria-label="Address"
              placeholder="rtsp://"
              className="font-mono text-caption1"
              value={draft.pullUrl}
              onChange={(e) => setDraft({ ...draft, pullUrl: e.target.value })}
            />
          </StackedField>

          <StackedField label="Username and password">
            <div className="flex gap-2">
              <Input
                aria-label="Username"
                placeholder="If the device asks for one"
                value={draft.pullUsername}
                onChange={(e) => setDraft({ ...draft, pullUsername: e.target.value })}
              />
              <Input
                aria-label="Password"
                type="password"
                placeholder="Password"
                value={draft.pullPassword}
                onChange={(e) => {
                  setDraft({ ...draft, pullPassword: e.target.value });
                  setPullPasswordTouched(true);
                }}
              />
            </div>
            {/^srt:/i.test(draft.pullUrl.trim()) && (
              <span className="text-caption1 text-fg-subtle">
                SRT takes a passphrase only: 10 to 80 plain letters, digits, spaces and punctuation. Leave Username empty and put it in Password.
              </span>
            )}
            {/* The field itself never shows a stored password — only THAT
                one is stored, via hasPassword, never the value. Hidden the
                moment the operator starts typing a replacement, since the
                message ("a password is saved") stops being true the instant
                they are actively setting a new one. */}
            {!isNew && feed?.source.kind === "pull" && feed.hasPassword && !pullPasswordTouched && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption1 text-fg-subtle">A password is saved. Type to replace it, or clear it.</span>
                <Button type="button" variant="transparent" size="small" onClick={() => void handleClearPullPassword()}>
                  Clear
                </Button>
              </div>
            )}
          </StackedField>
        </>
      )}

      {draft.kind === "push" && (
        <>
          <StackedField label="How it connects">
            <Segmented
              label="How it connects"
              value={draft.pushProtocol}
              options={PUSH_PROTOCOLS.map((p) => ({ value: p, label: PUSH_PROTOCOL_LABEL[p] }))}
              onChange={(v) => setDraft({ ...draft, pushProtocol: v })}
            />
          </StackedField>

          {!isNew && feed && feed.source.kind === "push" ? (
            // `protocol` is the DRAFT's current segmented-control
            // choice, not necessarily the feed's saved one — the address
            // and description now preview whatever protocol is selected,
            // via the server's own protocolOverride (pushAddress()), never
            // saving anything until Save is pressed.
            <PushAddressFields feedId={feed.id} protocol={draft.pushProtocol} relayRunning={relayRunning} />
          ) : (
            <p className="rounded-lg bg-fill px-2.5 py-2 text-caption1 text-fg-muted">
              Save this feed to get its address and password.
            </p>
          )}
        </>
      )}

      {draft.kind === "embed" && (
        <>
          <StackedField label="Player">
            <Select value={draft.embedPlayer} onValueChange={(v) => setDraft({ ...draft, embedPlayer: v as EmbedPlayer })}>
              <SelectTrigger aria-label="Player" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMBED_PLAYERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {EMBED_PLAYER_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </StackedField>

          <StackedField label={EMBED_FIELD_LABEL[draft.embedPlayer]}>
            <Input
              aria-label={EMBED_FIELD_LABEL[draft.embedPlayer]}
              value={draft.embedRef}
              onChange={(e) => setDraft({ ...draft, embedRef: e.target.value })}
            />
          </StackedField>

          <p className="rounded-lg bg-fill px-2.5 py-2 text-caption1 text-fg-muted">{EMBED_CALLOUT[draft.embedPlayer]}</p>
        </>
      )}

      {draft.kind === "external" && (
        <StackedField
          label="WebRTC (WHEP) or HLS address"
          description="Something else already serves this feed. Stage Utility plays it as given and cannot report its health."
        >
          <Input
            aria-label="WebRTC (WHEP) or HLS address"
            placeholder="https://"
            className="font-mono text-caption1"
            value={draft.externalUrl}
            onChange={(e) => setDraft({ ...draft, externalUrl: e.target.value })}
          />
        </StackedField>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="accent" size="small" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="transparent" size="small" onClick={handleCancel} disabled={saving}>
          Cancel
        </Button>
        {!isNew && feed && (
          <Button
            variant="transparent"
            size="small"
            className="ml-auto text-danger-11"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete feed"}
          </Button>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {!isNew && feed && <UsedByLine feedId={feed.id} />}
    </aside>
  );
}

interface PushAddress {
  protocol: PushProtocol;
  address: string;
  password: string;
}

/** What newPushPassword() reports about the rotation that just ran.
 *  Kept separate from `PushAddress`: it is only ever set by an ACTUAL
 *  rotation this session, never by a plain load, so its presence alone is
 *  "a rotation happened," not "the feed has ever been rotated." */
interface RotationResult {
  applied: boolean;
  kicked: KickResult;
}

/** How long the Copy button's label reads "Copied" before reverting. */
export const COPIED_LABEL_MS = 1400;

/**
 * A push feed's paste-ready address and password: "Paste this into the
 * device" with Copy, then Password with New password. Re-fetched whenever
 * `feedId` OR `protocol` changes — `protocol` is the editor's own
 * DRAFT choice (the segmented control above), so flipping it previews that
 * protocol's address with the SAME stored password, via the server's own
 * `protocolOverride`, without saving anything.
 *
 * Copy never throws: `navigator.clipboard` is undefined outside a secure
 * context, which is how Stage Utility is normally served on a LAN (plain
 * HTTP) — the fallback selects the address so Ctrl+C/Cmd+C still works,
 * rather than reaching for the same silent execCommand trick
 * renderer/lib/clipboard.ts uses elsewhere; the design calls for the
 * operator to see and confirm the selection, not a copy that happened
 * invisibly.
 */
function PushAddressFields({ feedId, protocol, relayRunning }: { feedId: string; protocol: PushProtocol; relayRunning: boolean }) {
  const [data, setData] = useState<PushAddress | null>(null);
  // One slot each: a rotation landing after a newer preview failed must
  // not clear that preview's error, nor a preview a rotation's.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rotationError, setRotationError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotation, setRotation] = useState<RotationResult | null>(null);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [justCopied, setJustCopied] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  /** The timer that turns "Copied" back into "Copy": a second copy restarts
   *  it, and leaving the editor cancels it. */
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );
  /** Every request this component makes — a preview
   *  load() or a rotation — takes a ticket, and a response is applied only
   *  if its own ticket is still the newest one issued. Without this, two
   *  requests in flight together apply in WHATEVER ORDER THEY RESOLVE, not
   *  the order they were ISSUED in: flipping the segmented control to
   *  preview a protocol, then clicking New password before that preview's
   *  own GET has returned, could have the (fast) rotation land first and
   *  then the (slower) STALE preview overwrite it right back — showing an
   *  address the rotation had already replaced. */
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    return invoke<PushAddress>("video:pushAddress", { id: feedId, protocol }).then(
      (r) => {
        if (seq !== requestSeq.current) return; // superseded by a newer request — drop it
        setData(r);
        setLoadError(null);
      },
      (err: unknown) => {
        if (seq !== requestSeq.current) return;
        logReadFailure("video", "the push address", err);
        setLoadError("Couldn't read the push address.");
      },
    );
  }, [feedId, protocol]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleNewPassword() {
    setRotating(true);
    const seq = ++requestSeq.current;
    try {
      const r = await invoke<PushAddress & RotationResult>("video:newPushPassword", { id: feedId });
      // The rotation's own report — what happened to whoever was
      // publishing — describes THIS call, never "whatever the control
      // currently shows," so it must never be dropped just because the
      // control was flipped to a different protocol while the request was
      // in flight. Only the DATA a later request
      // could already have replaced is gated by the counter below.
      setRotation({ applied: r.applied, kicked: r.kicked });
      setRotationError(null);
      setCopyHint(null);
      if (seq !== requestSeq.current) return; // a newer request already owns the data shown now
      if (protocol === r.protocol) {
        // The control is showing the feed's own saved protocol — r's own
        // answer already IS that protocol's fresh address; no second round
        // trip needed.
        setData({ protocol: r.protocol, address: r.address, password: r.password });
      } else {
        // The control is previewing a DIFFERENT, unsaved protocol. Showing
        // r's own (saved-protocol) address here would show an address for a
        // protocol the control does not even have selected, so the control
        // and the address field would stop matching. Re-preview the protocol the control shows, now with the
        // fresh password. Safe to land out of order: the request counter
        // above drops it if a newer request has since started.
        void load();
      }
    } catch (err) {
      // Same reasoning as above: a rotation failure IS the report worth
      // showing, regardless of what is being previewed by the time it
      // arrives.
      setRotationError(errorMessage(err));
    } finally {
      setRotating(false);
    }
  }

  function handleCopy() {
    if (!data) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(data.address).then(
          () => {
            setCopyHint(null);
            setJustCopied(true);
            if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setJustCopied(false), COPIED_LABEL_MS);
          },
          () => {
            addressRef.current?.select();
            setCopyHint("Press Ctrl+C / Cmd+C to copy");
          },
        );
        return;
      }
    } catch {
      /* fall through to the select-and-prompt fallback below */
    }
    addressRef.current?.select();
    setCopyHint("Press Ctrl+C / Cmd+C to copy");
  }

  // An error from a ROTATION (data already loaded) keeps the
  // fields on screen, with the error under Password and New password still
  // pressable — only a failed INITIAL load (nothing to show at all) falls
  // back to a bare ErrorNote.
  if (loadError && !data) return <ErrorNote>{loadError}</ErrorNote>;
  if (!data) return null;

  // A note only for a RUNNING relay — with none running (video switched off,
  // or no relay started yet), `applied` is vacuously true and `kicked` is
  // "none", and would otherwise show a false alarm on every rotation. `kicked` is
  // three-way, not a boolean: "none" means EITHER nobody was publishing OR
  // no relay was there to ask — both unremarkable — so the note fires only
  // for "failed", where a device really was connected and dropping it did
  // not work. `applied` false wins when both are true: the new password is
  // not live at the relay yet, so whether the kick itself also failed is
  // moot until it is.
  let rotationNote: string | null = null;
  if (relayRunning && rotation) {
    if (!rotation.applied) rotationNote = "The relay did not take the new password yet; it will on its next start";
    else if (rotation.kicked === "failed") rotationNote = "The device already sending could not be dropped; it keeps sending until it reconnects";
  }

  return (
    <>
      <StackedField label="Paste this into the device" description={PUSH_DESCRIPTION[data.protocol]}>
        <div className="flex gap-2">
          <Input
            ref={addressRef}
            aria-label="Paste this into the device"
            readOnly
            className="min-w-0 flex-1 font-mono text-caption1"
            value={data.address}
            onBlur={() => setCopyHint(null)}
          />
          <Button type="button" variant="filled" size="small" className="shrink-0" onClick={handleCopy}>
            {justCopied ? "Copied" : "Copy"}
          </Button>
        </div>
        {copyHint && <span className="text-caption1 text-fg-subtle">{copyHint}</span>}
      </StackedField>

      <StackedField label="Password">
        <div className="flex gap-2">
          <Input aria-label="Password" readOnly className="min-w-0 flex-1 font-mono text-caption1" value={data.password} />
          <Button
            type="button"
            variant="filled"
            size="small"
            className="shrink-0 whitespace-nowrap"
            onClick={() => void handleNewPassword()}
            disabled={rotating}
          >
            {rotating ? "…" : "New password"}
          </Button>
        </div>
      </StackedField>

      {rotationNote && <p className="text-caption1 text-warn-11">{rotationNote}</p>}
      {loadError && <ErrorNote>{loadError}</ErrorNote>}
      {rotationError && <ErrorNote>{rotationError}</ErrorNote>}
    </>
  );
}

/**
 * "Used by 2 layouts: Stage confidence, Home.", under the editor's buttons,
 * read when a feed is selected. Delete reads it again before its confirm, so
 * the confirm is never answered on a stale count. A failed read says so here
 * and on /log rather than claiming the feed is unused.
 */
function UsedByLine({ feedId }: { feedId: string }) {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke<{ layouts: { viewId: string; name: string }[] }>("video:feedUsage", { id: feedId }).then(
      (usage) => {
        if (live) setLine(usedBy(usage.layouts));
      },
      (err: unknown) => {
        logReadFailure("video", "which layouts use a feed", err);
        if (live) setLine("Couldn't read which layouts use this feed.");
      },
    );
    return () => {
      live = false;
    };
  }, [feedId]);
  if (line === null) return null;
  return <span className="text-caption1 text-fg-subtle">{line}</span>;
}
