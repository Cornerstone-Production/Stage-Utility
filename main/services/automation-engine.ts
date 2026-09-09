// automation-engine.ts — subscribes to the broadcast bus and runs the rules.
//
// The bus carries state SNAPSHOTS, so the engine keeps the previous snapshot per
// channel and asks each trigger's pure didFire whether an EDGE occurred.
//
// The most important line in this file is the seeding guard in handleBroadcast:
// the first snapshot on a channel is stored and never evaluated. Without it a
// restart mid-service would read the first snapshot as a transition and fire every
// rule at once, unattended.

import { errorMessage } from "./errors.js";
import { randomUUID } from "node:crypto";
import { scrub } from "./scrub.js";

import type { AutomationSettings, ConditionCtx, Rule } from "../types/automation.js";
import { addBroadcastListener, addChannelDemandSource, broadcast } from "./broadcaster.js";
import { AUTOMATION_ACTIONS } from "./automation-actions.js";
import { missingSentence, readFingerprint } from "./companion-fingerprint.js";
import { AUTOMATION_CONDITIONS, allConditionsHold, firstFailingCondition, serviceQuietness } from "./automation-conditions.js";
import { sampleArchive } from "./archive/sample-archive.js";
import { automationLog } from "./automation-log.js";
import { automationStore } from "./automation-store.js";
import { integrationManager } from "./integration-manager.js";
import { signalStore } from "./signal-store.js";
import { obsService } from "./obs-service.js";
import { resiService } from "./resi-service.js";
import { youtubeService } from "./youtube-service.js";
import { pvpService } from "./pvp-service.js";
import { reaperService } from "./reaper-service.js";
import { baptismTimerService } from "./baptism-timer-service.js";
import { AUTOMATION_TRIGGERS, CALL_CHANNEL, CALL_TRIGGER_ID, isValidCueName, triggersForChannel } from "./automation-triggers.js";
import { splRecorder } from "./spl-recorder.js";
import { stageController } from "./stage-controller.js";

/** Why a call was refused. Each maps to one sentence the caller can speak. */
export type CueBlockReason =
  | "disabled"
  | "disarmed"
  | "service-live"
  | "planning-center-unknown"
  | "once-per-service"
  | "condition-not-met"
  | "cooldown"
  | "button-missing";

/**
 * What a call answers with. A STATUS plus a body, decided here rather than in
 * the route, so the refusal reasons live beside the guards that produce them.
 */
export type CueCallResult =
  | { status: 200; body: { ok: boolean; detail: string; simulated?: true } }
  | { status: 202; body: { confirm: string; expiresInSec: number } }
  | { status: 404; body: { error: string; reason: "unknown" } }
  | { status: 409; body: { error: string; reason: CueBlockReason; plan?: string } };

/** ISO timestamp -> epoch ms, or null when absent or unparseable. */
function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** How long a handed-out confirmation stays good. Long enough to say "yes",
 *  short enough that walking away cancels it. */
const CONFIRM_WINDOW_MS = 30_000;

class AutomationEngine {
  private rules: Rule[] = [];
  private settings: AutomationSettings = { simulate: true, disarmed: false };
  /** Last snapshot seen per channel. Absent = not yet seeded. */
  private prev = new Map<string, unknown>();
  private lastFiredAt = new Map<string, number>();
  private firedForService = new Map<string, string>();
  /** Latest service occurrence id, taken from the pco:live payload when one flows.
   *  Preferred over stageController so the engine stays drivable by a broadcast
   *  alone — which is what makes oncePerService testable without the controller. */
  private serviceKeyFromBus: string | null = null;
  /** ruleId -> the confirmation handed out and when it lapses. In memory only:
   *  a confirmation must not survive a restart, which is thirty seconds of
   *  nobody watching turning into a cue that fires on a call made yesterday. */
  private pendingConfirm = new Map<string, { token: string; expiresAt: number }>();
  private subscribed = false;

