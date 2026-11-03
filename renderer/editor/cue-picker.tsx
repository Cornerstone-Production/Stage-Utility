// cue-picker.tsx — the Command select on a cue-button object.
//
// TWO GROUPS, the operator's own first. "Your commands" are the ones somebody here
// wrote, so they are what a button is most likely bound to and are offered
// before the cues the app ships (OBS, REAPER, ProVideoPlayer and the app itself;
// see main/services/builtin-cues.ts), which need no automation rule behind them.
// Each entry reads the same either way: the name, the room, and whether it is a
// switch or a button.
//
// Its own component rather than an expression inside the inspector so it can be
// RENDERED in a test — the inspector reads the manifest through a hook that
// fetches, and a picker that silently listed nothing would otherwise be a bug
// nothing could catch without a server.

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui";
import type { CuesLive } from "../main/use-cue-live";

/** One row of the list: what to show, and whether it is a switch or a button. */
interface Entry {
  id: string;
  name: string;
  room: string;
  kind: "switch" | "button";
  builtin?: true;
}

/** The manifest flattened to rows, switches before buttons within each group. */
export function cuePickerEntries(cues: CuesLive | null): Entry[] {
  return [
    ...(cues?.manifest.switches ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      room: s.room,
      kind: "switch" as const,
      ...(s.builtin ? { builtin: true as const } : {}),
    })),
    ...(cues?.manifest.buttons ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      room: b.room,
      kind: "button" as const,
      ...(b.builtin ? { builtin: true as const } : {}),
    })),
  ];
}

export function CuePicker({
  cues,
  value,
  hide,
  onChange,
}: {
  cues: CuesLive | null;
  value: string;
  /** Names this list does not offer: another Button's own command. The one chosen stays listed. */
  hide?: ReadonlySet<string>;
  onChange: (cue: string) => void;
}) {
  const entries = cuePickerEntries(cues).filter((e) => e.id === value || !hide?.has(e.id.toLowerCase()));
  const builtIn = entries.filter((e) => e.builtin);
  const mine = entries.filter((e) => !e.builtin);
  const label = (e: Entry) => `${e.name}${e.room ? ` · ${e.room}` : ""} (${e.kind})`;
  // Two commands can read the same: the name is the operator's own words, and two
  // buttons given one label make two. The command's name is what tells them apart,
  // so it is shown beside any entry whose reading another entry shares.
  const reads = new Map<string, number>();
  for (const e of entries) reads.set(label(e), (reads.get(label(e)) ?? 0) + 1);
  const item = (e: Entry) => (
    <SelectItem key={e.id} value={e.id}>
      {label(e)}
      {(reads.get(label(e)) ?? 0) > 1 ? ` · ${e.id}` : ""}
    </SelectItem>
  );
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="Command" className="w-full">
        <SelectValue placeholder={cues ? "Select a command" : "Loading commands…"} />
      </SelectTrigger>
      <SelectContent>
        {mine.length > 0 && (
          <SelectGroup>
            <SelectLabel>Your commands</SelectLabel>
            {mine.map(item)}
          </SelectGroup>
        )}
        {builtIn.length > 0 && (
          <SelectGroup>
            <SelectLabel>Built in</SelectLabel>
            {builtIn.map(item)}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}
