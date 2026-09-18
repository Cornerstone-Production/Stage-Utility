// cue-picker.tsx — the Cue select on a cue-button object.
//
// TWO GROUPS, built in first. The cues the app ships (OBS, REAPER,
// ProVideoPlayer and the app itself; see main/services/builtin-cues.ts) need no
// automation rule behind them and are what most buttons are bound to, so they
// are offered before the operator's own. Each entry reads the same either way:
// the name, the room, and whether it is a switch or a button.
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
  onChange,
}: {
  cues: CuesLive | null;
  value: string;
  onChange: (cue: string) => void;
}) {
  const entries = cuePickerEntries(cues);
  const builtIn = entries.filter((e) => e.builtin);
  const mine = entries.filter((e) => !e.builtin);
  const item = (e: Entry) => (
    <SelectItem key={e.id} value={e.id}>
      {e.name}
      {e.room ? ` · ${e.room}` : ""} ({e.kind})
    </SelectItem>
  );
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder={cues ? "Select a cue" : "Loading cues…"} />
      </SelectTrigger>
      <SelectContent>
        {builtIn.length > 0 && (
          <SelectGroup>
            <SelectLabel>Built in</SelectLabel>
            {builtIn.map(item)}
          </SelectGroup>
        )}
        {mine.length > 0 && (
          <SelectGroup>
            <SelectLabel>Your cues</SelectLabel>
            {mine.map(item)}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}
