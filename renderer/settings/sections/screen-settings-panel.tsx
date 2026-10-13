// The side panel on the Screens page: the settings of whatever the operator has
// pointed it at.
//
// FOUR THINGS IT CAN BE ON.
//
//   nothing  The empty state, with a way to add a screen.
//   edit     A screen's settings. Changes save as they are made, each through
//            the per-field handler the card's menu used, so the card beside it
//            shows what a change did.
//   view     A view's settings: what it is, whether the sidebar lists it, which
//            screens show it, its layout.
//   new      Two steps for a screen that does not exist yet: its name, then what
//            it shows. NOTHING is created until "Create screen", and closing the
//            panel creates nothing at all.
//
// The panel reads only props and calls only callbacks, so it can be driven with
// no server behind it. ScreenPanelHost is the one place that knows which handler
// each callback is.
//
// A screen is a control surface (its buttons work for anyone at it) exactly when
// the view it shows is a console, and a read-only wall display otherwise. A
// screen's panel says which in one line under its view picker, and picking a view
// of the other kind asks first, because the screen's buttons go live or stop.
// What a view is for is set in View settings, which names every screen it changes.

import { useState, type FormEvent } from "react";
import { CopyIcon, PanelRightIcon, XIcon } from "lucide-react";

import { Button, Checkbox, ErrorNote, NumberInput, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tooltip, toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { errorMessage } from "@main/services/errors";
import { KIND_DRAWS_TOP_BAR, screenIsControlSurface, viewShownInSidebar, viewSurface, type CreateScreenInput, type ViewSurface } from "@main/types/views";
import { useResyncOn } from "../../lib/use-resync-on";
import { NONE, chooseViewForScreen } from "../screen-role-confirm";
import { useDevices } from "../../app/screens/use-devices";
import { releaseDevice } from "../../app/screens/screen-device";
import { cardOf, outputModeLine } from "../../app/screens/output-helpers";
import { modeChoices, ROTATIONS, type Rotation } from "@main/types/output-format";
import type { DeviceOutput } from "@main/types/kiosk";
import type { OutputHealth } from "@main/types/output-health";
import type { MessageGroups } from "../../main/use-message-groups";
import type { CreateScreenOutcome } from "../types";
import {
  DangerButton, NameInput, PanelFooter, RoleLine, Section, SettingRow, SidebarRow, SlugInput, SwitchRow, ViewPicker, viewGroups,
} from "./screen-panel-parts";
import { NewScreenBody, STEP_TITLES, type Step } from "./new-screen-body";
import { ViewBody } from "./view-settings-body";

/** What the panel is open on. */
export type PanelTarget =
  /** `created`: the screen was made a moment ago, so its panel says so. */
  | { kind: "edit"; outputId: string; created?: { viewMade: boolean } }
  | { kind: "view"; viewId: string }
  /** A new screen. `device` is the unclaimed machine it is being set up for.
   *  `defaultName` is what the name field starts with; empty sends no name, and
   *  the server names the screen from its id. `start` tells one start from the next:
   *  pressing Add a screen again begins a new form rather than continuing the last. */
  | { kind: "new"; device: PanelDevice | null; defaultName: string; start?: number };

/** An unclaimed device, as the guided panel needs to name it. */
export interface PanelDevice {
  id: string;
  hostname?: string;
  ip?: string;
  /** What to call the screen when it differs from the hostname: an output of a
   *  Mac output helper is named for the output. */
  name?: string;
}

/** Everything the panel does to the outside world, as callbacks, so the panel
 *  itself reads from props and a test can drive it with no server behind it. */
export interface ScreenPanelActions {
  onRename: (id: string, name: string) => void;
  /** Rejects with the server's reason, which the panel shows without closing. */
  onSetSlug: (id: string, slug: string) => Promise<void>;
  onSetView: (id: string, viewId: string | null, expectSurface?: ViewSurface) => void;
  onSetLocked: (id: string, locked: boolean) => void;
  onSetHideTopBar: (id: string, hideTopBar: boolean) => void;
  onSetTextSize: (id: string, size: number) => void;
  onSetRotation: (id: string, rotation: Rotation) => void;
  onSetVideoMode: (id: string, videoMode: string) => void;
  onSetAllowHls: (id: string, allowHls: boolean) => void;
  onSetGroups: (id: string, groups: string[]) => void;
  onSetShowInSidebar: (viewId: string, show: boolean) => void;
  onOpenMessagingSettings: () => void;
  /** Open the new-view dialog for this screen, for a view of this kind. */
  onRequestNewView: (outputId: string, surface: ViewSurface) => void;
  /** Make the screen. `refused` says why it was not; `viewChanged` is a view that
   *  changed kind while the operator was deciding. */
  onCreate: (input: CreateScreenInput, device: PanelDevice | null) => Promise<CreateScreenOutcome>;
  /** Point the panel at something else: a view's screens, a screen's view. */
  onSelect: (target: PanelTarget) => void;
  /** Start a new screen. */
  onAddScreen: () => void;
  /** Open a view's layout editor. */
  onEditLayout: (viewId: string) => void;
  /** Ask, then remove a screen (and its view, if the operator says so). */
  onRemoveScreen: (outputId: string) => void;
  onRenameView: (viewId: string, name: string) => void;
  /** Change what a view is for. Asks first when screens show it. */
  onSetViewSurface: (viewId: string, surface: ViewSurface) => void;
  onDuplicateView: (viewId: string) => void;
  /** Ask, then delete a view. */
  onDeleteView: (viewId: string) => void;
}

export interface ScreenSettingsPanelProps {
  /** What it is open on; null for nothing yet. */
  target: PanelTarget | null;
  outputs: Output[];
  /** Every view a screen could show (Home already left out). */
  views: View[];
  baseUrl: string;
  /** Whether a screen is connected to the one being edited. */
  online: boolean;
  messageGroups: MessageGroups;
  actions: ScreenPanelActions;
  onClose: () => void;
}

/** Which new screen a form belongs to: another device, or another start, is another form. */
const newScreenKey = (target: Extract<PanelTarget, { kind: "new" }>): string => `${target.device?.id ?? "add"}:${target.start ?? 0}`;

/** The panel's element id: there is one panel on the page, and the card menu that
 *  opens it needs to hand focus to it once the menu has finished closing. */
export const SCREEN_PANEL_ID = "screen-settings-panel";

// ── Small parts ──────────────────────────────────────────────────────────

/** The friendly link, saved with an explicit Save so a refusal stays on screen:
 *  the server is the authority on what a slug may be (a reserved word does not
 *  error at request time, it silently serves that page instead of the display). */
function SlugField({
  slug,
  baseUrl,
  onSave,
}: {
  slug: string;
  baseUrl: string;
  onSave: (slug: string) => Promise<void>;
}) {
  const [value, setValue] = useState(slug);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useResyncOn([slug], () => {
    setValue(slug);
    setError(null);
  });
  const next = value.trim().toLowerCase();

  async function save(e: FormEvent) {
    e.preventDefault();
    if (next === slug) return;
    setBusy(true);
    try {
      await onSave(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)}>
      <SlugInput id="screen-slug" baseUrl={baseUrl} value={value} onChange={setValue}>
        {next !== slug && (
          <Button type="submit" variant="accent" size="small" disabled={busy} className="h-8">
            Save
          </Button>
        )}
      </SlugInput>
      {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
    </form>
  );
}

/** One checkbox per message group, in the config's order. */
function GroupsChecklist({
  messageGroups,
  inGroups,
  onSetGroups,
  onOpenMessagingSettings,
}: {
  messageGroups: MessageGroups;
  inGroups: readonly string[];
  onSetGroups: (groups: string[]) => void;
  onOpenMessagingSettings: () => void;
}) {
  // The whole new list goes out, never the one id clicked: it is what the server
  // stores, in the config's order. Built from the config's own groups, so an id
  // the config no longer holds is not sent back and refused.
  function toggle(id: string, on: boolean) {
    const chosen = new Set(inGroups);
    if (on) chosen.add(id);
    else chosen.delete(id);
    onSetGroups(messageGroups.groups.map((g) => g.id).filter((x) => chosen.has(x)));
  }
  if (messageGroups.groups.length === 0) {
    if (messageGroups.failed) return <p className="text-caption1 text-danger-11">Couldn't load the groups.</p>;
    if (!messageGroups.known) return <p className="text-caption1 text-fg-subtle">Loading groups...</p>;
    return (
      <button type="button" onClick={() => onOpenMessagingSettings()} className="text-left text-footnote text-accent hover:underline">
        No groups yet. Make some in Settings → Messages
      </button>
    );
  }
  return (
    <div className="grid gap-1">
      {messageGroups.groups.map((g) => (
        <label key={g.id} className="flex cursor-pointer items-center gap-2.5 py-0.5 text-footnote text-fg">
          <Checkbox checked={inGroups.includes(g.id)} onCheckedChange={(on) => toggle(g.id, on === true)} />
          {g.name}
        </label>
      ))}
    </div>
  );
}

// ── Edit mode ────────────────────────────────────────────────────────────

/** One of the three figures under Rotation. */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-line bg-fill px-2.5 py-1.5">
      <b className="block text-callout font-semibold tabular-nums text-fg">{value}</b>
      <span className="text-caption2 text-fg-subtle">{label}</span>
    </div>
  );
}

