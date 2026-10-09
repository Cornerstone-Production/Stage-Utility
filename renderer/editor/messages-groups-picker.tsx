// messages-groups-picker.tsx — which groups a Messages widget answers for.
//
// "Follow screen" is the default and the right answer on a wall or a panel:
// the widget takes the groups of whichever screen draws it, so one layout shown
// in two rooms follows each. "Own groups" is the escape hatch, and the only
// way for a widget on an in-app console to have any — a console is not a screen.
//
// Its own component so it can be rendered in a test and so the group list is
// read (and subscribed to) only while a Messages widget is selected.

import { plural } from "@main/services/plural";
import { Checkbox } from "../components/ui/checkbox";
import { useMessageGroups } from "../main/use-message-groups";
import { RowToggle } from "./inspector-rows";

export function MessagesGroupsPicker({
  groups,
  onChange,
}: {
  /** The widget's own list; null or absent follows the screen. */
  groups: string[] | null | undefined;
  onChange: (next: string[] | null) => void;
}) {
  const all = useMessageGroups();
  const own = groups ?? null;

  // Saved ids this install has no group for: a widget imported from another
  // install, or a group deleted since. Only once the groups have been read, or every
  // id would look unknown. They are kept in the value (an operator's data is not
  // tidied away) and named in a note, like the rule editor's "no longer offered".
  const known = new Set(all.groups.map((g) => g.id));
  const unknown = all.known && !all.failed ? (own ?? []).filter((id) => !known.has(id)) : [];

  function toggle(id: string, on: boolean) {
    const mine = new Set(own ?? []);
    if (on) mine.add(id);
    else mine.delete(id);
    // The config's order, so the stored list does not depend on click order; the
    // ids with no group here stay after them.
    onChange([...all.groups.filter((g) => mine.has(g.id)).map((g) => g.id), ...unknown]);
  }

  return (
    <>
      <RowToggle
        label="Groups"
        hint="Which messages this shows, and which it can answer. Following the screen takes the groups the screen is in (set on the Screens page); a console in the app is not a screen, so give it groups here."
        value={own === null ? "follow" : "chosen"}
        options={[
          { value: "follow", label: "Follow screen" },
          { value: "chosen", label: "Own groups" },
        ]}
        onChange={(v) => onChange(v === "follow" ? null : [])}
      />
      {own !== null && (
        all.groups.length === 0 ? (
          <p className="text-caption2 text-fg-muted leading-snug">
            {all.failed
              ? "Could not read the groups."
              : all.known
                ? "No groups yet. Add some in Settings, Messages. Everyone's messages always show."
                : "Reading the groups..."}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5" role="group" aria-label="Groups this widget answers for">
            {all.groups.map((g) => (
              <label key={g.id} className="flex cursor-pointer items-center gap-2 text-caption2 text-fg">
                <Checkbox
                  checked={own.includes(g.id)}
                  onCheckedChange={(v) => toggle(g.id, v === true)}
                  className="size-3.5"
                />
                {g.name}
              </label>
            ))}
            <p className="text-caption2 text-fg-muted leading-snug">Everyone's messages always show.</p>
          </div>
        )
      )}
      {own !== null && unknown.length > 0 && (
        <p className="text-caption2 text-warn-11 leading-snug">
          {plural(unknown.length, "saved group no longer exists", "saved groups no longer exist")} on this install and
          {unknown.length === 1 ? " matches" : " match"} nothing. {unknown.length === 1 ? "It is" : "They are"} kept in
          case the group comes back.
        </p>
      )}
    </>
  );
}
