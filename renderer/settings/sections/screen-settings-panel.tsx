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
// CHANGING ONE SCREEN NEVER CHANGES ANOTHER. A view several screens show cannot
// be made a control surface (the server refuses) or a wall screen (it would
// silently strip the live controls from every other screen showing it) without
// changing them, so when the role chosen no longer fits a shared view the panel
// says which screens share it and offers a copy for this screen, or a different
// view. A view that is not custom cannot be a control surface at all, nor can a
// copy of it, so for one of those it offers only a different view. Both are
// roleChangeConflict(), the function the server decides with.

import { useEffect, useRef, useState, type ChangeEvent, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { XIcon } from "lucide-react";

import { Button, Checkbox, ErrorNote, Input, NumberInput, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, confirm } from "../../components/ui";
import { cn } from "../../lib/cn";
import { errorMessage } from "@main/services/errors";
import { KIND_DRAWS_TOP_BAR, outputMode, roleChangeConflict, viewFitsRole, viewShownInSidebar, viewSurface, type CreateScreenInput, type OutputMode } from "@main/types/views";
import { useResyncOn } from "../../lib/use-resync-on";
import { useDevices } from "../../app/screens/use-devices";
import type { MessageGroups } from "../../main/use-message-groups";

/** Select sentinels. Never stored: one clears the view, one asks for a new one. */
const NONE = "__none__";
const NEW_VIEW = "__new__";

/** What the panel is open on. */
export type PanelTarget =
  | { kind: "edit"; outputId: string }
  /** A new screen. `device` is the unclaimed machine it is being set up for. */
  | { kind: "new"; device: PanelDevice | null; defaultName: string };

/** An unclaimed device, as the guided panel needs to name it. */
export interface PanelDevice {
  id: string;
  hostname?: string;
  ip?: string;
}

/** Everything the panel does to the outside world, as callbacks, so the panel
 *  itself reads from props and a test can drive it with no server behind it. */
export interface ScreenPanelActions {
  onRename: (id: string, name: string) => void;
  /** Rejects with the server's reason, which the panel shows without closing. */
  onSetSlug: (id: string, slug: string) => Promise<void>;
  onSetView: (id: string, viewId: string | null) => void;
  /** True when it landed; a refusal is already on screen. */
  onSetRole: (id: string, mode: OutputMode, opts: { copyView?: boolean; viewId?: string }) => Promise<boolean>;
  onSetLocked: (id: string, locked: boolean) => void;
  onSetHideTopBar: (id: string, hideTopBar: boolean) => void;
  onSetTextSize: (id: string, size: number) => void;
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

const ROLE_LABEL: Record<OutputMode, string> = { display: "wall display", panel: "control surface" };

/** The views a screen of this role may show: custom control surfaces for a
 *  control surface, wall screens for a wall display (viewFitsRole, the server's
 *  own test). `current` is always kept so the picker never goes blank on a
 *  pairing the server has already accepted. */
export function viewsFittingRole(views: readonly View[], mode: OutputMode, current: string | null): View[] {
  return views.filter((v) => viewFitsRole(v, mode) || v.id === current);
}

async function confirmRole(name: string, mode: OutputMode): Promise<boolean> {
  const toPanel = mode === "panel";
  // Confirmed, and the confirm says what actually changes. Turning a screen into
  // a control surface makes its controls live to anyone standing at it, which is
  // not something to do by misclick.
  return confirm({
    title: toPanel ? `Use "${name}" as a control surface?` : `Make "${name}" a display again?`,
    message: toPanel
      ? "Buttons on this screen will work. Anyone standing at it can press them."
      : "This screen becomes read-only. Its buttons will render but do nothing.",
    confirmLabel: toPanel ? "Use as a control surface" : "Make it a display",
  });
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

/** A setting that is a switch: its name and what it does, and the switch. */
function SwitchRow({
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-footnote font-medium text-fg">{label}</div>
        <div className="mt-px text-caption1 text-fg-subtle">{help}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} className="mt-0.5" />
    </div>
  );
}

function RoleCards({ role, onChoose }: { role: OutputMode; onChoose: (mode: OutputMode) => void }) {
  const cards: { mode: OutputMode; title: string; hint: string }[] = [
    { mode: "display", title: "Wall display", hint: "Read from across the room. Buttons draw but do nothing." },
    { mode: "panel", title: "Control surface", hint: "A touch screen. Its buttons work for anyone at it." },
  ];
  return (
    <div role="group" aria-label="What this screen is" className="grid grid-cols-2 gap-2">
      {cards.map((c) => (
        <button
          key={c.mode}
          type="button"
          aria-pressed={role === c.mode}
          onClick={() => onChoose(c.mode)}
          className={cn(
            "flex flex-col items-start justify-start rounded-[10px] border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            role === c.mode ? "border-accent bg-accent/12" : "border-line-strong bg-fill hover:bg-fill-hover",
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

/** The role-filtered view picker, shared by both modes. */
function ViewPicker({
  views,
  role,
  value,
  onChange,
  newLabel,
  noneLabel,
}: {
  views: readonly View[];
  role: OutputMode;
  value: string;
  onChange: (v: string) => void;
  newLabel: string;
  noneLabel: string;
}) {
  const fit = viewsFittingRole(views, role, value === NONE || value === NEW_VIEW ? null : value);
  return (
    <>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label="View">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
          {fit.map((v) => (
            <SelectItem key={v.id} value={v.id}>
              {v.name}
            </SelectItem>
          ))}
          <SelectItem value={NEW_VIEW}>{newLabel}</SelectItem>
        </SelectContent>
      </Select>
      <p className="mt-1.5 text-caption1 text-fg-subtle">
        {role === "panel" ? "Control-surface views only." : "Wall-display views only."}
      </p>
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
      <FieldLabel htmlFor="screen-slug">Friendly link — optional</FieldLabel>
      <span className="mb-1 block truncate font-mono text-caption2 text-fg-faint">{baseUrl}/</span>
      <div className="flex gap-2">
        <Input
          id="screen-slug"
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
          placeholder="optional"
          autoComplete="off"
          className="h-8 min-w-0 flex-1 font-mono text-caption1"
        />
        {next !== slug && (
          <Button type="submit" variant="accent" size="small" disabled={busy} className="h-8">
            Save
          </Button>
        )}
      </div>
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

// ── The shared-view prompt ───────────────────────────────────────────────

function SharedViewPrompt({
  conflict,
  mode,
  views,
  choice,
  picked,
  busy,
  onChoice,
  onPick,
  onApply,
  onCancel,
}: {
  conflict: NonNullable<ReturnType<typeof roleChangeConflict>>;
  mode: OutputMode;
  views: readonly View[];
  choice: "copy" | "pick";
  picked: string;
  busy: boolean;
  onChoice: (c: "copy" | "pick") => void;
  onPick: (id: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { view, others, copyName } = conflict;
  const names = others.map((o) => o.name).join(", ");
  const modes = new Set(others.map((o) => outputMode(o)));
  const stays = modes.size === 1 ? `, which ${others.length === 1 ? "stays" : "stay"} a ${ROLE_LABEL[[...modes][0]]}` : "";
  const fit = viewsFittingRole(views, mode, null).filter((v) => v.id !== view.id);
  return (
    <div
      role="group"
      aria-label={others.length > 0 ? "This view is shared" : "This view cannot be a control surface"}
      className="mt-2.5 rounded-[9px] border border-warn-9/35 bg-warn-9/8 px-3 py-2.5 text-footnote"
    >
      <p className="mb-2 text-fg-muted">
        {others.length > 0 && (
          <>
            <b className="font-semibold text-fg">
              "{view.name}" is also on {names}
            </b>
            {stays}. Changing this screen never changes another one.{" "}
          </>
        )}
        {/* No copy to offer: a copy of a view that is not custom is not custom
            either, and the server refuses both. */}
        {copyName === null && (
          <>
            {others.length === 0 && <b className="font-semibold text-fg">"{view.name}" </b>}
            {others.length === 0 ? "cannot" : "It cannot"} be a control surface: only a custom view has a layout to put a
            control on. Choose a control-surface view for this screen.
          </>
        )}
      </p>
      {copyName !== null && (
        <>
          <label className="flex cursor-pointer items-start gap-2 py-1">
            <input type="radio" name="shared-view" checked={choice === "copy"} onChange={() => onChoice("copy")} className="mt-1 accent-[var(--su-accent)]" />
            <span className="text-fg">
              Use a copy on this screen
              <small className="block text-caption1 text-fg-subtle">
                "{copyName}", made as a {ROLE_LABEL[mode]}. {names} keeps the original.
              </small>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 py-1">
            <input type="radio" name="shared-view" checked={choice === "pick"} onChange={() => onChoice("pick")} className="mt-1 accent-[var(--su-accent)]" />
            <span className="text-fg">
              Choose a different view
              <small className="block text-caption1 text-fg-subtle">
                Only views that fit a {ROLE_LABEL[mode]} are offered.
              </small>
            </span>
          </label>
        </>
      )}
      {choice === "pick" && (
        <Select value={picked || NONE} onValueChange={(v: string) => onPick(v === NONE ? "" : v)}>
          <SelectTrigger aria-label="A different view" className="mt-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Pick a view…</SelectItem>
            {fit.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <PromptButtons busy={busy} disabled={choice === "pick" && !picked} onApply={onApply} onCancel={onCancel} />
    </div>
  );
}

function PromptButtons({ busy, disabled, onApply, onCancel }: { busy: boolean; disabled?: boolean; onApply: () => void; onCancel: () => void }) {
  return (
    <div className="mt-2.5 flex justify-end gap-2">
      <Button type="button" variant="transparent" size="small" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button type="button" variant="accent" size="small" onClick={onApply} disabled={busy || disabled}>
        Apply
      </Button>
    </div>
  );
}

// ── Edit mode ────────────────────────────────────────────────────────────

function DeviceSection({ outputId, online }: { outputId: string; online: boolean }) {
  const { bound } = useDevices();
  const device = bound.find((d) => d.outputId === outputId);
  if (!device) {
    return <p className="text-caption1 text-fg-subtle">No device is set up for this screen.</p>;
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

function EditBody({ output, outputs, views, baseUrl, online, messageGroups, actions }: {
  output: Output;
  outputs: Output[];
  views: View[];
  baseUrl: string;
  online: boolean;
  messageGroups: MessageGroups;
  actions: ScreenPanelActions;
}) {
  const role = outputMode(output);
  const shown = output.viewId ? views.find((v) => v.id === output.viewId) : undefined;
  // The same condition the card's menu used for the lock and the top bar: both
  // are about a strip only some kinds draw. An unrouted screen still shows a bar.
  const drawsTopBar = shown ? KIND_DRAWS_TOP_BAR[shown.kind] : true;

  const [name, setName] = useState(output.name);
  useResyncOn([output.name], () => setName(output.name));
  const [draftSize, setDraftSize] = useState<number | null>(null);

  // A role chosen that would change another screen, waiting for the operator to
  // say how. `null` when nothing is waiting. `waiting` is the same, unless the
  // screen has meanwhile become that role (another browser made the change).
  const [pending, setPending] = useState<OutputMode | null>(null);
  const [choice, setChoice] = useState<"copy" | "pick">("copy");
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const waiting = pending !== null && pending !== role ? pending : null;
  // Recomputed from the props on every render, so it follows the other screens.
  // It can go away while the operator is deciding (the screens sharing the view
  // move off it); the choice they made still stands, and Apply then makes the
  // plain change, which now changes nobody else.
  const conflict = waiting ? roleChangeConflict(output, outputs, views, waiting) : null;

  async function chooseRole(next: OutputMode) {
    if (next === role && pending === null) return;
    if (next === role) { setPending(null); return; }
    const asks = roleChangeConflict(output, outputs, views, next);
    if (asks) {
      setPending(next);
      // A copy when one can take the role, the default; otherwise a different
      // view is the only way.
      setChoice(asks.copyName === null ? "pick" : "copy");
      setPicked("");
      return;
    }
    setPending(null);
    if (!(await confirmRole(output.name, next))) return;
    await actions.onSetRole(output.id, next, {});
  }

  async function applyPending() {
    if (!waiting) return;
    if (!(await confirmRole(output.name, waiting))) return;
    setBusy(true);
    try {
      const opts = !conflict ? {} : choice === "copy" ? { copyView: true } : { viewId: picked };
      if (await actions.onSetRole(output.id, waiting, opts)) setPending(null);
    } finally {
      setBusy(false);
    }
  }

  function commitName() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== output.name) actions.onRename(output.id, trimmed);
    else setName(output.name);
  }

  const permanent = `${baseUrl}/${encodeURIComponent(output.id)}`;
  const shownRole = waiting ?? role;

  return (
    <>
      <Section title="What this screen is">
        <RoleCards role={shownRole} onChoose={(m) => void chooseRole(m)} />
        {/* Only for a console, or for no view yet (the switch then says to
            choose one). A panel can show a wall view, and the sidebar never
            lists one. */}
        {role === "panel" && waiting === null && (!shown || viewSurface(shown) === "console") && (
          <SidebarRow
            checked={shown ? viewShownInSidebar(shown) : true}
            disabled={!shown}
            onChange={(on) => shown && actions.onSetShowInSidebar(shown.id, on)}
          />
        )}
        {waiting && conflict && (
          <SharedViewPrompt
            conflict={conflict}
            mode={waiting}
            views={views}
            choice={choice}
            picked={picked}
            busy={busy}
            onChoice={setChoice}
            onPick={setPicked}
            onApply={() => void applyPending()}
            onCancel={() => setPending(null)}
          />
        )}
        {waiting && !conflict && (
          <div role="group" aria-label="Change the role" className="mt-2.5 rounded-[9px] border border-line px-3 py-2.5 text-footnote text-fg-muted">
            <p>
              {shown ? `No other screen shows "${shown.name}" now, so it changes with this screen.` : "No other screen is affected now."}
            </p>
            <PromptButtons busy={busy} onApply={() => void applyPending()} onCancel={() => setPending(null)} />
          </div>
        )}
      </Section>

      <Section title="What it shows">
        <ViewPicker
          views={views}
          role={role}
          value={output.viewId ?? NONE}
          onChange={(v) => {
            if (v === NEW_VIEW) actions.onRequestNewView(output.id);
            else actions.onSetView(output.id, v === NONE ? null : v);
          }}
          newLabel={role === "panel" ? "+ New control surface…" : "+ New wall view…"}
          noneLabel="— Unrouted —"
        />
      </Section>

      <Section title="Name and address">
        <FieldLabel htmlFor="screen-name">Name</FieldLabel>
        <Input
          id="screen-name"
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="h-8 w-full"
        />
        <SlugField slug={output.slug ?? ""} baseUrl={baseUrl} onSave={(s) => actions.onSetSlug(output.id, s)} />
        <p className="mt-1.5 break-all font-mono text-caption1 text-fg-muted">
          {output.slug ? `${baseUrl}/${output.slug} · also /${output.id}` : permanent}
        </p>
      </Section>

      <Section title="On the screen">
        {/* The lock's ONLY effect is on the top bar: it strips the home link and
            the QR and leaves the rest. Neither is offered on a screen with no bar
            — "Lock display" once shipped as a no-op on a calendar wall. */}
        {drawsTopBar && (
          <SwitchRow
            label="Top bar"
            help="The brand, plan and QR strip along the top."
            checked={!output.hideTopBar}
            onChange={(on) => actions.onSetHideTopBar(output.id, !on)}
          />
        )}
        {drawsTopBar && (
          <SwitchRow
            label="Lock"
            help="Keeps the top bar but removes its links, so the screen cannot be navigated away from."
            checked={output.locked ?? false}
            onChange={(on) => actions.onSetLocked(output.id, on)}
          />
        )}
        <div className="flex items-start justify-between gap-3 py-1.5">
          <div className="min-w-0">
            <label htmlFor="screen-text-size" className="block text-footnote font-medium text-fg">Text size</label>
            <div className="mt-px text-caption1 text-fg-subtle">For ServiceCue and readouts on this screen.</div>
          </div>
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
        </div>
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
        <DeviceSection outputId={output.id} online={online} />
      </Section>
    </>
  );
}

// ── Guided mode ──────────────────────────────────────────────────────────

type Step = 1 | 2 | 3;
const STEP_TITLES = ["What is this screen?", "What should it show?", "Name it"] as const;

function GuidedBody({ target, views, baseUrl, step, setStep, actions, onClose }: {
  target: Extract<PanelTarget, { kind: "new" }>;
  views: View[];
  baseUrl: string;
  step: Step;
  setStep: Dispatch<SetStateAction<Step>>;
  actions: ScreenPanelActions;
  onClose: () => void;
}) {
  const [role, setRole] = useState<OutputMode>("display");
  const [listed, setListed] = useState<boolean | null>(null);
  const [viewChoice, setViewChoice] = useState<string>(NONE);
  const [name, setName] = useState(target.defaultName);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A view picked for one role does not follow the screen to the other.
  const fits = viewChoice === NONE || viewChoice === NEW_VIEW || viewsFittingRole(views, role, null).some((v) => v.id === viewChoice);
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
        name: name.trim() || undefined,
        mode: role,
        ...(effectiveChoice === NEW_VIEW ? { newView: true } : effectiveChoice !== NONE ? { viewId: effectiveChoice } : {}),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        // Sent only when the operator moved the switch: an existing control
        // surface that is hidden should not be re-listed by a screen made for it.
        ...(role === "panel" && hasView && listed !== null ? { showInSidebar: listed } : {}),
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
            <RoleCards role={role} onChoose={setRole} />
            {role === "panel" && <SidebarRow checked={shownListed} onChange={setListed} />}
          </Section>
        )}
        {step === 2 && (
          <Section title="What it shows">
            <ViewPicker
              views={views}
              role={role}
              value={effectiveChoice}
              onChange={setViewChoice}
              newLabel="+ New blank view"
              noneLabel="— No view yet —"
            />
            {effectiveChoice === NEW_VIEW && (
              <p className="mt-1.5 text-caption1 text-fg-subtle">
                A blank {role === "panel" ? "control-surface" : "wall"} view named after the screen is made with it.
              </p>
            )}
          </Section>
        )}
        {step === 3 && (
          <Section title="Name and address">
            <FieldLabel htmlFor="new-screen-name">Name</FieldLabel>
            <Input
              id="new-screen-name"
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              className="h-8 w-full"
            />
            <FieldLabel htmlFor="new-screen-slug">Friendly link — optional</FieldLabel>
            <span className="mb-1 block truncate font-mono text-caption2 text-fg-faint">{baseUrl}/</span>
            <Input
              id="new-screen-slug"
              value={slug}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSlug(e.target.value)}
              placeholder="optional"
              autoComplete="off"
              className="h-8 w-full font-mono text-caption1"
            />
          </Section>
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
              view, a numbered name), so there is nothing to finish before it. */}
          <Button type="button" variant="accent" size="medium" onClick={() => void create()} disabled={busy}>
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
              outputs={outputs}
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
        <GuidedBody target={target} views={views} baseUrl={baseUrl} step={step} setStep={setStep} actions={actions} onClose={onClose} />
      ) : null}
    </aside>
  );
}