/**
 * The Device section for a screen shown by one output of a Mac output helper:
 * which port, what it sends, how far it is turned, and how it is doing.
 *
 * Format is DeckLink only: a display runs at whatever the Mac drives it at.
 */
function OutputDeviceSection({ output, device, online, health, reported, actions }: {
  output: Output;
  device: { id: string; hostname?: string; ip?: string; label?: string; output: DeviceOutput };
  online: boolean;
  health: OutputHealth | undefined;
  /** Whether it has reported at any time since the page loaded. */
  reported: boolean;
  actions: ScreenPanelActions;
}) {
  const [busy, setBusy] = useState(false);
  const rotation = output.rotation ?? 0;
  const sideways = rotation === 90 || rotation === 270;
  const mode = outputModeLine(device.output, output.videoMode, undefined);
  const who = [device.hostname || device.label || "Set up on a device", device.output.port].join(" · ");
  const via = [cardOf(device.output), device.ip ? `via the output helper on ${device.ip}` : "via the output helper"].join(" · ");

  return (
    <div>
      <div className="flex items-start justify-between gap-3 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-footnote font-medium text-fg">{who}</div>
          <div className="mt-px text-caption1 text-fg-subtle">{via}</div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-caption2 text-fg-muted">
          <span className={cn("size-2 rounded-full", online ? "bg-ok-9" : "bg-fg-faint")} />
          {online ? "Online" : "Offline"}
        </span>
      </div>

      {device.output.kind === "decklink" && (
        <SettingRow label="Format" help="What the port sends. The house standard is the default.">
          <Select value={mode} onValueChange={(v: string) => actions.onSetVideoMode(output.id, v)}>
            <SelectTrigger aria-label="Format" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modeChoices(device.output.modes, mode).map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      )}

      <SettingRow label="Rotation" help="For a monitor mounted on its side.">
        <div role="group" aria-label="Rotation" className="inline-flex shrink-0 overflow-hidden rounded-[7px] border border-line-strong">
          {ROTATIONS.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={rotation === r}
              onClick={() => actions.onSetRotation(output.id, r)}
              className={cn(
                "border-l border-line-strong px-2.5 py-1 text-caption1 first:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
                rotation === r ? "bg-accent/12 text-fg" : "bg-fill text-fg-muted hover:bg-fill-hover",
              )}
            >
              {r}°
            </button>
          ))}
        </div>
      </SettingRow>
      {/* Tall enough to hold the picture turned on its side without running over
          the figures under it. */}
      <div aria-hidden="true" className="grid h-[144px] place-items-center">
        <i
          style={{ transform: `rotate(${rotation}deg)` }}
          className="grid h-[72px] w-[128px] place-items-center rounded border border-line-strong bg-bg text-caption2 not-italic text-fg-subtle transition-transform duration-(--motion-settled) ease-(--motion-ease) motion-reduce:transition-none"
        >
          {sideways ? "1080 × 1920" : "1920 × 1080"}
        </i>
      </div>

      <div role="group" aria-label="Output health" className="grid grid-cols-3 gap-2">
        {/* A display's rate comes from its display link, which does not tick
            while the display sleeps or the screen is locked: 0 there is a
            sleeping display, not a measurement. */}
        <Stat
          value={health && !(device.output.kind === "display" && health.fps === 0) ? health.fps.toFixed(2) : "—"}
          label="frames / s"
        />
        <Stat value={health ? `${health.repeated.toFixed(1)}%` : "—"} label="repeated" />
        <Stat value={health ? String(health.dropped) : "—"} label="dropped by the card" />
      </div>
      {device.output.kind === "decklink" && health?.latencyMs !== undefined && (
        <p className="mt-2 text-caption1 text-fg-muted">Latency {Math.round(health.latencyMs)} ms (render to air)</p>
      )}
      {health?.struggling && (
        <p role="status" className="mt-2 text-caption1 text-warn-11">
          This output is dropping frames or running late.
        </p>
      )}
      {!health && (
        <p className="mt-2 text-caption1 text-fg-subtle">
          {!online
            ? "Offline, so nothing is being reported."
            : reported
              ? "The helper stopped reporting."
              : "No report from the helper yet."}
        </p>
      )}

      <div className="mt-1.5 flex items-start justify-between gap-3 py-1.5">
        <p className="min-w-0 text-caption1 text-fg-subtle">
          Repeated frames are a late page, shown twice rather than skipped. Dropped means the card ran out of frames.
        </p>
        <Button
          type="button"
          variant="transparent"
          size="small"
          className="border border-line-strong font-medium text-fg"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await releaseDevice(device.id, output.name);
            } finally {
              setBusy(false);
            }
          }}
        >
          Release
        </Button>
      </div>
    </div>
  );
}

