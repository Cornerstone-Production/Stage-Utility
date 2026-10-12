// The Screen settings side panel: every setting a screen has, in one place.
//
// The screen card's menu used to hold all of them (the role, the lock, the top
// bar, HLS, the message groups, the friendly link), and a menu is the wrong shape
// for a setting: it closes on every choice, it cannot say what a choice does, and
// it grew a submenu and a caption to cope. The menu is now actions only, and this
// panel is where a screen is configured.
//
// TWO MODES OF ONE FORM.
//
//   edit    Changes save as they are made, each through the per-field handler the
//           menu used (the card stays on the page beside it, so what a change did
//           is visible).
//   guided  Three steps for a screen that does not exist yet: what it is, what it
//           shows, what it is called. NOTHING is created until "Create screen",
//           which is enabled on every step because every step has a default, and
//           closing the panel creates nothing at all.
//
// The mockup is the spec for both (scratchpad screen-settings-mockup.html, side
// panel layout).
//
// THE VIEW DECIDES WHAT A SCREEN IS. A screen is a control surface (its buttons
// work for anyone at it) exactly when the view it shows is a console, and a
// read-only wall display otherwise. There is no role to set on the screen: the
// picker offers views of both kinds, one line under it says what the choice makes
// the screen, and choosing a view of the other kind asks first, because the
// screen's buttons go live or stop. Changing what a view is for is the view's
// own card, which names every screen it changes.

import { useEffect, useRef, useState, type ChangeEvent, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { CopyIcon, XIcon } from "lucide-react";

import { Button, Checkbox, ErrorNote, Input, NumberInput, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue, Switch, Tooltip, confirm, toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { errorMessage } from "@main/services/errors";
import { expectedSurface } from "../view-role-change";
import { KIND_DRAWS_TOP_BAR, screenIsControlSurface, viewCanBeControlSurface, viewShownInSidebar, viewSurface, type CreateScreenInput, type NewViewKind, type ViewSurface } from "@main/types/views";
import { useResyncOn } from "../../lib/use-resync-on";
import { useDevices } from "../../app/screens/use-devices";
import { releaseDevice } from "../../app/screens/screen-device";
import { cardOf, outputModeLine } from "../../app/screens/output-helpers";
import { modeChoices, ROTATIONS, type Rotation } from "@main/types/output-format";
import type { DeviceOutput } from "@main/types/kiosk";
import type { OutputHealth } from "@main/types/output-health";
import type { MessageGroups } from "../../main/use-message-groups";

/** Select sentinels. Never stored: one clears the view, one asks for a new one. */
const NONE = "__none__";
const NEW_VIEW = "__new__";

/** What the panel is open on. */
export type PanelTarget =
  | { kind: "edit"; outputId: string }
  /** A new screen. `device` is the unclaimed machine it is being set up for.
   *  `defaultName` is what the name field starts with; empty sends no name, and
   *  the server names the screen from its id. */
  | { kind: "new"; device: PanelDevice | null; defaultName: string };

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
  /** Open the new-view dialog for this screen. */
  onRequestNewView: (outputId: string) => void;
  /** Make the screen. Resolves with why it was refused, or null once it exists. */
  onCreate: (input: CreateScreenInput, device: PanelDevice | null) => Promise<string | null>;
}

export interface ScreenSettingsPanelProps {
  target: PanelTarget;
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

/** The panel's element id: there is one panel on the page, and the card menu that
 *  opens it needs to hand focus to it once the menu has finished closing. */
export const SCREEN_PANEL_ID = "screen-settings-panel";

/** The views a new screen of this kind may be shown: a custom console for a
 *  control surface, a wall view for a wall display. (Guided creation only. An
 *  existing screen's picker offers both kinds.) */
export function viewsOfKind(views: readonly View[], kind: NewViewKind): View[] {
  return views.filter((v) => (kind === "control" ? viewSurface(v) === "console" && viewCanBeControlSurface(v) : viewSurface(v) === "display"));
}

/** What a screen showing a view of this surface is, in the words the panel uses. */
const WHAT_IT_IS: Record<ViewSurface, string> = {
  console: "Control surface: its buttons work for anyone at it.",
  display: "Wall display: read-only. Buttons draw but do nothing.",
};

/**
 * Ask before a screen becomes what it is not. The one confirm for it, here and on
 * the screen card's view picker, so the title and the button are written once.
 *
 * Making a screen a control surface makes its buttons live to anyone standing at
 * it, which is not something to do by misclick, and making it a wall display
 * switches them off. `why` leads the message when the change is a consequence of
 * something else the operator chose.
 */
export async function confirmRole(name: string, becomes: ViewSurface, why?: string): Promise<boolean> {
  const toConsole = becomes === "console";
  const what = toConsole
    ? "Its buttons will work. Anyone standing at it can press them."
    : "It becomes read-only. Its buttons will render but do nothing.";
  return confirm({
    title: toConsole ? `Make "${name}" a control surface?` : `Make "${name}" a wall display?`,
    message: why ? `${why} ${what}` : what,
    confirmLabel: toConsole ? "Make it a control surface" : "Make it a wall display",
  });
}

/**
 * Pointing a screen at a view is also choosing what the screen is. Asks when that
 * changes it (the view is of the other kind than the screen shows now) and says
 * whether to go ahead. A view of the kind the screen already shows asks nothing.
 */
export async function confirmViewKind(output: Output, views: readonly View[], viewId: string): Promise<boolean> {
  const picked = views.find((v) => v.id === viewId);
  if (!picked) return true;
  const becomes = viewSurface(picked);
  if ((becomes === "console") === screenIsControlSurface(output, views)) return true;
  return confirmRole(output.name, becomes, `"${picked.name}" is ${becomes === "console" ? "a control surface" : "a wall view"}.`);
}

// ── Small parts ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line py-3.5 last:border-b-0">
      <h4 className="mb-2.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">{title}</h4>
      {children}
    </section>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 mt-2 block text-caption1 text-fg-muted first:mt-0">
      {children}
    </label>
  );
}

