// use-read.ts — one read of a server value for a page, and whether it failed.
//
// The shape five Q-SYS reads had each written out: invoke once on mount, ignore an
// answer that lands after unmount, and log a failure on the component's tag. A
// failure is its own state, never the empty value, so a page can say "couldn't
// read" where an empty list would say something false. `put` sets the value from
// elsewhere (a save's answer, a push), and the first read, landing late, never
// overwrites a value put since.

import { useCallback, useEffect, useState } from "react";

import { invoke, type IpcChannel } from "./api";
import { logReadFailure } from "./client-log";

export type ReadState<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed" };

export function useRead<T>(channel: IpcChannel, tag: string, what: string): [ReadState<T>, (value: T) => void] {
  const [read, setRead] = useState<ReadState<T>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    invoke<T>(channel).then(
      (value) => {
        if (live) setRead((cur) => (cur.state === "ok" ? cur : { state: "ok", value }));
      },
      (err: unknown) => {
        logReadFailure(tag, what, err);
        if (live) setRead((cur) => (cur.state === "ok" ? cur : { state: "failed" }));
      },
    );
    return () => {
      live = false;
    };
  }, [channel, tag, what]);
  const put = useCallback((value: T) => setRead({ state: "ok", value }), []);
  return [read, put];
}