function DeviceSection({ output, online, actions }: { output: Output; online: boolean; actions: ScreenPanelActions }) {
  const outputId = output.id;
  const { bound, health, reported } = useDevices();
  const device = bound.find((d) => d.outputId === outputId);
  if (!device) {
    return <p className="text-caption1 text-fg-subtle">No device is set up for this screen.</p>;
  }
  if (device.output) {
    return (
      <OutputDeviceSection
        output={output}
        device={{ ...device, output: device.output }}
        online={online}
        health={health.find((h) => h.deviceId === device.id)}
        reported={reported.includes(device.id)}
        actions={actions}
      />
    );
  }
  const who = [device.label || device.hostname || "Set up on a device", device.ip].filter(Boolean).join(" · ");
  return (
    <div className="py-0.5">
      <div className="text-footnote font-medium text-fg">{who}</div>
      <div className="mt-px text-caption1 text-fg-subtle">
        {online ? "Online. The device follows this screen." : "Offline. The device follows this screen when it is on."}
      </div>
    </div>
  );
}

/** The note after a screen is made: what happened, and the way into its layout. */
function CreatedNote({ output, viewMade, onEditLayout }: { output: Output; viewMade: boolean; onEditLayout?: () => void }) {
  return (
    <div role="status" className="mt-3 rounded-[9px] border border-ok-9/30 bg-ok-9/6 px-3 py-2.5 text-footnote text-fg">
      <b className="font-semibold">Created "{output.name}"{viewMade && " and its view"}</b>.
      {viewMade && " The view is blank until you lay it out."}
      {viewMade && onEditLayout && (
        <div className="mt-2">
          <Button type="button" variant="accent" size="medium" onClick={onEditLayout}>
            Edit layout
          </Button>
        </div>
      )}
    </div>
  );
}