  async init(): Promise<void> {
    await automationLog.init();
    // Populate the signal cache before any client can ask for the hello burst.
    await signalStore.init();
    this.rules = await automationStore.loadRules();
    this.settings = await automationStore.loadSettings();
    // Re-seeding on every init is deliberate: a restart must never inherit stale
    // edges from the previous process.
    this.prev.clear();
    this.lastFiredAt.clear();
    this.firedForService.clear();
    this.pendingConfirm.clear();
    this.serviceKeyFromBus = null;

    if (!this.subscribed) {
      this.subscribed = true;
      addBroadcastListener((channel, payload) => {
        // Never recurse on our own channels.
        if (channel.startsWith("automation:")) return;
        void this.handleBroadcast(channel, payload, Date.now());
      });
    }
  }

  listRules(): Rule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  getSettings(): AutomationSettings {
    return { ...this.settings };
  }

  async setSettings(patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
    this.settings = await automationStore.saveSettings(patch);
    broadcast("automation:settings", this.getSettings());
    return this.getSettings();
  }

  /**
   * Refuse a cue name that is blank, malformed or already taken.
   *
   * A cue name IS a URL and a Home Assistant entity id, and two rules answering
   * to one name means `POST /api/cues/projectors_off` picks whichever happens to
   * be first in the file. Checked on the way in, where it can still be a 400,
   * rather than resolved at call time where it would be a coin toss.
   */
  private assertCueNameFree(rule: Pick<Rule, "trigger">, exceptId: string | null): void {
    if (rule.trigger?.id !== CALL_TRIGGER_ID) return;
    const name = String(rule.trigger.params?.name ?? "").trim().toLowerCase();
    if (!name) throw new Error("A called cue needs a name");
    if (!isValidCueName(name)) {
      throw new Error(`"${name}" is not a usable cue name — use lower_snake_case`);
    }
    const clash = this.rules.find((r) => r.id !== exceptId && this.cueNameOf(r) === name);
    if (clash) throw new Error(`The cue name "${name}" is already used by "${clash.name}"`);
  }

  async addRule(rule: Omit<Rule, "id">): Promise<Rule> {
    this.assertCueNameFree(rule, null);
    const next: Rule = { ...rule, id: randomUUID() };
    this.rules.push(next);
    await automationStore.saveRules(this.rules);
    broadcast("automation:rules", { rules: this.listRules() });
    return next;
  }

  async updateRule(id: string, patch: Partial<Omit<Rule, "id">>): Promise<Rule[]> {
    const r = this.rules.find((x) => x.id === id);
    if (!r) throw new Error(`Automation: unknown rule ${id}`);
    this.assertCueNameFree({ ...r, ...patch }, id);
    Object.assign(r, patch);
    await automationStore.saveRules(this.rules);
    broadcast("automation:rules", { rules: this.listRules() });
    return this.listRules();
  }

  async removeRule(id: string): Promise<Rule[]> {
    this.rules = this.rules.filter((r) => r.id !== id);
    await automationStore.saveRules(this.rules);
    broadcast("automation:rules", { rules: this.listRules() });
    return this.listRules();
  }

  /** Run a rule's action now, ignoring its trigger. Explicit operator intent, so it
   *  runs even for a disabled rule — but still honours simulate. */
  async testFire(id: string): Promise<{ ok: boolean; detail: string }> {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error(`Automation: unknown rule ${id}`);
    return this.runAction(rule, "test fire");
  }

  // ── Called cues ────────────────────────────────────────────────────────────

  /** Rules whose trigger is `call.by-name`, in rule order. */
  cueRules(): Rule[] {
    return this.rules.filter((r) => r.trigger.id === CALL_TRIGGER_ID).map((r) => ({ ...r }));
  }

  /** The cue name a rule answers to, or "" when it is not a cue at all. */
  cueNameOf(rule: Rule): string {
    if (rule.trigger.id !== CALL_TRIGGER_ID) return "";
    return String(rule.trigger.params.name ?? "").trim().toLowerCase();
  }

