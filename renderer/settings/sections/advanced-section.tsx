import { errorMessage } from "@main/services/errors";
import { availableCount } from "@main/services/update/availability";
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, RefreshCwIcon, DownloadIcon, CheckCircle2Icon, AlertTriangleIcon, XIcon, RotateCwIcon, LockIcon, FileTextIcon } from "lucide-react";
import { invoke, onNotification } from "../../lib/api";
import { useServerNow } from "../../lib/server-clock";
import { useFailedReads } from "../../lib/use-failed-reads";
import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  InfoHint,
  Switch,
  Input,
  NumberInput,
  Button,
  ButtonGroup,
  type ButtonProps,
  ErrorNote,
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
import { HostNamesCard } from "./host-names-card";
import { HistoryMilestonesPanel } from "./history-milestones-panel";
import { VideoRelayFfmpegPanel } from "./video-relay-ffmpeg";
import { VideoRelayPortsPanel, VIDEO_PORTS_FLASH_ID } from "./video-relay-ports";
import { BarConfigurator } from "../../app/bar-configurator";
import { clockOptions, formatClock } from "../../lib/clock-format";
import type { BackupSchedule } from "../../../main/services/backup-scheduler";
import type { SectionProps } from "../types";
import { restartConsequence, restartOutcome } from "../../lib/restart-warning";
import { useUpdateStatus } from "../../app/queries";
import { plural } from "@main/services/plural";
import { useRevealTarget } from "../../app/flash";
import {
  ADVANCED_CARDS,
  ADVANCED_SETTINGS,
  ADVANCED_TABS,
  DEFAULT_ADVANCED_TAB,
  SEARCH_TAB_ID,
  cardsByBestHit,
  parseAdvancedTab,
  settingText,
  tabName,
  type AdvancedCardKey,
  type AdvancedPageTab,
  type AdvancedSettingId,
  type AdvancedTabId,
} from "./advanced-settings";
import { searchSettings, wordsOf } from "./advanced-search";
import { ADVANCED_PANEL_ID, AdvancedSearchBox, AdvancedTabBar, searchShortcutLabel, tabButtonId } from "./advanced-tabs";
import { useAdvancedSignals } from "../../app/advanced-signals";

/** Words that find the Server log from Search. */
const SERVER_LOG_WORDS = ["server", "log", "logs", "diagnostics", "debug", "errors"];

/**
 * Does a query offer the Server log? Every word must begin one of the log's words,
 * and a word needs two letters: one letter begins half the alphabet and would offer
 * the log for a lone "s" or "e".
 */
export function offersServerLog(query: string): boolean {
  const words = wordsOf(query);
  return words.length > 0 && words.every((w) => w.length >= 2 && SERVER_LOG_WORDS.some((k) => k.startsWith(w)));
}

/**
 * The conditions under which a conditional row is drawn, each written once: the
 * rows read them to decide what to draw, and `undrawnSettings` reads them to decide
 * what Search may match.
 */

/** An install with no usable updater draws only the status line. Gated on a check having confirmed it. */
function hasNoUpdater(s: SectionProps["updateStatus"]): boolean {
  return !!s && s.canUpdate === false && !!s.lastCheckedAt;
}
/** The track switch: only where the install follows more than one track. */
function drawsTrackRow(s: SectionProps["updateStatus"]): boolean {
  return !!s && !hasNoUpdater(s) && (s.tracks?.length ?? 0) > 1;
}
/** The update window: only when updates are applied by themselves. */
function drawsWindowRow(s: SectionProps["updateStatus"], autoUpdate: StageState["autoUpdate"]): boolean {
  return !hasNoUpdater(s) && autoUpdate.mode !== "manual";
}
/** The reconnect timings: only while Wake around service times is on. */
function drawsReconnectTimings(rc: { enabled: boolean }): boolean {
  return rc.enabled;
}

/** Which rows a card draws. Every row by default; the Search tab narrows it to the matches. */
export type ShowRow = (id: AdvancedSettingId) => boolean;
const SHOW_ALL: ShowRow = () => true;

/** What a call that restarts the server answers: why it could not arrange its own relaunch, if it could not. */
type RestartAnswer = { relaunchFailure?: string };

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ANY_DAY = "any";

// Fallback when the backend predates the in-app updater (#48) and omits `autoUpdate`
// — e.g. a server that hasn't been restarted after a frontend deploy, or the brief
// window during an in-app self-update. Mirrors the backend default so a newer bundle
// never crashes against an older API. Keep in sync with settings-store DEFAULT_SETTINGS.
const DEFAULT_AUTO_UPDATE: StageState["autoUpdate"] = { mode: "manual", dayOfWeek: null, hour: 3 };

/**
 * A segmented control built from `ButtonGroup` + small `Button`s — one filled
 * "selected" button and the rest quiet, exactly the shape Data archive's
 * Keep mine / Merge / Replace mine row already used. Reused for every
 * Select-with-a-handful-of-options this section replaced: update track,
 * update mode, clock format.
 *
 * `value` may be null (nothing known yet, e.g. an unreadable install's
 * branch) — every option then renders unselected rather than guessing one.
 */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  /** Accessible name for the group; the visible FieldLabel beside it is not associated. */
  label: string;
  options: { value: T; label: ReactNode; hint?: string }[];
  value: T | null;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <ButtonGroup role="group" aria-label={label}>
      {options.map((o) => (
        <Button
          key={o.value}
          variant={value === o.value ? "accent" : "filled"}
          aria-pressed={value === o.value}
          size="small"
          disabled={disabled}
          title={o.hint}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </ButtonGroup>
  );
}

/** A recorder's record is open (still recording) when it exists and its
 *  `endedAt` has not been stamped — the same field name and meaning on
 *  ServiceSplHistory, ServiceAttendance and ServiceTimeline alike (all extend
 *  ServiceRecord in main/services/service-recorder.ts). */
function isRecordOpen(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && (payload as { endedAt?: string | null }).endedAt == null;
}

/**
 * The one fact each lock-relevant channel carries that the server's lock
 * (serviceActivity() in main/services/routes/system-routes.ts) actually
 * depends on — never the rest of the payload, which changes far more often
 * than the lock does.
 */
const LOCK_CHANNELS: readonly (readonly [string, (payload: unknown) => boolean])[] = [
  ["pco:live", (p) => (p as { mode?: string } | null)?.mode === "item"],
  ["spl:history", isRecordOpen],
  ["attendance:history", isRecordOpen],
  ["service-timeline:history", isRecordOpen],
];

/** An hour of the day, in the app's clock format. A fixed date: only the hour is read. */
function formatHour(h: number): string {
  return formatClock(new Date(2000, 0, 1, h));
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
          className="h-full rounded-full bg-accent transition-[width] duration-(--motion-settled) ease-out"
          style={{ width: `${meta.pct}%` }}
        />
      </div>
      <p className="text-caption2 text-gray-9">
        Keep this page open — it will reload automatically when the update finishes.
      </p>
    </div>
  );
}

