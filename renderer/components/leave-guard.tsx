// leave-guard.tsx — leaving a page with unsaved work asks first, for a link,
// Back and a closing tab alike. Mic slots and the stage plot editor use it.
// Rendered only under a router: useBlocker needs one.

import { useEffect, useRef } from "react";
import { useBlocker } from "@tanstack/react-router";

import { confirm } from "./ui";

export function LeaveGuard({ dirty, message }: { dirty: boolean; message: string }) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  const asked = useRef(false);
  useEffect(() => {
    if (blocker.status !== "blocked" || asked.current) return;
    asked.current = true;
    void confirm({
      title: "Leave without saving?",
      message,
      confirmLabel: "Leave",
      destructive: true,
    }).then((ok) => {
      asked.current = false;
      if (ok) blocker.proceed?.();
      else blocker.reset?.();
    });
  }, [blocker, message]);
  return null;
}
