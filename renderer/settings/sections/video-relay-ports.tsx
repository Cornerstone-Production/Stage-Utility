// video-relay-ports.tsx — Advanced's own card for the video relay's seven
// ports: PATCH /api/video/ports, which saves them and restarts the relay if
// it is running.
//
// Seven fields validated as ONE body (all different, each 1024-65535) is why
// this does not follow the ordinary NumberInput rule of persisting on every
// change: a value mid-edit ("193" on the way to "1935") can legitimately
// collide with another field for a keystroke, and PATCHing on every one of
// those would refuse constantly. Local state buffers the seven until Save.

import { useState } from "react";

import { errorMessage } from "@main/services/errors";
import type { VideoPorts } from "@main/types/video";

import { invoke } from "../../lib/api";
import { useVideoState } from "../../main/video/use-video-state";
import { Button, ErrorNote, Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, NumberInput } from "../../components/ui";
import { settingText } from "./advanced-settings";

/** The card's own `data-flash-id`, named here (rather than in
 *  advanced-section.tsx, which just renders it) so the Video feeds page's
 *  "Change ports in Advanced" link — the only other place that needs it —
 *  imports the identifier from the thing it identifies, not a duplicated
 *  string literal. */
export const VIDEO_PORTS_FLASH_ID = "video-relay-ports";

const NETWORK_FIELDS: { key: keyof VideoPorts; label: string }[] = [
  { key: "rtmp", label: "RTMP" },
  { key: "srt", label: "SRT" },
  { key: "webrtcUdp", label: "Video to screens (UDP)" },
];

const LOOPBACK_FIELDS: { key: keyof VideoPorts; label: string }[] = [
  { key: "webrtcHttp", label: "WebRTC signalling" },
  { key: "hls", label: "HLS" },
  { key: "api", label: "Relay API" },
  { key: "rtsp", label: "RTSP (audio conversion)" },
];

function PortRow({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
      </FieldContent>
      <NumberInput value={value} onChange={onChange} min={1024} max={65535} disabled={disabled} aria-label={label} />
    </Field>
  );
}

/**
 * Reads the server's ports and, once they arrive, hands off to the form
 * below — which owns its own local buffer FROM THAT POINT ON via
 * `useState(initialPorts)`, never an effect that copies a prop into state: a
 * later `video:state` push handing this component a NEW `initialPorts`
 * value changes nothing, because `useState`'s initializer runs only once, on
 * mount — which is exactly the point: a status poll landing mid-edit must
 * never overwrite what the operator is typing.
 */
export function VideoRelayPortsPanel() {
  const state = useVideoState();
  if (!state?.ports) {
    return (
      // No data-setting-id: the id marks the real form, so a test that counts drawn
      // rows cannot be satisfied by this placeholder.
      <p className="px-4 py-3 text-caption1 text-fg-muted">Loading…</p>
    );
  }
  return <VideoRelayPortsForm initialPorts={state.ports} />;
}

function VideoRelayPortsForm({ initialPorts }: { initialPorts: VideoPorts }) {
  const [ports, setPorts] = useState(initialPorts);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const text = settingText("video-relay-ports");

  function setField(key: keyof VideoPorts, value: number) {
    setSaved(false);
    setPorts((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await invoke<{ ports: VideoPorts }>("video:setPorts", { ...ports });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FieldGroup data-setting-id="video-relay-ports">
      <div className="flex flex-col px-4 py-3">
        <FieldLabel>{text.name}</FieldLabel>
        <FieldDescription>{text.description}</FieldDescription>
      </div>
      <p className="px-4 pt-3 pb-1 text-caption2 font-semibold uppercase tracking-wide text-fg-muted">
        On the network
      </p>
      {NETWORK_FIELDS.map(({ key, label }) => (
        <PortRow key={key} label={label} value={ports[key]} onChange={(v) => setField(key, v)} disabled={saving} />
      ))}
      <p className="px-4 pt-3 pb-1 text-caption2 font-semibold uppercase tracking-wide text-fg-muted">
        This machine only
      </p>
      {LOOPBACK_FIELDS.map(({ key, label }) => (
        <PortRow key={key} label={label} value={ports[key]} onChange={(v) => setField(key, v)} disabled={saving} />
      ))}
      <div className="flex flex-col gap-2 px-4 pt-2 pb-3">
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex items-center gap-2">
          <Button type="button" variant="accent" size="small" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {saved && !error && <span className="text-caption1 text-fg-muted">Saved.</span>}
        </div>
      </div>
    </FieldGroup>
  );
}