/**
 * A control the update lock guards.
 *
 * The lock deliberately does NOT disable these. A live service can go wrong and
 * the operator may genuinely need to update or restart in the middle of one, so
 * each of these opens a destructive override dialog instead of refusing — that
 * is the "or override in the dialog" the lock warning promises. What was missing
 * was the affordance: while locked they rendered exactly as they do when there
 * is nothing to worry about, so the warning above them was the only thing on
 * screen saying otherwise, and "Update now" in full accent said the opposite.
 *
 * Locked, a control takes an amber lock in place of whatever icon it had and a
 * label saying that pressing it now is an override; the two that are `accent`
 * also drop to `filled`, off the encouraged primary weight. Never colour alone.
 * The tooltip repeats the reasons for a pointer user; it is never the only place
 * they are said.
 *
 * The guarded look follows being PRESSABLE, not the lock alone. A control its own
 * rules have already disabled cannot reach the override, so promising "anyway" on
 * it would be the same lie pointing the other way. That is also what keeps the
 * deferred-update banner honest: it is the one control nothing else disables, so
 * it stays guarded even mid-update, when the others have gone quiet behind their
 * own `disabled`. Tying this to `updating` instead left exactly that button
 * clickable, in full accent, on an active lock.
 */
function GuardedButton({
  guard,
  variant,
  icon,
  label,
  lockedLabel,
  ...props
}: Omit<ButtonProps, "children" | "tooltip"> & {
  /** Why the lock is active, or null when it is not. Never feeds `disabled`. */
  guard: string[] | null;
  /** The action's own icon, shown when nothing is locked. */
  icon?: ReactNode;
  label: string;
  lockedLabel: string;
}) {
  const locked = guard !== null && !props.disabled;
  return (
    <Button
      {...props}
      variant={locked ? "filled" : variant}
      tooltip={locked ? `Locked — ${guard.join(" · ")}. You'll be asked to confirm.` : ""}
    >
      {locked ? <LockIcon className="size-3.5 text-amber-11" /> : icon}
      {locked ? lockedLabel : label}
    </Button>
  );
}

