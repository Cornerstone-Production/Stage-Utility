import { errorMessage } from "@main/services/errors";
import { invoke, onNotification } from "../lib/api";
import { useStageState } from "../main/use-stage-state";
import { useState, useEffect, useCallback, useRef, type ChangeEvent, type ReactNode } from "react";
import { useSlideOnMove } from "../lib/use-slide-on-move";
import { useRevealTarget } from "../app/flash";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WirelessConnectionsPanel } from "./wireless-connections-panel";
import { OscTargetsPanel } from "./osc-targets-panel";
import { ScoresTeamsPanel } from "../settings/panels/scores-teams-panel";
import { RossTalkTargetsPanel } from "./rosstalk-targets-panel";
import { CompanionInfoPanel } from "./companion-info-panel";
import { CaptionColorsPanel } from "./caption-colors-panel";
import { SenSourceScopePicker } from "./sensource-scope-picker";
import { RossTslFeedsPanel } from "./ross-tsl-feeds-panel";
import { ProPresenterInstancesPanel } from "./propresenter-instances-panel";
import { ConnectionBadge } from "./connection-badge";
import { IpListField } from "./ip-list-field";
import { integrationDialogClass } from "./integration-dialog-size";
import { UnsavedChangesDialog } from "../editor/unsaved-changes-dialog";
import { UnsavedWorkProvider, useUnsavedWork } from "./unsaved-work";
import {
  Button,
  Field,
  FieldSet,
  FieldGroup,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Switch,
  NumberInput,
  toast,
  confirm,
  SkeletonRows,
  InfoHint,
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui";
import { Loader2Icon, CheckCircle2Icon, XCircleIcon, RefreshCwIcon, EraserIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { formatClock } from "../lib/clock-format";

// ---- helpers ----------------------------------------------------------------

function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(channel, args[0] as Record<string, unknown> | undefined);
}

const MASKED_PASSWORD = "••••••••";

function isPasswordMasked(value: string): boolean {
  return /^•+$/.test(value);
}

/**
 * Cards that Getting Started can point at, by integration id.
 *
 * Named here rather than inline so the reveal listener below and the attribute
 * that emits it cannot drift — a flash id with no card, or a card whose id
 * changed, would silently stop highlighting.
 */
const FLASH_IDS: Record<string, string | undefined> = {
  "planning-center": "pco-credentials",
};

/**
 * The `data-flash-id` for one integration's card.
 *
 * Every integration needs one, not just the two something happened to point at:
 * the context bar's "N disconnected" now sends you straight at whichever is
 * down, and that is any of them. Exported so the sender and the target derive
 * the same string from the same function — a hand-written id on one side is how
 * a highlight silently lands nowhere.
 */
export function integrationFlashId(id: string): string {
  return FLASH_IDS[id] ?? `integration-${id}`;
}

/**
 * The order integrations are laid out in, by purpose.
 *
 * The headings these categories used to draw are gone: eight of them over
 * sixteen integrations meant most held ONE card, and a heading above a single
 * card in a four-column grid wastes three quarters of the row and rebuilds the
 * tall thin column the grid exists to remove. The ORDER is kept, so Planning
 * Center and ProdCom still sit next to each other and the Ross pair is still
 * adjacent — which is all the pair card and the headings were really doing.
 */
const CATEGORY_ORDER: string[][] = [
  ["planning-center", "prodcom"], // Service & plan
  ["propresenter"], // Presentation
  ["smaart"], // Audio
  ["sensource"], // People
  ["wireless"], // Wireless
  ["resi", "youtube"], // Streaming
  ["obs", "reaper", "pvp", "osc", "rosstalk", "ross-tsl"], // Control & output
  ["scores"], // Information
];

const ORDER = CATEGORY_ORDER.flat();

/** Anything not named above sorts to the end of its half, in server order. */
function rank(id: string): number {
  const i = ORDER.indexOf(id);
  return i === -1 ? ORDER.length : i;
}

/**
 * An integration is "in use" if it is enabled or has been configured. Everything
 * else sorts below the "Not set up" heading and renders in the quiet treatment.
 * An ERRORING integration always stays up with the live ones, since an error is
 * exactly what you want to see — and it is what keeps "not set up" and "broken"
 * from reading alike now that both halves are on screen at once.
 *
 * At module scope because it is also what the slide animation watches: a card
 * changes group exactly when this answer changes, and a signature built from
 * anything else would either miss a move or animate on a re-render that was not
 * one.
 */
function isInUse(state: IntegrationState): boolean {
  return state.enabled || state.configured !== false || state.connection === "error";
}

/**
 * What the slide animation watches: it changes when, and only when, some
 * integration crosses between the two grids.
 *
 * Built from `isInUse` and nothing else. A signature that also carried, say, the
 * connection state would re-run the FLIP on every SSE push — sliding cards that
 * had not moved — and one that carried less would miss a move entirely.
 */
export function moveSignature(states: IntegrationState[]): string {
  return states.map((s) => `${s.id}:${isInUse(s) ? 1 : 0}`).join("|");
}

/** Config keys that name the machine an integration is pointed at. */
const HOST_KEYS = ["host", "url", "address", "ip", "server"];
const PORT_KEYS = ["port", "apiPort"];

function firstString(config: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = config[key];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/**
 * The card's second line: what this integration is pointed at, or what it is.
 *
 * A row could get away with a name and a badge because it was 1176px wide and
 * about to be opened anyway. A 252px card in a grid of sixteen has to answer
 * "which one is this" on its own, and for a configured integration the useful
 * answer is the address — that is what an operator is checking when something is
 * down. Derived from the descriptor rather than a per-id table, so adding an
 * integration cannot leave a card with a blank line under its name.
 */
export function summaryLine(descriptor: IntegrationDescriptor, state: IntegrationState): string {
  const host = firstString(state.config, HOST_KEYS);
  if (host) {
    const port = firstString(state.config, PORT_KEYS);
    return port ? `${host}:${port}` : host;
  }
  const sentence = descriptor.description?.match(/^[^.]+\./)?.[0];
  return sentence ?? descriptor.description ?? descriptor.label;
}

// "Synced 12:52 PM" for the PCO Refresh-now row; "Never synced" when null/invalid.
function fmtSynced(iso: string | null | undefined): string {
  if (!iso) return "Never synced";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never synced";
  return `Synced ${formatClock(d)}`;
}

/** The form's starting values for an integration — the saved config, with password
 *  fields masked and unset numbers prefilled from their default/placeholder.
 *  Hoisted out of the component so Discard can rebuild exactly the same thing. */
function initialConfig(
  descriptor: IntegrationDescriptor,
  state: IntegrationState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of descriptor.configSchema) {
    const raw = state.config[field.key];
    if (field.type === "password" && typeof raw === "string" && raw !== "") {
      out[field.key] = MASKED_PASSWORD;
    } else if (field.type === "number") {
      // Unset numeric fields (e.g. an API port) prefill the integration's
      // default — field.default if declared, else the numeric placeholder
      // (the shown default) — so the field displays and saves the real port
      // instead of a bare 0.
      const fallback =
        field.default ?? (field.placeholder != null && field.placeholder !== "" ? Number(field.placeholder) : undefined);
      const rawNum = raw == null || raw === "" ? NaN : Number(raw);
      out[field.key] = Number.isFinite(rawNum) && rawNum > 0 ? rawNum : (fallback ?? "");
    } else {
      out[field.key] = raw ?? field.default ?? "";
    }
  }
  return out;
}

/**
 * A panel that REPLACES the schema form, or null when the schema form is shown.
 *
 * These five have no ConfigField-shaped settings at all — a searchable team
 * picker, a list of receivers, a list of UDP targets, an address to dial us on —
 * and each saves its own list as it is edited. They therefore get no Save /
 * Discard and no Test in the dialog footer, exactly as they had neither in the
 * row.
 */
function bespokePanelFor(descriptor: IntegrationDescriptor, state: IntegrationState): ReactNode | null {
  if (descriptor.kind === "wireless") return <WirelessConnectionsPanel />;
  if (descriptor.id === "osc") return <OscTargetsPanel />;
  // Its own panel: the only setting is WHICH TEAMS, and a searchable
  // multi-league team picker is not expressible as a ConfigField.
  if (descriptor.id === "scores") return <ScoresTeamsPanel />;
  if (descriptor.id === "rosstalk") return <RossTalkTargetsPanel />;
  // Its own panel: what Companion needs is an address to dial and the module
  // to dial it with, not a form.
  if (descriptor.id === "companion") return <CompanionInfoPanel state={state} />;
  return null;
}

// ---- the card ---------------------------------------------------------------

/** One integration as a card: name, what it is pointed at, its connection, and
 *  an enable switch. Settings open in a dialog — the card never holds a form,
 *  which is what lets the grid stay a grid and the page fit on one screen. */
function IntegrationTile({
  descriptor,
  state,
  onOpen,
  onToggle,
  toggling,
}: {
  descriptor: IntegrationDescriptor;
  state: IntegrationState;
  onOpen: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  toggling: boolean;
}) {
  const dormant = !isInUse(state);
  return (
    <div
      role="button"
      tabIndex={0}
      // The flash target is the TILE, not the form. The form lives in a portal
      // and is not in the DOM until the dialog opens, so a highlight aimed at it
      // would land on nothing — which is the bug useRevealNonce existed to work
      // around by remounting a collapsed body open.
      data-flash-id={integrationFlashId(descriptor.id)}
      data-integration-card={descriptor.id}
      // The id, not the position, is what the slide animation follows: enabling
      // an integration moves this card into the other grid, which is a remount
      // at a different place in the tree.
      data-slide-id={descriptor.id}
      onClick={() => onOpen(descriptor.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(descriptor.id);
        }
      }}
      aria-haspopup="dialog"
      aria-label={`${descriptor.label} settings`}
      className={cn(
        "flex flex-col gap-1.5 rounded-[0.875rem] px-3 py-2.5 min-w-0 text-left cursor-pointer",
        "hover:border-line-strong transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        // Quieter, never dimmer. A dormant card is one an operator CLICKS — on a
        // fresh install every card on the page is one of these — so nothing here
        // is carried by faint text. The name drops from --su-fg (16.28:1 light)
        // to --su-fg-muted (5.63:1 light, 6.91:1 dark, both past AA), and the
        // rest of the signal is the ground, the dashed border, the missing
        // shadow and the words "Not set up". Neither --su-fg-faint (1.76:1) nor
        // --su-fg-subtle (2.45:1) appears on any text on this page.
        //
        // The two treatments are alternatives rather than a base plus overrides:
        // `.su-card` is declared inside @layer utilities and AFTER Tailwind's own
        // utilities in the same layer, so at equal specificity it wins on source
        // order — `su-card bg-transparent border-dashed shadow-none` painted a
        // solid white card with a solid border and a shadow, and the class list
        // said otherwise. Caught in a browser; a className assertion had passed.
        dormant
          ? "min-h-[4.5rem] border border-dashed border-line bg-transparent"
          : "su-card min-h-24",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "flex-1 min-w-0 text-callout truncate",
            dormant ? "font-medium text-fg-muted" : "font-semibold text-fg",
          )}
        >
          {descriptor.label}
        </span>
        {/* No switch for an integration that dials US. There was one, and
            nothing was gated on it: turning Companion off left the module
            connecting and controlling the app exactly as before, while the
            row said it was disabled. */}
        {!descriptor.inbound && (
          <Switch
            checked={state.enabled}
            disabled={toggling}
            aria-label={`Enable ${descriptor.label}`}
            // The switch is a control ON a card that is itself a button. Without
            // this, flicking it also opened the dialog.
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            onCheckedChange={(v: boolean) => onToggle(descriptor.id, v)}
          />
        )}
      </div>
      <span className="text-caption1 text-fg-muted line-clamp-2 min-w-0">
        {summaryLine(descriptor, state)}
      </span>
      <div className="mt-auto min-w-0">
        {dormant ? (
          <span className="text-caption1 text-fg-muted">Not set up</span>
        ) : (
          <ConnectionBadge
            connection={state.connection}
            message={state.message}
            inbound={descriptor.inbound}
          />
        )}
      </div>
    </div>
  );
}