  /**
   * Fire a cue by name, on behalf of an identified caller.
   *
   * Everything a triggered rule is subject to still applies — disarm, the rule's
   * own switch, its conditions, its cooldown — because a cue IS a rule and giving
   * it a second, looser path through the engine is how the guards drift apart.
   * What a call adds is that every outcome, including every refusal, comes back
   * as a status and a sentence somebody can read out loud, and lands in the
   * activity log with the caller on it.
   */
  async callByName(
    name: string,
    opts: { caller: string; confirm?: string | null; now?: number },
  ): Promise<CueCallResult> {
    const now = opts.now ?? Date.now();
    const wanted = name.trim().toLowerCase();
    const rule = this.rules.find((r) => this.cueNameOf(r) === wanted && wanted !== "");

    if (!rule) {
      console.warn(`[cues] ${scrub(wanted)} by ${scrub(opts.caller)}: blocked (unknown)`);
      return { status: 404, body: { error: `There is no cue called ${wanted}`, reason: "unknown" } };
    }

    const blocked = (
      reason: CueBlockReason,
      sentence: string,
      extra: Record<string, string> = {},
    ): CueCallResult => {
      // A condition that did not hold is logged as such whichever condition it
      // was — `service-live` is a reason code for the CALLER, not a different
      // kind of outcome, and logging it as a plain suppression would hide it
      // from anyone filtering the activity log for gated rules.
      const outcome =
        reason === "condition-not-met" ||
        reason === "service-live" ||
        reason === "planning-center-unknown"
          ? "condition-not-met"
          : "suppressed";
      this.log(rule, outcome, sentence, opts.caller);
      console.warn(`[cues] ${scrub(wanted)} by ${scrub(opts.caller)}: blocked (${scrub(reason)})`);
      return { status: 409, body: { error: sentence, reason, ...extra } };
    };

    if (!rule.enabled) {
      return blocked("disabled", `The cue ${wanted} is switched off`);
    }
    if (this.settings.disarmed) {
      return blocked("disarmed", "Automation is disarmed, so nothing will run");
    }
    // The button this cue presses is not in Companion's export any more. Refused
    // before the conditions, because it is the one refusal that no amount of
    // waiting fixes — a caller told "not right now" would try again all morning.
    // The action itself refuses too, for every other way a rule can fire.
    if (rule.action.id === "companion.press") {
      const f = readFingerprint(rule.action.params);
      if (f.status === "missing") {
        return blocked("button-missing", missingSentence(f));
      }
    }

    const ctx = this.conditionCtx();
    const failing = firstFailingCondition(rule.conditions, ctx, now);
    if (failing !== null) {
      // `service.is-not-live` is called out by name because it is the guard that
      // exists for this feature — "not during a service" — and a caller reading
      // "a condition did not hold" down a phone line learns nothing. Its three
      // failing answers are three different things to say.
      if (failing === "service.is-not-live") {
        const plan = stageController.getState().planTitle;
        switch (serviceQuietness(ctx, now)) {
          case "live":
            return blocked("service-live", plan ? `${plan} is live` : "A service is live", plan ? { plan } : {});
          case "starting":
            return blocked(
              "service-live",
              plan ? `${plan} is about to start` : "A service is about to start",
              plan ? { plan } : {},
            );
          case "unknown":
            // Logged as well as answered: an operator hearing "I cannot tell"
            // needs somewhere to find out that PCO is the thing that is broken.
            console.warn(
              `[cues] ${scrub(wanted)} by ${scrub(opts.caller)}: Planning Center state is unreadable, refusing`,
            );
            return blocked(
              "planning-center-unknown",
              "I cannot tell whether a service is running — Planning Center is not answering",
            );
          case "quiet":
            // Unreachable: the condition holds when it is quiet. Falls through to
            // the generic wording rather than claiming a service is live.
            break;
        }
      }
      const label = AUTOMATION_CONDITIONS[failing]?.label ?? failing;
      return blocked("condition-not-met", `Not right now — ${label.toLowerCase()} is not satisfied`);
    }

    const last = this.lastFiredAt.get(rule.id);
    if (last !== undefined && rule.cooldownSec > 0) {
      const remaining = Math.ceil((last + rule.cooldownSec * 1000 - now) / 1000);
      if (remaining > 0) {
        return blocked("cooldown", `${wanted} just ran — try again in ${remaining} second${remaining === 1 ? "" : "s"}`);
      }
    }

    // oncePerService applies to a CALL exactly as it does to a triggered fire —
    // it was read from the rule and silently ignored here, so "the pre-service
    // announcement, once" ran as often as anybody asked for it. Checked before
    // the confirmation so a cue that cannot run is not answered "say that again".
    if (rule.oncePerService) {
      const key = this.serviceKey();
      if (key && this.firedForService.get(rule.id) === key) {
        return blocked("once-per-service", `${wanted} has already run for this service`);
      }
    }

    if (rule.confirmRequired) {
      const pending = this.pendingConfirm.get(rule.id);
      const presented = String(opts.confirm ?? "").trim();
      const valid = !!pending && pending.expiresAt > now && presented !== "" && presented === pending.token;
      if (!valid) {
        const token = randomUUID();
        this.pendingConfirm.set(rule.id, { token, expiresAt: now + CONFIRM_WINDOW_MS });
        this.log(rule, "suppressed", `awaiting confirmation (${CONFIRM_WINDOW_MS / 1000}s)`, opts.caller);
        console.log(`[cues] ${scrub(wanted)} by ${scrub(opts.caller)}: blocked (confirm-required)`);
        return { status: 202, body: { confirm: token, expiresInSec: CONFIRM_WINDOW_MS / 1000 } };
      }
      this.pendingConfirm.delete(rule.id);
    }

    this.lastFiredAt.set(rule.id, now);
    if (rule.oncePerService) {
      const key = this.serviceKey();
      if (key) this.firedForService.set(rule.id, key);
    }
    const result = await this.runAction(rule, `call by ${opts.caller}`, opts.caller);
    const verdict = result.ok ? "dispatched" : "blocked (action-failed)";
    console.log(`[cues] ${scrub(wanted)} by ${scrub(opts.caller)}: ${scrub(verdict)}`);
    // Simulate is on by default on a fresh install, and a call that answers a
    // plain 200 while nothing reached a device is a switch in Home Assistant
    // that flips with the projectors still off. The flag is how a caller can
    // tell; `detail` already reads "would press …".
    return this.settings.simulate
      ? { status: 200, body: { ...result, simulated: true } }
      : { status: 200, body: result };
  }

