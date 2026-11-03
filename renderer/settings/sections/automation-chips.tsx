// automation-chips.tsx — the small marks on a command's row: where it is shown
// (Home Assistant), whether it has a spoken name (Voice), and the screens its
// Buttons sit on (Used on).

import { screenNames, type CueUse } from "./cue-usage";

const CHIP =
  "inline-flex shrink-0 items-center rounded-[4px] border px-1.5 text-caption2 leading-4 whitespace-nowrap";

/** The command has a Home Assistant entity (it is not hidden from Home). */
export function HomeAssistantChip() {
  return (
    <span data-command-badge="home-assistant" className={`${CHIP} border-accent text-accent-text`}>
      Home Assistant
    </span>
  );
}

/** The command has a spoken name, so voice can call it. */
export function VoiceChip() {
  return (
    <span data-command-badge="voice" className={`${CHIP} border-line-strong text-fg-muted`}>
      Voice
    </span>
  );
}

/**
 * The screens a command's Buttons are on, one chip per screen.
 *
 * `uses` is null while the usage has not been read: no row says "nothing yet"
 * about a command whose usage is simply not in yet, which would be a claim.
 */
export function UsedOn({ uses }: { uses: readonly CueUse[] | null }) {
  if (uses === null) return null;
  const screens = screenNames(uses);
  return (
    <div data-used-on={screens.length} className="mt-0.5 flex flex-wrap items-center gap-1 text-caption1 text-fg-muted">
      <span>Used on</span>
      {screens.length === 0 ? (
        <span className="text-fg-subtle">nothing yet</span>
      ) : (
        screens.map((name) => (
          <span key={name} data-used-on-chip={name} className={`${CHIP} border-transparent bg-fill text-fg`}>
            {name}
          </span>
        ))
      )}
    </div>
  );
}
