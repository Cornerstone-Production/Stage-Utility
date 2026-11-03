// Shared contracts for the settings view and its section components.

import type { useSensors } from "@dnd-kit/core";
import type { DeviceChannel } from "@main/types/devices";
import type { CreateScreenInput, ViewSurface } from "@main/types/views";
import type { Rotation } from "@main/types/output-format";
import type { AppIconInput } from "@main/services/app-icon";

/**
 * One bindable wireless channel, as `/api/integrations/wireless/channels`
 * returns it.
 *
 * An ALIAS, not a second declaration. This was a hand-copy of `DeviceChannel`
 * that happened to match, so adding `deviceType` on the server left the client
 * unable to see it — and a client type that silently lags the wire is what let
 * the wireless widgets read fields the endpoint had never sent.
 */
export type WirelessChannel = DeviceChannel;

/** How deleting a view went. `ifUnshown` asked the server to refuse a view a screen
 *  shows; `shownOn` then names those screens, and no failure was toasted. */
export type RemoveViewOutcome = { removed: true } | { removed: false; shownOn?: string[] };

/** How making a screen went: why it was refused, or null, and the id of the
 *  screen that now exists (null when it was refused). */
export interface CreateScreenOutcome {
  refused: string | null;
  outputId: string | null;
  /** Refused because the view chose changed kind while the operator was deciding:
   *  nothing was made, and the page's copy of the view has been reloaded. */
  viewChanged?: boolean;
}

// Action callbacks owned by SettingsView and threaded into each section.
export interface SectionHandlers {
  handleServiceTypeChange: (id: string) => Promise<void>;
  handlePlanModeChange: (mode: "auto" | "manual") => Promise<void>;
  handlePlanChange: (id: string) => Promise<void>;
  handleNextPlan: () => Promise<void>;
  handleRefresh: () => Promise<void>;
  handleShowQrChange: (show: boolean) => Promise<void>;
  handleSetPublicUrl: (url: string | null) => Promise<void>;
  // In-app self-update
  handleCheckUpdates: () => Promise<void>;
  handleApplyUpdate: (override?: boolean) => Promise<void>;
  handleSetAutoUpdate: (partial: { mode?: "manual" | "auto-install" | "auto-full"; enabled?: boolean; dayOfWeek?: number | null; hour?: number }) => Promise<void>;
  handleSetReconnectSchedule: (partial: { enabled?: boolean; leadMin?: number; tailMin?: number; dormantMin?: number }) => Promise<void>;
  handleSetTaperWindow: (partial: { preMin?: number; postMin?: number }) => Promise<void>;
  handleSetChecklistSources: (categories: string[], teams: string[]) => Promise<void>;
  handleSetTimezone: (tz: string | null) => Promise<void>;
  handleSetHourCycle: (cycle: "12h" | "24h") => Promise<void>;
  handleSetAllowedServiceTypes: (ids: string[]) => Promise<void>;
  handleSetPlanSwitcherMode: (mode: PlanSwitcherMode) => Promise<void>;
  handleSetBranding: (partial: {
    name?: string;
    accentColor?: string | null;
    logo?: string | null;
    monochrome?: boolean;
    logoOriginal?: string | null;
    logoCrop?: { scale: number; x: number; y: number } | null;
    emptyLogo?: string | null;
    emptyLogoOriginal?: string | null;
    emptyLogoCrop?: { scale: number; x: number; y: number } | null;
    avatar?: string | null;
    avatarOriginal?: string | null;
    avatarCrop?: { scale: number; x: number; y: number } | null;
    /** The tab and home-screen icon, set as a whole; `null` removes it. */
    icon?: AppIconInput | null;
  }) => Promise<boolean>;
  // Views (content)
  handleAddView: (name: string, kind: ViewKind, surface?: "display" | "console") => Promise<string | null>;
  handleRenameView: (id: string, name: string) => Promise<void>;
  /** Resolves the copy's id, or null when it could not be made. */
  handleDuplicateView: (id: string) => Promise<string | null>;
  /** Resolves whether it is gone; the failure is already toasted. */
  handleRemoveView: (id: string, opts?: { ifUnshown?: boolean }) => Promise<RemoveViewOutcome>;
  handleSetViewKind: (id: string, kind: ViewKind) => Promise<void>;
  /**
   * `layoutRev` is the revision the editor opened; omit to overwrite regardless.
   * Resolves with the view's authoritative revision afterwards, and `discarded`
   * when a conflict was resolved by keeping the other version — the editor must
   * then restart on the layout that was just pulled.
   */
  handleSetViewLayout: (
    id: string,
    layout: LayoutDTO,
    layoutRev?: number,
  ) => Promise<{ rev: number; discarded: boolean }>;
  handleSaveLayoutTemplate: (name: string, layout: LayoutDTO) => Promise<void>;
  handleUpdateLayoutTemplate: (id: string, patch: { name?: string; layout?: LayoutDTO }) => Promise<void>;
  handleDeleteLayoutTemplate: (id: string) => Promise<void>;
  // Outputs (physical screens + routing)
  /** Make a screen from the Screen settings panel's answers. */
  handleCreateScreen: (input: CreateScreenInput) => Promise<CreateScreenOutcome>;
  /** Make a screen for a waiting device and bind the device to it. */
  handleClaimDevice: (deviceId: string, input: CreateScreenInput) => Promise<CreateScreenOutcome>;
  handleRenameOutput: (id: string, name: string) => Promise<void>;
  /** `expectSurface` is the kind of view the operator confirmed going live on; the
   *  server refuses (409) when the view is the other kind by the time it writes. */
  handleSetOutputView: (id: string, viewId: string | null, expectSurface?: ViewSurface) => Promise<void>;
  handleSetOutputLocked: (id: string, locked: boolean) => Promise<void>;
  handleSetOutputHideTopBar: (id: string, hideTopBar: boolean) => Promise<void>;
  handleSetOutputAllowHls: (id: string, allowHls: boolean) => Promise<void>;
  handleSetOutputGroups: (id: string, groups: string[]) => Promise<void>;
  handleSetOutputTextSize: (id: string, textSize: number) => Promise<void>;
  /** Turn a Mac output helper screen's picture by quarter turns. */
  handleSetOutputRotation: (id: string, rotation: Rotation) => Promise<void>;
  /** Choose the video mode a DeckLink port sends this screen in. */
  handleSetOutputVideoMode: (id: string, videoMode: string) => Promise<void>;
  handleSetViewShowInSidebar: (id: string, showInSidebar: boolean) => Promise<void>;
  handleSetViewSurface: (id: string, surface: "display" | "console") => Promise<void>;
  /** Resolves whether it is gone; the failure is already toasted. */
  handleRemoveOutput: (id: string) => Promise<boolean>;
  handleReorderOutputs: (ids: string[]) => Promise<void>;
  /** Remotely reload kiosk pages. Pass an output id, or null for all displays. */
  handleRefreshDisplay: (id: string | null) => Promise<void>;
  /** Mouse and touch drag sensors for a reorderable list. */
  sensors: ReturnType<typeof useSensors>;
}

export interface SectionProps {
  stageState: StageState;
  serviceTypes: ServiceTypeDTO[];
  plans: PlanDTO[];
  wirelessChannels: WirelessChannel[];
  layoutTemplates: LayoutTemplate[];
  isRefreshing: boolean;
  updateStatus: UpdateStatus | null;
  handlers: SectionHandlers;
}
