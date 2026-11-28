// The actions a person card offers beyond Redo / Approve / Keep: Move, Copy and
// Remove, each behind an inline confirm. Shared by the panel's grid and Manage,
// so the two cannot word a confirm differently.
//
// One confirm is open at a time. A refusal is drawn inside the confirm and the
// confirm stays, so nothing looks done that was not; the themes are read again
// either way (use-photo-themes `write`).

import { useState, type ReactNode } from "react";

import type { ThemeDTO, ThemePersonDTO } from "@main/types/photo-themes";

import { invoke as ipc } from "../../../lib/api";
import { OpBox, type MenuKind, type PersonOp } from "./person-card";
import type { PhotoThemes } from "./use-photo-themes";

interface OpenOp extends PersonOp {
  themeId: string;
}

export function useCardOps(photos: PhotoThemes, themes: readonly ThemeDTO[]) {
  const [op, setOp] = useState<OpenOp | null>(null);

  function open(theme: ThemeDTO, personId: string, kind: MenuKind) {
    const others = themes.filter((t) => t.id !== theme.id);
    setOp({ kind, themeId: theme.id, personId, target: others[0]?.id ?? null, error: null });
  }

  async function go() {
    if (!op) return;
    const { themeId, personId, kind, target } = op;
    const key = `${kind}:${themeId}:${personId}`;
    const result =
      kind === "remove"
        ? await photos.write(key, () => ipc("photoThemes:remove", { id: themeId, personId }), { quiet: true })
        : kind === "move"
          ? await photos.write(key, () => ipc("photoThemes:move", { id: themeId, personId, to: target }), { quiet: true })
          : await photos.write(key, () => ipc("photoThemes:copy", { id: themeId, personId, to: target }), { quiet: true });
    // Closed on success; on a refusal the confirm stays, saying why.
    setOp((cur) => (cur === null ? null : result.ok ? null : { ...cur, error: result.message }));
  }

  /** The confirm for this card, or nothing when another card's (or none) is open. */
  function confirmFor(theme: ThemeDTO, person: ThemePersonDTO): ReactNode {
    if (!op || op.themeId !== theme.id || op.personId !== person.personId) return null;
    return (
      <OpBox
        op={op}
        person={person}
        theme={theme}
        others={themes.filter((t) => t.id !== theme.id)}
        busy={photos.isBusy(`${op.kind}:${op.themeId}:${op.personId}`)}
        onTarget={(target) => setOp({ ...op, target, error: null })}
        onGo={() => void go()}
        onCancel={() => setOp(null)}
      />
    );
  }

  return { open, cancel: () => setOp(null), confirmFor, hasOtherTheme: (theme: ThemeDTO) => themes.some((t) => t.id !== theme.id) };
}
