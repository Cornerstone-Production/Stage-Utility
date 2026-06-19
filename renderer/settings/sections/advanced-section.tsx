import { useState, type ChangeEvent } from "react";
import { Loader2Icon, RefreshCwIcon, DownloadIcon, CheckCircle2Icon, AlertTriangleIcon } from "lucide-react";
import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Switch,
  Input,
  Button,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "../../components/ui";
import type { SectionProps } from "../types";

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ANY_DAY = "any";

// Fallback when the backend predates the in-app updater (#48) and omits `autoUpdate`
// — e.g. a server that hasn't been restarted after a frontend deploy, or the brief
// window during an in-app self-update. Mirrors the backend default so a newer bundle
// never crashes against an older API. Keep in sync with settings-store DEFAULT_SETTINGS.
const DEFAULT_AUTO_UPDATE: StageState["autoUpdate"] = { enabled: false, dayOfWeek: null, hour: 3 };

function formatHour(h: number): string {
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${am ? "AM" : "PM"}`;
}

function UpdatesPanel({
  updateStatus,
  autoUpdate,
  handlers,
}: {
  updateStatus: SectionProps["updateStatus"];
  autoUpdate: StageState["autoUpdate"];
  handlers: SectionProps["handlers"];
}) {
  const s = updateStatus;
  const updating = s?.phase === "updating";
  const behind = s?.behind ?? 0;

  function onUpdateNow() {
    if (window.confirm("Update now? The displays will go blank and reload for a few seconds while the server restarts.")) {
      handlers.handleApplyUpdate();
    }
  }

  // Not a git checkout → can't self-update.
  if (s && !s.isGitRepo) {
    return (
      <FieldSet title="Updates">
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
    <FieldSet title="Updates">
      <FieldGroup>
        <Field orientation="vertical">
          <FieldContent>
            <FieldLabel>
              {!s ? "Checking for updates…" : behind > 0 ? `${behind} update${behind === 1 ? "" : "s"} available` : "Up to date"}
            </FieldLabel>
            <FieldDescription>
              {s ? (
                <>
                  Running v{s.version}
                  {s.currentSha ? ` · ${s.currentSha}` : ""}
                  {s.currentDate ? ` · ${new Date(s.currentDate).toLocaleDateString()}` : ""}
                  {s.branch ? ` (${s.branch})` : ""}.
                  {s.lastCheckedAt ? ` Last checked ${new Date(s.lastCheckedAt).toLocaleString()}.` : ""}
                </>
              ) : (
                "Comparing this install against the latest release…"
              )}
            </FieldDescription>

            {/* Changelog of pending commits */}
            {behind > 0 && s?.changelog?.length ? (
              <ul className="mt-1 flex flex-col gap-0.5 rounded-md border border-gray-a4 bg-gray-a2 p-2 text-caption2 text-gray-11 max-h-40 overflow-y-auto">
                {s.changelog.map((line, i) => (
                  <li key={i} className="truncate">• {line}</li>
                ))}
              </ul>
            ) : null}

            {/* Last apply result */}
            {s?.lastResult && !s.lastResult.ok ? (
              <p className="mt-1 flex items-start gap-1.5 text-caption2 text-red-10">
                <AlertTriangleIcon className="size-3.5 shrink-0 mt-0.5" />
                Last update failed{s.lastResult.finishedAt ? ` (${new Date(s.lastResult.finishedAt).toLocaleString()})` : ""}.
                {s.lastResult.log ? ` ${s.lastResult.log.split("\n").filter(Boolean).slice(-1)[0]}` : ""}
              </p>
            ) : null}
            {s && behind === 0 && !updating && (!s.lastResult || s.lastResult.ok) ? (
              <p className="mt-1 flex items-center gap-1.5 text-caption2 text-green-10">
                <CheckCircle2Icon className="size-3.5" /> You're on the latest version.
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
          </div>
        </Field>

        {/* Automatic updates */}
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Automatic updates</FieldLabel>
            <FieldDescription>
              Install available updates automatically during the chosen weekly window. Updates are
              skipped while a Planning Center service is live, so a display never restarts mid-service.
            </FieldDescription>
          </FieldContent>
          <Switch
            checked={autoUpdate.enabled}
            onCheckedChange={(v: boolean) => handlers.handleSetAutoUpdate({ enabled: v })}
          />
        </Field>

        {autoUpdate.enabled ? (
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

export function AdvancedSection({ stageState, updateStatus, handlers }: Pick<SectionProps, "stageState" | "updateStatus" | "handlers">) {
  // Local field state so typing doesn't fight the live store; commit on blur.
  const [publicUrl, setPublicUrl] = useState(stageState.publicUrl ?? "");

  function commitPublicUrl() {
    const trimmed = publicUrl.trim();
    if (trimmed === (stageState.publicUrl ?? "")) return;
    handlers.handleSetPublicUrl(trimmed || null);
  }

  return (
    <div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
      <UpdatesPanel updateStatus={updateStatus} autoUpdate={stageState.autoUpdate ?? DEFAULT_AUTO_UPDATE} handlers={handlers} />

      <FieldSet title="Advanced">
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
    </div>
  );
}
