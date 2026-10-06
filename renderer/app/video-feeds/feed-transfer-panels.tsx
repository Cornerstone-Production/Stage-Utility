// feed-transfer-panels.tsx — moving video feeds between servers: the Export
// and Import panels that open in the Video feeds page's right column.
//
// Export is a plain download link built from the chosen options, so the browser
// takes the filename from Content-Disposition. Import is pick a file, review
// every feed against what is here, then one request that carries the choices;
// the review is the server's own comparison (POST /api/video/import/preview),
// never a second one computed here.

import { useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { hostTimeZone, zonedDateKey } from "@main/services/app-timezone";
import { errorMessage } from "@main/services/errors";
import { plural } from "@main/services/plural";
import {
  PUSH_PROTOCOL_LABEL,
  type FeedDifference,
  type ImportChoice,
  type ImportFeedPreview,
  type ImportPreview,
  type ImportReport,
  type VideoFeedView,
  type VideoFeedsBundle,
  type VideoPorts,
  type VideoSource,
} from "@main/types/video";

import { Button, Checkbox, ErrorNote, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";
import { cn } from "../../lib/cn";
import { invoke } from "../../lib/api";
import { joinWithAnd } from "../../lib/join-with-and";
import { useStageState } from "../../main/use-stage-state";
import { SIDE_PANE } from "./side-pane";

const BUNDLE_KIND = "stage-utility-video-feeds";

const LABEL = "text-caption2 font-semibold uppercase tracking-wider text-fg-subtle";
const MONO = "font-mono text-caption1 text-fg-muted [overflow-wrap:anywhere]";


/** The short line under a feed's name: the address, or the kind and protocol. */
function briefSource(s: VideoSource): string {
  switch (s.kind) {
    case "pull":
    case "external":
      return s.url;
    case "push":
      return `push · ${PUSH_PROTOCOL_LABEL[s.protocol]}`;
    case "embed":
      return `embed · ${s.player === "resi" ? "Resi" : "YouTube"}`;
  }
}

function Note({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        "rounded-lg px-2.5 py-2 text-caption1",
        tone === "warn" ? "bg-warn-9/10 text-warn-11" : "bg-info-9/10 text-info-11",
      )}
    >
      {children}
    </p>
  );
}

// ── Export ──────────────────────────────────────────────────────────────

export interface ExportChoice {
  /** Every feed here, and which of them are ticked. */
  allIds: string[];
  chosenIds: string[];
  ports: boolean;
  passwords: boolean;
}

/** The download address. Every feed ticked sends no `feeds` at all, which the
 *  server reads as "all of them", so a feed added later is not left out. */
export function exportHref(c: ExportChoice): string {
  const q: string[] = [];
  if (c.chosenIds.length < c.allIds.length) q.push(`feeds=${c.chosenIds.map(encodeURIComponent).join(",")}`);
  if (c.ports) q.push("ports=1");
  if (c.passwords) q.push("passwords=1");
  return `/api/video/export${q.length ? `?${q.join("&")}` : ""}`;
}

/** The ports as one line: the three LAN inputs, then a count of the rest. */
function portsLine(p: VideoPorts): string {
  return `RTMP ${p.rtmp} · SRT ${p.srt} · UDP ${p.webrtcUdp} · and three loopback ports`;
}

/** A group checkbox's state: all ticked, none, or some. */
function groupState(ticked: number, total: number): boolean | "indeterminate" {
  if (ticked === total) return true;
  return ticked === 0 ? false : "indeterminate";
}

/** The group checkbox's label: "All 3 feeds", "2 of 3 feeds", and "1 feed" for a single one. */
export function groupLabel(ticked: number, total: number): string {
  if (ticked !== total) return `${ticked} of ${total} feeds`;
  return total === 1 ? "1 feed" : `All ${total} feeds`;
}

