// The Lyrics inspector, drawn as the approved mockup draws it: four groups —
// Layout, Group tag, Lyrics, Underneath — each a stacked label over a segmented
// choice or a switch, in the mockup's order and words.
//
// A control that would change nothing in the current layout is greyed rather than
// hidden, so the group keeps its shape: Width only means something Beside, Align
// anywhere but Beside (which is always left), and everything under Underneath only while
// "Show what comes next" is on.

import type { LayoutObjectConfig } from "@main/types/views";
import { StackedField } from "../components/ui";
import { LYRICS_OPTIONS, lyricsSettings, type LyricsChoice, type LyricsConfig, type LyricsSettings } from "../main/lyrics-config";
import { Section, Segmented, StackedSwitch } from "./inspector-rows";

export function LyricsInspector({ c, onConfig }: { c: LyricsConfig; onConfig: (c: LayoutObjectConfig) => void }) {
  const s = lyricsSettings(c);
  const set = (patch: Partial<LyricsConfig>) => onConfig({ ...c, ...patch });
  const beside = s.display === "beside";

  /** A segmented control over one setting; `label` is the words beside it, which
   *  need not be the setting's name (the Layout group's "Group tag" edits `display`). */
  const seg = <K extends LyricsChoice>(key: K, label: string, opts: { disabled?: boolean } = {}) => (
    <StackedField label={label}>
      <Segmented<LyricsSettings[K]>
        label={label}
        value={s[key]}
        options={LYRICS_OPTIONS[key]}
        disabled={opts.disabled}
        onChange={(v) => onConfig({ ...c, [key]: v })}
      />
    </StackedField>
  );

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-3">
        <Section label="Layout" />
        {seg("display", "Group tag")}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <Section label="Group tag" />
        {seg("tagStyle", "Style")}
        {seg("tagColor", "Colour")}
        {seg("tagText", "Text")}
        {seg("tagWidth", "Width (beside)", { disabled: !beside })}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <Section label="Lyrics" />
        {seg("size", "Size")}
        {seg("weight", "Weight")}
        {seg("align", "Align", { disabled: beside })}
        {seg("noWords", "No words")}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <Section label="Underneath" />
        <StackedSwitch label="Show what comes next" checked={s.under} onChange={(v) => set({ under: v })} />
        {seg("underShows", "Shows", { disabled: !s.under })}
        <StackedSwitch label="Its lyrics" checked={s.underWords} disabled={!s.under} onChange={(v) => set({ underWords: v })} />
        {seg("underDim", "Dimmed", { disabled: !s.under })}
        <StackedSwitch label="Song title" checked={s.showTitle} onChange={(v) => set({ showTitle: v })} />
      </div>
    </div>
  );
}
