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

import type { AutomationSettings, ConditionCtx, Rule } from "../types/automation.js";
import { addBroadcastListener, broadcast } from "./broadcaster.js";
import { AUTOMATION_ACTIONS } from "./automation-actions.js";
import { allConditionsHold } from "./automation-conditions.js";
import { sampleArchive } from "./archive/sample-archive.js";
import { automationLog } from "./automation-log.js";
import { automationStore } from "./automation-store.js";
import { integrationManager } from "./integration-manager.js";
import { signalStore } from "./signal-store.js";
import { smaartService } from "./smaart-service.js";
import { sensourceService } from "./sensource-service.js";
import { obsService } from "./obs-service.js";
import { resiService } from "./resi-service.js";
import { youtubeService } from "./youtube-service.js";
import { reaperService } from "./reaper-service.js";
import { baptismTimerService } from "./baptism-timer-service.js";
import { AUTOMATION_TRIGGERS, triggersForChannel } from "./automation-triggers.js";
import { splRecorder } from "./spl-recorder.js";
import { stageController } from "./stage-controller.js";

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

  async addRule(rule: Omit<Rule, "id">): Promise<Rule> {
    const next: Rule = { ...rule, id: randomUUID() };
    this.rules.push(next);
    await automationStore.saveRules(this.rules);
    broadcast("automation:rules", { rules: this.listRules() });
    return next;
  }

  async updateRule(id: string, patch: Partial<Omit<Rule, "id">>): Promise<Rule[]> {
    const r = this.rules.find((x) => x.id === id);
    if (!r) throw new Error(`Automation: unknown rule ${id}`);
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

  private async runAction(rule: Rule, why: string): Promise<{ ok: boolean; detail: string }> {
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
    this.log(rule, outcome, `${result.detail} (${why})`);
    return result;
  }

  private log(rule: Rule, outcome: Parameters<typeof automationLog.add>[0]["outcome"], detail: string): void {
    automationLog.add({
      at: new Date().toISOString(),
      ruleId: rule.id,
      ruleName: rule.name,
      triggerId: rule.trigger.id,
      actionId: rule.action.id,
      outcome,
      detail,
    });
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
    for (const s of integrationManager.getStates()) integrations[s.id] = s.connection;
    return {
      pcoLive: live ? { mode: live.mode, serviceTimeId: live.serviceTimeId ?? null } : null,
      serviceTypeId: state.serviceTypeId ?? null,
      integrations,
      obsRecording: obsService.getLatest().recording === true,
      reaperRecording: reaperService.getLatest().recording === true,
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
}

export const automationEngine = new AutomationEngine();

// Keep the channels this engine evaluates flowing even with no browser attached.
//
// smaart-service skipped the broadcast entirely without SSE subscribers, so
// spl.crossed-above / crossed-below never fired on an unattended box — the normal
// state for an appliance. sensource's gate throttles polling rather than
// broadcasting, so people.count triggers were evaluating counts up to a minute
// stale. Registered here, at the consumer, matching how attendance-recorder and
// tsl-service declare their own demand.
smaartService.addDemandSource(() => automationEngine.wantsChannel("spl:metrics"));
sensourceService.addDemandSource(() => automationEngine.wantsChannel("people:count"));
// Same reasoning for the streaming polls: idle, Resi drops to two minutes and
// YouTube to five, so "Resi goes live" on an unattended box would fire minutes
// after the stream started. A rule reading the channel is a watcher.
resiService.addDemandSource(() => automationEngine.wantsChannel("resi:status"));
youtubeService.addDemandSource(() => automationEngine.wantsChannel("youtube:status"));
