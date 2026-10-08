// messages-groups-picker.tsx — which groups a Messages widget answers for.
//
// "Follow this screen" is the default and the right answer on a wall or a panel:
// the widget takes the groups of whichever screen draws it, so one layout shown
// in two rooms follows each. "Chosen groups" is the escape hatch, and the only
// way for a widget on an in-app console to have any — a console is not a screen.
//
// Its own component so it can be rendered in a test and so the group list is
// read (and subscribed to) only while a Messages widget is selected.

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

  function toggle(id: string, on: boolean) {
    const mine = new Set(own ?? []);
    if (on) mine.add(id);
    else mine.delete(id);
    // The config's order, so the stored list does not depend on click order.
    onChange(all.groups.filter((g) => mine.has(g.id)).map((g) => g.id));
  }

  return (
    <>
      <RowToggle
        label="Groups"
        hint="Which messages this shows, and which it can answer. Following the screen takes the groups the screen is in (set on the Screens page); a console in the app is not a screen, so give it groups here."
        value={own === null ? "follow" : "chosen"}
        options={[
          { value: "follow", label: "Follow this screen" },
          { value: "chosen", label: "Chosen groups" },
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
    </>
  );
}
