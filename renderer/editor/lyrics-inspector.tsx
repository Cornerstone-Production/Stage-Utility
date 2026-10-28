// The Lyrics inspector: four groups — Layout, Group tag, Lyrics, Underneath — in the
// shared rows every other widget's inspector uses, in the mockup's order and words.
//
// A control that would change nothing in the current layout is not drawn: Width
// only means something Beside, Align anywhere but Beside (which is always left),
// and everything under Underneath only while "Show what comes next" is on.

import type { LayoutObjectConfig } from "@main/types/views";
import { LYRICS_OPTIONS, lyricsSettings, type LyricsChoice, type LyricsConfig, type LyricsSettings } from "../main/lyrics-config";
import { RowSwitch, RowToggle, Section } from "./inspector-rows";

export function LyricsInspector({ c, onConfig }: { c: LyricsConfig; onConfig: (c: LayoutObjectConfig) => void }) {
  const s = lyricsSettings(c);
  const set = (patch: Partial<LyricsConfig>) => onConfig({ ...c, ...patch });
  const beside = s.display === "beside";

  /** A choice over one setting; `label` is the words beside it, which need not be
   *  the setting's name (the Layout group's "Group tag" edits `display`). */
  const choice = <K extends LyricsChoice>(key: K, label: string) => (
    <RowToggle<LyricsSettings[K]>
      label={label}
      value={s[key]}
      options={LYRICS_OPTIONS[key]}
      onChange={(v) => onConfig({ ...c, [key]: v })}
    />
  );

  return (
    <div className="flex flex-col gap-2.5">
      <Section label="Layout" />
      {choice("display", "Group tag")}

      <div className="flex flex-col gap-2.5 border-t border-line pt-3">
        <Section label="Group tag" />
        {choice("tagStyle", "Style")}
        {choice("tagColor", "Color")}
        {choice("tagText", "Text")}
        {beside && choice("tagWidth", "Width (beside)")}
      </div>

      <div className="flex flex-col gap-2.5 border-t border-line pt-3">
        <Section label="Lyrics" />
        {choice("size", "Size")}
        {choice("weight", "Weight")}
        {!beside && choice("align", "Align")}
        {choice("noWords", "No words")}
      </div>

      <div className="flex flex-col gap-2.5 border-t border-line pt-3">
        <Section label="Underneath" />
        <RowSwitch label="Show what comes next" checked={s.under} onChange={(v) => set({ under: v })} />
        {s.under && (
          <>
            {choice("underShows", "Shows")}
            <RowSwitch label="Its lyrics" checked={s.underWords} onChange={(v) => set({ underWords: v })} />
            {choice("underDim", "Dimmed")}
          </>
        )}
        <RowSwitch label="Song title" checked={s.showTitle} onChange={(v) => set({ showTitle: v })} />
      </div>
    </div>
  );
}
