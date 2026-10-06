// The ServiceCue text size a screen is showing, and how it is changed.
//
// Start order: a valid `?text=` in the address, then what this screen remembered,
// then 100. A `?text=` is also remembered, so it is how a display with no
// keyboard is set: open its link once with the size on the end and it keeps it.
// `key` is per screen (see servicecue-text-size.ts), and null means "this caller
// has no user text size" — a rundown embedded in a layout object — which gets
// 100 and ignores the address, so a `?text=` on a display cannot resize an
// object inside its layout.

import { useCallback, useEffect, useState } from "react";

import {
  clampTextSize,
  DEFAULT_TEXT_SIZE,
  readStoredSize,
  textSizeFromSearch,
  writeStoredSize,
} from "./servicecue-text-size";

export function useTextSize(key: string | null): [number, (size: number) => void] {
  const [size, setSizeState] = useState(() =>
    key ? (textSizeFromSearch(window.location.search) ?? readStoredSize(key) ?? DEFAULT_TEXT_SIZE) : DEFAULT_TEXT_SIZE,
  );

  // Remember a size that arrived in the address. Done in an effect, not in the
  // initialiser above: a render must not write.
  useEffect(() => {
    if (!key) return;
    const fromAddress = textSizeFromSearch(window.location.search);
    // A refusal from storage means the size lasts until a reload, not longer.
    // The size on screen is right either way, so there is nothing to undo.
    if (fromAddress != null) writeStoredSize(key, fromAddress);
  }, [key]);

  const setSize = useCallback(
    (next: number) => {
      const v = clampTextSize(next);
      setSizeState(v);
      if (key) writeStoredSize(key, v);
    },
    [key],
  );

  return [size, setSize];
}
