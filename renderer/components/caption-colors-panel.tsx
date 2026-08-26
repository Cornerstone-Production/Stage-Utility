import { useState } from "react";
import { invoke } from "../lib/api";
import { useStageState } from "../main/use-stage-state";
import { useTranscript } from "../main/use-transcript";
import { channelColor } from "../main/channel-color";
import { Button, InfoHint, toast } from "./ui";
import { ColorField } from "./ui/color-field";
import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { cn } from "../lib/cn";

// Collapsible "Transcription colors" disclosure shown under the ProdCom integration.
// Lists every channel seen in the transcript (plus any already assigned) and lets
// the user pick a color per channel. ProdCom doesn't send colors, so this is the
// way to control them; a pick overrides the otherwise-automatic per-channel color.
export function CaptionColorsPanel() {
  const [open, setOpen] = useState(false);
  const { state } = useStageState();
  const lines = useTranscript();
  const saved = state?.captionChannelColors ?? {};

  // Channel label → a channel id for the deterministic fallback color. Labels come
  // from the live transcript, unioned with any already-assigned (so they persist
  // even when that channel isn't currently talking).
  const seen = new Map<string, string | null>();
  for (const l of lines) {
    const label = l.channelName ?? l.channel;
    if (label) seen.set(label, l.channel);
  }
  for (const k of Object.keys(saved)) if (!seen.has(k)) seen.set(k, null);
  const labels = [...seen.keys()].sort((a, b) => a.localeCompare(b));

  async function save(channel: string, color: string | null) {
    try {
      await invoke("captions:setChannelColor", { channel, color });
    } catch (err) {
      toast.error(`Failed to save color: ${String(err)}`);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 self-start">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 py-1 text-caption1 font-medium text-gray-11 hover:text-gray-12 transition-colors"
          aria-expanded={open}
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          Transcription colors
        </button>
        <InfoHint>
          Override the auto-assigned color for each transcription channel (speaker/mic). ProdCom doesn't
          send colors, so this is where you set them; leave a channel on "auto" to keep its default.
        </InfoHint>
      </div>

      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {labels.length === 0 ? (
            <p className="text-caption1 text-gray-9">
              No channels seen yet — colors appear here as ProdCom sends transcript lines.
            </p>
          ) : (
            labels.map((label) => {
              const channel = seen.get(label) ?? label;
              const custom = saved[label];
              const value = custom ?? channelColor(channel);
              return (
                <div key={label} className="flex items-center gap-2">
                  <ColorField
                    label={`Color for ${label}`}
                    allowAlpha={false}
                    value={value}
                    onChange={(v: string) => save(label, v)}
                    className="shrink-0"
                  />
                  <span className="text-caption1 text-gray-12 flex-1 min-w-0 truncate">{label}</span>
                  {custom ? (
                    <Button
                      variant="transparent"
                      size="small"
                      iconOnly
                      onClick={() => save(label, null)}
                      aria-label={`Reset ${label} to automatic color`}
                      tooltip="Reset to automatic"
                    >
                      <RotateCcwIcon className="size-3.5 text-gray-9" />
                    </Button>
                  ) : (
                    <span className="text-caption2 text-gray-9 pr-1">auto</span>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
