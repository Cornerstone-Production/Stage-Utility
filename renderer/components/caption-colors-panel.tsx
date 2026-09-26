import { useState } from "react";
import { invoke } from "../lib/api";
import { useStageState } from "../main/use-stage-state";
import { useTranscript } from "../main/use-transcript";
import { useProdcomChannels } from "../main/use-prodcom-channels";
import { resolveChannelColor, mergeChannels } from "../main/channel-color";
import { Button, InfoHint, toast } from "./ui";
import { ColorField } from "./ui/color-field";
import { Switch } from "./ui/switch";
import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { cn } from "../lib/cn";

// Collapsible "Transcription colors" disclosure shown under the ProdCom integration.
// Lists every channel ProdCom has, whether or not it has spoken, and lets the
// operator pick a color per channel or follow ProdCom's own. A custom pick always
// wins; failing that, ProdCom's own color is used only while "Follow ProdCom's
// channel colors" is on (off by default — ProdCom repeats colors across channels).
export function CaptionColorsPanel() {
  const [open, setOpen] = useState(false);
  const { state } = useStageState();
  const lines = useTranscript();
  const channels = useProdcomChannels();
  const saved = state?.captionChannelColors ?? {};
  const following = state?.followProdcomColors ?? false;

  const rows = mergeChannels(channels, lines, saved);

  async function save(channel: string, color: string | null) {
    try {
      await invoke("captions:setChannelColor", { channel, color });
    } catch (err) {
      toast.error(`Failed to save color: ${String(err)}`);
    }
  }

  async function setFollowing(on: boolean) {
    try {
      await invoke("captions:setFollowProdcomColors", { on });
    } catch (err) {
      toast.error(`Failed to save setting: ${String(err)}`);
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
          Override the color for each transcription channel (speaker/mic). A custom pick always wins;
          otherwise a channel uses either a distinct auto color or ProdCom's own, per the switch below.
        </InfoHint>
      </div>

      {open && (
        <div className="mt-1.5 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Switch checked={following} onCheckedChange={(v: boolean) => void setFollowing(v)} />
            <span className="text-caption1 text-gray-12">Follow ProdCom's channel colors</span>
            <InfoHint>
              When on, a channel with no custom pick above uses the color ProdCom assigns it, instead
              of a distinct auto color. ProdCom often repeats one color across several channels, which
              is why the distinct auto color is the default.
            </InfoHint>
          </div>

          {rows.length === 0 ? (
            <p className="text-caption1 text-gray-9">
              No channels yet — this fills in once ProdCom's channel list loads.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {rows.map((row) => {
                const custom = saved[row.label];
                const value = resolveChannelColor({
                  channel: row.channelId,
                  label: row.label,
                  prodcomColor: row.prodcomColor,
                  followProdcom: following,
                  customColors: saved,
                });
                return (
                  <div key={row.label} className="flex items-center gap-2">
                    <ColorField
                      label={`Color for ${row.label}`}
                      allowAlpha={false}
                      value={value}
                      onChange={(v: string) => save(row.label, v)}
                      className="shrink-0"
                    />
                    <span className="text-caption1 text-gray-12 flex-1 min-w-0 truncate">{row.label}</span>
                    {custom ? (
                      <Button
                        variant="transparent"
                        size="small"
                        iconOnly
                        onClick={() => save(row.label, null)}
                        aria-label={`Reset ${row.label} to automatic color`}
                        tooltip="Reset to automatic"
                      >
                        <RotateCcwIcon className="size-3.5 text-gray-9" />
                      </Button>
                    ) : (
                      <span className="text-caption2 text-gray-9 pr-1">auto</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