/** One setting: its name and what it does, and the control beside them.
 *  `htmlFor` makes the name the label of a control carrying that id; a control
 *  with no id (a Switch, the NumberInput) names itself with aria-label. */
function SettingRow({ label, help, htmlFor, children }: { label: string; help: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-footnote font-medium text-fg">{label}</label>
        ) : (
          <div className="text-footnote font-medium text-fg">{label}</div>
        )}
        <div className="mt-px text-caption1 text-fg-subtle">{help}</div>
      </div>
      {children}
    </div>
  );
}

/** A setting that is a switch. */
function SwitchRow({ label, help, checked, onChange, disabled }: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingRow label={label} help={help}>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} className="mt-0.5" />
    </SettingRow>
  );
}

/** The screen's name, as both modes draw it. `onCommit`, when given, runs as the
 *  field is left, and Enter leaves it. */
function NameInput({ id, value, onChange, onCommit, placeholder }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onCommit?: () => void;
  placeholder?: string;
}) {
  return (
    <>
      <FieldLabel htmlFor={id}>Name</FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={onCommit ? (e) => { if (e.key === "Enter") e.currentTarget.blur(); } : undefined}
        className="h-8 w-full"
      />
    </>
  );
}

/** The friendly-link field, as both modes draw it: the base address over the
 *  field. When it is saved is the caller's; `children` sits beside the field. */
function SlugInput({ id, baseUrl, value, onChange, children }: {
  id: string;
  baseUrl: string;
  value: string;
  onChange: (v: string) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <FieldLabel htmlFor={id}>Friendly link — optional</FieldLabel>
      <span className="mb-1 block truncate font-mono text-caption2 text-fg-faint">{baseUrl}/</span>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          placeholder="optional"
          autoComplete="off"
          className="h-8 min-w-0 flex-1 font-mono text-caption1"
        />
        {children}
      </div>
    </>
  );
}

function KindCards({ kind, onChoose }: { kind: NewViewKind; onChoose: (kind: NewViewKind) => void }) {
  const cards: { kind: NewViewKind; title: string; hint: string }[] = [
    { kind: "wall", title: "Wall display", hint: "Read from across the room. Buttons draw but do nothing." },
    { kind: "control", title: "Control surface", hint: "A touch screen. Its buttons work for anyone at it." },
  ];
  return (
    <div role="group" aria-label="What this screen is" className="grid grid-cols-2 gap-2">
      {cards.map((c) => (
        <button
          key={c.kind}
          type="button"
          aria-pressed={kind === c.kind}
          onClick={() => onChoose(c.kind)}
          className={cn(
            "flex flex-col items-start justify-start rounded-[10px] border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            kind === c.kind ? "border-accent bg-accent/12" : "border-line-strong bg-fill hover:bg-fill-hover",
          )}
        >
          <span className="block text-footnote font-semibold text-fg">{c.title}</span>
          <span className="mt-0.5 block text-caption1 text-fg-muted">{c.hint}</span>
        </button>
      ))}
    </div>
  );
}

/** "List in the sidebar", for a control surface. Writes the VIEW the screen
 *  shows: the sidebar lists consoles, and a console is a view. */
