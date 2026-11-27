import { useCallback, useEffect, useRef, useState } from "react";

import { copyText } from "./clipboard";

type CopyState = "idle" | "copied" | "failed";

/** How long a Copy button keeps saying what happened before it reads "Copy" again. */
const COPY_FEEDBACK_MS = 1_500;

/**
 * The feedback half of a Copy button: runs {@link copyText} (which already
 * handles plain HTTP) and reports `copied` or `failed`, then returns to `idle`
 * after `ms`. Another copy restarts the timer; leaving the component cancels
 * it. `copiedText` is what the last copy was for, so a status can name it. Pass `ms: null` for a status that stays until `reset()` (a field that
 * explains itself until something else changes).
 */
export function useCopyFeedback(ms: number | null = COPY_FEEDBACK_MS) {
  const [state, setState] = useState<CopyState>("idle");
  const [copiedText, setCopiedText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    setState("idle");
  }, []);

  const copy = useCallback(
    async (text: string, container?: HTMLElement | null): Promise<boolean> => {
      let ok: boolean;
      try {
        ok = await copyText(text, container);
      } catch {
        ok = false;
      }
      if (!mounted.current) return ok;
      clearTimeout(timer.current);
      setCopiedText(text);
      setState(ok ? "copied" : "failed");
      if (ms !== null) timer.current = setTimeout(() => setState("idle"), ms);
      return ok;
    },
    [ms],
  );

  return { state, copiedText, copy, reset };
}