// Exported for update-lock-affordance.test.tsx, which renders it directly — the
// whole AdvancedSection needs a full StageState it has no opinion about.
export function UpdatesPanel({
  updateStatus,
  autoUpdate,
  handlers,
  justUpdated,
  show = SHOW_ALL,
  children,
}: {
  updateStatus: SectionProps["updateStatus"];
  autoUpdate: StageState["autoUpdate"];
  handlers: SectionProps["handlers"];
  /** Set while the post-update banner is up: the result lines beneath would contradict it. */
  justUpdated?: { version: string } | null;
  /** Which of the panel's rows to draw; all of them unless the Search tab narrows it. */
  show?: ShowRow;
  /** Further rows of the same card, drawn after the panel's own. */
  children?: ReactNode;
}) {
  const s = updateStatus;
  const updating = s?.phase === "updating";
  const behind = s?.behind ?? 0;
  // What the banner counts. `behind` includes the release workflow's own version
  // bump, which trails every merge — announcing that as an update trains people to
  // ignore the banner. Falls back to `behind` for a server too old to send the
  // narrower count.
  const behindNews = s?.behindUserFacing ?? behind;
  // One definition, shared with the toast and the nav dot.
  const available = availableCount(s);
  // Merged but not yet released — CI still running, or red. Only worth saying when
  // there is nothing to install, otherwise it competes with the update itself.
  const unreleased = s?.tagBased ? (s.unreleasedCommits ?? 0) : 0;
  // A release that exists but cannot be installed here yet — archives still
  // uploading, or the Homebrew tap not regenerated. Same idea as `unreleased`,
  // one step further along the pipeline.
  const awaiting = s?.awaitingPackage ?? null;
  const [trackSel, setTrackSel] = useState<string | null>(null);
  // Update lock — a live service / active recording blocks self-updates (which
  // restart the process) unless overridden. Re-checked whenever a service goes
  // live/idle or a recorder opens/closes so the indicator stays fresh.
  const [lock, setLock] = useState<{ active: boolean; reasons: string[] } | null>(null);
  // A lock that could not be READ is not an unlocked server. It starts null,
  // which reads as "not locked", so a failed read used to draw a plain Restart
  // in the middle of a service.
  const { failed: lockReads, fail: failLock, clear: clearLock } = useFailedReads<"lock">("updater");
  useEffect(() => {
    let cancelled = false;
    // Refreshes overlap — a service going live and a recorder opening arrive
    // together — and answer in any order. Only the newest counts, so an older
    // read cannot put back a lock state, or a failure, that a newer one replaced.
    let latest = 0;
    const refresh = () => {
      const mine = ++latest;
      invoke<{ active: boolean; reasons: string[] }>("update:lock")
        .then((l) => {
          if (cancelled || mine !== latest) return;
          setLock(l);
          clearLock("lock");
        })
        .catch((err: unknown) => {
          if (!cancelled && mine === latest) failLock("lock", "the update lock", err);
        });
    };
    refresh();
    // All four channels are hydrated (sse-channels.ts), so every one replays
    // its last frame the moment this effect subscribes — on top of the mount
    // `refresh()` above, that was 5 reads every time the page opened. A
    // replay is at best as new as this mount, which `refresh()` already
    // covers, so it seeds the comparison below but never causes a re-read.
    // pco:live especially keeps broadcasting (an item change, or a 15s
    // keepalive) with the lock's own fact unchanged, so a read is worth
    // repeating only when that fact — a PCO item live, or a recorder's
    // record newly opened/closed — actually flips. See serviceActivity() in
    // main/services/routes/system-routes.ts for what the lock reads.
    const lastFact = new Map<string, boolean>();
    const offs = LOCK_CHANNELS.map(([ch, fact]) =>
      onNotification(ch, (payload, replayed) => {
        const next = fact(payload);
        const prev = lastFact.get(ch);
        lastFact.set(ch, next);
        if (!replayed && next !== prev) refresh();
      }),
    );
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, [failLock, clearLock]);
  // Presentation only — the same fact the three handlers below read. Passed as
  // the reasons or null, rather than a flag plus a list, so a control cannot
  // render "locked" with nothing to name.
  const guard = lock?.active ? lock.reasons : null;
  // Restart is the one action here the server does not refuse on its own during
  // a service — an update and a track switch answer 409 — so a lock that could
  // not be read guards Restart as though it were active, and says why. The other
  // two keep the server's own answer.
  const lockUnread = lockReads.has("lock");
  const restartGuard = guard ?? (lockUnread ? ["the service state could not be checked"] : null);

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
      void invoke<RestartAnswer>("update:restart")
        .then((r) => {
          if (r?.relaunchFailure) window.alert(restartOutcome(s?.selfRecovers, "Restarting.", r.relaunchFailure));
        })
        .catch((e) => window.alert(`Restart failed: ${errorMessage(e)}`));
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
    if (lockUnread) {
      if (
        await confirm({
          title: "Couldn't check for a service",
          message: "The update lock could not be read, so there is no telling whether a service is running. Restarting the server interrupts one if it is.",
          confirmLabel: "Restart anyway",
          destructive: true,
        })
      ) {
        doRestart();
      }
      return;
    }
    if (await confirm({ title: "Restart the server?", message: `${restartConsequence(s?.selfRecovers)} No update is installed.`, confirmLabel: "Restart" })) {
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
        window.alert(`Track switch failed: ${errorMessage(e)}`),
      );
    }
  }

  // No usable updater → say so. Gated on canUpdate, NOT on isGitRepo: a Homebrew
  // or tarball install is not a checkout and updates perfectly well through its
  // own strategy. Keying this off isGitRepo told exactly those installs to update
  // from the command line while a working updater sat behind the message.
  //
  // Only shown once a check has confirmed it (lastCheckedAt set) — otherwise a
  // freshly-restarted server flashes this before the first check runs.
  if (s && hasNoUpdater(s)) {
    return (
      <FieldSet flat>
        <FieldGroup>
          {show("update-status") && (
            <Field orientation="vertical" data-setting-id="update-status">
              <FieldContent>
                <FieldLabel>{settingText("update-status").name}</FieldLabel>
                <FieldDescription>
                  {s.updateBlockedReason ??
                    "In-app updates aren't available for this install. Update from the command line on the server (see INSTALL.md)."}{" "}
                  Current version: v{s.version}.
                </FieldDescription>
              </FieldContent>
            </Field>
          )}
          {children}
        </FieldGroup>
      </FieldSet>
    );
  }

  return (
    <FieldSet flat>
      <FieldGroup>
        {show("update-status") && (
          <Field orientation="vertical" data-setting-id="update-status">
            <FieldContent>
              <FieldLabel>
                {!s
                  ? "Checking for updates…"
                  : available > 0
                    ? s.tagBased && s.targetTag
                      ? `${s.targetTag} available`
                      : `${plural(available, "update")} available`
                    : "Up to date"}
              </FieldLabel>
              <FieldDescription>
                {s ? (
                  <>
                    Running {s.currentTag ?? `v${s.version}`}
                    {s.currentSha ? ` · ${s.currentSha}` : ""}
                    {s.currentDate ? ` · ${new Date(s.currentDate).toLocaleDateString()}` : ""}
                    {s.branch ? ` (${s.branch})` : ""}.
                    {available > 1 ? ` ${available} releases behind.` : ""}
                    {s.lastCheckedAt ? ` Last checked ${new Date(s.lastCheckedAt).toLocaleString()}.` : ""}
                    {/* Said plainly rather than hidden. The banner stays quiet because
                        nothing pending changes what the app does, but Update still
                        works if you want the version number to line up. */}
                    {!s.tagBased && behindNews === 0 && behind > 0
                      ? ` A version bump is pending (${plural(behind, "commit")}) — nothing user-facing.`
                      : ""}
                  </>
                ) : (
                  "Comparing this install against the latest release…"
                )}
              </FieldDescription>

              {/* Live progress while applying (survives until the page auto-reloads). */}
              {updating ? <UpdateProgress step={s?.step ?? null} /> : null}

              {/* Changelog of pending commits */}
              {!updating && available > 0 && s?.changelog?.length ? (
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
              {/* Never beside the success banner. The version handshake is ground
                  truth — the server demonstrably came back on a new version — while
                  the result file is a claim written by the run that restarted it,
                  and a strategy can write "failed" for a step that happened after
                  the new build was already live. Showing both left the operator
                  reading "Update installed successfully" directly above "Last
                  update failed" for the same run. */}
              {!justUpdated && !updating && s?.lastResult && !s.lastResult.ok ? (
                <p className="mt-1 flex items-start gap-1.5 text-caption2 text-red-10">
                  <AlertTriangleIcon className="size-3.5 shrink-0 mt-0.5" />
                  Last update failed{s.lastResult.finishedAt ? ` (${new Date(s.lastResult.finishedAt).toLocaleString()})` : ""}.
                  {s.lastResult.log ? ` ${s.lastResult.log.split("\n").filter(Boolean).slice(-1)[0]}` : ""}
                </p>
              ) : null}
              {!justUpdated && s && available === 0 && !awaiting && !updating && (!s.lastResult || s.lastResult.ok) ? (
                <p className="mt-1 flex items-center gap-1.5 text-caption2 text-green-10">
                  <CheckCircle2Icon className="size-3.5" /> You're on the latest release.
                </p>
              ) : null}
              {/* Work is merged but not released. Normal for a few minutes while the
                  release build runs; if it persists, that build failed and the track
                  is stalled — which should read as "waiting", not "up to date". */}
              {/* The package for a published release is still being built. Normal for
                  a few minutes after a release; if it persists, that build failed —
                  which must read as "waiting", not "up to date". */}
              {!updating && available === 0 && awaiting ? (
                <p className="mt-1 text-caption2 text-gray-9">
                  {awaiting} has been released, but the {s?.trackSource === "formula" ? "Homebrew package" : "download"} for
                  it isn't ready yet. It usually appears within a few minutes.
                </p>
              ) : null}
              {!updating && available === 0 && !awaiting && unreleased > 0 ? (
                <p className="mt-1 text-caption2 text-gray-9">
                  {plural(unreleased, "commit")} merged since {s?.targetTag} and not yet
                  released. Updates arrive once the release build passes.
                </p>
              ) : null}
              {lock?.active && !updating ? (
                <p className="mt-1 flex items-center gap-1.5 text-caption2 text-amber-11">
                  <LockIcon className="size-3.5" /> Update &amp; restart locked — {lock.reasons.join(" · ")}. Finish the service, or override in the dialog.
                </p>
              ) : lockUnread && !updating ? (
                <ErrorNote className="mt-1">Couldn't read the update lock, so Restart can't tell whether a service is running and asks first.</ErrorNote>
              ) : null}
            </FieldContent>

            <div className="flex flex-wrap gap-2">
              <Button variant="filled" size="small" onClick={() => handlers.handleCheckUpdates()} disabled={updating}>
                <RefreshCwIcon className="size-3.5 text-gray-9" />
                Check now
              </Button>
              <GuardedButton
                guard={guard}
                variant="accent"
                size="small"
                onClick={onUpdateNow}
                disabled={updating || (s?.tagBased ? available === 0 : behind === 0)}
                icon={updating ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
                label={updating ? "Updating…" : "Update now"}
                lockedLabel="Update anyway"
              />
              <GuardedButton
                guard={restartGuard}
                variant="filled"
                size="small"
                onClick={onRestart}
                disabled={updating}
                icon={<RotateCwIcon className="size-3.5 text-gray-9" />}
                label="Restart"
                lockedLabel="Restart anyway"
              />
            </div>
          </Field>
        )}

        {/* Update track (beta / main) */}
        {show("update-track") && s && drawsTrackRow(s) ? (
          <Field orientation="horizontal" data-setting-id="update-track">
            <FieldContent>
              <FieldLabel>{settingText("update-track").name}</FieldLabel>
              <FieldDescription>{settingText("update-track").description}</FieldDescription>
            </FieldContent>
            <div className="flex items-center gap-2">
              {/* No selection rather than a default when the track is unknown —
                  an install whose layout we cannot read — since guessing "main"
                  is how a beta box came to report itself as stable. */}
              <Segmented
                label="Update track"
                value={trackSel ?? s.branch ?? null}
                onChange={setTrackSel}
                disabled={updating}
                options={s.tracks.map((t) => ({ value: t, label: t }))}
              />
              {/* Locked too: a track switch reinstalls, rebuilds and restarts,
                  and onSwitchTrack already asks for the same override. */}
              <GuardedButton
                guard={guard}
                variant="filled"
                size="small"
                disabled={updating || (trackSel ?? s.branch) === s.branch}
                onClick={onSwitchTrack}
                label="Switch"
                lockedLabel="Switch anyway"
              />
            </div>
          </Field>
        ) : null}

        {/* A build is installed but not running yet — auto-install deferred the
            restart, so the operator decides when the displays blink. */}
        {show("update-status") && updateStatus?.restartPending ? (
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
            <GuardedButton
              guard={restartGuard}
              variant="accent"
              size="small"
              onClick={() => void onRestart()}
              label="Restart now"
              lockedLabel="Restart anyway"
            />
          </div>
        ) : null}

        {/* Update mode */}
        {show("update-mode") && (
          <Field orientation="horizontal" data-setting-id="update-mode">
            <FieldContent>
              <FieldLabel>{settingText("update-mode").name}</FieldLabel>
              <FieldDescription>{settingText("update-mode").description}</FieldDescription>
            </FieldContent>
            <Segmented
              label="Updates"
              value={autoUpdate.mode}
              onChange={(mode) => handlers.handleSetAutoUpdate({ mode })}
              options={[
                { value: "manual", label: "Manual", hint: "Manual — I check and apply." },
                { value: "auto-install", label: "Install", hint: "Install automatically, restart when I say." },
                { value: "auto-full", label: "Install + restart", hint: "Install and restart automatically." },
              ]}
            />
          </Field>
        )}

        {show("update-mode") && autoUpdate.mode === "auto-install" ? (
          <p className="text-caption1 text-fg-muted">
            The new build is applied in the window and then waits. Displays keep running the old one
            until you press Restart, so an update can land on Saturday and be taken on Monday.
          </p>
        ) : null}

        {show("update-window") && drawsWindowRow(s, autoUpdate) ? (
          <Field orientation="horizontal" data-setting-id="update-window">
            <FieldContent>
              <FieldLabel>{settingText("update-window").name}</FieldLabel>
              <FieldDescription>{settingText("update-window").description}</FieldDescription>
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
        {children}
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

// Unattended backups. One control covers both the config snapshot and the data
// archive, since "did my backups run" should have one answer, not two.
function AutoBackupPanel() {
  const queryClient = useQueryClient();
  const { data: sched } = useQuery({
    queryKey: ["backup:schedule"],
    queryFn: () => invoke<BackupSchedule>("backup:getSchedule"),
    staleTime: 10_000,
  });
  const [busy, setBusy] = useState(false);
  const [dest, setDest] = useState("");
  const stored = sched?.destination ?? "";
  const [lastDest, setLastDest] = useState(stored);
  if (stored !== lastDest) {
    setLastDest(stored);
    setDest(stored);
  }

  async function patch(partial: Partial<BackupSchedule>) {
    try {
      const next = await invoke<BackupSchedule>("backup:setSchedule", partial);
      queryClient.setQueryData(["backup:schedule"], next);
    } catch (e) {
      toast.error(`Couldn't save: ${errorMessage(e)}`);
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      const next = await invoke<BackupSchedule>("backup:runNow");
      queryClient.setQueryData(["backup:schedule"], next);
      if (next.lastError) toast.error(`Backup failed: ${next.lastError}`);
      else toast.success("Backup written.");
    } catch (e) {
      toast.error(`Backup failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!sched) return null;

  const text = settingText("auto-backups");
  return (
    <FieldSet flat data-setting-id="auto-backups">
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>
              {text.name}
              <InfoHint className="ml-1.5 align-middle">
                Writes a config snapshot, and optionally the data archive, on the interval
                below — keeping the most recent few and deleting the rest. A run that fails
                leaves the existing backups alone and is retried, rather than being skipped
                until the next interval. A machine that was switched off runs one backup when
                it comes back, not one per interval it missed.
              </InfoHint>
            </FieldLabel>
            <FieldDescription>{text.description}</FieldDescription>
          </FieldContent>
          <Switch checked={sched.enabled} onCheckedChange={(v: boolean) => void patch({ enabled: v })} />
        </Field>

        {sched.enabled && (
          <>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Every (days)</FieldLabel>
                <FieldDescription>1 = daily, 7 = weekly, 30 = monthly.</FieldDescription>
              </FieldContent>
              <NumberInput value={sched.intervalDays} min={1} max={365} className="w-28"
                onChange={(v) => { if (v !== sched.intervalDays) void patch({ intervalDays: Math.round(v) }); }}
                aria-label="Backup interval (days)" />
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Keep</FieldLabel>
                <FieldDescription>How many of each to keep. Older ones are deleted.</FieldDescription>
              </FieldContent>
              <NumberInput value={sched.keep} min={1} max={100} className="w-28"
                onChange={(v) => { if (v !== sched.keep) void patch({ keep: Math.round(v) }); }}
                aria-label="How many backups to keep" />
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Include recorded services</FieldLabel>
                <FieldDescription>
                  Adds the data archive — every recorded service and its raw samples. Much
                  larger than the config alone.
                </FieldDescription>
              </FieldContent>
              <Switch checked={sched.includeArchive}
                onCheckedChange={(v: boolean) => void patch({ includeArchive: v })} />
            </Field>

            <Field orientation="vertical">
              <FieldContent>
                <FieldLabel>Where to write</FieldLabel>
                <FieldDescription>
                  Blank keeps them in the data directory. Point this at a mounted network
                  share to keep the copies off this machine — a disk failure takes the data
                  directory with it.
                </FieldDescription>
              </FieldContent>
              <Input
                value={dest}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setDest(e.target.value)}
                onBlur={() => { if (dest !== stored) void patch({ destination: dest }); }}
                placeholder="/mnt/nas/stage-backups"
                className="w-full font-mono text-gray-12"
                aria-label="Backup destination directory"
              />
            </Field>

            {/* The one action row here that is not a Field; it takes the Field gutter so it does not sit on the card edge. */}
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Button variant="filled" size="small" onClick={runNow} disabled={busy}>
                <SaveIcon className="size-3.5 text-gray-9" /> Back up now
              </Button>
              <span className="text-caption2 text-gray-9">
                {sched.lastError
                  ? `Last run failed: ${sched.lastError}`
                  : sched.lastRunAt
                    ? `Last backup ${new Date(sched.lastRunAt).toLocaleString()}`
                    : "No backup yet."}
              </span>
            </div>
          </>
        )}
      </FieldGroup>
    </FieldSet>
  );
}

function ConfigSnapshotPanel() {
  const queryClient = useQueryClient();
  // Read here rather than threaded down: the warning belongs beside the button
  // that causes it, and this is the same query the update panel already polls.
  const selfRecovers = useUpdateStatus().data?.selfRecovers;
  const { data: snapshots } = useQuery({
    queryKey: ["config:listSnapshots"],
    queryFn: () => invoke<SnapshotMeta[]>("config:listSnapshots"),
    retry: 1,
  });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["config:listSnapshots"] });

  /** Say a restore was accepted: as an error when the server could not arrange its own relaunch. */
  function toastRestored(answer: RestartAnswer | undefined) {
    const message = restartOutcome(selfRecovers, "Restored.", answer?.relaunchFailure);
    if (answer?.relaunchFailure) toast.error(message);
    else toast.success(message);
  }

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
      toast.error(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function recall(id: string, label: string) {
    if (!(await confirm({
      title: `Recall "${label}"?`,
      message: `This overwrites the current config (views, integrations, branding, etc.). ${restartConsequence(selfRecovers)} Secrets (API keys/passwords) are kept as-is.`,
      confirmLabel: "Recall",
    }))) return;
    try {
      toastRestored(await invoke<RestartAnswer>("config:recallSnapshot", { id }));
    } catch (e) {
      toast.error(`Recall failed: ${errorMessage(e)}`);
    }
  }

  async function remove(id: string) {
    if (!(await confirm({ title: "Delete snapshot?", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await invoke("config:deleteSnapshot", { id });
      await refresh();
    } catch (e) {
      toast.error(`Delete failed: ${errorMessage(e)}`);
    }
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      if (await confirm({
        title: `Restore from "${file.name}"?`,
        message: `This overwrites the current config. ${restartConsequence(selfRecovers)} Secrets aren't included — you'll re-enter API keys/passwords after.`,
        confirmLabel: "Restore",
      })) {
        toastRestored(await invoke<RestartAnswer>("config:import", { bundle }));
      }
    } catch (err) {
      toast.error(`Import failed: ${errorMessage(err)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const text = settingText("config-snapshot");
  return (
    <FieldSet flat data-setting-id="config-snapshot">
      <FieldGroup>
        <Field orientation="vertical">
          <FieldContent>
            <FieldLabel>{text.name}</FieldLabel>
            <FieldDescription>{text.description}</FieldDescription>
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
                      {new Date(s.createdAt).toLocaleString()} · v{s.appVersion} · {plural(s.fileCount, "file")}
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

/**
 * The zone the server makes wall-clock decisions in.
 *
 * Worth a control of its own because the failure it prevents is invisible: a
 * server left on UTC (the default on most Linux images and every container) rolls
 * its date at 7pm in Chicago, which once stopped every recorder in the middle of a
 * live service. Showing the host's own zone next to a live clock makes a wrong one
 * obvious at a glance, instead of at 7pm on a Sunday.
 */
function TimezoneField({
  timezone,
  hostTimezone,
  onChange,
}: {
  timezone: string | null;
  hostTimezone: string;
  onChange: (tz: string | null) => Promise<void>;
}) {
  const FOLLOW = "__host__";
  const zones = (() => {
    // supportedValuesOf is widely available but not universal; fall back to the
    // zones we can name rather than rendering an empty picker.
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const all = typeof f === "function" ? f("timeZone") : [];
    if (all.length) return all;
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return Array.from(new Set([hostTimezone, browser, "UTC"].filter(Boolean)));
  })();

  const effective = timezone ?? hostTimezone;
  // A live clock in the chosen zone — the fastest way to confirm it is right.
  // On the SERVER's clock, because the setting it previews is the server's.
  const now = useServerNow(1000);
  const reads = (() => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: effective,
        weekday: "short",
        ...clockOptions({ seconds: true }),
      }).format(new Date(now));
    } catch {
      return "—";
    }
  })();

  const text = settingText("timezone");
  return (
    <Field orientation="horizontal" data-setting-id="timezone">
      <FieldContent>
        <FieldLabel>
          {text.name}
          <InfoHint className="ml-1.5 align-middle">
            Everything the server decides by the clock reads this: which day a service is
            filed under, the update window, and the day-of-week and time-of-day automation
            conditions. Recording a live service does not — once Planning Center reports a
            service live, nothing time-based can stop it being recorded.
          </InfoHint>
        </FieldLabel>
        <FieldDescription>
          {text.description}{" "}
          The server clock reads <span className="font-mono">{hostTimezone}</span>.
          {" "}Now: <span className="font-mono tabular-nums">{reads}</span>
        </FieldDescription>
      </FieldContent>
      <Select
        value={timezone ?? FOLLOW}
        onValueChange={(v: string) => void onChange(v === FOLLOW ? null : v)}
      >
        <SelectTrigger className="w-64" aria-label="Time zone">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW}>Follow server clock ({hostTimezone})</SelectItem>
          {zones.map((z) => (
            <SelectItem key={z} value={z}>
              {z}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * 12-hour or 24-hour, everywhere the app shows a time of day.
 *
 * Beside the time zone because they are the same question asked twice — which
 * clock am I reading — and because this one changes nothing else. The zone
 * moves what the server DECIDES; this moves only what it prints.
 */
function HourCycleField({
  hourCycle,
  onChange,
}: {
  hourCycle: "12h" | "24h";
  onChange: (cycle: "12h" | "24h") => Promise<void>;
}) {
  return (
    <Field orientation="horizontal" data-setting-id="clock-format">
      <FieldContent>
        <FieldLabel>{settingText("clock-format").name}</FieldLabel>
        <FieldDescription>{settingText("clock-format").description}</FieldDescription>
      </FieldContent>
      <Segmented
        label="Clock format"
        value={hourCycle}
        onChange={(v) => void onChange(v)}
        options={[
          { value: "24h", label: `24-hour (${formatClock(SAMPLE_EVENING, { seconds: true, hourCycle: "24h" })})` },
          { value: "12h", label: `12-hour (${formatClock(SAMPLE_EVENING, { seconds: true, hourCycle: "12h" })})` },
        ]}
      />
    </Field>
  );
}

/** A fixed evening instant, so each option shows the difference rather than
 *  describing it. Evening because that is where 12h and 24h diverge. */
const SAMPLE_EVENING = new Date(2026, 0, 1, 20, 45, 30).getTime();

/** Flash targets on this page, and the tab each one sits on. */
const FLASH_TABS: Readonly<Record<string, AdvancedTabId>> = {
  [VIDEO_PORTS_FLASH_ID]: "video",
};

/** The `data-flash-id` a card carries, when something elsewhere in the app points at it. */
const CARD_FLASH_IDS: Partial<Record<AdvancedCardKey, string>> = {
  "video/Video relay": VIDEO_PORTS_FLASH_ID,
};

/**
 * Settings whose row the page is not drawing right now, because the state they
 * depend on says they do not apply. Search skips them rather than counting a match
 * it cannot show.
 */
function undrawnSettings(
  updateStatus: SectionProps["updateStatus"],
  autoUpdate: StageState["autoUpdate"],
  rc: { enabled: boolean },
): Set<AdvancedSettingId> {
  const out = new Set<AdvancedSettingId>();
  if (hasNoUpdater(updateStatus)) out.add("update-mode");
  if (!drawsTrackRow(updateStatus)) out.add("update-track");
  if (!drawsWindowRow(updateStatus, autoUpdate)) out.add("update-window");
  if (!drawsReconnectTimings(rc)) (["reconnect-lead", "reconnect-tail", "reconnect-idle"] as const).forEach((id) => out.add(id));
  return out;
}

/**
 * The note the pre-restart page leaves for the one that loads after it. Drawn above
 * the tabs so it shows whichever tab the operator lands on.
 */
function JustUpdatedBanner({
  updateStatus,
  justUpdated,
  onDismiss,
}: {
  updateStatus: SectionProps["updateStatus"];
  justUpdated: { version: string };
  onDismiss?: () => void;
}) {
  const s = updateStatus;
  return (
    <div
      role="status"
      data-just-updated=""
      className="flex items-start gap-2 rounded-md border border-ok-9/30 bg-ok-9/6 p-2.5 text-caption1 text-green-11"
    >
      <CheckCircle2Icon className="size-4 shrink-0 mt-0.5 text-green-10" />
      <div className="flex-1">
        <p className="font-medium">Update installed successfully.</p>
        {/* The handshake value is a git SHA — it has to change on every
            update, not just released ones, or kiosks would not reload.
            Right for that job, meaningless to read, so the banner names
            the release from live status and keeps the SHA as a fallback. */}
        <p className="text-caption2 text-green-11/80">
          Now running {s?.currentTag ?? (s ? `v${s.version}` : justUpdated.version)}.
        </p>
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="touch-target shrink-0 rounded p-0.5 text-green-11/70 hover:text-green-11"
          aria-label="Dismiss"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** One card: its heading, an optional status on the right, and its rows. */
function CardFrame({
  title,
  badge,
  flashId,
  children,
}: {
  title: ReactNode;
  badge?: ReactNode;
  flashId?: string;
  children: ReactNode;
}) {
  return (
    <div className="su-card" data-flash-id={flashId}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="text-callout font-semibold text-fg">{title}</h3>
        {badge ? <span className="text-caption1 text-fg-muted">{badge}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A card of plain Fields. */
function FieldCard({ title, flashId, children }: { title: ReactNode; flashId?: string; children: ReactNode }) {
  return (
    <CardFrame title={title} flashId={flashId}>
      <FieldSet flat>
        <FieldGroup>{children}</FieldGroup>
      </FieldSet>
    </CardFrame>
  );
}

export function AdvancedSection({
  stageState,
  updateStatus,
  handlers,
  justUpdated,
  onDismissJustUpdated,
  tab: tabSegment,
  onTabChange,
}: Pick<SectionProps, "stageState" | "updateStatus" | "handlers"> & {
  justUpdated?: { version: string } | null;
  onDismissJustUpdated?: () => void;
  /** The URL's tab segment. Anything that is not a tab shows General. */
  tab?: string;
  /** Called when the operator picks a tab, which the URL then hands back as `tab`. Without it the page keeps its own tab, starting at `tab`. */
  onTabChange?: (tab: AdvancedPageTab) => void;
}) {
  // Local field state so typing doesn't fight the live store; commit on blur.
  const [publicUrl, setPublicUrl] = useState(stageState.publicUrl ?? "");
  const [configuringBar, setConfiguringBar] = useState(false);
  // Bulky and rarely needed — collapsed by default, expanded with a plain
  // inline text button rather than a Collapsible.
  const [showCommands, setShowCommands] = useState(false);

  // The tab belongs to the URL when the route hands it down, and to this page when not.
  const [ownTab, setOwnTab] = useState<AdvancedPageTab>(() => parseAdvancedTab(tabSegment) ?? DEFAULT_ADVANCED_TAB);
  const tab: AdvancedPageTab = onTabChange ? (parseAdvancedTab(tabSegment) ?? DEFAULT_ADVANCED_TAB) : ownTab;
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Bumped each time the operator asks for Search; the effect below answers it once the box exists.
  const [searchAsked, setSearchAsked] = useState(0);
  const searchAnswered = useRef(0);

  const latest = useRef({ tab, onTabChange });
  useEffect(() => {
    latest.current = { tab, onTabChange };
  });
  /** Open a tab. Opening Search also puts the cursor in its box, unless an arrow key got there: focus stays on the strip. */
  function goTo(next: AdvancedPageTab, focusSearch = true) {
    if (next === SEARCH_TAB_ID && focusSearch) setSearchAsked((n) => n + 1);
    if (latest.current.onTabChange) latest.current.onTabChange(next);
    else setOwnTab(next);
  }

  useEffect(() => {
    if (tab !== SEARCH_TAB_ID || searchAnswered.current === searchAsked) return;
    searchAnswered.current = searchAsked;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [tab, searchAsked]);

  // Cmd-F (Ctrl-F elsewhere) opens Search, with the text in the box selected, from any tab.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      // Something nearer already took the key, or a dialog is open and the page behind it is not the operator's focus.
      if (e.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      goTo(SEARCH_TAB_ID);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // goTo reads the newest tab and handler through a ref, so one listener serves every render.
  }, []);

  // A deep link into a card on another tab opens that tab first.
  useRevealTarget((flashId) => {
    const target = FLASH_TABS[flashId];
    if (target && target !== latest.current.tab) goTo(target);
  });

  function commitPublicUrl() {
    const trimmed = publicUrl.trim();
    if (trimmed === (stageState.publicUrl ?? "")) return;
    handlers.handleSetPublicUrl(trimmed || null);
  }

  // NumberInput persists on change (server round-trips back into stageState) — no
  // local mirror needed; it selects-all on focus and clamps to min/max itself.
  const rc = stageState.reconnectSchedule ?? { enabled: true, leadMin: 120, tailMin: 60, dormantMin: 30 };
  const tw = stageState.taperWindow ?? { preMin: 60, postMin: 60 };
  const autoUpdate = stageState.autoUpdate ?? DEFAULT_AUTO_UPDATE;

  const signals = useAdvancedSignals();
  const available = availableCount(updateStatus);
  const updatesBadge = !updateStatus
    ? undefined
    : available > 0
      ? updateStatus.tagBased && updateStatus.targetTag
        ? `${updateStatus.targetTag} available`
        : `${plural(available, "update")} available`
      : `Up to date · ${updateStatus.currentTag ?? `v${updateStatus.version}`}`;

  /** What each card draws, given the rows it is asked to show. Every card on the page is here. */
  const bodies: Record<AdvancedCardKey, (show: ShowRow, title: ReactNode, flashId?: string) => ReactNode> = {
    "general/General": (show, title) => (
      <FieldCard title={title}>
        {show("timezone") && (
          <TimezoneField
            timezone={stageState.timezone ?? null}
            hostTimezone={stageState.hostTimezone ?? "UTC"}
            onChange={handlers.handleSetTimezone}
          />
        )}
        {show("clock-format") && (
          <HourCycleField hourCycle={stageState.hourCycle ?? "24h"} onChange={handlers.handleSetHourCycle} />
        )}
        {show("context-bar") && (
          <Field orientation="horizontal" data-setting-id="context-bar">
            <FieldContent>
              <FieldLabel>{settingText("context-bar").name}</FieldLabel>
              <FieldDescription>{settingText("context-bar").description}</FieldDescription>
            </FieldContent>
            <Button variant="filled" size="small" onClick={() => setConfiguringBar(true)}>
              Configure…
            </Button>
          </Field>
        )}
      </FieldCard>
    ),

    "updates/Updates": (show, title) => (
      <CardFrame title={title} badge={updatesBadge}>
        <UpdatesPanel
          updateStatus={updateStatus}
          autoUpdate={autoUpdate}
          handlers={handlers}
          justUpdated={justUpdated ?? null}
          show={show}
        >
          {show("update-machines") && (
            <Field orientation="horizontal" data-setting-id="update-machines">
              <FieldContent>
                <FieldLabel>{settingText("update-machines").name}</FieldLabel>
                <FieldDescription>{settingText("update-machines").description}</FieldDescription>
              </FieldContent>
              <Switch
                checked={stageState.autoUpdateMachines ?? true}
                onCheckedChange={(on: boolean) =>
                  void invoke("stage:setAutoUpdateMachines", { enabled: on })
                    .catch((e: unknown) => toast.error(`Could not change this setting: ${errorMessage(e)}`))
                }
                aria-label="Update Mac output helpers and Windows kiosks with this server"
              />
            </Field>
          )}
        </UpdatesPanel>
      </CardFrame>
    ),

    "schedule/Reconnects": (show, title) => (
      <FieldCard title={title}>
        {show("reconnect-wake") && (
          <Field orientation="horizontal" data-setting-id="reconnect-wake">
            <FieldContent>
              <FieldLabel>
                {settingText("reconnect-wake").name}
                <InfoHint className="ml-1.5 align-middle">
                  Church gear is off most of the week, so retrying at full speed is wasted
                  traffic and log noise. Rehearsal and service windows come from Planning
                  Center; outside them connections back off toward the idle interval below,
                  and the Planning Center poll slows too. Nothing ever sleeps past the moment
                  the next window opens, and if the schedule cannot be worked out — no
                  credentials, a failed fetch, nothing planned — everything stays at full
                  speed rather than going quiet.
                </InfoHint>
              </FieldLabel>
              <FieldDescription>{settingText("reconnect-wake").description}</FieldDescription>
            </FieldContent>
            <Switch
              checked={rc.enabled}
              onCheckedChange={(v: boolean) => handlers.handleSetReconnectSchedule({ enabled: v })}
            />
          </Field>
        )}
        {drawsReconnectTimings(rc) && show("reconnect-lead") && (
          <Field orientation="horizontal" data-setting-id="reconnect-lead">
            <FieldContent>
              <FieldLabel>{settingText("reconnect-lead").name}</FieldLabel>
              <FieldDescription>{settingText("reconnect-lead").description}</FieldDescription>
            </FieldContent>
            <NumberInput value={rc.leadMin} min={0} max={1440} className="w-28"
              onChange={(v) => { if (v !== rc.leadMin) handlers.handleSetReconnectSchedule({ leadMin: Math.round(v) }); }}
              aria-label="Lead time before rehearsal (minutes)" />
          </Field>
        )}
        {drawsReconnectTimings(rc) && show("reconnect-tail") && (
          <Field orientation="horizontal" data-setting-id="reconnect-tail">
            <FieldContent>
              <FieldLabel>{settingText("reconnect-tail").name}</FieldLabel>
              <FieldDescription>{settingText("reconnect-tail").description}</FieldDescription>
            </FieldContent>
            <NumberInput value={rc.tailMin} min={0} max={1440} className="w-28"
              onChange={(v) => { if (v !== rc.tailMin) handlers.handleSetReconnectSchedule({ tailMin: Math.round(v) }); }}
              aria-label="Keep active after service ends (minutes)" />
          </Field>
        )}
        {drawsReconnectTimings(rc) && show("reconnect-idle") && (
          <Field orientation="horizontal" data-setting-id="reconnect-idle">
            <FieldContent>
              <FieldLabel>{settingText("reconnect-idle").name}</FieldLabel>
              <FieldDescription>{settingText("reconnect-idle").description}</FieldDescription>
            </FieldContent>
            <NumberInput value={rc.dormantMin} min={1} max={1440} className="w-28"
              onChange={(v) => { if (v !== rc.dormantMin) handlers.handleSetReconnectSchedule({ dormantMin: Math.round(v) }); }}
              aria-label="Idle retry interval (minutes)" />
          </Field>
        )}
      </FieldCard>
    ),

    "schedule/Attendance sampling": (show, title) => (
      <FieldCard title={title}>
        {show("taper-pre") && (
          <Field orientation="horizontal" data-setting-id="taper-pre">
            <FieldContent>
              <FieldLabel>{settingText("taper-pre").name}</FieldLabel>
              <FieldDescription>{settingText("taper-pre").description}</FieldDescription>
            </FieldContent>
            <NumberInput value={tw.preMin} min={0} max={240} className="w-28"
              onChange={(v) => { if (v !== tw.preMin) handlers.handleSetTaperWindow({ preMin: Math.round(v) }); }}
              aria-label="Pre-service ramp (minutes)" />
          </Field>
        )}
        {show("taper-post") && (
          <Field orientation="horizontal" data-setting-id="taper-post">
            <FieldContent>
              <FieldLabel>
                {settingText("taper-post").name}
                <InfoHint className="ml-1.5 align-middle">
                  Sampling continues even once the live plan is cleared, so an emptying room
                  is still recorded. These samples are excluded from the Peak and Lowest
                  figures — otherwise the taper would drag the low toward an empty room.
                </InfoHint>
              </FieldLabel>
              <FieldDescription>{settingText("taper-post").description}</FieldDescription>
            </FieldContent>
            <NumberInput value={tw.postMin} min={0} max={240} className="w-28"
              onChange={(v) => { if (v !== tw.postMin) handlers.handleSetTaperWindow({ postMin: Math.round(v) }); }}
              aria-label="Post-service taper (minutes)" />
          </Field>
        )}
      </FieldCard>
    ),

    "network/Addresses": (show, title) => (
      <FieldCard title={title}>
        {show("public-address") && (
          <Field orientation="vertical" data-setting-id="public-address">
            <FieldContent>
              <FieldLabel>{settingText("public-address").name}</FieldLabel>
              <FieldDescription>{settingText("public-address").description}</FieldDescription>
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
        )}
        {show("kiosk-discovery") && (
          <Field orientation="horizontal" data-setting-id="kiosk-discovery">
            <FieldContent>
              <FieldLabel>{settingText("kiosk-discovery").name}</FieldLabel>
              <FieldDescription>{settingText("kiosk-discovery").description}</FieldDescription>
            </FieldContent>
            <Switch
              checked={stageState.kioskDiscovery ?? false}
              onCheckedChange={(on: boolean) =>
                void invoke("stage:setKioskDiscovery", { enabled: on })
                  .catch((e: unknown) => toast.error(`Could not change this setting: ${errorMessage(e)}`))
              }
              aria-label="Answer kiosk devices looking for a server"
            />
          </Field>
        )}
        {show("kiosk-setup") && (
          <Field orientation="vertical" data-setting-id="kiosk-setup">
            <FieldContent>
              <FieldLabel>{settingText("kiosk-setup").name}</FieldLabel>
              <FieldDescription>{settingText("kiosk-setup").description}</FieldDescription>
            </FieldContent>
            <Button
              variant="transparent"
              size="small"
              // Keeps the button padding so the hover pill has air, and pulls it back by that much so the text still sits on the column.
              className="self-start -ml-2"
              aria-expanded={showCommands}
              onClick={() => setShowCommands((v) => !v)}
            >
              {showCommands ? "Hide commands" : "Show commands"}
            </Button>
            {showCommands && (
              <div className="flex flex-col gap-1.5">
                {[
                  ["Linux / Raspberry Pi", `curl -fsSL ${stageState.lanUrl ?? "http://<server>"}/kiosk/install-linux.sh | sudo sh`],
                  ["macOS", `curl -fsSL ${stageState.lanUrl ?? "http://<server>"}/kiosk/install-macos.sh | sudo sh`],
                  ["Windows (elevated)", `irm ${stageState.lanUrl ?? "http://<server>"}/kiosk/install-windows.ps1 | iex`],
                ].map(([os, cmd]) => (
                  <div key={os}>
                    <div className="text-caption2 text-fg-subtle">{os}</div>
                    <code className="block select-all rounded-md border border-line bg-bg px-3 py-2 font-mono text-caption1 text-fg">
                      {cmd}
                    </code>
                  </div>
                ))}
              </div>
            )}
          </Field>
        )}
      </FieldCard>
    ),

    "network/Host names": (show, title) => <HostNamesCard title={title} show={show} />,

    "data/Backups": (show, title) => (
      <CardFrame title={title}>
        {show("auto-backups") && <AutoBackupPanel />}
        {show("config-snapshot") && <ConfigSnapshotPanel />}
      </CardFrame>
    ),

    "data/Records": (show, title) => (
      <CardFrame title={title}>
        {show("data-archive") && <DataArchivePanel />}
        {show("history-milestones") && <HistoryMilestonesPanel />}
      </CardFrame>
    ),

    "video/Video relay": (show, title, flashId) => (
      <CardFrame title={title} flashId={flashId}>
        {show("video-relay-ports") && <VideoRelayPortsPanel />}
        {show("video-relay-ffmpeg") && <VideoRelayFfmpegPanel />}
      </CardFrame>
    ),
  };

  const searching = tab === SEARCH_TAB_ID;
  const trimmedQuery = query.trim();
  const undrawn = undrawnSettings(updateStatus, autoUpdate, rc);
  const hits = searching
    ? searchSettings(
        ADVANCED_SETTINGS.filter((s) => !undrawn.has(s.id)),
        query,
        ADVANCED_TABS,
      )
    : [];

  // The log is a button on every tab, not a setting row, but "log" is the first
  // thing someone typing into Search for it will try.
  const logHit = offersServerLog(query);
  const openLog = () => window.open("/log", "_blank", "noreferrer");

  let panel: ReactNode;
  if (searching) {
    const matched = new Set<string>(hits.map((h) => h.setting.id));
    // Cards in the order of their best hit; the rows inside a card keep the card's own order.
    const cards = cardsByBestHit(hits.map((h) => ({ setting: h.setting, rank: h.rank })));
    panel = (
      <div className="flex flex-col gap-4">
        <AdvancedSearchBox value={query} onChange={setQuery} inputRef={searchRef} />
        {trimmedQuery === "" ? (
          <p className="py-7 text-center text-footnote text-fg-muted">
            Type to search every Advanced setting.{" "}
            <kbd className="rounded border border-line-strong px-1.5 py-px font-mono text-caption1 text-fg">
              {searchShortcutLabel()}
            </kbd>{" "}
            brings you here from any tab.
          </p>
        ) : hits.length === 0 && !logHit ? (
          <p className="py-7 text-center text-footnote text-fg-muted">No setting matches “{trimmedQuery}”.</p>
        ) : (
          <>
            {hits.length > 0 && (
              <p className="text-caption1 text-fg-muted" aria-live="polite">
                {plural(hits.length, "setting")} {hits.length === 1 ? "matches" : "match"} “{trimmedQuery}”
              </p>
            )}
            {logHit && (
              <div className="su-card flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-callout font-semibold text-fg">Server log</span>
                  <span className="text-caption1 text-fg-muted">
                    The raw log, for diagnosing a problem. Also the button at the top of every tab.
                  </span>
                </div>
                <Button variant="filled" size="small" onClick={openLog}>
                  <FileTextIcon className="size-3.5 text-gray-9" /> Open
                </Button>
              </div>
            )}
            {cards.map((c) => (
              <div key={c.key}>
                {bodies[c.key](
                  (id) => matched.has(id),
                  <>
                    <button
                      type="button"
                      onClick={() => goTo(c.tab)}
                      className="rounded-sm font-semibold text-fg hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
                    >
                      {tabName(c.tab)}
                    </button>
                    {c.name !== tabName(c.tab) && (
                      <>
                        {" "}
                        <span className="text-fg-subtle" aria-hidden="true">›</span> {c.name}
                      </>
                    )}
                  </>,
                )}
              </div>
            ))}
          </>
        )}
      </div>
    );
  } else {
    const cards = ADVANCED_CARDS.filter((c) => c.tab === tab);
    const draw = (c: (typeof cards)[number]) => (
      <div key={c.key}>{bodies[c.key](SHOW_ALL, c.name, CARD_FLASH_IDS[c.key])}</div>
    );
    // Each column stacks on its own, so a tall card does not leave a gap under its neighbour.
    panel =
      cards.length > 1 ? (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-6">{cards.filter((_, i) => i % 2 === 0).map(draw)}</div>
          <div className="flex min-w-0 flex-col gap-6">{cards.filter((_, i) => i % 2 === 1).map(draw)}</div>
        </div>
      ) : (
        cards.map(draw)
      );
  }

  return (
    <div className="flex flex-col gap-4 pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-title3 font-semibold text-fg">Advanced</h1>
        {/* Opens the raw server log in a new tab. */}
        <Button variant="transparent" onClick={openLog} className="border border-line-strong">
          <FileTextIcon className="size-4 text-fg-muted" /> Server log
        </Button>
      </div>

      {justUpdated ? <JustUpdatedBanner updateStatus={updateStatus} justUpdated={justUpdated} onDismiss={onDismissJustUpdated} /> : null}

      <AdvancedTabBar tab={tab} onSelect={goTo} onMove={(next) => goTo(next, false)} signals={signals} />

      <div role="tabpanel" id={ADVANCED_PANEL_ID} aria-labelledby={tabButtonId(tab)} className="flex flex-col gap-6">
        {panel}
      </div>

      <BarConfigurator open={configuringBar} onOpenChange={setConfiguringBar} />
    </div>
  );
}