// ---- the dialog -------------------------------------------------------------

interface IntegrationDialogProps {
  descriptor: IntegrationDescriptor;
  state: IntegrationState;
  onStateChange: (s: IntegrationState) => void;
  /** ISO timestamp of the last successful PCO sync (planning-center only). */
  lastRefreshedAt?: string | null;
  onClose: () => void;
  /** Called as the header switch is flicked, before the state comes back — the
   *  moment to record where every card is, since this is what moves one. */
  onBeforeMove?: () => void;
}

/**
 * One integration's settings, in a dialog.
 *
 * Explicit Save, not autosave, and that is not a change: the row already
 * compared against the saved config and offered Save / Discard. It has to stay
 * explicit for the same reason the screen-URL dialog gives — closing a dialog
 * blurs the field, so a blur-save races the unmount, and a value the server
 * REFUSED would read as accepted because the dialog is already gone. A bad
 * credential here comes back as a rejected promise, so the refusal has to stay
 * on screen.
 */
export function IntegrationDialog({
  descriptor,
  state,
  onStateChange,
  lastRefreshedAt,
  onClose,
  onBeforeMove,
}: IntegrationDialogProps) {
  const bespoke = bespokePanelFor(descriptor, state);

  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>(
    () => initialConfig(descriptor, state),
  );
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Sub-panels that hold their own unsaved buffer (the Ross TSL feeds, the
  // ProPresenter instances) register here. Their rows are not in the
  // descriptor's configSchema, so the comparison below is blind to them and
  // dismissing the dialog unmounted the buffer with no question asked.
  const panels = useUnsavedWork();

  // Compare against the saved config rather than tracking a flag, so Save/Discard
  // appear only for genuine edits — and disappear again on their own after a save.
  const pristine = initialConfig(descriptor, state);
  // A bespoke panel REPLACES the form, so nothing can move localConfig; the
  // guard keeps a state update arriving from the panel's own save from reading
  // as a typed edit.
  const schemaDirty = !bespoke && JSON.stringify(localConfig) !== JSON.stringify(pristine);
  // What a dismissal has to ask about: this form, plus every sub-panel buffer.
  const dirty = schemaDirty || panels.dirty;

  function setField(key: string, value: unknown) {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
  }

  /** Save, and say whether it landed. The caller decides what to do next — a
   *  failed save must not be followed by a close. */
  async function handleSave(): Promise<boolean> {
    setIsSaving(true);
    try {
      // Build config — skip password fields that still show the mask
      const config: Record<string, unknown> = {};
      for (const field of descriptor.configSchema) {
        const v = localConfig[field.key];
        if (field.type === "password" && typeof v === "string" && isPasswordMasked(v)) {
          // User hasn't changed this password — omit so the backend keeps the original
          continue;
        }
        config[field.key] = v;
      }
      console.log("[IntegrationsPanel:save]", descriptor.id, Object.keys(config));
      const next = await ipc<IntegrationState>("integrations:setConfig", { id: descriptor.id, config });
      onStateChange(next);
      // Re-seed the form from what was actually saved. `dirty` compares the form
      // against initialConfig(state), and that is not always what was typed: a
      // password comes back MASKED, and any value the backend normalises comes
      // back in its own form. Leaving the typed value in place made the two
      // permanently unequal, so "Unsaved changes" stayed up after a successful
      // save — most visibly after changing a secret.
      setLocalConfig(initialConfig(descriptor, next));
      toast.success(`${descriptor.label} settings saved.`);
      return true;
    } catch (err) {
      console.error("[IntegrationsPanel:save] error", err);
      toast.error(`Failed to save: ${String(err)}`);
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleEnabled(enabled: boolean) {
    setToggling(true);
    onBeforeMove?.();
    try {
      const next = await ipc<IntegrationState>("integrations:setEnabled", { id: descriptor.id, enabled });
      onStateChange(next);
    } catch (err) {
      toast.error(`Failed to ${enabled ? "enable" : "disable"}: ${String(err)}`);
    } finally {
      setToggling(false);
    }
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await ipc("stage:refresh");
      toast.success("Plan refreshed from PCO.");
    } catch (err) {
      toast.error(`Refresh failed: ${String(err)}`);
    } finally {
      setIsRefreshing(false);
    }
  }

  /**
   * Empty the transcript on every display at once.
   *
   * Here because a line CAN get stuck with nothing an operator can do: a partial
   * whose channel was renamed mid-service has no final coming to clear it, and
   * before this the only way out was restarting the server. That case is fixed,
   * but "the board is showing something I do not want on it, right now" deserves
   * a control regardless.
   */
  async function handleClearTranscript() {
    if (!(await confirm({
      title: "Clear the transcript?",
      message: "Every transcription display goes empty. New lines carry on arriving from ProdCom.",
      confirmLabel: "Clear",
    }))) return;
    setIsClearing(true);
    try {
      await invoke("prodcom:clearTranscript");
      toast.success("Transcript cleared.");
    } catch (err) {
      toast.error(`Could not clear the transcript: ${errorMessage(err)}`);
    } finally {
      setIsClearing(false);
    }
  }

  async function handleTest() {
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await ipc<{ ok: boolean; message?: string }>("integrations:test", { id: descriptor.id });
      console.log("[IntegrationsPanel:test]", descriptor.id, result);
      setTestResult(result);
    } catch (err) {
      console.error("[IntegrationsPanel:test] error", err);
      setTestResult({ ok: false, message: String(err) });
    } finally {
      setIsTesting(false);
    }
  }

  /** Escape, the X and a click outside all arrive here. A dismissed dialog is
   *  never consent to throw work away — this form's, or a sub-panel's. */
  function requestClose() {
    if (dirty) {
      setConfirming(true);
      return;
    }
    onClose();
  }

  /** Everything the confirm is asking about: each sub-panel's buffer, then this
   *  form. False if any of them refused — the dialog must then stay open. */
  async function saveEverything(): Promise<boolean> {
    const panelsOk = await panels.saveAll();
    const formOk = schemaDirty ? await handleSave() : true;
    return panelsOk && formOk;
  }

  const body = bespoke ?? (
    <div className="flex flex-col gap-3">
      <FieldSet flat>
        <FieldGroup>
          {descriptor.configSchema.map((field) => {
            const value = localConfig[field.key];
            // A field that belongs to the other way of connecting. Hidden rather
            // than disabled: it is not a control you could use, it is one this
            // setup has no question for. Its saved value is untouched.
            if (field.showIf && String(localConfig[field.showIf.key] ?? "") !== field.showIf.equals) {
              return null;
            }

            return (
              <Field key={field.key} data-config-field={field.key} orientation="horizontal">
                <FieldContent>
                  <FieldLabel className="flex items-center gap-1.5">
                    {field.label}
                    {field.help && <InfoHint>{field.help}</InfoHint>}
                  </FieldLabel>
                  {field.placeholder && (
                    <FieldDescription>{field.placeholder}</FieldDescription>
                  )}
                </FieldContent>

                {field.type === "select" ? (
                  <Select
                    value={typeof value === "string" ? value : ""}
                    onValueChange={(v: string) => setField(field.key, v)}
                  >
                    <SelectTrigger className="w-44 max-sm:w-full" aria-label={field.label}>
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options ?? []).map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : field.type === "ip-list" ? (
                  <IpListField
                    value={Array.isArray(value) ? (value as string[]) : []}
                    onChange={(v) => setField(field.key, v)}
                    placeholder={field.placeholder}
                  />
                ) : field.type === "number" ? (
                  <NumberInput
                    value={typeof value === "number" ? value : Number(value) || 0}
                    // The number, not String(n): initialConfig stores a number
                    // for a numeric field, so "4455" !== 4455 and one stepper
                    // click left the dialog permanently dirty — raising the
                    // unsaved-changes modal over a config identical to the saved one.
                    onChange={(n) => setField(field.key, n)}
                    min={field.min}
                    max={field.max}
                    className="w-44 max-sm:w-full"
                    aria-label={field.label}
                  />
                ) : (
                  <Input
                    type={field.type === "password" ? "password" : "text"}
                    value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder ?? ""}
                    className="w-44 max-sm:w-full"
                    aria-label={field.label}
                  />
                )}
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>

      {descriptor.id === "sensource" && (
        <SenSourceScopePicker state={state} onStateChange={onStateChange} />
      )}
      {descriptor.id === "ross-tsl" && (
        <RossTslFeedsPanel state={state} onStateChange={onStateChange} />
      )}
      {descriptor.id === "propresenter" && (
        <ProPresenterInstancesPanel state={state} onStateChange={onStateChange} />
      )}
      {descriptor.id === "prodcom" && <CaptionColorsPanel />}
    </div>
  );

  return (
    <>
      <DialogRoot
        open
        onOpenChange={(next: boolean) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent
          className={integrationDialogClass(descriptor.id)}
          // Focus is put back by the panel, which looks the card up by id after
          // the grid has settled. Radix would otherwise restore it to the node
          // it took focus from, and saving can move that card into the other
          // grid — which unmounts the node and drops focus onto <body>.
          onCloseAutoFocus={(e: Event) => e.preventDefault()}
        >
          <DialogHeader className="flex-row items-start gap-3 border-b border-line px-5 pb-3 pt-4 mb-0">
            <div className="min-w-0">
              <DialogTitle>{descriptor.label}</DialogTitle>
              {descriptor.description && (
                <DialogDescription>{descriptor.description}</DialogDescription>
              )}
            </div>
            {/* Room for the X in the corner. */}
            <div className="ml-auto mr-6 flex shrink-0 items-center gap-3">
              <ConnectionBadge
                connection={state.connection}
                message={state.message}
                inbound={descriptor.inbound}
              />
              {!descriptor.inbound && (
                <Switch
                  checked={state.enabled}
                  disabled={toggling}
                  onCheckedChange={toggleEnabled}
                  aria-label={`Enable ${descriptor.label}`}
                />
              )}
            </div>
          </DialogHeader>

          {/* The provider wraps the body, not the footer: only a sub-panel
              inside the body reports unsaved work. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <UnsavedWorkProvider registry={panels.registry}>{body}</UnsavedWorkProvider>
          </div>

          {!bespoke && (
            <DialogFooter className="mt-0 flex-wrap justify-start gap-2 border-t border-line px-5 py-3">
              <Button variant="transparent" size="small" onClick={handleTest} disabled={isTesting}>
                {isTesting ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : null}
                Test connection
              </Button>
              {descriptor.id === "prodcom" && (
                <Button variant="transparent" size="small" onClick={handleClearTranscript} disabled={isClearing}>
                  {isClearing
                    ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" />
                    : <EraserIcon className="size-3.5 text-gray-9" />}
                  Clear transcript
                </Button>
              )}
              {descriptor.id === "planning-center" && (
                <>
                  <Button variant="transparent" size="small" onClick={handleRefresh} disabled={isRefreshing}>
                    {isRefreshing
                      ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" />
                      : <RefreshCwIcon className="size-3.5 text-gray-9" />}
                    Refresh now
                  </Button>
                  <span className="text-caption1 text-fg-muted tabular-nums">{fmtSynced(lastRefreshedAt)}</span>
                </>
              )}
              {testResult !== null && (
                <span
                  className={cn(
                    "text-caption1 flex min-w-0 items-center gap-1",
                    testResult.ok ? "text-green-10" : "text-red-10",
                  )}
                >
                  {testResult.ok ? (
                    <CheckCircle2Icon className="size-3.5 text-green-10 shrink-0" />
                  ) : (
                    <XCircleIcon className="size-3.5 text-red-10 shrink-0" />
                  )}
                  <span className="truncate">
                    {testResult.ok ? (testResult.message ?? "OK") : (testResult.message ?? "Failed")}
                  </span>
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="transparent"
                  size="small"
                  disabled={!schemaDirty || isSaving}
                  onClick={() => setLocalConfig(initialConfig(descriptor, state))}
                >
                  Discard
                </Button>
                <Button variant="accent" size="small" disabled={!schemaDirty || isSaving} onClick={handleSave}>
                  {isSaving ? "Saving…" : "Save"}
                </Button>
              </div>
            </DialogFooter>
          )}
        </DialogContent>
      </DialogRoot>

      <UnsavedChangesDialog
        open={confirming}
        saving={isSaving}
        description={`Your changes to ${descriptor.label} have not been saved.`}
        saveLabel="Save & close"
        onCancel={() => setConfirming(false)}
        onDiscard={() => {
          setConfirming(false);
          onClose();
        }}
        onSave={async () => {
          // Only close if it actually saved. A rejected credential has to stay
          // on screen; closing on a failure is how work reads as saved and is not.
          if (!(await saveEverything())) return;
          setConfirming(false);
          onClose();
        }}
      />
    </>
  );
}

// ---- main export ------------------------------------------------------------

/** One column under `sm`, an auto-filling grid above it.
 *
 *  `minmax(0,1fr)` for the phone track, not a bare `1fr`: an automatic minimum
 *  is `min-content`, and a nowrap description inside one card made the track
 *  752px wide inside a 390px viewport, scrolling the whole page sideways. Every
 *  child carries `min-w-0` for the same reason. */
const GRID =
  "grid gap-2.5 grid-cols-[minmax(0,1fr)] sm:grid-cols-[repeat(auto-fill,minmax(15.75rem,1fr))] [&>*]:min-w-0";

interface IntegrationsPanelProps {
  className?: string;
  /** Which integration's settings are open, as an id or a flash id. Omit to let
   *  the panel hold it itself; the route passes it so the open dialog is URL
   *  state and the browser's Back button closes it. Same uncontrolled-unless-
   *  told shape the app's own `Dialog` uses. */
  open?: string | null;
  onOpenChange?: (next: string | null) => void;
}

export function IntegrationsPanel({ className, open: openProp, onOpenChange }: IntegrationsPanelProps) {
  // The dialog to show, held as EITHER an integration id (a card was clicked) or
  // a flash id (something asked us to reveal one). Resolved below, at render
  // time rather than in an effect, because the common reveal arrives from
  // another page: the request lands before the descriptors it has to be matched
  // against, and a resolution parked in an effect is a cascading render for
  // something the render can just work out.
  const [ownWanted, setOwnWanted] = useState<string | null>(null);
  const controlled = openProp !== undefined;
  const wanted = controlled ? openProp : ownWanted;
  const setWanted = useCallback(
    (next: string | null) => {
      if (controlled) onOpenChange?.(next);
      else setOwnWanted(next);
    },
    [controlled, onOpenChange],
  );
  // A reveal names one integration: the context bar's "N disconnected", or
  // Getting Started's "Connect Planning Center". Open its settings — the
  // operator clicked it to DO something. Nothing needs expanding first; every
  // card is mounted, always.
  useRevealTarget(setWanted);

  const queryClient = useQueryClient();
  const { state: stageState } = useStageState();

  const { data, isLoading, error } = useQuery({
    queryKey: ["integrations:list"],
    queryFn: () =>
      ipc<{ descriptors: IntegrationDescriptor[]; states: IntegrationState[] }>("integrations:list"),
  });

  // `wanted` as an integration id if it is one, else the integration whose flash
  // id it is, else nothing at all — an id nobody here owns opens no dialog and
  // does not throw.
  const openId =
    wanted === null || !data
      ? null
      : (data.descriptors.find((d) => d.id === wanted || integrationFlashId(d.id) === wanted)?.id ??
        null);

  // Live state updates from backend broadcasts
  useEffect(() => {
    const unsub = onNotification(
      "integrations:state-changed",
      (payload: unknown) => {
        const states = payload as IntegrationState[];
        queryClient.setQueryData(
          ["integrations:list"],
          (prev: { descriptors: IntegrationDescriptor[]; states: IntegrationState[] } | undefined) => {
            if (!prev) return prev;
            return { ...prev, states };
          },
        );
      },
    );
    return unsub;
  }, [queryClient]);

  const handleStateChange = useCallback(
    (updated: IntegrationState) => {
      queryClient.setQueryData(
        ["integrations:list"],
        (prev: { descriptors: IntegrationDescriptor[]; states: IntegrationState[] } | undefined) => {
          if (!prev) return prev;
          return {
            ...prev,
            states: prev.states.map((s) => (s.id === updated.id ? updated : s)),
          };
        },
      );
    },
    [queryClient],
  );

  // Slide a card that changes group instead of teleporting it. Declared here,
  // above every early return, because hooks must run in the same order on every
  // render — so the signature is built from the raw states rather than from the
  // grouped lists below. It changes when, and only when, a descriptor crosses
  // between "Not set up" and the grid above it. The same FLIP Home's grid uses
  // between grid cells; it honours prefers-reduced-motion itself, which the
  // global CSS override cannot do for an inline transform.
  const { setHost: setSlideHost, capture: captureCardPositions } = useSlideOnMove(
    moveSignature(data?.states ?? []),
    true,
    "data-slide-id",
  );

  // Put the operator back on the card they opened. Radix restores focus to the
  // NODE it took it from, and saving can move that card into the other grid,
  // which unmounts the node and leaves focus on <body> with nowhere to arrow
  // from. Run after the commit that closed the dialog, so the card is wherever
  // it has ended up, and look it up by id rather than holding the old element.
  const wasOpen = useRef<string | null>(null);
  useEffect(() => {
    const closed = wasOpen.current;
    wasOpen.current = openId;
    if (openId !== null || closed === null) return;
    document
      .querySelector<HTMLElement>(`[data-integration-card="${closed}"]`)
      ?.focus({ preventScroll: true });
  }, [openId]);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      setTogglingId(id);
      captureCardPositions();
      try {
        const next = await ipc<IntegrationState>("integrations:setEnabled", { id, enabled });
        handleStateChange(next);
      } catch (err) {
        toast.error(`Failed to ${enabled ? "enable" : "disable"}: ${String(err)}`);
      } finally {
        setTogglingId(null);
      }
    },
    [captureCardPositions, handleStateChange],
  );

  if (isLoading) {
    return (
      <div className={cn("py-2", className)}>
        <SkeletonRows rows={4} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={cn("flex items-center justify-center py-8", className)}>
        <span className="text-body text-red-10">Failed to load integrations.</span>
      </div>
    );
  }

  const { descriptors, states } = data;
  const stateMap = new Map(states.map((s) => [s.id, s]));
  const byId = new Map(descriptors.map((d) => [d.id, d]));

  const inUse = (d: IntegrationDescriptor) => {
    const st = stateMap.get(d.id);
    return !!st && isInUse(st);
  };
  const byOrder = (a: IntegrationDescriptor, b: IntegrationDescriptor) => rank(a.id) - rank(b.id);
  const live = descriptors.filter(inUse).sort(byOrder);
  const dormant = descriptors.filter((d) => !inUse(d)).sort(byOrder);

  const connectedCount = descriptors.filter((d) => stateMap.get(d.id)?.connection === "connected").length;

  const renderTile = (descriptor: IntegrationDescriptor) => {
    const state = stateMap.get(descriptor.id);
    if (!state) return null;
    return (
      <IntegrationTile
        key={descriptor.id}
        descriptor={descriptor}
        state={state}
        onOpen={setWanted}
        onToggle={handleToggle}
        toggling={togglingId === descriptor.id}
      />
    );
  };

  const open = openId ? byId.get(openId) : undefined;
  const openState = openId ? stateMap.get(openId) : undefined;

  return (
    <div className={cn("flex flex-col gap-2.5", className)} ref={setSlideHost}>
      {live.length === 0 ? (
        // "0 of 16 connected" is a useless thing to lead a fresh install with,
        // so the sentence replaces the count rather than sitting under it.
        // "open any card" names the interaction, which is not obvious from a card
        // that no longer looks like a form.
        <p className="text-caption1 text-fg-muted">
          Nothing is set up yet — open any card to connect it.
        </p>
      ) : (
        // A denominator, because how many of the sixteen are up is the one fact
        // no single card can tell you. The old "M to set up" is cut: those cards
        // are now on screen under a heading that names the state.
        <p className="text-caption1 text-fg-muted">
          <span className="font-medium text-accent">{connectedCount}</span> of {descriptors.length} connected
        </p>
      )}

      {live.length > 0 && <div className={GRID}>{live.map(renderTile)}</div>}

      {dormant.length > 0 && (
        // A heading, not a disclosure. The same grammar as any other group
        // heading in the app, over a rule — so this reads as "another group, not
        // set up", never as an error area. No count: the cards are on screen.
        <section className="mt-2.5 border-t border-line pt-[18px]">
          <span className="mb-2 block text-caption2 font-semibold uppercase tracking-wider text-fg-muted">
            Not set up
          </span>
          <div className={GRID}>{dormant.map(renderTile)}</div>
        </section>
      )}

      {/* Rendered here, next to the grid, rather than inside the tile. A dialog
          owned by a tile is unmounted when that tile moves between grids — which
          is exactly what enabling an integration does, and exactly how everything
          typed used to be lost. In a portal beside the grid it does not care what
          the grid does. */}
      {open && openState && (
        <IntegrationDialog
          key={open.id}
          descriptor={open}
          state={openState}
          onStateChange={handleStateChange}
          lastRefreshedAt={stageState?.lastRefreshedAt ?? null}
          onClose={() => setWanted(null)}
          onBeforeMove={captureCardPositions}
        />
      )}
    </div>
  );
}
