import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, RefreshCwIcon, DownloadIcon, CheckCircle2Icon, AlertTriangleIcon, XIcon, RotateCwIcon, LockIcon } from "lucide-react";
import { invoke, onNotification } from "../../lib/api";
import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  InfoHint,
  Collapsible,
  Switch,
  Input,
  NumberInput,
  Button,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  toast,
  confirm,
} from "../../components/ui";
import { DownloadIcon as DlIcon, UploadIcon, SaveIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { DataArchivePanel } from "./data-archive-panel";
import type { SectionProps } from "../types";

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ANY_DAY = "any";

// Fallback when the backend predates the in-app updater (#48) and omits `autoUpdate`
// — e.g. a server that hasn't been restarted after a frontend deploy, or the brief
// window during an in-app self-update. Mirrors the backend default so a newer bundle
// never crashes against an older API. Keep in sync with settings-store DEFAULT_SETTINGS.
const DEFAULT_AUTO_UPDATE: StageState["autoUpdate"] = { mode: "manual", dayOfWeek: null, hour: 3 };

function formatHour(h: number): string {
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${am ? "AM" : "PM"}`;
}

// Maps each update sub-phase to a label + a (monotonic, approximate) percentage.
// npm/git don't report true progress, so these are honest milestones rather than
// a precise byte count — they always move forward and never imply more than is known.
const STEP_META: Record<NonNullable<UpdateStatus["step"]>, { label: string; pct: number }> = {
  pull: { label: "Downloading update…", pct: 20 },
  install: { label: "Installing dependencies…", pct: 50 },
  build: { label: "Building the app…", pct: 78 },
  restarting: { label: "Restarting server…", pct: 94 },
};

// A thin determinate progress bar for the active update.
function UpdateProgress({ step }: { step: UpdateStatus["step"] }) {
  const meta = step ? STEP_META[step] : { label: "Starting…", pct: 8 };
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-caption2 text-gray-11">
        <span className="flex items-center gap-1.5">
          <Loader2Icon className="size-3.5 animate-spin text-accent" />
          {meta.label}
        </span>
        <span className="tabular-nums text-gray-10">{meta.pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-a4">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
          style={{ width: `${meta.pct}%` }}
        />
      </div>
      <p className="text-caption2 text-gray-9">
        Keep this page open — it will reload automatically when the update finishes.
      </p>
    </div>
  );
}

function UpdatesPanel({
  updateStatus,
  autoUpdate,
  handlers,
  justUpdated,
  onDismissJustUpdated,
}: {
  updateStatus: SectionProps["updateStatus"];
  autoUpdate: StageState["autoUpdate"];
  handlers: SectionProps["handlers"];
  justUpdated?: { version: string } | null;
  onDismissJustUpdated?: () => void;
}) {
  const s = updateStatus;
  const updating = s?.phase === "updating";
  const behind = s?.behind ?? 0;
  // What the banner counts. `behind` includes the release workflow's own version
  // bump, which trails every merge — announcing that as an update trains people to
  // ignore the banner. Falls back to `behind` for a server too old to send the
  // narrower count.
  const behindNews = s?.behindUserFacing ?? behind;
  const [trackSel, setTrackSel] = useState<string | null>(null);
  // Update lock — a live service / active recording blocks self-updates (which
  // restart the process) unless overridden. Re-checked whenever a service goes
  // live/idle or a recorder opens/closes so the indicator stays fresh.
  const [lock, setLock] = useState<{ active: boolean; reasons: string[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      invoke<{ active: boolean; reasons: string[] }>("update:lock")
        .then((l) => !cancelled && setLock(l))
        .catch(() => {});
    refresh();
    const offs = ["pco:live", "spl:history", "attendance:history", "service-timeline:history"].map((ch) =>
      onNotification(ch, refresh),
    );
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, []);

  async function onUpdateNow() {
    if (lock?.active) {
      if (
        await confirm({
          title: "Service in progress",
          message: `Updating restarts the server and would interrupt: ${lock.reasons.join(", ")}. It's safest to wait until the service is over.`,
          confirmLabel: "Override & update anyway",
          destructive: true,
        })
      ) {
        handlers.handleApplyUpdate(true);
      }
      return;
    }
    if (await confirm({ title: "Update now?", message: "The displays will go blank and reload for a few seconds while the server restarts.", confirmLabel: "Update now" })) {
      handlers.handleApplyUpdate();
    }
  }

  async function onRestart() {
    const doRestart = () =>
      void invoke("update:restart").catch((e) =>
        window.alert(`Restart failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    // Locked during a live service / recording, same as self-update — a manual
    // restart interrupts displays too. Overridable for a genuine emergency.
    if (lock?.active) {
      if (
        await confirm({
          title: "Service in progress",
          message: `Restarting the server would interrupt: ${lock.reasons.join(", ")}. It's safest to wait until the service is over.`,
          confirmLabel: "Override & restart anyway",
          destructive: true,
        })
      ) {
        doRestart();
      }
      return;
    }
    if (await confirm({ title: "Restart the server?", message: "The displays will go blank and reload for a few seconds while the server restarts. No update is installed.", confirmLabel: "Restart" })) {
      doRestart();
    }
  }

  async function onSwitchTrack() {
    const branch = trackSel ?? s?.branch ?? null;
    if (!branch || branch === s?.branch) return;
    const locked = lock?.active ?? false;
    const ok = await confirm(
      locked
        ? {
            title: "Service in progress",
            message: `Switching tracks reinstalls, rebuilds, and restarts the server, interrupting: ${lock!.reasons.join(", ")}. It's safest to wait until the service is over.`,
            confirmLabel: "Override & switch",
            destructive: true,
          }
        : {
            title: `Switch to "${branch}"?`,
            message: `The server will reinstall + rebuild and restart (displays go blank for a few seconds), then follow the ${branch} branch.`,
            confirmLabel: "Switch track",
          },
    );
    if (ok) {
      void invoke("update:setTrack", { branch, override: locked }).catch((e) =>
        window.alert(`Track switch failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  // Not a git checkout → can't self-update. Only show this once a check has
  // actually confirmed it (lastCheckedAt set) — otherwise a freshly-restarted
  // server briefly serves the default `isGitRepo:false` and flashes this banner
  // before the first check runs.
  if (s && !s.isGitRepo && s.lastCheckedAt) {
    return (
      <FieldSet>
        <FieldGroup>
          <Field orientation="vertical">
            <FieldContent>
              <FieldLabel>Software updates</FieldLabel>
              <FieldDescription>
                This install isn't a git checkout, so in-app updates aren't available. Update from the
                command line on the server (see INSTALL.md). Current version: v{s.version}.
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldGroup>
      </FieldSet>
    );
  }

  return (
    <FieldSet>
      <FieldGroup>
        <Field orientation="vertical">
          <FieldContent>
            <FieldLabel>
              {!s ? "Checking for updates…" : behindNews > 0 ? `${behindNews} update${behindNews === 1 ? "" : "s"} available` : "Up to date"}
            </FieldLabel>
            <FieldDescription>
              {s ? (
                <>
                  Running v{s.version}
                  {s.currentSha ? ` · ${s.currentSha}` : ""}
                  {s.currentDate ? ` · ${new Date(s.currentDate).toLocaleDateString()}` : ""}
                  {s.branch ? ` (${s.branch})` : ""}.
                  {s.lastCheckedAt ? ` Last checked ${new Date(s.lastCheckedAt).toLocaleString()}.` : ""}
                  {/* Said plainly rather than hidden. The banner stays quiet because
                      nothing pending changes what the app does, but Update still
                      works if you want the version number to line up. */}
                  {behindNews === 0 && behind > 0
                    ? ` A version bump is pending (${behind} commit${behind === 1 ? "" : "s"}) — nothing user-facing.`
                    : ""}
                </>
              ) : (
                "Comparing this install against the latest release…"
              )}
            </FieldDescription>

            {/* Success banner after an auto-reload completes (set pre-restart). */}
            {justUpdated ? (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-green-a5 bg-green-a2 p-2.5 text-caption1 text-green-11">
                <CheckCircle2Icon className="size-4 shrink-0 mt-0.5 text-green-10" />
                <div className="flex-1">
                  <p className="font-medium">Update installed successfully.</p>
                  <p className="text-caption2 text-green-11/80">Now running {justUpdated.version}.</p>
                </div>
                {onDismissJustUpdated ? (
                  <button
                    type="button"
                    onClick={onDismissJustUpdated}
                    className="shrink-0 rounded p-0.5 text-green-11/70 hover:text-green-11"
                    aria-label="Dismiss"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* Live progress while applying (survives until the page auto-reloads). */}
            {updating ? <UpdateProgress step={s?.step ?? null} /> : null}

            {/* Changelog of pending commits */}
            {!updating && behindNews > 0 && s?.changelog?.length ? (
              <div className="mt-2 rounded-md border border-gray-a4 bg-gray-a2">
                <p className="border-b border-gray-a4 px-2.5 py-1.5 text-caption2 font-medium text-gray-11">
                  What's new
                </p>
                <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto p-2.5 text-caption2 text-gray-11">
                  {s.changelog.map((line, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="shrink-0 text-gray-9">•</span>
                      <span className="min-w-0 break-words">{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Last apply result */}
            {!updating && s?.lastResult && !s.lastResult.ok ? (
              <p className="mt-1 flex items-start gap-1.5 text-caption2 text-red-10">
                <AlertTriangleIcon className="size-3.5 shrink-0 mt-0.5" />
                Last update failed{s.lastResult.finishedAt ? ` (${new Date(s.lastResult.finishedAt).toLocaleString()})` : ""}.
                {s.lastResult.log ? ` ${s.lastResult.log.split("\n").filter(Boolean).slice(-1)[0]}` : ""}
              </p>
            ) : null}
            {!justUpdated && s && behindNews === 0 && !updating && (!s.lastResult || s.lastResult.ok) ? (
              <p className="mt-1 flex items-center gap-1.5 text-caption2 text-green-10">
                <CheckCircle2Icon className="size-3.5" /> You're on the latest version.
              </p>
            ) : null}
            {lock?.active && !updating ? (
              <p className="mt-1 flex items-center gap-1.5 text-caption2 text-amber-11">
                <LockIcon className="size-3.5" /> Update &amp; restart locked — {lock.reasons.join(" · ")}. Finish the service, or override in the dialog.
              </p>
            ) : null}
          </FieldContent>

          <div className="flex flex-wrap gap-2">
            <Button variant="filled" size="small" onClick={() => handlers.handleCheckUpdates()} disabled={updating}>
              <RefreshCwIcon className="size-3.5 text-gray-9" />
              Check now
            </Button>
            <Button variant="accent" size="small" onClick={onUpdateNow} disabled={updating || behind === 0}>
              {updating ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
              {updating ? "Updating…" : "Update now"}
            </Button>
            <Button variant="filled" size="small" onClick={onRestart} disabled={updating}>
              <RotateCwIcon className="size-3.5 text-gray-9" />
              Restart
            </Button>
          </div>
        </Field>

        {/* Update track (beta / main) */}
        {s && (s.tracks?.length ?? 0) > 1 ? (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Update track</FieldLabel>
              <FieldDescription>
                Which branch this server follows. <b>main</b> is the stable production track; <b>beta</b> gets
                new features first for testing. Switching reinstalls, rebuilds, and restarts the server.
              </FieldDescription>
            </FieldContent>
            <div className="flex items-center gap-2">
              <Select value={trackSel ?? s.branch ?? ""} onValueChange={setTrackSel} disabled={updating}>
                <SelectTrigger className="w-28" aria-label="Update track"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {s.tracks.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button
                variant="filled"
                size="small"
                disabled={updating || (trackSel ?? s.branch) === s.branch}
                onClick={onSwitchTrack}
              >
                Switch
              </Button>
            </div>
          </Field>
        ) : null}

        {/* A build is installed but not running yet — auto-install deferred the
            restart, so the operator decides when the displays blink. */}
        {updateStatus?.restartPending ? (
          <div className="flex items-start gap-3 rounded-lg border border-line-strong bg-popover p-3">
            <div className="min-w-0 flex-1">
              <div className="text-footnote font-medium text-fg">Update installed — restart to use it</div>
              <p className="mt-0.5 text-caption1 text-fg-muted">
                The new build is ready. Displays are still running the previous one and will reload
                when you restart.
              </p>
            </div>
            {/* Reuses onRestart, which already refuses (with an override) during a
                live service or an active recording — a deferred update must not be
                the thing that finally interrupts one. */}
            <Button variant="accent" size="small" onClick={() => void onRestart()}>
              Restart now
            </Button>
          </div>
        ) : null}

        {/* Update mode */}
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Updates</FieldLabel>
            <FieldDescription>
              How updates are applied. Nothing is applied or restarted while a Planning Center
              service is live, whichever mode you pick.
            </FieldDescription>
          </FieldContent>
          <Select
            value={autoUpdate.mode}
            onValueChange={(v: string) =>
              handlers.handleSetAutoUpdate({ mode: v as StageState["autoUpdate"]["mode"] })
            }
          >
            <SelectTrigger className="w-56" aria-label="Update mode"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Manual — I check and apply</SelectItem>
              <SelectItem value="auto-install">Install automatically, restart when I say</SelectItem>
              <SelectItem value="auto-full">Install and restart automatically</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {autoUpdate.mode === "auto-install" ? (
          <p className="text-caption1 text-fg-muted">
            The new build is applied in the window and then waits. Displays keep running the old one
            until you press Restart, so an update can land on Saturday and be taken on Monday.
          </p>
        ) : null}

        {autoUpdate.mode !== "manual" ? (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Update window</FieldLabel>
              <FieldDescription>When to apply updates each week. Pick an off-hours time.</FieldDescription>
            </FieldContent>
            <div className="flex gap-2">
              <Select
                value={autoUpdate.dayOfWeek == null ? ANY_DAY : String(autoUpdate.dayOfWeek)}
                onValueChange={(v: string) =>
                  handlers.handleSetAutoUpdate({ dayOfWeek: v === ANY_DAY ? null : Number(v) })
                }
              >
                <SelectTrigger className="w-36" aria-label="Update day"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_DAY}>Any day</SelectItem>
                  {DAY_LABELS.map((d, i) => (
                    <SelectItem key={i} value={String(i)}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={String(autoUpdate.hour)}
                onValueChange={(v: string) => handlers.handleSetAutoUpdate({ hour: Number(v) })}
              >
                <SelectTrigger className="w-28" aria-label="Update hour"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, h) => (
                    <SelectItem key={h} value={String(h)}>{formatHour(h)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Field>
        ) : null}
      </FieldGroup>
    </FieldSet>
  );
}

interface SnapshotMeta {
  id: string;
  name: string;
  createdAt: string;
  appVersion: string;
  fileCount: number;
}

// Backup / restore the whole config (secrets excluded). Download/upload a file,
// or save/recall named snapshots. Restoring overwrites config + restarts.
function ConfigSnapshotPanel() {
  const queryClient = useQueryClient();
  const { data: snapshots } = useQuery({
    queryKey: ["config:listSnapshots"],
    queryFn: () => invoke<SnapshotMeta[]>("config:listSnapshots"),
    retry: 1,
  });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["config:listSnapshots"] });

  function download() {
    // The export route sets Content-Disposition: attachment, so this downloads
    // without navigating away.
    window.location.assign("/api/config/export");
  }

  async function saveCurrent() {
    setBusy(true);
    try {
      await invoke("config:saveSnapshot", { name: name.trim() || undefined });
      setName("");
      await refresh();
      toast.success("Snapshot saved.");
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function recall(id: string, label: string) {
    if (!(await confirm({ title: `Recall "${label}"?`, message: "This overwrites the current config (views, integrations, branding, etc.) and restarts the server — displays go blank for a few seconds. Secrets (API keys/passwords) are kept as-is.", confirmLabel: "Recall" }))) return;
    try {
      await invoke("config:recallSnapshot", { id });
      toast.success("Restoring… the server is restarting.");
    } catch (e) {
      toast.error(`Recall failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function remove(id: string) {
    if (!(await confirm({ title: "Delete snapshot?", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await invoke("config:deleteSnapshot", { id });
      await refresh();
    } catch (e) {
      toast.error(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      if (await confirm({ title: `Restore from "${file.name}"?`, message: "This overwrites the current config and restarts the server. Secrets aren't included — you'll re-enter API keys/passwords after.", confirmLabel: "Restore" })) {
        await invoke("config:import", { bundle });
        toast.success("Restoring… the server is restarting.");
      }
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <FieldSet flat>
      <FieldGroup>
        <Field orientation="vertical">
          <FieldContent>
            <FieldLabel>Config snapshot</FieldLabel>
            <FieldDescription>
              Save, download, or restore your full configuration — views, custom layouts,
              integration hosts/ports/names, branding, and display options. Secrets (API keys,
              passwords) are not included, so the file is safe to store; you re-enter those after a
              restore. Restoring overwrites the current config and restarts the server.
            </FieldDescription>
          </FieldContent>

          <div className="flex flex-wrap gap-2">
            <Button variant="filled" size="small" onClick={download}>
              <DlIcon className="size-3.5 text-gray-9" /> Download config
            </Button>
            <Button variant="filled" size="small" onClick={() => fileRef.current?.click()}>
              <UploadIcon className="size-3.5 text-gray-9" /> Upload &amp; restore
            </Button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onUpload} />
          </div>

          {/* Save current as a named snapshot */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="Snapshot name (e.g. Sunday AM)"
              className="w-56 text-gray-12"
              aria-label="Snapshot name"
            />
            <Button variant="accent" size="small" onClick={saveCurrent} disabled={busy}>
              <SaveIcon className="size-3.5" /> Save current
            </Button>
          </div>

          {/* Saved snapshots list */}
          {snapshots && snapshots.length > 0 ? (
            <div className="mt-2 rounded-md border border-gray-a4 bg-gray-a2">
              {snapshots.map((s, i) => (
                <div
                  key={s.id}
                  className={`flex items-center gap-2 px-2.5 py-2 ${i > 0 ? "border-t border-gray-a4" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-caption1 text-gray-12">{s.name}</p>
                    <p className="text-caption2 text-gray-9">
                      {new Date(s.createdAt).toLocaleString()} · v{s.appVersion} · {s.fileCount} file{s.fileCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Button variant="filled" size="small" onClick={() => recall(s.id, s.name)}>
                    <RotateCcwIcon className="size-3.5 text-gray-9" /> Recall
                  </Button>
                  <Button variant="transparent" size="small" iconOnly onClick={() => remove(s.id)} aria-label="Delete snapshot">
                    <Trash2Icon className="size-3.5 text-red-10" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-caption2 text-gray-9">No saved snapshots yet.</p>
          )}
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

export function AdvancedSection({
  stageState,
  updateStatus,
  handlers,
  justUpdated,
  onDismissJustUpdated,
}: Pick<SectionProps, "stageState" | "updateStatus" | "handlers"> & {
  justUpdated?: { version: string } | null;
  onDismissJustUpdated?: () => void;
}) {
  // Local field state so typing doesn't fight the live store; commit on blur.
  const [publicUrl, setPublicUrl] = useState(stageState.publicUrl ?? "");

  function commitPublicUrl() {
    const trimmed = publicUrl.trim();
    if (trimmed === (stageState.publicUrl ?? "")) return;
    handlers.handleSetPublicUrl(trimmed || null);
  }

  // NumberInput persists on change (server round-trips back into stageState) — no
  // local mirror needed; it selects-all on focus and clamps to min/max itself.
  const rc = stageState.reconnectSchedule ?? { enabled: true, leadMin: 120, tailMin: 60, dormantMin: 30 };
  const tw = stageState.taperWindow ?? { preMin: 60, postMin: 60 };

  return (
    <div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
      <UpdatesPanel
        updateStatus={updateStatus}
        autoUpdate={stageState.autoUpdate ?? DEFAULT_AUTO_UPDATE}
        handlers={handlers}
        justUpdated={justUpdated ?? null}
        onDismissJustUpdated={onDismissJustUpdated}
      />

      <FieldSet>
        <Collapsible label="Network & behavior" summary="Public address, reconnects, attendance" headerClassName="px-4 py-2.5">
          <FieldSet flat>
        <FieldGroup>
          <Field orientation="vertical">
            <FieldContent>
              <FieldLabel>Public address (DNS)</FieldLabel>
              <FieldDescription>
                The address people use to reach this server — e.g. a DNS name behind a reverse proxy.
                When set, the connect QR code and the display links use it instead of the local IP.
                Leave blank to use the auto-detected network address.
              </FieldDescription>
            </FieldContent>
            <Input
              value={publicUrl}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPublicUrl(e.target.value)}
              onBlur={commitPublicUrl}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder="http://stage-display.example.com"
              className="text-gray-12"
              aria-label="Public address (DNS)"
            />
          </Field>
        </FieldGroup>
      </FieldSet>

          <FieldSet flat>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>
                Wake around service times
                <InfoHint className="ml-1.5 align-middle">
                  Church gear is off most of the week, so retrying at full speed is wasted
                  traffic and log noise. Rehearsal and service windows come from Planning
                  Center; outside them connections back off toward the idle interval below,
                  and the Planning Center poll slows too. Nothing ever sleeps past the moment
                  the next window opens, and if the schedule cannot be worked out — no
                  credentials, a failed fetch — everything stays at full speed rather than
                  going quiet.
                </InfoHint>
              </FieldLabel>
              <FieldDescription>
                Back off reconnects when gear is off for the week, and ramp up before a
                rehearsal or service. Off = a fixed 2-minute retry.
              </FieldDescription>
            </FieldContent>
            <Switch
              checked={rc.enabled}
              onCheckedChange={(v: boolean) => handlers.handleSetReconnectSchedule({ enabled: v })}
            />
          </Field>
          {rc.enabled && (
            <>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Lead time before rehearsal (minutes)</FieldLabel>
                  <FieldDescription>Start reconnecting this long before a scheduled rehearsal or service.</FieldDescription>
                </FieldContent>
                <NumberInput value={rc.leadMin} min={0} max={1440} className="w-28"
                  onChange={(v) => { if (v !== rc.leadMin) handlers.handleSetReconnectSchedule({ leadMin: Math.round(v) }); }}
                  aria-label="Lead time before rehearsal (minutes)" />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Keep active after service ends (minutes)</FieldLabel>
                  <FieldDescription>Stay in fast-reconnect mode this long after the service end time.</FieldDescription>
                </FieldContent>
                <NumberInput value={rc.tailMin} min={0} max={1440} className="w-28"
                  onChange={(v) => { if (v !== rc.tailMin) handlers.handleSetReconnectSchedule({ tailMin: Math.round(v) }); }}
                  aria-label="Keep active after service ends (minutes)" />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Idle retry interval (minutes)</FieldLabel>
                  <FieldDescription>Longest gap between reconnect attempts when far from any service (the dead-week cadence).</FieldDescription>
                </FieldContent>
                <NumberInput value={rc.dormantMin} min={1} max={1440} className="w-28"
                  onChange={(v) => { if (v !== rc.dormantMin) handlers.handleSetReconnectSchedule({ dormantMin: Math.round(v) }); }}
                  aria-label="Idle retry interval (minutes)" />
              </Field>
            </>
          )}
        </FieldGroup>
      </FieldSet>

          <FieldSet flat>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Pre-service ramp (minutes)</FieldLabel>
              <FieldDescription>Start sampling attendance this long before the service start, so the graph shows the room filling up. 0 = off.</FieldDescription>
            </FieldContent>
            <NumberInput value={tw.preMin} min={0} max={240} className="w-28"
              onChange={(v) => { if (v !== tw.preMin) handlers.handleSetTaperWindow({ preMin: Math.round(v) }); }}
              aria-label="Pre-service ramp (minutes)" />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>
                Post-service taper (minutes)
                <InfoHint className="ml-1.5 align-middle">
                  Sampling continues even once the live plan is cleared, so an emptying room
                  is still recorded. These samples are excluded from the Peak and Lowest
                  figures — otherwise the taper would drag the low toward an empty room.
                </InfoHint>
              </FieldLabel>
              <FieldDescription>Keep sampling this long after the service ends, to capture how fast the room empties. 0 = off.</FieldDescription>
            </FieldContent>
            <NumberInput value={tw.postMin} min={0} max={240} className="w-28"
              onChange={(v) => { if (v !== tw.postMin) handlers.handleSetTaperWindow({ postMin: Math.round(v) }); }}
              aria-label="Post-service taper (minutes)" />
          </Field>
        </FieldGroup>
          </FieldSet>
        </Collapsible>
      </FieldSet>

      <FieldSet>
        <Collapsible label="Backup & restore" summary="Save, download & recall how the app is set up" headerClassName="px-4 py-2.5">
          <ConfigSnapshotPanel />
        </Collapsible>
      </FieldSet>

      <FieldSet>
        <Collapsible
          label="Data archive"
          summary="Download & restore what the app recorded"
          headerClassName="px-4 py-2.5"
        >
          <DataArchivePanel />
        </Collapsible>
      </FieldSet>
    </div>
  );
}
