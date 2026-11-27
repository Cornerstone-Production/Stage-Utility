// Pieces of the Themes block the panel and Manage share: a theme's facts, and
// the inline confirm for deleting one.

import { TrashIcon } from "lucide-react";
import { useState } from "react";

import type { ThemeDTO } from "@main/types/photo-themes";

import { invoke as ipc } from "../../../lib/api";
import { Button } from "../../../components/ui";
import { Num, useEscapeFirst } from "./photo-bits";
import { keptDay, usedBy } from "./photo-format";
import type { PhotoThemes } from "./use-photo-themes";

export const themeLabel = (t: ThemeDTO) => t.name.trim() || "Untitled theme";

export function ThemeFacts({ theme, timeZone, showPeople }: { theme: ThemeDTO; timeZone: string; showPeople?: boolean }) {
  const used = usedBy(theme, timeZone);
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-caption1 text-fg-muted">
      {showPeople && (
        <li>
          <Num>{theme.people.length}</Num> {theme.people.length === 1 ? "person" : "people"}
        </li>
      )}
      <li>
        Used by <b className="font-medium text-fg">{used.join(", ") || "no service yet"}</b>
      </li>
      <li>
        Kept until <b className="font-medium text-fg">{keptDay(theme.keptUntil)}</b>
      </li>
    </ul>
  );
}

/** "Delete theme…", and once pressed the confirm that names what it takes with it. */
export function DeleteTheme({ theme, photos, onDeleted }: { theme: ThemeDTO; photos: PhotoThemes; onDeleted?: () => void }) {
  const [asking, setAsking] = useState(false);
  if (asking) return <DeleteConfirm theme={theme} photos={photos} onDeleted={onDeleted} close={() => setAsking(false)} />;
  return (
    <div>
      <Button variant="transparent" size="small" className="text-danger-11" onClick={() => setAsking(true)}>
        <TrashIcon className="size-3.5" />
        Delete theme…
      </Button>
    </div>
  );
}

function DeleteConfirm({ theme, photos, onDeleted, close }: { theme: ThemeDTO; photos: PhotoThemes; onDeleted?: () => void; close: () => void }) {
  const [error, setError] = useState<string | null>(null);
  useEscapeFirst(close);
  const used = usedBy(theme, photos.timeZone);
  const photoCount = theme.people.filter((p) => p.approved || p.pending?.url).length;
  return (
    <div role="group" aria-label="Confirm delete theme" className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3 py-2.5 text-[12.5px] leading-[17px]">
      <span>
        Delete {themeLabel(theme)}? Its <Num>{photoCount}</Num> {photoCount === 1 ? "photo is" : "photos are"} removed, and{" "}
        {used.length > 0 ? `these services go back to the originals: ${used.join(", ")}.` : "no service uses it."}
      </span>
      {error && (
        <span role="alert" className="text-danger-11">
          {error}
        </span>
      )}
      <span className="flex flex-wrap gap-1.5">
        <Button
          variant="filled"
          size="small"
          className="text-danger-11"
          disabled={photos.isBusy(`delete:${theme.id}`)}
          onClick={async () => {
            const r = await photos.write(`delete:${theme.id}`, () => ipc("photoThemes:deleteTheme", { id: theme.id }), { quiet: true });
            if (r.ok) onDeleted?.();
            else setError(r.message);
          }}
        >
          Delete theme
        </Button>
        <Button variant="filled" size="small" onClick={close}>
          Cancel
        </Button>
      </span>
    </div>
  );
}