  /** Exposed for tests — drives the engine with a synthetic broadcast. */
  async __handleBroadcast(channel: string, payload: unknown, now: number): Promise<void> {
    return this.handleBroadcast(channel, payload, now);
  }

  private async handleBroadcast(channel: string, payload: unknown, now: number): Promise<void> {
    // Track the live service occurrence straight off the bus, before any early
    // return — oncePerService keys on it and must not depend on evaluation order.
    if (channel === "pco:live" && payload && typeof payload === "object") {
      const id = (payload as { serviceTimeId?: unknown }).serviceTimeId;
      if (typeof id === "string" && id) this.serviceKeyFromBus = id;
    }

    const triggers = triggersForChannel(channel);
    if (triggers.length === 0) return;

    const had = this.prev.has(channel);
    const prev = this.prev.get(channel) ?? null;
    this.prev.set(channel, payload);
    // SEEDING: the first snapshot on a channel establishes a baseline and is never
    // evaluated. This is what stops a restart mid-service firing everything.
    if (!had) return;

    if (this.settings.disarmed) return;

    const ctx = this.conditionCtx();
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const trigger = AUTOMATION_TRIGGERS[rule.trigger.id];
      if (!trigger || trigger.channel !== channel) continue;
      // A CALLED cue never fires from the bus. `didFire` returns false for it as
      // well, but that is the trigger author's discipline and this is the
      // engine's: a cue that pressed a real button because a snapshot changed is
      // the one failure this whole feature must not have.
      if (trigger.channel === CALL_CHANNEL) continue;

      let fired: boolean;
      try {
        fired = trigger.didFire(prev, payload, rule.trigger.params, now);
      } catch {
        // A malformed payload must not take the engine down.
        fired = false;
      }
      if (!fired) continue;

      if (!allConditionsHold(rule.conditions, ctx, now)) {
        this.log(rule, "condition-not-met", "a condition did not hold");
        continue;
      }

      const suppression = this.suppressionFor(rule, now);
      if (suppression) {
        this.log(rule, "suppressed", suppression);
        continue;
      }

      this.lastFiredAt.set(rule.id, now);
      if (rule.oncePerService) {
        const key = this.serviceKey();
        if (key) this.firedForService.set(rule.id, key);
      }
      await this.runAction(rule, "trigger");
    }
  }

  /** Why this rule may not fire right now, or null if it may. */
  private suppressionFor(rule: Rule, now: number): string | null {
    const last = this.lastFiredAt.get(rule.id);
    if (last !== undefined && rule.cooldownSec > 0) {
      const remaining = Math.ceil((last + rule.cooldownSec * 1000 - now) / 1000);
      if (remaining > 0) return `cooldown (${remaining}s remaining)`;
    }
    if (rule.oncePerService) {
      const key = this.serviceKey();
      if (key && this.firedForService.get(rule.id) === key) {
        return "already fired this service";
      }
    }
    return null;
  }

  private async runAction(rule: Rule, why: string, caller?: string): Promise<{ ok: boolean; detail: string }> {
    const action = AUTOMATION_ACTIONS[rule.action.id];
    if (!action) {
      const detail = `unknown action "${rule.action.id}"`;
      this.log(rule, "failed", detail);
      return { ok: false, detail };
    }
    let result: { ok: boolean; detail: string };
    try {
      result = await action.run(rule.action.params, { simulate: this.settings.simulate });
    } catch (e) {
      // A provider is contractually not supposed to throw; if one does, it must not
      // stop the engine or the next rule.
      result = { ok: false, detail: errorMessage(e) };
    }
    const outcome = !result.ok ? "failed" : this.settings.simulate ? "simulated" : "fired";
    this.log(rule, outcome, `${result.detail} (${why})`, caller);
    return result;
  }

  private log(
    rule: Rule,
    outcome: Parameters<typeof automationLog.add>[0]["outcome"],
    detail: string,
    caller?: string,
  ): void {
    automationLog.add({
      at: new Date().toISOString(),
      ruleId: rule.id,
      ruleName: rule.name,
      triggerId: rule.trigger.id,
      actionId: rule.action.id,
      outcome,
      detail,
      ...(caller ? { caller } : {}),
    });
    // A rule that FAILED is the one automation outcome that belongs in the server
    // log as well. Everything the engine does is recorded — but only in its own
    // store, read only by /automation, so an action that errored was invisible
    // from /log, which is the page you are on when you are working out why the
    // building is not doing what it should. Fires, simulations and suppressions
    // stay out: in a normal service there are dozens of them and they would bury
    // the failure this line exists to surface.
    //
    // Both halves go through scrub(): the rule name is typed by the operator into
    // an HTTP body and the detail carries whatever a device or provider said back,
    // so a newline in either forges a log line on a LAN-visible page.
    if (outcome === "failed") {
      console.warn(`[automation] rule "${scrub(rule.name)}" failed: ${scrub(detail)}`);
    }
    // Mirror into the raw layer, but only while a service is being recorded — the
    // archive is per-service, and a rule firing on a Tuesday belongs to no service.
    // The open SPL record is the authority on which occurrence that is.
    const rec = splRecorder.getCurrent();
    if (rec && !rec.endedAt) {
      sampleArchive.recordEvent(
        { serviceKey: rec.serviceKey, serviceDate: rec.serviceDate },
        "automation",
        outcome,
        `${rule.name}: ${detail}`,
      );
    }
  }

  private conditionCtx(): ConditionCtx {
    const live = stageController.getLastLive();
    const state = stageController.getState();
    const integrations: Record<string, string> = {};
    let pcoConfigured = false;
    for (const s of integrationManager.getStates()) {
      integrations[s.id] = s.connection;
      if (s.id === "planning-center") pcoConfigured = s.configured === true;
    }
    // Read ONCE. Two getLatest() calls could straddle a poll and hand the
    // conditions a `connected` from one snapshot and layers from the next.
    const pvp = pvpService.getLatest();
    return {
      pcoLive: live
        ? {
            mode: live.mode,
            serviceTimeId: live.serviceTimeId ?? null,
            // The countdown target first: in "preservice" it is when things
            // actually begin, which is earlier than the service time by the
            // length of the pre-roll items above the SERVICE START header.
            startsAtMs: parseMs(live.targetAt ?? live.serviceTimeStartsAt),
          }
        : null,
      pcoConfigured,
      serviceTypeId: state.serviceTypeId ?? null,
      integrations,
      obsRecording: obsService.getLatest().recording === true,
      reaperRecording: reaperService.getLatest().recording === true,
      // null, not [], when PVP has never connected. An empty workspace and an
      // integration that is switched off look identical as a list, and "the
      // workspace has nothing on screen" must not hold for a machine we have
      // never spoken to.
      pvpLayers: pvp.connected ? pvp.layers : null,
      resiStreaming: resiService.getLatest().live === true,
      youtubeStreaming: youtubeService.getLatest().live === true,
      baptismPhase: baptismTimerService.getState()?.phase ?? null,
    };
  }

  /** Identifies one service occurrence, for oncePerService. Prefers what the bus
   *  just carried; falls back to the controller when no pco:live has flowed yet. */
  private serviceKey(): string | null {
    return this.serviceKeyFromBus ?? stageController.getLastLive()?.serviceTimeId ?? null;
  }

  /**
   * Does any armed, enabled rule read this channel?
   *
   * Answered for services that skip broadcasting when no browser is watching:
   * this engine listens in-process, so it is demand the SSE subscriber check
   * cannot see. Recomputed per call rather than cached — rules are edited at
   * runtime, and a cache would leave a newly-created rule dark until a restart.
   */
  wantsChannel(channel: string): boolean {
    if (this.settings.disarmed) return false;
    return this.rules.some(
      (rule) => rule.enabled && AUTOMATION_TRIGGERS[rule.trigger.id]?.channel === channel,
    );
  }

  /**
   * Does any armed, enabled rule carry this condition?
   *
   * Conditions never touch the bus — conditionCtx() PULLS each one from its
   * service's latest snapshot when a rule fires — so wantsChannel cannot see
   * them. A condition reading a throttled poll is demand on that poll all the
   * same: "REAPER is recording" qualifying a rule while REAPER polls at its idle
   * cadence answers from a snapshot seconds old.
   */
  wantsCondition(conditionId: string): boolean {
    if (this.settings.disarmed) return false;
    return this.rules.some(
      (rule) => rule.enabled && rule.conditions.some((c) => c.id === conditionId),
    );
  }
}