function SidebarRow({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <SwitchRow
      label="List in the sidebar"
      help={
        disabled
          ? "Choose what this screen shows first. The listing belongs to that view."
          : checked
            ? "Its console is under Consoles in the app."
            : "Kept out of the sidebar. Its buttons still work here; open it from this screen's card."
      }
      checked={checked}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

/** The view picker, shared by both modes: views in labelled groups (a group with
 *  no label is flat), then the way to make a new one. `hint` is the line under it. */
function ViewPicker({
  groups,
  value,
  onChange,
  newLabel,
  noneLabel,
  hint,
}: {
  groups: readonly { label: string | null; views: readonly View[] }[];
  value: string;
  onChange: (v: string) => void;
  newLabel: string;
  noneLabel: string;
  hint: ReactNode;
}) {
  return (
    <>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label="View">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
          {groups.map((g) =>
            g.label === null ? (
              g.views.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))
            ) : g.views.length > 0 ? (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.views.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null,
          )}
          <SelectItem value={NEW_VIEW}>{newLabel}</SelectItem>
        </SelectContent>
      </Select>
      <p className="mt-1.5 text-caption1 text-fg-subtle">{hint}</p>
    </>
  );
}

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
      {/* Tall enough to hold the picture turned on its side. Smaller than the
          mockup's 160 x 90: turned, that is 160 high, which ran over the figures
          under it. */}
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

function EditBody({ output, views, baseUrl, online, messageGroups, actions }: {
  output: Output;
  views: View[];
  baseUrl: string;
  online: boolean;
  messageGroups: MessageGroups;
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
  async function pickView(v: string) {
    if (v === NEW_VIEW) actions.onRequestNewView(output.id);
    else if (v === NONE) actions.onSetView(output.id, null);
    else if (await confirmViewKind(output, views, v)) actions.onSetView(output.id, v, expectedSurface(views, v));
  }

  function commitName() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== output.name) actions.onRename(output.id, trimmed);
    else setName(output.name);
  }

  const permanent = `${baseUrl}/${encodeURIComponent(output.id)}`;

  return (
    <>
      <Section title="What it shows">
        <ViewPicker
          groups={[
            { label: "Wall views", views: views.filter((v) => viewSurface(v) === "display") },
            { label: "Control surfaces", views: views.filter((v) => viewSurface(v) === "console") },
          ]}
          value={output.viewId ?? NONE}
          onChange={(v) => void pickView(v)}
          newLabel={controlSurface ? "+ New control surface…" : "+ New wall view…"}
          noneLabel="— Unrouted —"
          hint={shown ? WHAT_IT_IS[viewSurface(shown)] : "Shows nothing yet."}
        />
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
          {/* The permanent one, as the old URL dialog and the card's Copy URL
              copy: it is what a Pi or a printed QR is pointed at. copyText
              rather than navigator.clipboard, which prod's plain HTTP does not
              have. */}
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
    </>
  );
}

// ── Guided mode ──────────────────────────────────────────────────────────

type Step = 1 | 2 | 3;
const STEP_TITLES = ["What is this screen?", "What should it show?", "Name it"] as const;

