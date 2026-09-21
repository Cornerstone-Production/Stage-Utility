// youtube-connect-row.tsx — the "oauth-device" ConfigField for YouTube.
//
// Renders one of four states off GET /api/integrations/youtube/connect and
// polls it every 2 seconds while pending — nothing else on the card needs to
// move, so the polling starts and stops with this one row rather than living
// higher up. react-query's own `refetchInterval` owns the polling (it already
// stops on unmount, the same reason the Automation page's cue-state poll uses
// it), so the row itself only decides WHETHER to keep polling: "pending",
// forever, and nothing else. The "Paste a token instead" disclosure keeps the
// old password field reachable underneath, unchanged, for the OAuth Playground
// path.

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { useServerNow } from "../lib/server-clock";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { Button, Input } from "./ui";

type ConnectStatus =
  | { status: "idle" }
  | { status: "pending"; userCode: string; verificationUrl: string; expiresAt: number }
  | { status: "connected"; channelTitle?: string | null }
  | { status: "error"; message: string };

const POLL_MS = 2000;
const QUERY_KEY = ["youtube-connect-status"];

interface YouTubeConnectRowProps {
  /** The saved client id/secret are blank, or the card has unsaved changes to
   *  them — either way there is nothing yet for Connect to use. */
  disabled: boolean;
  disabledHint: string;
  /** The raw `refreshToken` field, so the disclosure below can still edit a
   *  hand-pasted token without a schema change. */
  rawValue: unknown;
  onRawChange: (v: string) => void;
  /** How often to poll while pending. Overridable so a test can prove polling
   *  starts and stops without waiting out the real 2s cadence. */
  pollMs?: number;
}

function formatCountdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function YouTubeConnectRow({
  disabled,
  disabledHint,
  rawValue,
  onRawChange,
  pollMs = POLL_MS,
}: YouTubeConnectRowProps) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [showPaste, setShowPaste] = useState(false);

  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => invoke<ConnectStatus>("youtube:connectStatus"),
    // Only "pending" ever needs another look — idle, connected and error are
    // all terminal until an action (Connect, Cancel, Disconnect, Try again)
    // changes them, and those write the cache directly rather than waiting
    // for the next tick.
    refetchInterval: (query) => (query.state.data?.status === "pending" ? pollMs : false),
  });
  const state: ConnectStatus = data ?? { status: "idle" };

  // The countdown's own tick, independent of the status poll, and on the
  // SERVER's clock — `expiresAt` is the server's deadline, so a console an hour
  // out would count down to the wrong one. Reads the page's clock rather than
  // subscribing for itself: this row only ever renders inside the operator
  // shell, whose context bar feeds that clock on every page.
  const now = useServerNow(1000, state.status === "pending");

  async function run(channel: string): Promise<void> {
    setBusy(true);
    try {
      const next = await invoke<ConnectStatus>(channel);
      queryClient.setQueryData(QUERY_KEY, next);
    } catch (err) {
      queryClient.setQueryData(QUERY_KEY, { status: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-80 max-sm:w-full flex-col gap-2">
      {state.status === "idle" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="small"
            variant="accent"
            onClick={() => void run("youtube:connectStart")}
            disabled={disabled || busy}
          >
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            Connect YouTube
          </Button>
          <span className="text-caption1 text-fg-muted">{disabled ? disabledHint : "Not connected"}</span>
        </div>
      )}

      {state.status === "pending" && (
        <div className="flex flex-col gap-1">
          <div className="font-mono text-lg tracking-widest">{state.userCode}</div>
          <div className="text-caption1 text-fg-muted">Enter this code at google.com/device</div>
          <div className="text-caption1 text-fg-muted">Expires in {formatCountdown(state.expiresAt, now)}</div>
          <Button
            size="small"
            variant="transparent"
            className="self-start"
            onClick={() => void run("youtube:connectCancel")}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      )}

      {state.status === "connected" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body">
            Connected{state.channelTitle ? ` — ${state.channelTitle}` : ""}
          </span>
          <Button
            size="small"
            variant="transparent"
            onClick={() => void run("youtube:connectStart")}
            disabled={disabled || busy}
          >
            Reconnect
          </Button>
          <Button
            size="small"
            variant="transparent"
            onClick={() => void run("youtube:connectDisconnect")}
            disabled={busy}
          >
            Disconnect
          </Button>
        </div>
      )}

      {state.status === "error" && (
        <div className="flex flex-col gap-1">
          <span className="text-body text-red-10">{state.message}</span>
          <Button
            size="small"
            variant="accent"
            className="self-start"
            onClick={() => void run("youtube:connectStart")}
            disabled={disabled || busy}
          >
            Try again
          </Button>
        </div>
      )}

      <button
        type="button"
        className="self-start text-caption1 text-accent-11 underline underline-offset-2 hover:text-accent-12"
        onClick={() => setShowPaste((v) => !v)}
      >
        Paste a token instead
      </button>
      {showPaste && (
        <Input
          type="password"
          value={typeof rawValue === "string" ? rawValue : ""}
          onChange={(e) => onRawChange(e.target.value)}
          placeholder="Refresh Token"
          aria-label="Refresh Token"
          className="w-80 max-sm:w-full"
        />
      )}
    </div>
  );
}
