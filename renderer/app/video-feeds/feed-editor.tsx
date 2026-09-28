// feed-editor.tsx — the narrow right pane of the Video feeds page: a live
// picture of the selected feed, its Name and Source, whatever fields that
// source needs, Save / Cancel / Delete, and which layouts use it.
//
// The Source select offers exactly video:state's `kinds` (the kinds this
// build accepts; see allowedKinds() in main/services/video/video-service.ts).
// A kind with no field group here yet is refused at Save rather than guessed
// at.

import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "@main/services/errors";
import {
  EMBED_PLAYERS,
  PUSH_PROTOCOLS,
  type EmbedPlayer,
  type KickResult,
  type PushProtocol,
  type VideoFeedView,
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

const KIND_LABEL: Record<VideoSourceKind, string> = {
  pull: "Pull from a device (RTSP, SRT, HLS)",
  push: "The device pushes to Stage Utility (SRT, RTMP, WHIP)",
  embed: "YouTube or Resi player",
  external: "Another WebRTC or HLS address",
};

const PUSH_PROTOCOL_LABEL: Record<PushProtocol, string> = {
  srt: "SRT",
  rtmp: "RTMP",
  whip: "WHIP (OBS)",
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
 * R14k: `<b>Delayed a few seconds.</b>` then the shared B-frames sentence
 * (b-frames-copy.ts, also used by the list row's own hint), then — WHIP
 * only — the OBS-specific fix. A pull camera, or a push feed on SRT/RTMP,
 * gets no third sentence at all: R14k's own copy for that case is exactly
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
    name: feed?.name ?? "New feed",
    kind: feed?.source.kind ?? kinds[0] ?? "embed",
    pullUrl: feed?.source.kind === "pull" ? feed.source.url : "rtsp://",
    pullUsername: feed?.source.kind === "pull" ? feed.source.username : "",
    pullPassword: "",
    pushProtocol: feed?.source.kind === "push" ? feed.source.protocol : "srt",
    embedPlayer: feed?.source.kind === "embed" ? feed.source.player : "youtube-channel",
    embedRef: feed?.source.kind === "embed" ? feed.source.ref : "",
    externalUrl: feed?.source.kind === "external" ? feed.source.url : "https://",
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
  /** `video:state`'s `relay.state === "running"` — R14d gates the push
   *  editor's "did not take effect" notes on this, so they never fire
   *  merely because no relay is attached yet (the common case until Task
   *  15 wires one into the server). */
  relayRunning: boolean;
}

export function FeedEditor({ feed, isNew, kinds, appLogo, appLogoMonochrome, onSaved, onDeleted, onCancelNew, relayRunning }: FeedEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(feed, kinds));
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

  /** null for a kind with no field group here yet (see the file header). */
  function sourcePayload():
    | { kind: "pull"; url: string; username: string }
    | { kind: "push"; protocol: PushProtocol }
    | { kind: "embed"; player: EmbedPlayer; ref: string }
    | { kind: "external"; url: string }
    | null {
    if (draft.kind === "pull") return { kind: "pull", url: draft.pullUrl, username: draft.pullUsername };
    if (draft.kind === "push") return { kind: "push", protocol: draft.pushProtocol };
    if (draft.kind === "embed") return { kind: "embed", player: draft.embedPlayer, ref: draft.embedRef };
    if (draft.kind === "external") return { kind: "external", url: draft.externalUrl };
    return null;
  }

  async function handleSave() {
    const source = sourcePayload();
    if (!source) {
      setError("This build does not support that source yet.");
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

  /** Item 12: clears a pull feed's stored password immediately — sends
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
    <aside
      aria-label="Feed settings"
      className="flex min-w-0 flex-col gap-3.5 border-t border-line bg-surface-raised p-4 min-[900px]:border-l min-[900px]:border-t-0"
    >
      <h2 className="text-subheadline font-semibold text-fg">{isNew ? "New feed" : feed?.name}</h2>

      <div className="aspect-video w-full overflow-hidden rounded-[10px] bg-black">
        <VideoObject o={picture.o} config={picture.config} appLogo={appLogo} appLogoMonochrome={appLogoMonochrome} />
      </div>

      {warning && (
        <p className="rounded-lg bg-warn-9/14 px-2.5 py-2 text-caption1 text-warn-11">
          <b>{warning.headline}</b> {warning.body}
        </p>
      )}

      <StackedField label="Name" description="What layouts and Home show. Renaming keeps every layout using it.">
        <Input aria-label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
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
            {/* Item 12: the field itself never shows a stored password —
                only THAT one is stored, via hasPassword, never the value.
                Hidden the moment the operator starts typing a replacement,
                since the message ("a password is saved") stops being true
                the instant they are actively setting a new one. */}
            {!isNew && feed?.source.kind === "pull" && feed.hasPassword && !pullPasswordTouched && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption1 text-fg-subtle">A password is saved. Type to replace it, or clear it.</span>
                <Button type="button" variant="transparent" size="small" onClick={() => void handleClearPullPassword()}>
                  Clear
                </Button>
              </div>
            )}
          </StackedField>

          <p className="rounded-lg bg-fill px-2.5 py-2 text-caption1 text-fg-muted">
            <b>Magewell Ultra Stream:</b> turn on its RTSP server as the second output. It keeps streaming to Resi on the
            first.
          </p>
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
            // R14g-a: `protocol` is the DRAFT's current segmented-control
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

/** What newPushPassword() reports about the rotation that just ran — R14d.
 *  Kept separate from `PushAddress`: it is only ever set by an ACTUAL
 *  rotation this session, never by a plain load, so its presence alone is
 *  "a rotation happened," not "the feed has ever been rotated." */
interface RotationResult {
  applied: boolean;
  kicked: KickResult;
}

/** How long the Copy button's label reads "Copied" before reverting — R14g. */
export const COPIED_LABEL_MS = 1400;

/**
 * A push feed's paste-ready address and password: "Paste this into the
 * device" with Copy, then Password with New password. Re-fetched whenever
 * `feedId` OR `protocol` changes — R14g-a: `protocol` is the editor's own
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
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotation, setRotation] = useState<RotationResult | null>(null);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [justCopied, setJustCopied] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  /** R14 round 2 item 6: every request this component makes — a preview
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
        setError(null);
      },
      (err: unknown) => {
        if (seq !== requestSeq.current) return;
        logReadFailure("video", "the push address", err);
        setError("Couldn't read the push address.");
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
      if (seq !== requestSeq.current) return; // an even newer request landed first — drop it
      setRotation({ applied: r.applied, kicked: r.kicked });
      setError(null);
      setCopyHint(null);
      if (protocol === r.protocol) {
        // The control is showing the feed's own saved protocol — r's own
        // answer already IS that protocol's fresh address; no second round
        // trip needed.
        setData({ protocol: r.protocol, address: r.address, password: r.password });
      } else {
        // The control is previewing a DIFFERENT, unsaved protocol — R14
        // round 2 item 6. Showing r's own (saved-protocol) address here
        // would show an address for a protocol the control does not even
        // have selected, so the control and the address field would stop
        // matching. Re-preview the protocol the control shows, now with the
        // fresh password. Safe to land out of order: the request counter
        // above drops it if a newer request has since started.
        void load();
      }
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(errorMessage(err));
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
            setTimeout(() => setJustCopied(false), COPIED_LABEL_MS);
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

  // Item 11: an error from a ROTATION (data already loaded) keeps the
  // fields on screen, with the error under Password and New password still
  // pressable — only a failed INITIAL load (nothing to show at all) falls
  // back to a bare ErrorNote.
  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return null;

  // R14d, refined per controller ruling: a note only for a RUNNING relay —
  // with none attached (the common case until Task 15 wires one into the
  // server), `applied` is vacuously true and `kicked` is "none", and would
  // otherwise show a false alarm on every single rotation. `kicked` is
  // three-way, not a boolean: "none" means EITHER nobody was publishing OR
  // no relay was there to ask — both unremarkable — so the note fires only
  // for "failed", where a device really was connected and dropping it did
  // not work. `applied` false wins when both are true: the new password is
  // not live at the relay yet, so whether the kick itself also failed is
  // moot until it is.
  const rotationNote =
    relayRunning && rotation && (!rotation.applied || rotation.kicked === "failed")
      ? !rotation.applied
        ? "The relay did not take the new password yet; it will on its next start"
        : "The device already sending could not be dropped; it keeps sending until it reconnects"
      : null;

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
      {error && <ErrorNote>{error}</ErrorNote>}
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