export const automationEngine = new AutomationEngine();

// Keep the channels this engine evaluates flowing even with no browser attached.
//
// Several producers skip work when nothing is watching — smaart-service dropped
// the push entirely, sensource and the streaming polls fell to their idle
// cadence, stage-controller skipped the whole device re-resolve — and all of them
// asked an SSE subscriber check, which cannot see this engine. The result was
// enabled rules that had simply never run, with no error anywhere.
//
// Derived from the trigger registry rather than written out per service, because
// the hand-written version covered four channels and missed slots:devices and
// prodcom:transcript. A new trigger on a new channel is now covered the moment it
// is registered; demand-gating.test.ts asserts that, exactly.
for (const channel of new Set(Object.values(AUTOMATION_TRIGGERS).map((t) => t.channel))) {
  // CALL_CHANNEL has no producer, by design — registering demand on it would
  // ask a service that does not exist to start working.
  if (channel === CALL_CHANNEL) continue;
  addChannelDemandSource(channel, () => automationEngine.wantsChannel(channel));
}

/**
 * Conditions, which arrive by pull rather than on the bus.
 *
 * conditionCtx() reads each one from its service's latest snapshot at the moment
 * a rule fires, so the trigger loop above cannot see the demand. A condition
 * needs its own registration even when its channel is ALSO a trigger channel:
 * the loop above covers the channels a rule TRIGGERS on, and a rule can
 * perfectly well trigger on PCO and merely ASK about a PVP layer. That rule
 * would read a snapshot at the idle cadence — which for PVP, whose whole point
 * is driving content from a rule on a booth appliance with no browser open, is
 * the case that matters most.
 *
 * Derived from the registry, exactly as the trigger loop is. This was a
 * hand-maintained table beside AUTOMATION_CONDITIONS, and deleting five of its
 * ten entries left the whole suite green — nothing anywhere tied a condition to
 * its channel. `ConditionDef.channel` is now required and nullable, so a new
 * condition cannot be written without answering the question.
 */
for (const [conditionId, def] of Object.entries(AUTOMATION_CONDITIONS)) {
  const { channel } = def;
  if (channel === null) continue;
  addChannelDemandSource(channel, () => automationEngine.wantsCondition(conditionId));
}
