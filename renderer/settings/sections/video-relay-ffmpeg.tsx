// video-relay-ffmpeg.tsx — Advanced's ffmpeg row on the Video relay card: whether
// the server found a usable system ffmpeg (GET /api/video/ffmpeg) and the path
// to use instead of searching (PATCH /api/video/ffmpeg). Saving, even an
// unchanged path, checks again. A read that fails says so and offers Retry.

import { useEffect, useState, type ChangeEvent } from "react";

import { errorMessage } from "@main/services/errors";
import type { FfmpegStatus } from "@main/types/video";

import { invoke } from "../../lib/api";
import { Button, ErrorNote, Field, FieldContent, FieldDescription, FieldLabel, Input } from "../../components/ui";

const SOURCE_TEXT: Record<Extract<FfmpegStatus, { ok: true }>["source"], string> = {
  automatic: "found automatically",
  homebrew: "found in a Homebrew folder",
  configured: "at the path set above",
};

/** The one line the operator reads: what was found and how, or what is missing
 *  and the command that fixes it. No folder: the server log has those. */
export function ffmpegStatusLine(status: FfmpegStatus): string {
  return status.ok ? `ffmpeg ${status.version}, ${SOURCE_TEXT[status.source]}` : `${status.reason}. Install it with: ${status.hint}`;
}

export function VideoRelayFfmpegPanel() {
  const [stored, setStored] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<FfmpegStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Bumped by Retry; the read below runs again for each value.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    invoke<{ path: string; status: FfmpegStatus }>("video:ffmpeg")
      .then((r) => {
        if (!live) return;
        setLoadError(null);
        setStored(r.path);
        setPath(r.path);
        setStatus(r.status);
      })
      .catch((err: unknown) => {
        if (live) setLoadError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await invoke<{ status: FfmpegStatus }>("video:setFfmpegPath", { path });
      setStatus(r.status);
      setStored(path.trim());
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function retry() {
    setLoadError(null);
    setAttempt((n) => n + 1);
  }

  // Disabled only while the first read is in flight; a failed read leaves the
  // path editable, since saving does not need what the read would have said.
  const loading = stored === null && loadError === null;

  return (
    <Field orientation="vertical">
      <FieldContent>
        <FieldLabel>ffmpeg</FieldLabel>
        <FieldDescription>
          The Video relay&apos;s audio conversion needs the system&apos;s ffmpeg. It is found automatically; set a path
          only if it is installed somewhere unusual.
        </FieldDescription>
        <FieldDescription role="status" className="mt-1 break-words">{status ? ffmpegStatusLine(status) : loading ? "Checking…" : ""}</FieldDescription>
      </FieldContent>
      <Input
        value={path}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setPath(e.target.value)}
        placeholder="Find it automatically"
        className="w-full font-mono text-gray-12"
        aria-label="ffmpeg path"
        disabled={saving || loading}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="accent" size="small" onClick={() => void save()} disabled={saving || loading}>
          {saving ? "Checking…" : "Save and check again"}
        </Button>
        {loadError && (
          <>
            <ErrorNote>{loadError}</ErrorNote>
            <Button type="button" size="small" onClick={retry}>
              Retry
            </Button>
          </>
        )}
        {saveError && <ErrorNote>{saveError}</ErrorNote>}
      </div>
    </Field>
  );
}