function GuidedBody({ target, outputs, views, baseUrl, step, setStep, actions, onClose }: {
  target: Extract<PanelTarget, { kind: "new" }>;
  outputs: Output[];
  views: View[];
  baseUrl: string;
  step: Step;
  setStep: Dispatch<SetStateAction<Step>>;
  actions: ScreenPanelActions;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<NewViewKind>("wall");
  const [listed, setListed] = useState<boolean | null>(null);
  const [viewChoice, setViewChoice] = useState<string>(NONE);
  const [name, setName] = useState(target.defaultName);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The device this is for may be bound by another operator while the form is
  // open. It is no longer waiting then, the server refuses to make it a new
  // screen, and the form says so rather than inviting a claim that fails.
  const { bound } = useDevices();
  const taken = target.device ? bound.find((d) => d.id === target.device!.id) : undefined;
  const takenBy = taken ? (outputs.find((o) => o.id === taken.outputId)?.name ?? taken.outputId) : null;

  // A view picked for one kind does not follow the screen to the other.
  const fitting = viewsOfKind(views, kind);
  const fits = viewChoice === NONE || viewChoice === NEW_VIEW || fitting.some((v) => v.id === viewChoice);
  const effectiveChoice = fits ? viewChoice : NONE;
  const hasView = effectiveChoice !== NONE;
  // What the switch shows until the operator moves it: the listing of the
  // console chosen, which may already be kept out of the sidebar, else listed,
  // which is what a new view is.
  const chosenView = views.find((v) => v.id === effectiveChoice);
  const shownListed = listed ?? (chosenView ? viewShownInSidebar(chosenView) : true);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const input: CreateScreenInput = {
        // Omitted when empty, so the server names the screen from its id.
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(effectiveChoice === NEW_VIEW ? { newView: kind } : effectiveChoice !== NONE ? { viewId: effectiveChoice } : {}),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        // Sent only when the operator moved the switch: an existing control
        // surface that is hidden should not be re-listed by a screen made for it.
        ...(kind === "control" && hasView && listed !== null ? { showInSidebar: listed } : {}),
      };
      const refused = await actions.onCreate(input, target.device);
      if (refused) {
        setError(refused);
        // The friendly link is the one answer the form cannot rule out itself.
        if (slug.trim()) setStep(3);
      } else {
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-[18px] pb-[18px] pt-1.5">
        {step === 1 && (
          <Section title="What this screen is">
            <KindCards kind={kind} onChoose={setKind} />
            {kind === "control" && <SidebarRow checked={shownListed} onChange={setListed} />}
          </Section>
        )}
        {step === 2 && (
          <Section title="What it shows">
            <ViewPicker
              groups={[{ label: null, views: fitting }]}
              value={effectiveChoice}
              onChange={setViewChoice}
              newLabel="+ New blank view"
              noneLabel="— No view yet —"
              hint={kind === "control" ? "Control-surface views only." : "Wall-display views only."}
            />
            {effectiveChoice === NEW_VIEW && (
              <p className="mt-1.5 text-caption1 text-fg-subtle">
                A blank {kind === "control" ? "control-surface" : "wall"} view named after the screen is made with it.
              </p>
            )}
          </Section>
        )}
        {step === 3 && (
          <Section title="Name and address">
            {/* Left empty, the server names it from the id it is given. */}
            <NameInput id="new-screen-name" value={name} onChange={setName} placeholder="Left empty: Display and its number" />
            {/* Sent with Create screen, so it has no Save of its own. */}
            <SlugInput id="new-screen-slug" baseUrl={baseUrl} value={slug} onChange={setSlug} />
          </Section>
        )}
        {takenBy !== null && (
          <p role="status" className="mt-3 rounded-[9px] border border-warn-9/35 bg-warn-9/8 px-3 py-2.5 text-footnote text-fg">
            This device was set up as "{takenBy}" meanwhile, so it cannot be made a new screen. Close this to keep that,
            or release it from that screen first.
          </p>
        )}
        {error && <ErrorNote className="mt-3">{error}</ErrorNote>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-[18px] py-3">
        <span className="text-caption1 text-fg-subtle">
          {target.device
            ? "Nothing is created until you finish. The device then shows this screen."
            : "Nothing is created until you finish. Then point a monitor at its address."}
        </span>
        <span className="flex gap-2">
          {step > 1 && (
            <Button type="button" variant="transparent" size="medium" onClick={() => setStep((s) => (s - 1) as Step)} disabled={busy}>
              Back
            </Button>
          )}
          {step < 3 && (
            <Button type="button" variant="filled" size="medium" onClick={() => setStep((s) => (s + 1) as Step)} disabled={busy}>
              Next
            </Button>
          )}
          {/* Enabled on every step: each one has a default (a wall display, no
              view, a numbered name), so there is nothing to finish before it.
              Off only for a device someone else has bound meanwhile. */}
          <Button type="button" variant="accent" size="medium" onClick={() => void create()} disabled={busy || takenBy !== null}>
            Create screen
          </Button>
        </span>
      </div>
    </>
  );
}

// ── The panel ────────────────────────────────────────────────────────────

export function ScreenSettingsPanel({ target, outputs, views, baseUrl, online, messageGroups, actions, onClose }: ScreenSettingsPanelProps) {
  const [step, setStep] = useState<Step>(1);
  // Focus moves into the panel when it opens, so a keyboard user who chose
  // "Screen settings…" is in the form rather than back on a card's menu button
  // with the whole card grid between them and it.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const output = target.kind === "edit" ? outputs.find((o) => o.id === target.outputId) : undefined;
  // The screen was removed (here or from another browser) while its panel was open.
  // Nothing is left to edit, and a panel on nothing is not a state to draw.
  if (target.kind === "edit" && !output) return null;

  return (
    <aside
      ref={ref}
      id={SCREEN_PANEL_ID}
      tabIndex={-1}
      aria-label="Screen settings"
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
            {target.kind === "new" ? `New screen · step ${step} of 3` : "Screen settings"}
          </div>
          <h3 className="mt-0.5 truncate text-callout font-semibold text-fg">
            {target.kind === "new" ? STEP_TITLES[step - 1] : output?.name}
          </h3>
          {target.kind === "new" && (
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
      {target.kind === "edit" && output ? (
        <>
          <div className="flex-1 overflow-y-auto px-[18px] pb-[18px] pt-1.5">
            <EditBody
              key={output.id}
              output={output}
              views={views}
              baseUrl={baseUrl}
              online={online}
              messageGroups={messageGroups}
              actions={actions}
            />
          </div>
          <div className="border-t border-line px-[18px] py-3 text-caption1 text-fg-subtle">Changes save as you make them.</div>
        </>
      ) : target.kind === "new" ? (
        <GuidedBody target={target} outputs={outputs} views={views} baseUrl={baseUrl} step={step} setStep={setStep} actions={actions} onClose={onClose} />
      ) : null}
    </aside>
  );
}
