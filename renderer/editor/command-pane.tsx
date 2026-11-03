// command-pane.tsx — the A command choice of a Button: an existing command from the
// manifest, a way to make a manual one, and where the chosen one is used.

import { useCueUsage, usesOf } from "../settings/sections/cue-usage";
import type { CuesLive } from "../main/use-cue-live";
import { CuePicker } from "./cue-picker";
import type { PressOwner } from "./owned-press";

/** Where "+ New manual command…" goes: the Automation page, which opens its creation
 *  flow for `new=manual`. */
export const NEW_MANUAL_COMMAND_HREF = "/automation?new=manual";

export function CommandPane({
  cues,
  value,
  hide,
  where,
  owner,
  onChange,
}: {
  cues: CuesLive | null;
  value: string;
  hide: ReadonlySet<string>;
  where: string;
  owner: PressOwner;
  onChange: (cue: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <CuePicker cues={cues} value={value} hide={hide} onChange={onChange} />
      <a
        href={NEW_MANUAL_COMMAND_HREF}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start rounded text-footnote text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        + New manual command…
      </a>
      {value && <UsedOn cue={value} where={where} owner={owner} />}
    </div>
  );
}

/** The chips of every screen a command is used on. */
function UsedOn({ cue, where, owner }: { cue: string; where: string; owner: PressOwner }) {
  const { usage, error } = useCueUsage();
  if (error) return <p className="text-caption2 text-fg-subtle">Could not read where it is used.</p>;
  if (!usage) return null;
  const uses = usesOf(usage, [cue]);
  // A Button that is not saved yet is not in the views: it is on this screen all the same.
  const places = new Map<string, string>(uses.map((u) => [u.viewId, u.home ? "Home" : u.viewName]));
  if (!places.has(owner.viewId)) places.set(owner.viewId, where);
  return (
    <p className="flex flex-wrap items-center gap-1 text-caption1 text-fg-muted">
      <span>Used on</span>
      {[...places].map(([id, name]) => (
        <span key={id} className="rounded bg-fill px-1.5 text-caption2 text-fg">
          {name}
        </span>
      ))}
    </p>
  );
}