function EditBody({ output, views, baseUrl, online, messageGroups, created, canRemove, actions }: {
  output: Output;
  views: View[];
  baseUrl: string;
  online: boolean;
  messageGroups: MessageGroups;
  created: { viewMade: boolean } | null;
  /** Another screen exists, so this one may be removed: the server refuses the last. */
  canRemove: boolean;
  actions: ScreenPanelActions;
}) {
  const shown = output.viewId ? views.find((v) => v.id === output.viewId) : undefined;
  // What the screen is, from its view: the one question every reader asks.
  const controlSurface = screenIsControlSurface(output, views);
  // The same condition the card's menu used for the lock and the top bar: both
  // are about a strip only some kinds draw. An unrouted screen still shows a bar.
  const drawsTopBar = shown ? KIND_DRAWS_TOP_BAR[shown.kind] : true;

  const [name, setName] = useState(output.name);
  useResyncOn([output.name], () => setName(output.name));
  const [draftSize, setDraftSize] = useState<number | null>(null);

  /** Choosing a view is choosing what the screen is, so a view of the other kind
   *  is asked about first. Declining leaves the picker on the view it was on. */
  function pickView(value: string) {
    void chooseViewForScreen({
      output,
      views,
      value,
      setView: (...choice) => actions.onSetView(output.id, ...choice),
      requestNewView: (surface) => actions.onRequestNewView(output.id, surface),
    });
  }

  function commitName() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== output.name) actions.onRename(output.id, trimmed);
    else setName(output.name);
  }

  const permanent = `${baseUrl}/${encodeURIComponent(output.id)}`;

  return (
    <>
      <div className="flex-1 overflow-y-auto px-[18px] pb-[18px] pt-1.5">
        {created && <CreatedNote output={output} viewMade={created.viewMade} onEditLayout={shown ? () => actions.onEditLayout(shown.id) : undefined} />}
        <Section title="What it shows">
          <ViewPicker
            groups={viewGroups(views)}
            value={output.viewId ?? NONE}
            onChange={pickView}
            noneLabel="— No view yet —"
          />
          <RoleLine surface={shown ? viewSurface(shown) : null} />
          {shown && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="filled"
                size="medium"
                className="border border-line-strong"
                onClick={() => actions.onSelect({ kind: "view", viewId: shown.id })}
              >
                View settings →
              </Button>
              <Button
                type="button"
                variant="filled"
                size="medium"
                className="border border-line-strong"
                onClick={() => actions.onEditLayout(shown.id)}
              >
                Edit layout
              </Button>
            </div>
          )}
          {/* Only for a console: the sidebar lists consoles, and the listing is
              the view's, so it is written there. */}
          {controlSurface && shown && (
            <SidebarRow
              checked={viewShownInSidebar(shown)}
              onChange={(on) => actions.onSetShowInSidebar(shown.id, on)}
            />
          )}
        </Section>
        <Section title="Name and address">
          <NameInput id="screen-name" value={name} onChange={setName} onCommit={commitName} />
          <SlugField slug={output.slug ?? ""} baseUrl={baseUrl} onSave={(s) => actions.onSetSlug(output.id, s)} />
          <div className="mt-1.5 flex items-start gap-1.5">
            {/* overflow-wrap:anywhere, not break-all: a long URL may still break,
                but only where it has to, and "also /display-2" stays whole. */}
            <p className="min-w-0 flex-1 font-mono text-caption1 text-fg-muted [overflow-wrap:anywhere]">
              {output.slug ? (
                <>
                  {`${baseUrl}/${output.slug}`} <span className="whitespace-nowrap">· also /{output.id}</span>
                </>
              ) : permanent}
            </p>
            {/* The permanent address, as the card's Copy URL copies it: it is what a
                Pi or a printed QR is pointed at. copyText rather than
                navigator.clipboard, which prod's plain HTTP does not have. */}
            <Tooltip label="Copy the permanent URL">
              <button
                type="button"
                aria-label="Copy the permanent URL"
                onClick={async () => {
                  if (await copyText(permanent)) toast.success("URL copied");
                  else toast.error("Could not copy — select the URL and copy it by hand");
                }}
                className="shrink-0 rounded-md p-1 text-fg-subtle hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <CopyIcon className="size-3.5" />
              </button>
            </Tooltip>
          </div>
        </Section>

        <Section title="On the screen">
          {/* The lock's ONLY effect is on the top bar: it strips the home link and
              the QR and leaves the rest. Neither is offered on a screen with no bar
              — "Lock display" once shipped as a no-op on a calendar wall. */}
          {drawsTopBar && (
            <>
              <SwitchRow
                label="Top bar"
                help="The brand, plan and QR strip along the top."
                checked={!output.hideTopBar}
                onChange={(on) => actions.onSetHideTopBar(output.id, !on)}
              />
              <SwitchRow
                label="Lock"
                help="Keeps the top bar but removes its links, so the screen cannot be navigated away from."
                checked={output.locked ?? false}
                onChange={(on) => actions.onSetLocked(output.id, on)}
              />
            </>
          )}
          <SettingRow label="Text size" help="For ServiceCue and readouts on this screen.">
            {/* Held in a draft and written when settled (a blur or a stepper press),
                not on every keystroke: typing 150 passes through 1 and 15, which
                clamp to 50, and each would be sent to a live wall. */}
            <NumberInput
              aria-label="Text size"
              value={draftSize ?? output.textSize ?? 100}
              min={50}
              max={300}
              step={5}
              suffix="%"
              className="w-32"
              onChange={setDraftSize}
              onCommit={(v) => {
                setDraftSize(null);
                actions.onSetTextSize(output.id, v);
              }}
            />
          </SettingRow>
        </Section>

        <Section title="Messages">
          <GroupsChecklist
            messageGroups={messageGroups}
            inGroups={output.groups ?? []}
            onSetGroups={(g) => actions.onSetGroups(output.id, g)}
            onOpenMessagingSettings={actions.onOpenMessagingSettings}
          />
        </Section>

        <Section title="Video">
          <SwitchRow
            label="Use HLS"
            help="Off, this screen plays only WebRTC. A feed that needs HLS says it can't play here."
            checked={output.allowHls !== false}
            onChange={(on) => actions.onSetAllowHls(output.id, on)}
          />
        </Section>

        <Section title="Device">
          <DeviceSection output={output} online={online} actions={actions} />
        </Section>
      </div>
      <PanelFooter hint="Changes save as you make them.">
        <DangerButton
          disabled={!canRemove}
          title={canRemove ? undefined : "The last screen cannot be removed"}
          onClick={() => actions.onRemoveScreen(output.id)}
        >
          Remove screen…
        </DangerButton>
      </PanelFooter>
    </>
  );
}

