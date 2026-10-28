// Accepting a file dragged onto an element: the Branding page's cards, its logo
// stage and its dialogs.

import { useRef, useState, type DragEvent } from "react";

/** Is a file being dragged? Text or a link dragged over the page is not ours. */
function carriesFile(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Accept an image file dragged onto an element: the handlers to spread on it, and
 * whether a file is over it now, for the veil.
 *
 * Counted, not a boolean: dragenter and dragleave fire for every child the pointer
 * crosses, so a flag set on enter and cleared on leave flickers off over the first
 * child. Only the first file is taken; which file it is, and whether it is an image
 * at all, the caller decides, so the refusal is said in one place.
 */
export function useFileDrop(onFile: (file: File) => void) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFile(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFile(e)) return;
      // Without this the browser refuses the drop and opens the file in the tab.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFile(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFile(e)) return;
      e.preventDefault();
      // A drop inside an open dialog must not also land on the card under it.
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
  };
  return { over, handlers };
}
