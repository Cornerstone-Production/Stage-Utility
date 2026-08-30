import { errorMessage } from "@main/services/errors";
import { invoke, onNotification } from "../lib/api";
import { useStageState } from "../main/use-stage-state";
import { useState, useEffect, useCallback, useRef, type ChangeEvent, type ReactNode } from "react";
import { integrationDrafts } from "./integration-drafts";
import { SLIDE_MS, prefersReducedMotion, useSlideOnMove } from "../lib/use-slide-on-move";
import { useRevealNonce } from "../app/flash";
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
  Collapsible,
  NumberInput,
  toast,
  confirm,
  SkeletonRows,
  InfoHint,
  UnsavedBanner,
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

// ---- single integration card ------------------------------------------------

interface IntegrationCardProps {
  descriptor: IntegrationDescriptor;
  state: IntegrationState;
  onStateChange: (s: IntegrationState) => void;
  /** ISO timestamp of the last successful PCO sync (planning-center card only). */
  lastRefreshedAt?: string | null;
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

export function IntegrationCard({ descriptor, state, onStateChange, lastRefreshedAt }: IntegrationCardProps) {
  // Local config mirrors state.config but tracks in-progress edits.
  //
  // Seeded from the draft store, not only from `state`, because this card is
  // remounted for reasons that have nothing to do with the operator: enabling an
  // integration moves it into a different group and therefore a different place
  // in the React tree, and collapsing it unmounts the body outright. Held in
  // plain `useState` alone, everything typed since the last save went with it.
  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>(
    () => integrationDrafts.get(descriptor.id) ?? initialConfig(descriptor, state),
  );

  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Compare against the saved config rather than tracking a flag, so Save/Discard
  // appear only for genuine edits — and disappear again on their own after a save.
  const pristine = initialConfig(descriptor, state);
  const dirty = JSON.stringify(localConfig) !== JSON.stringify(pristine);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Park the draft above the card, and take it away again the moment the form
  // matches what is saved — so "there is a draft" stays a true statement, and a
  // clean card is seeded from the real state on its next mount.
  useEffect(() => {
    if (dirty) integrationDrafts.set(descriptor.id, localConfig);
    else integrationDrafts.clear(descriptor.id);
  }, [descriptor.id, dirty, localConfig]);

  // Put the operator back in the field they were typing in. Moving between
  // groups is a remount, and a remount blurs whatever had focus — so after
  // flicking the enable switch they were left scrolled to a different part of
  // the page with no caret anywhere. One-shot, taken from the store, so nothing
  // steals focus on an ordinary re-render.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const key = integrationDrafts.takeFocus(descriptor.id);
    if (!key) return;
    const el = bodyRef.current?.querySelector<HTMLInputElement>(
      `[data-config-field="${key}"] input`,
    );
    if (!el) return;
    // preventScroll, because the card is sitting on the FLIP's inverse transform
    // at this instant: it LOOKS like it has not moved, so the browser sees a
    // field already on screen and scrolls nowhere — and then the card slides to
    // its real position at the top of the page, taking the caret with it and
    // leaving the operator staring at a part of the list they were not in.
    el.focus({ preventScroll: true });
    // Caret where they left it, at the end of what they typed. Guarded because
    // setSelectionRange throws InvalidStateError on a native number input.
    if (el.type !== "number") el.setSelectionRange(el.value.length, el.value.length);
    // Then follow the card, once it has landed. jsdom has no scrollIntoView.
    const landed = window.setTimeout(
      () => el.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" }),
      SLIDE_MS,
    );
    return () => window.clearTimeout(landed);
  }, [descriptor.id]);

  function setField(key: string, value: unknown) {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
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
    } catch (err) {
      console.error("[IntegrationsPanel:save] error", err);
      toast.error(`Failed to save: ${String(err)}`);
    } finally {
      setIsSaving(false);
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

  const [isClearing, setIsClearing] = useState(false);
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

  return (
    // Getting-started sends "Connect Planning Center" straight at this card's form.
    <div
      className="flex flex-col gap-3"
      data-flash-id={integrationFlashId(descriptor.id)}
      ref={bodyRef}
      // One listener for the whole form rather than a prop on each control:
      // NumberInput takes a closed set of props and forwards no handler of its
      // own, and React's onFocus bubbles, so the field wrapper's marker is what
      // identifies which control the operator is in.
      onFocus={(e) => {
        const key = (e.target as HTMLElement)
          .closest("[data-config-field]")
          ?.getAttribute("data-config-field");
        if (key) integrationDrafts.noteFocus(descriptor.id, key);
      }}
    >
      {/* Schema-driven form */}
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
                    <SelectTrigger className="w-44" aria-label={field.label}>
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
                    onChange={(n) => setField(field.key, String(n))}
                    min={field.min}
                    max={field.max}
                    className="w-44"
                    aria-label={field.label}
                  />
                ) : (
                  <Input
                    type={field.type === "password" ? "password" : "text"}
                    value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder ?? ""}
                    className="w-44"
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

      {/* Unsaved changes — same bar as the patch sheet and the layout editor, so
          "you have edits" reads identically everywhere in the app. */}
      {dirty && (
        <UnsavedBanner
          compact
          className="self-start"
          saving={isSaving}
          onSave={handleSave}
          onDiscard={() => setLocalConfig(initialConfig(descriptor, state))}
        />
      )}

      {/* Actions row */}
      <div className="flex items-center gap-2">
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
            <span className="text-caption1 text-gray-9 tabular-nums">{fmtSynced(lastRefreshedAt)}</span>
          </>
        )}
        {testResult !== null && (
          <span
            className={cn(
              "text-caption1 flex items-center gap-1",
              testResult.ok ? "text-green-10" : "text-red-10",
            )}
          >
            {testResult.ok ? (
              <CheckCircle2Icon className="size-3.5 text-green-10 shrink-0" />
            ) : (
              <XCircleIcon className="size-3.5 text-red-10 shrink-0" />
            )}
            {testResult.ok ? (testResult.message ?? "OK") : (testResult.message ?? "Failed")}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- collapsible row + categories -------------------------------------------

// Groups the growing integration list by purpose so the page stays scannable.
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

const CATEGORY_ORDER: { title: string; ids: string[] }[] = [
  { title: "Service & plan", ids: ["planning-center", "prodcom"] },
  { title: "Presentation", ids: ["propresenter"] },
  { title: "Audio", ids: ["smaart"] },
  { title: "People", ids: ["sensource"] },
  { title: "Wireless", ids: ["wireless"] },
  { title: "Streaming", ids: ["resi", "youtube"] },
  { title: "Control & output", ids: ["obs", "reaper", "pvp", "osc", "rosstalk", "ross-tsl"] },
  // Its own group rather than "Control & output": scores are something the app
  // READS and shows, and nothing here controls a device. "People" is the only
  // other read-only feed and it is named for what it counts, so a general
  // heading is the honest place for this one.
  { title: "Information", ids: ["scores"] },
];

/** Two integrations that present as one card. RossTalk (commands, TCP 7788) and
 *  Ross MultiViewer (TSL UMD) are different protocols that usually address the
 *  same Carbonite, so two separate cards read as clutter. This is presentation
 *  only — each keeps its own id, enable flag, config and connection state, so
 *  layout buttons and automation actions referencing "rosstalk" are untouched. */
const PAIRS: { title: string; ids: [string, string] }[] = [
  { title: "Ross", ids: ["rosstalk", "ross-tsl"] },
];

/**
 * An integration is "in use" if it is enabled or has been configured. Everything
 * else is noise on this page — a site running three integrations should not scroll
 * past eleven. Nothing is hidden permanently and there is no preference to store:
 * the state already says which are in use, so the list reorganizes itself as soon
 * as one is set up. An ERRORING integration always stays in the main list, since an
 * error is exactly what you want to see.
 *
 * At module scope because it is also what the slide animation watches: a card
 * changes group exactly when this answer changes, and a signature built from
 * anything else would either miss a move or animate on a re-render that was not
 * one.
 */
function isInUse(state: IntegrationState): boolean {
  return state.enabled || state.configured !== false || state.connection === "error";
}

/** One integration as a collapsible card: header (name · status · enable) that
 *  expands to the config body. Configured integrations start collapsed; ones that
 *  still need setup start open, so the page opens on what needs attention. */
function IntegrationRow({
  descriptor,
  state,
  onStateChange,
  body,
  onBeforeMove,
}: {
  descriptor: IntegrationDescriptor;
  state: IntegrationState;
  onStateChange: (s: IntegrationState) => void;
  body: ReactNode;
  /** Called as the switch is flicked, before the state comes back — the moment
   *  to record where every card is, since this is what moves one. */
  onBeforeMove?: () => void;
}) {
  const [toggling, setToggling] = useState(false);
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
  return (
    // The id, not the position, is what the slide animation follows: enabling an
    // integration moves this card into a different group, which is a remount at
    // a different place in the tree.
    <div className="su-card px-3 py-2" data-slide-id={descriptor.id}>
      <IntegrationEntry
        descriptor={descriptor}
        state={state}
        body={body}
        toggling={toggling}
        onToggle={toggleEnabled}
      />
    </div>
  );
}

/** The collapsible header + body for one integration, without a card wrapper —
 *  so it can sit alone in its own card or beside a sibling inside a pair card. */
function IntegrationEntry({
  descriptor,
  state,
  body,
  toggling,
  onToggle,
}: {
  descriptor: IntegrationDescriptor;
  state: IntegrationState;
  body: ReactNode;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  // A CONFIGURED integration is collapsed, so the card the context bar's
  // "N disconnected" aims a highlight at is not in the DOM — the highlight had
  // nothing to land on and did nothing at all. Remounting with defaultOpen
  // reveals it, and the operator can still close it again afterwards.
  const revealNonce = useRevealNonce((id) => id === integrationFlashId(descriptor.id));
  return (
    <Collapsible
      key={revealNonce}
      defaultOpen={!state.configured || revealNonce > 0}
      label={<span className="text-callout font-semibold text-fg truncate">{descriptor.label}</span>}
      afterLabel={descriptor.description ? <InfoHint>{descriptor.description}</InfoHint> : undefined}
      right={
        <div className="flex items-center gap-3 shrink-0">
          <ConnectionBadge connection={state.connection} message={state.message} inbound={descriptor.inbound} />
          {/* No switch for an integration that dials US. There was one, and
              nothing was gated on it: turning Companion off left the module
              connecting and controlling the app exactly as before, while the
              row said it was disabled. */}
          {!descriptor.inbound && (
            <Switch
              checked={state.enabled}
              onCheckedChange={onToggle}
              disabled={toggling}
              aria-label={`Enable ${descriptor.label}`}
            />
          )}
        </div>
      }
    >
      <div className="pt-1">{body}</div>
    </Collapsible>
  );
}

/** One card holding two related integrations as sections. Each section keeps its
 *  own status badge and enable switch — this groups them visually, it does not
 *  merge them. */
function IntegrationPairRow({
  title,
  entries,
  onStateChange,
  onBeforeMove,
}: {
  title: string;
  entries: { descriptor: IntegrationDescriptor; state: IntegrationState; body: ReactNode }[];
  onStateChange: (id: string, s: IntegrationState) => void;
  onBeforeMove?: () => void;
}) {
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function toggle(id: string, label: string, enabled: boolean) {
    setTogglingId(id);
    onBeforeMove?.();
    try {
      const next = await ipc<IntegrationState>("integrations:setEnabled", { id, enabled });
      onStateChange(id, next);
    } catch (err) {
      toast.error(`Failed to ${enabled ? "enable" : "disable"} ${label}: ${String(err)}`);
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="su-card flex flex-col gap-1 px-3 py-2" data-slide-id={`pair:${title}`}>
      <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">{title}</span>
      {entries.map(({ descriptor, state, body }, i) => (
        <div key={descriptor.id} className={i > 0 ? "border-t border-line pt-1" : undefined}>
          <IntegrationEntry
            descriptor={descriptor}
            state={state}
            body={body}
            toggling={togglingId === descriptor.id}
            onToggle={(enabled) => toggle(descriptor.id, descriptor.label, enabled)}
          />
        </div>
      ))}
    </div>
  );
}

// ---- main export ------------------------------------------------------------

interface IntegrationsPanelProps {
  className?: string;
}

export function IntegrationsPanel({ className }: IntegrationsPanelProps) {
  // Getting Started points at a specific card, and an unconfigured integration
  // lives inside the collapsed "Not set up" group — which is exactly where a
  // first-run operator's PCO card is, so the highlight had nothing to land on.
  //
  // A nonce rather than a boolean: it remounts the group with defaultOpen, so
  // the operator can still close it afterwards, and there is no setState in an
  // effect to cascade renders. Declared here, above every early return, because
  // hooks must run in the same order on every render.
  // The "Not set up" group opens when the target is one of the cards inside it.
  // Same hook the rows use — this was the only copy of the pattern until the
  // rows needed it too.
  const revealNonce = useRevealNonce((flashId) => Object.values(FLASH_IDS).includes(flashId));

  // A draft lives exactly as long as this page is open. It has to outlive a
  // CARD — enabling an integration remounts one somewhere else — but leaving the
  // page is the operator walking away from the edit, and an unsaved value that
  // reappeared on a later visit would be a surprise they never asked for.
  useEffect(() => () => integrationDrafts.clearAll(), []);

  const queryClient = useQueryClient();
  const { state: stageState } = useStageState();

  const { data, isLoading, error } = useQuery({
    queryKey: ["integrations:list"],
    queryFn: () =>
      ipc<{ descriptors: IntegrationDescriptor[]; states: IntegrationState[] }>("integrations:list"),
  });

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
  // between "Not set up" and a category group. The same FLIP Home's grid uses;
  // it honours prefers-reduced-motion itself, which the global CSS override
  // cannot do for an inline transform.
  const moveSignature = (data?.states ?? [])
    .map((s) => `${s.id}:${isInUse(s) ? 1 : 0}`)
    .join("|");
  const { setHost: setSlideHost, capture: captureCardPositions } = useSlideOnMove(
    moveSignature,
    true,
    "data-slide-id",
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

  const { descriptors: allDescriptors, states } = data;
  const stateMap = new Map(states.map((s) => [s.id, s]));
  // Companion is listed here like everything else.
  //
  // It used to be filtered OUT, on the grounds that there is nothing to
  // configure — it dials in to us rather than the other way round. But "nothing
  // to configure" is not the same as "should not appear": this is the one page
  // whose job is to answer "what can this talk to", and the one integration
  // people go looking for was the one it did not mention.
  const descriptors = allDescriptors;
  const byId = new Map(descriptors.map((d) => [d.id, d]));

  // The body content for one integration: a bespoke panel (wireless/osc) or the
  // generic schema form (+ caption colors under ProdCom).
  const bodyFor = (descriptor: IntegrationDescriptor, state: IntegrationState): ReactNode => {
    if (descriptor.kind === "wireless") return <WirelessConnectionsPanel />;
    if (descriptor.id === "osc") return <OscTargetsPanel />;
    // Its own panel: the only setting is WHICH TEAMS, and a searchable
    // multi-league team picker is not expressible as a ConfigField.
    if (descriptor.id === "scores") return <ScoresTeamsPanel />;
    if (descriptor.id === "rosstalk") return <RossTalkTargetsPanel />;
    // Its own panel: what Companion needs is an address to dial and the module
    // to dial it with, not a form.
    if (descriptor.id === "companion") return <CompanionInfoPanel state={state} />;
    return (
      <>
        <IntegrationCard
          descriptor={descriptor}
          state={state}
          onStateChange={handleStateChange}
          lastRefreshedAt={stageState?.lastRefreshedAt ?? null}
        />
        {descriptor.id === "prodcom" && <CaptionColorsPanel />}
      </>
    );
  };

  // Summary strip + category groups (uncategorized descriptors fall into "Other").
  const connectedCount = descriptors.filter((d) => stateMap.get(d.id)?.connection === "connected").length;
  const needsSetup = descriptors.filter((d) => stateMap.get(d.id)?.configured === false).length;
  const categorized = new Set(CATEGORY_ORDER.flatMap((c) => c.ids));
  const inUse = (d: IntegrationDescriptor) => {
    const st = stateMap.get(d.id);
    return !!st && isInUse(st);
  };
  const dormant = descriptors.filter((d) => !inUse(d));
  const dormantIds = new Set(dormant.map((d) => d.id));

  const groups = [
    ...CATEGORY_ORDER.map((c) => ({
      title: c.title,
      items: c.ids
        .map((id) => byId.get(id))
        .filter((d): d is IntegrationDescriptor => !!d && !dormantIds.has(d.id)),
    })),
    { title: "Other", items: descriptors.filter((d) => !categorized.has(d.id) && !dormantIds.has(d.id)) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className={cn("flex flex-col gap-5", className)} ref={setSlideHost}>
      <p className="text-caption1 text-fg-subtle">
        <span className="font-medium text-accent">{connectedCount} connected</span>
        {needsSetup > 0 ? ` · ${needsSetup} to set up` : ""}
      </p>
      {groups.length === 0 && dormant.length > 0 && (
        <p className="text-caption1 text-fg-muted">
          Nothing set up yet — pick one below to get started.
        </p>
      )}
      {groups.map((g) => (
        <div key={g.title} className="flex flex-col gap-2">
          <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">{g.title}</span>
          {g.items.map((descriptor) => {
            const state = stateMap.get(descriptor.id);
            if (!state) return null;

            // Paired integrations render once, as a single card, in the position of
            // whichever id comes first; the sibling is skipped where it would have
            // rendered on its own.
            const pair = PAIRS.find((p) => p.ids.includes(descriptor.id));
            if (pair) {
              // Anchor to the first id actually in this group, not ids[0] — when one
              // half is dormant the card must still render for the half that isn't.
              const anchor = pair.ids.find((id) => g.items.some((d) => d.id === id));
              if (descriptor.id !== anchor) return null;
              const entries = pair.ids
                .map((id) => {
                  const d = byId.get(id);
                  const s = stateMap.get(id);
                  return d && s ? { descriptor: d, state: s, body: bodyFor(d, s) } : null;
                })
                .filter((e): e is { descriptor: IntegrationDescriptor; state: IntegrationState; body: ReactNode } => e !== null);
              return (
                <IntegrationPairRow
                  key={pair.title}
                  title={pair.title}
                  entries={entries}
                  onStateChange={(_id, s) => handleStateChange(s)}
                  onBeforeMove={captureCardPositions}
                />
              );
            }

            return (
              <IntegrationRow
                key={descriptor.id}
                descriptor={descriptor}
                state={state}
                onStateChange={handleStateChange}
                body={bodyFor(descriptor, state)}
                onBeforeMove={captureCardPositions}
              />
            );
          })}
        </div>
      ))}

      {dormant.length > 0 && (
        <Collapsible
          key={revealNonce}
          defaultOpen={revealNonce > 0}
          label={`Not set up (${dormant.length})`}
          summary="integrations you are not using"
        >
          <div className="flex flex-col gap-2 pt-2">
            {dormant.map((descriptor) => {
              const state = stateMap.get(descriptor.id);
              if (!state) return null;
              return (
                <IntegrationRow
                  key={descriptor.id}
                  descriptor={descriptor}
                  state={state}
                  onStateChange={handleStateChange}
                  body={bodyFor(descriptor, state)}
                  onBeforeMove={captureCardPositions}
                />
              );
            })}
          </div>
        </Collapsible>
      )}
    </div>
  );
}
