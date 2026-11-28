// leave-guard.tsx — leaving a page with unsaved work asks first, for a link,
// Back and a closing tab alike. Mic slots and the stage plot editor use it.
// Rendered only under a router: useBlocker needs one.
//
// `flush`, when given, is tried before asking on a link or Back: it stores the work
// somewhere safe (the plot editor's kept draft) and, when it does, the page is left
// without a question. A closing tab cannot wait for it, so the browser asks while
// `dirty`; the editor sends what it can as the page goes.

import { useEffect, useRef } from "react";
import { useBlocker } from "@tanstack/react-router";

import { confirm } from "./ui";

export function LeaveGuard({ dirty, message, flush }: { dirty: boolean; message: string; flush?: () => Promise<boolean> }) {
  const blocker = useBlocker({
    shouldBlockFn: async () => dirty && !(flush && (await flush())),
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
