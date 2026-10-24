// The Lyrics inspector, drawn as the approved mockup draws it: five groups —
// Layout, Group tag, Lyrics, Underneath — each a stacked label over a segmented
// choice or a switch, in the mockup's order and words.
//
// A control that would change nothing in the current layout is greyed rather than
// hidden, so the group keeps its shape: Width only means something Beside, Align
// only Above and in the Arrangement, and everything under Underneath only while
// "Show what comes next" is on.

import type { LayoutObjectConfig } from "@main/types/views";
import { StackedField } from "../components/ui";
import { LYRICS_OPTIONS, lyricsSettings, type LyricsConfig } from "../main/lyrics-config";
import { Segmented, StackedSwitch } from "./inspector-rows";

function Heading({ children }: { children: string }) {
  return <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">{children}</span>;
}

export function LyricsInspector({ c, onConfig }: { c: LyricsConfig; onConfig: (c: LayoutObjectConfig) => void }) {
  const s = lyricsSettings(c);
  const set = (patch: Partial<LyricsConfig>) => onConfig({ ...c, ...patch });
  const beside = s.display === "beside";

  /** A segmented control over one setting, its options and its current value. */
  const seg = <K extends keyof typeof LYRICS_OPTIONS>(key: K, label: string, opts: { disabled?: boolean } = {}) => (
    <StackedField label={label}>
      <Segmented
        label={label}
        value={s[key] as string}
        options={LYRICS_OPTIONS[key] as unknown as { value: string; label: string }[]}
        disabled={opts.disabled}
        onChange={(v) => set({ [key]: v } as Partial<LyricsConfig>)}
      />
    </StackedField>
  );

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-3">
        <Heading>Layout</Heading>
        {seg("display", "Group tag")}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <Heading>Group tag</Heading>
        {seg("tagStyle", "Style")}
        {seg("tagColor", "Colour")}
        {seg("tagText", "Text")}
        {seg("tagWidth", "Width (beside)", { disabled: !beside })}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <Heading>Lyrics</Heading>
        {seg("size", "Size")}
        {seg("weight", "Weight")}
        {seg("align", "Align (above)", { disabled: beside })}
        {seg("noWords", "No words")}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <Heading>Underneath</Heading>
        <StackedSwitch label="Show what comes next" checked={s.under} onChange={(v) => set({ under: v })} />
        {seg("underShows", "Shows", { disabled: !s.under })}
        <StackedSwitch label="Its lyrics" checked={s.underWords} disabled={!s.under} onChange={(v) => set({ underWords: v })} />
        {seg("underDim", "Dimmed", { disabled: !s.under })}
        <StackedSwitch label="Song title" checked={s.showTitle} onChange={(v) => set({ showTitle: v })} />
      </div>
    </div>
  );
}
