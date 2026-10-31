// cue-rename-notice.tsx — what the rule editor says about the Buttons that name
// a command, before a rename or a conversion changes what they point at, and
// after a rename that some screen would not follow.

import type { RepointResult } from "../../lib/console-cue-buttons";
import type { CueUse } from "./cue-usage";

const BOX = "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-footnote text-fg";

/** One Button, as a list item reads it: its screen, then its label when it has one. */
function placeName(use: CueUse): string {
  return use.label ? `${use.viewName} · ${use.label}` : use.viewName;
}

/**
 * Before Save: the places that will follow a rename, or that Making it automatic
 * will leave reading Not set. Nothing when no Button names the command.
 *
 * A rename lists the Buttons because Save points each at the new name; Make it
 * automatic lists them as a warning, because it points nothing anywhere: the
 * command is gone, and the Button reads Not set until somebody picks another.
 */
export function CueRenameNotice({
  kind,
  places,
  homeAssistant,
}: {
  kind: "rename" | "automatic";
  places: readonly CueUse[];
  /** Home Assistant has an entity for the command now. */
  homeAssistant: boolean;
}) {
  if (places.length === 0) return null;
  return (
    <div role="status" data-cue-notice={kind} className={`${BOX} border-amber-7`}>
      <b className="font-semibold">
        {kind === "rename" ? "Renaming changes what these point at:" : "Making it automatic changes what these point at:"}
      </b>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
        {places.map((u) => (
          <li key={`${u.viewId}:${u.objectId}`}>
            {placeName(u)}{" "}
            {kind === "rename" ? "follows the new name" : <>reads <b className="font-semibold">Not set</b></>}
          </li>
        ))}
        {homeAssistant && (
          <li>
            {kind === "rename"
              ? "Home Assistant's entity is made from the name, so it changes too"
              : "Home Assistant loses the entity and any automation that uses it"}
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * After Save: the screens that did not follow the new name, each with the reason.
 * The command IS renamed. Nothing when every screen followed.
 */
export function RepointRefusals({ to, results }: { to: string; results: readonly RepointResult[] }) {
  const refused = results.filter((r) => !r.ok);
  if (refused.length === 0) return null;
  return (
    <div role="alert" data-repoint-refused={refused.length} className={`${BOX} border-danger-9/40`}>
      <b className="font-semibold">
        {refused.length === 1 ? "One screen did not follow the new name:" : `${refused.length} screens did not follow the new name:`}
      </b>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
        {refused.map((r) => (
          <li key={r.viewId} data-repoint-refused-view={r.viewId}>
            {r.name}: {r.error ?? "refused"}
          </li>
        ))}
      </ul>
      <span className="text-caption1 text-fg-muted">
        The command is renamed to <span className="font-mono">{to}</span>. Point those Buttons at it in the layout editor.
      </span>
    </div>
  );
}