// ── The panel ────────────────────────────────────────────────────────────

/** The empty state: nothing is selected. */
function EmptyBody({ onAddScreen }: { onAddScreen: () => void }) {
  return (
    <div className="grid flex-1 place-items-center px-[26px] py-8 text-center">
      <div className="flex flex-col items-center">
        <PanelRightIcon className="size-[34px] text-fg-subtle" strokeWidth={1.6} aria-hidden="true" />
        <h3 className="mb-1 mt-2.5 text-callout font-semibold text-fg">Select a screen or view</h3>
        <p className="mb-3.5 max-w-[30ch] text-footnote text-fg-muted">Click any card on the left to see its settings here.</p>
        <Button type="button" variant="filled" size="medium" className="border border-line-strong" onClick={() => onAddScreen()}>
          + Add a screen
        </Button>
      </div>
    </div>
  );
}

export function ScreenSettingsPanel({ target, outputs, views, baseUrl, online, messageGroups, actions, onClose }: ScreenSettingsPanelProps) {
  const [step, setStep] = useState<Step>(1);
  // A different new screen (another device) starts again at its first step.
  useResyncOn([target?.kind === "new" ? newScreenKey(target) : null], () => setStep(1));
  const output = target?.kind === "edit" ? outputs.find((o) => o.id === target.outputId) : undefined;
  const created = target?.kind === "edit" ? target.created : undefined;
  const view = target?.kind === "view" ? views.find((v) => v.id === target.viewId) : undefined;
  // What the target resolves to. A screen or a view that is gone (removed here or
  // from another browser) leaves the panel on nothing rather than on a stale form.
  const shownTarget = target?.kind === "new" ? target : output ? { kind: "edit" as const, output, created } : view ? { kind: "view" as const, view } : null;

  return (
    <aside
      id={SCREEN_PANEL_ID}
      tabIndex={-1}
      aria-label="Settings"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        // Leave the field first, as pressing the X does: the name and the text
        // size save when they are left, and closing without leaving them dropped
        // what had been typed.
        const active = document.activeElement;
        if (active instanceof HTMLElement && e.currentTarget.contains(active)) active.blur();
        onClose();
      }}
      className="flex min-h-0 min-w-0 flex-col border-line bg-surface max-lg:bg-bg max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:w-full max-lg:max-w-[400px] max-lg:border-l max-lg:shadow-2xl focus:outline-none lg:rounded-xl lg:border"
    >
      <div className="flex items-start gap-3 border-b border-line px-[18px] pb-2.5 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            {shownTarget?.kind === "new"
              ? `New screen · step ${step} of 2`
              : shownTarget?.kind === "edit"
                ? "Screen settings"
                : shownTarget?.kind === "view"
                  ? "View settings"
                  : "Settings"}
          </div>
          <h3 className="mt-0.5 truncate text-callout font-semibold text-fg">
            {shownTarget?.kind === "new"
              ? STEP_TITLES[step - 1]
              : shownTarget?.kind === "edit"
                ? shownTarget.output.name
                : shownTarget?.kind === "view"
                  ? shownTarget.view.name
                  : "Nothing selected"}
          </h3>
          {shownTarget?.kind === "new" && (
            <div aria-hidden="true" className="mt-2.5 flex max-w-[360px] gap-1.5">
              {STEP_TITLES.map((t, i) => (
                <i key={t} className={cn("h-[3px] flex-1 rounded-sm", i < step ? "bg-accent" : "bg-line-strong")} />
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1 text-fg-muted hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {shownTarget?.kind === "edit" ? (
        <EditBody
          key={shownTarget.output.id}
          output={shownTarget.output}
          views={views}
          baseUrl={baseUrl}
          online={online}
          messageGroups={messageGroups}
          created={shownTarget.created ?? null}
          canRemove={outputs.length > 1}
          actions={actions}
        />
      ) : shownTarget?.kind === "view" ? (
        <ViewBody key={shownTarget.view.id} view={shownTarget.view} outputs={outputs} actions={actions} />
      ) : shownTarget?.kind === "new" ? (
        <NewScreenBody
          key={newScreenKey(shownTarget)}
          target={shownTarget}
          outputs={outputs}
          views={views}
          baseUrl={baseUrl}
          step={step}
          setStep={setStep}
          actions={actions}
        />
      ) : (
        <EmptyBody onAddScreen={actions.onAddScreen} />
      )}
    </aside>
  );
}
