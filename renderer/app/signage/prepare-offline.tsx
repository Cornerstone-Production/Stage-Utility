// prepare-offline.tsx — make a screen ready to play with no server, and say so.
//
// The whole point is turning "I hope it cached" into something checked before a
// Pi leaves the building. So this reports what the browser ACTUALLY holds, and
// every way it can fall short is stated rather than rounded up to "ready":
// a screen whose tags have no default playlist, a browser that cannot cache at
// all, and any
// individual asset that failed.
//
// It prepares the browser it is RUNNING IN. That is a real constraint and the
// copy says so — an operator has to open this on the screen itself, which for a
// Pi means visiting the Signage tab on that Pi.
//
// Keyed on the SCREEN rather than on a tag: what a screen plays with no server
// is its winning tag default, and a screen can carry several tags. Asking about
// one tag answered a question nobody had.

import { useCallback, useState } from "react";
import { DownloadIcon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import { Button } from "../../components/ui/button";
import { offlineCapable, precache } from "../../main/signage-offline";
import { size } from "./format";
import { invoke } from "../../lib/api";

interface Asset {
  url: string;
  bytes: number;
}

export function PrepareOffline({ outputId }: { outputId: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "warn">("ok");
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setTone("ok");
    setStatus("Fetching the list…");
    try {
      const { assets, reason, playlist } = await invoke<{
        assets: Asset[];
        reason?: string;
        playlist?: string;
      }>("signage:offlineAssets", { outputId });

      if (reason || assets.length === 0) {
        setTone("warn");
        setStatus(reason ?? "There is nothing to hold.");
        return;
      }

      if (!offlineCapable()) {
        // Said plainly rather than failing quietly. This browser will still play
        // signage; it just will not survive a reload.
        setTone("warn");
        setStatus(
          "This browser cannot store content offline. On a Raspberry Pi, open this page on the screen itself.",
        );
        return;
      }

      const total = assets.reduce((n, a) => n + a.bytes, 0);
      setStatus(`Holding ${assets.length} asset${assets.length === 1 ? "" : "s"} · ${size(total)}…`);

      const result = await precache(assets.map((a) => a.url));
      if (!result) {
        setTone("warn");
        setStatus("The offline worker did not answer. Reload this page and try again.");
        return;
      }

      if (result.failed.length) {
        setTone("warn");
        // Named, not counted: "30 of 34" tells the operator to try again, the
        // name tells them which file is broken.
        setStatus(
          `${result.cached} of ${result.total} held. Could not fetch: ${result.failed
            .map((f) => f.url.replace("/signage-media/", ""))
            .join(", ")}`,
        );
        return;
      }

      setTone("ok");
      setStatus(`${result.cached} of ${result.total} assets · ${size(total)} · ready${playlist ? ` (${playlist})` : ""}`);
    } catch (err) {
      setTone("warn");
      setStatus(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [outputId]);

  return (
    <div className="flex flex-col gap-1">
      <Button size="small" disabled={busy} onClick={() => void run()}>
        <DownloadIcon className="size-3.5" />
        Prepare for offline
      </Button>
      {status ? (
        <span className={tone === "warn" ? "text-caption2 text-amber-11" : "text-caption2 text-live-11"}>
          {status}
        </span>
      ) : null}
    </div>
  );
}
