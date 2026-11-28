// leave-guard.tsx — leaving a page with unsaved work asks first, for a link,
// Back and a closing tab alike. Mic slots, the stage plot editor and the patch
// editor use it. useBlocker needs a router, so with none (a page mounted on its
// own in a component test) it renders nothing rather than throwing.
//
// `flush`, when given, is tried before asking on a link or Back: it stores the work
// somewhere safe (the plot editor's kept draft) and, when it does, the page is left
// without a question. A closing tab cannot wait for it, so the browser asks while
// `dirty`; the editor sends what it can as the page goes.

import { useEffect, useRef } from "react";
import { useBlocker } from "@tanstack/react-router";

import { confirm } from "./ui";
import { useRouterHandle } from "../lib/use-search-param";

interface LeaveGuardProps {
  dirty: boolean;
  message: string;
  flush?: () => Promise<boolean>;
}

export function LeaveGuard(props: LeaveGuardProps) {
  return useRouterHandle() ? <RoutedLeaveGuard {...props} /> : null;
}

function RoutedLeaveGuard({ dirty, message, flush }: LeaveGuardProps) {
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