/** A push feed always has a publish password; a pull feed has one only when it was saved. */
function passwordKind(f: VideoFeedView): "publish" | "camera" | null {
  if (f.source.kind === "push") return "publish";
  if (f.source.kind === "pull" && f.hasPassword) return "camera";
  return null;
}


export function ExportPanel({ feeds, ports }: { feeds: VideoFeedView[]; ports: VideoPorts }) {
  // The server names the file by the app's date, not the browser's.
  const timeZone = useStageState().state?.timezone ?? null;
  const [openedAt] = useState(() => Date.now());
  // Feeds the operator unticked, so a feed that arrives while the panel is open
  // starts ticked like the rest.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [withPorts, setWithPorts] = useState(false);
  const [withPasswords, setWithPasswords] = useState(false);

  const chosen = feeds.filter((f) => !unticked.has(f.id));
  const holders = chosen.flatMap((f) => {
    const kind = passwordKind(f);
    return kind ? [{ name: f.name, kind }] : [];
  });
  const passwords = withPasswords && holders.length > 0;
  const none = chosen.length === 0;
  const publishNames = holders.filter((h) => h.kind === "publish").map((h) => h.name);
  const cameraNames = holders.filter((h) => h.kind === "camera").map((h) => h.name);

  const setTicked = (id: string, on: boolean): void => {
    const next = new Set(unticked);
    if (on) next.delete(id);
    else next.add(id);
    setUnticked(next);
  };

  return (
    <aside aria-label="Export video feeds" className={SIDE_PANE}>
      <h2 className="text-subheadline font-semibold text-fg">Export video feeds</h2>

      <div className="flex flex-col gap-1.5">
        <div className={LABEL}>Feeds</div>
        <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-field p-2.5">
          <label className="flex items-start gap-2 text-footnote text-fg">
            <Checkbox
              // A partly-ticked group paints as `mixed`, which the base look does not cover.
              className="mt-0.5 aria-[checked=mixed]:border-accent aria-[checked=mixed]:bg-accent"
              checked={groupState(chosen.length, feeds.length)}
              onCheckedChange={(v) => setUnticked(v === true ? new Set() : new Set(feeds.map((f) => f.id)))}
              aria-label="All feeds"
            />
            <span className="font-semibold">
              {groupLabel(chosen.length, feeds.length)}
            </span>
          </label>
          {feeds.map((f) => (
            <label key={f.id} className="flex items-start gap-2 text-footnote text-fg">
              <Checkbox
                className="mt-0.5"
                checked={!unticked.has(f.id)}
                onCheckedChange={(v) => setTicked(f.id, v === true)}
                aria-label={f.name}
              />
              <span className="min-w-0">
                {f.name}
                <span className={cn("block", MONO)}>{briefSource(f.source)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className={LABEL}>Also include</div>
        <label className="flex items-start gap-2 text-footnote text-fg">
          <Checkbox className="mt-0.5" checked={withPorts} onCheckedChange={(v) => setWithPorts(v === true)} aria-label="Relay ports" />
          <span className="min-w-0">
            Relay ports
            <span className={cn("block", MONO)}>{portsLine(ports)}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-footnote text-fg">
          <Checkbox
            className="mt-0.5"
            checked={passwords}
            disabled={holders.length === 0}
            onCheckedChange={(v) => setWithPasswords(v === true)}
            aria-label="Passwords"
          />
          <span className="min-w-0">
            Passwords
            <span className={cn("block", MONO)}>
              {holders.length === 0
                ? "None of these feeds has one"
                : `${plural(holders.length, "feed has", "feeds have")} one: ${holders.map((h) => `${h.name} (${h.kind})`).join(", ")}`}
            </span>
          </span>
        </label>
        {passwords && (
          <Note tone="warn">
            The file will hold these passwords in plain text. Anyone with the file can{" "}
            {[
              publishNames.length ? `publish to ${joinWithAnd(publishNames)}` : "",
              cameraNames.length
                ? `log in to the ${joinWithAnd(cameraNames)} ${cameraNames.length === 1 ? "camera" : "cameras"}`
                : "",
            ].filter(Boolean).join(" and ")}
            . Keep it off shared drives.
          </Note>
        )}
      </div>

      <Note tone="info">
        Feeds keep their ids, so a view moved with them finds its Video widgets&apos; feeds on the other server.
      </Note>
      <div className={MONO}>stage-utility-video-feeds-{zonedDateKey(openedAt, timeZone ?? hostTimeZone())}.json</div>
      <div className="flex justify-end pt-1">
        {none ? (
          <Button variant="accent" size="small" disabled>
            Choose a feed
          </Button>
        ) : (
          <Button variant="accent" size="small" asChild>
            <a
              href={exportHref({ allIds: feeds.map((f) => f.id), chosenIds: chosen.map((f) => f.id), ports: withPorts, passwords })}
              download
            >
              <DownloadIcon className="size-3.5" /> Download
            </a>
          </Button>
        )}
      </div>
    </aside>
  );
}

// ── Import ──────────────────────────────────────────────────────────────

const FIELD_LABEL: Record<FeedDifference["field"], string> = {
  name: "name",
  kind: "source",
  url: "address",
  username: "username",
  protocol: "protocol",
  player: "player",
  ref: "video or channel",
  password: "password",
};

const KIND_WORD: Record<string, string> = { pull: "pulled", push: "pushed", embed: "embed", external: "other address" };

function shown(field: FeedDifference["field"], v: string | undefined): string {
  if (v === undefined || v === "") return "(none)";
  return field === "kind" ? (KIND_WORD[v] ?? v) : v;
}

function DiffLine({ d }: { d: FeedDifference }) {
  if (d.field === "password") return <div className={MONO}>password differs</div>;
  return (
    <div className={MONO}>
      {FIELD_LABEL[d.field]} <del className="text-danger-11">{shown(d.field, d.here)}</del> →{" "}
      <ins className="text-ok-11 no-underline">{shown(d.field, d.file)}</ins>
    </div>
  );
}

const TAG: Record<ImportFeedPreview["status"], { text: string; cls: string }> = {
  new: { text: "New", cls: "bg-info-9/10 text-info-11" },
  same: { text: "Same as here", cls: "bg-fill text-fg-muted" },
  differs: { text: "Differs", cls: "bg-warn-9/14 text-warn-11" },
  invalid: { text: "Can't import", cls: "bg-danger-9/10 text-danger-11" },
};

interface Picked {
  filename: string;
  bundle: VideoFeedsBundle;
  preview: ImportPreview;
}

export function ImportPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [choices, setChoices] = useState<ReadonlyMap<string, ImportChoice>>(new Map());
  const [usePorts, setUsePorts] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function take(file: File): Promise<void> {
    // A drop while a file is already being reviewed would race it: whichever
    // preview answered last would win, not the file chosen last.
    if (busy) return;
    setError(null);
    setReport(null);
    setBusy(true);
    try {
      let bundle: VideoFeedsBundle;
      try {
        bundle = JSON.parse(await file.text()) as VideoFeedsBundle;
      } catch {
        throw new Error("That file is not JSON, so it is not a video feeds export.");
      }
      // Refused by name here as well as on the server, so picking a view or
      // config file by mistake is explained without a round trip.
      if (bundle?.kind !== BUNDLE_KIND) {
        throw new Error(`That is a "${String(bundle?.kind ?? "unknown").slice(0, 60)}" file, not a video feeds export.`);
      }
      const preview = await invoke<ImportPreview>("video:previewImport", { bundle });
      setChoices(new Map());
      setUsePorts(false);
      setPicked({ filename: file.name, bundle, preview });
    } catch (err) {
      setPicked(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // The file's own source for each feed, found by id: the review's rows are
  // the server's order, which nothing here may assume matches the file's.
  const fileSources = new Map((picked?.bundle.feeds ?? []).map((f) => [f.id, f.source]));
  const choiceFor = (id: string): ImportChoice => choices.get(id) ?? "replace";
  const toImport = picked
    ? picked.preview.feeds.filter((f) => f.status === "new" || (f.status === "differs" && choiceFor(f.id) === "replace")).length
    : 0;
  const portsDiffer = !!picked?.preview.ports && !picked.preview.ports.same;
  const portsOn = portsDiffer && usePorts;

  async function confirm(): Promise<void> {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<ImportReport>("video:importFeeds", {
        bundle: picked.bundle,
        choices: Object.fromEntries(
          picked.preview.feeds.filter((f) => f.status === "differs").map((f) => [f.id, choiceFor(f.id)]),
        ),
        // What the review showed, so a feed edited here since is not overwritten unseen.
        expect: Object.fromEntries(picked.preview.feeds.map((f) => [f.id, f.here ?? ""])),
        ports: portsOn,
      });
      setReport(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const again = (): void => {
    setPicked(null);
    setReport(null);
    setError(null);
  };

  return (
    <aside aria-label="Import video feeds" className={SIDE_PANE}>
      <h2 className="text-subheadline font-semibold text-fg">Import video feeds</h2>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        aria-label="Video feeds file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Cleared so choosing the same file twice fires onChange again.
          e.target.value = "";
          if (f) void take(f);
        }}
      />
      {error && <ErrorNote>{error}</ErrorNote>}

      {!picked && !report && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void take(f);
          }}
          className={cn(
            "flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-footnote text-fg-muted",
            dragging && "border-accent",
          )}
        >
          Drop a video feeds file here
          <Button variant="filled" size="small" disabled={busy} onClick={() => fileRef.current?.click()}>
            Choose file…
          </Button>
        </div>
      )}

      {picked && !report && (
        <>
          <div className={MONO}>
            {picked.filename} · from {picked.preview.server || "an unnamed server"} · {plural(picked.preview.feeds.length, "feed")} ·{" "}
            {picked.preview.hasPasswords ? "with passwords" : "no passwords"}
          </div>
          <div className="flex flex-col">
            {picked.preview.feeds.map((f) => (
              <FeedRow
                key={f.id}
                feed={f}
                source={fileSources.get(f.id)}
                choice={choiceFor(f.id)}
                onChoice={(c) => setChoices(new Map(choices).set(f.id, c))}
              />
            ))}
          </div>
          {picked.preview.absent.length > 0 && (
            <p className="text-caption1 text-fg-muted">
              {joinWithAnd(picked.preview.absent)} {picked.preview.absent.length === 1 ? "is" : "are"} not in the file. They stay as they
              are; an import never removes a feed.
            </p>
          )}
          {picked.preview.ports && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-field p-2.5">
              {picked.preview.ports.same ? (
                <span className="text-footnote text-fg-muted">The file&apos;s relay ports are the same as here.</span>
              ) : (
                <label className="flex items-start gap-2 text-footnote text-fg">
                  <Checkbox
                    className="mt-0.5"
                    checked={usePorts}
                    onCheckedChange={(v) => setUsePorts(v === true)}
                    aria-label="Use the file's relay ports"
                  />
                  <span className="min-w-0">
                    Use the file&apos;s relay ports
                    <span className={cn("block", MONO)}>{portsLine(picked.preview.ports.file)}</span>
                    <span className={cn("block", MONO)}>This server: {portsLine(picked.preview.ports.here)}</span>
                    <span className="block text-caption1 text-fg-subtle">A running relay restarts on the new ports.</span>
                  </span>
                </label>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="transparent" size="small" onClick={again} disabled={busy}>
              Cancel
            </Button>
            <Button variant="accent" size="small" onClick={() => void confirm()} disabled={busy || (toImport === 0 && !portsOn)}>
              {toImport === 0 && !portsOn ? "Nothing to import" : `Import ${plural(toImport, "feed")}`}
            </Button>
          </div>
        </>
      )}

      {report && picked && <ImportDone report={report} preview={picked.preview} onAgain={again} />}
    </aside>
  );
}

function FeedRow({
  feed,
  source,
  choice,
  onChoice,
}: {
  feed: ImportFeedPreview;
  source: VideoSource | undefined;
  choice: ImportChoice;
  onChoice: (c: ImportChoice) => void;
}) {
  const tag = TAG[feed.status];
  return (
    <div className="flex flex-col gap-1 border-b border-line py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-footnote font-semibold text-fg">{feed.name}</span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-caption2 font-medium", tag.cls)}>{tag.text}</span>
        {feed.status === "differs" && (
          <Select value={choice} onValueChange={(v) => onChoice(v as ImportChoice)}>
            <SelectTrigger aria-label={`${feed.name}: which to keep`} className="w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="replace">Use the file&apos;s</SelectItem>
              <SelectItem value="keep">Keep this server&apos;s</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
      {feed.status === "differs" && feed.differences.map((d) => <DiffLine key={d.field} d={d} />)}
      {feed.status === "new" && source && <div className={MONO}>{briefSource(source)}</div>}
      {feed.status === "invalid" && feed.error && <div className="text-caption1 text-danger-11">{feed.error}</div>}
      {feed.kind === "push" && feed.status !== "invalid" && !feed.filePassword && (
        <div className={MONO}>
          {feed.status === "new" ? "push · a new publish password is made here" : "push · keeps this server's publish password"}
        </div>
      )}
    </div>
  );
}

function ImportDone({ report, preview, onAgain }: { report: ImportReport; preview: ImportPreview; onAgain: () => void }) {
  const landed = report.added.length + report.replaced.length;
  const newPull = preview.feeds
    .filter((f) => f.status === "new" && f.kind === "pull" && report.addedIds.includes(f.id))
    .map((f) => f.name);
  return (
    <div className="flex flex-col gap-2 text-footnote text-fg">
      <div className="font-semibold">Imported {plural(landed, "feed")}</div>
      <ul className="flex list-disc flex-col gap-1 pl-4">
        {report.added.length > 0 && <li>Added {joinWithAnd(report.added)}</li>}
        {report.replaced.length > 0 && <li>Replaced {joinWithAnd(report.replaced)} with the file&apos;s</li>}
        {report.kept.length > 0 && <li>Kept this server&apos;s {joinWithAnd(report.kept)}</li>}
        {report.same.length > 0 && (
          <li>
            {joinWithAnd(report.same)} {report.same.length === 1 ? "was" : "were"} already the same
          </li>
        )}
        {report.skipped.map((k, i) => (
          <li key={`${i}:${k.name}`}>
            Skipped {k.name}: {k.reason}
          </li>
        ))}
        {report.passwordsWritten > 0 && <li>Saved {plural(report.passwordsWritten, "password")} from the file</li>}
        {report.portsApplied && <li>Relay ports changed to the file&apos;s</li>}
      </ul>
      {report.portsError && <Note tone="warn">The relay ports were not changed: {report.portsError}</Note>}
      {report.newPushPasswords.length > 0 && (
        <Note tone="warn">
          {joinWithAnd(report.newPushPasswords)} {report.newPushPasswords.length === 1 ? "has" : "have"} a new publish password on this
          server: paste the new publish password into each device.
        </Note>
      )}
      {newPull.length > 0 && (
        <Note tone="info">
          {joinWithAnd(newPull)} {newPull.length === 1 ? "is" : "are"} pulled from {newPull.length === 1 ? "a device" : "devices"} on the
          network the file came from. {newPull.length === 1 ? "It plays" : "They play"} here only if this server can reach{" "}
          {newPull.length === 1 ? "its" : "their"} device address{newPull.length === 1 ? "" : "es"}.
        </Note>
      )}
      <div className="flex justify-end pt-1">
        <Button variant="filled" size="small" onClick={onAgain}>
          Import another
        </Button>
      </div>
    </div>
  );
}
