// Shared contracts for the settings view and its section components.

import type { DragEndEvent } from "@dnd-kit/core";
import type { useSensors } from "@dnd-kit/core";
import type { DeviceChannel } from "@main/types/devices";

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
  }) => Promise<void>;
  // Slot editor (operates on the currently-selected View)
  updateSlot: (idx: number, updated: Slot) => void;
  addSlot: () => void;
  addSpacer: () => void;
  removeSlot: (idx: number) => void;
  saveSlots: () => Promise<void>;
  /** Drop unsaved slot edits and revert the editor + preview to saved state. */
  discardSlots: () => void;
  handleSetViewSlotsLayout: (id: string, slotsLayout: SlotsLayout | null) => Promise<void>;
  // Views (content)
  handleAddView: (name: string, kind: ViewKind, surface?: "display" | "console") => Promise<string | null>;
  handleRenameView: (id: string, name: string) => Promise<void>;
  handleDuplicateView: (id: string) => Promise<void>;
  handleRemoveView: (id: string) => Promise<void>;
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
  handleCopySlots: (targetViewId: string, fromViewId: string) => Promise<void>;
  // Presets (saved slot arrangements — global, recall into any view)
  handleSavePreset: (name: string) => Promise<void>;
  handleApplyPreset: (id: string) => Promise<void>;
  handleDeletePreset: (id: string) => Promise<void>;
  handleImportPreset: (name: string, slots: Slot[]) => Promise<void>;
  handleReorderPresets: (ids: string[]) => Promise<void>;
  handleRenamePreset: (id: string, name: string) => Promise<void>;
  handleOverwritePreset: (id: string) => Promise<void>;
  // Outputs (physical screens + routing)
  handleAddOutput: () => Promise<void>;
  handleRenameOutput: (id: string, name: string) => Promise<void>;
  handleSetOutputView: (id: string, viewId: string | null) => Promise<void>;
  handleSetOutputLocked: (id: string, locked: boolean) => Promise<void>;
  handleSetOutputHideTopBar: (id: string, hideTopBar: boolean) => Promise<void>;
  handleSetOutputMode: (id: string, mode: "display" | "panel") => Promise<void>;
  handleSetViewSurface: (id: string, surface: "display" | "console") => Promise<void>;
  handleRemoveOutput: (id: string) => Promise<void>;
  handleReorderOutputs: (ids: string[]) => Promise<void>;
  /** Remotely reload kiosk pages. Pass an output id, or null for all displays. */
  handleRefreshDisplay: (id: string | null) => Promise<void>;
  handleDragEnd: (event: DragEndEvent) => void;
  sensors: ReturnType<typeof useSensors>;
}

export interface SectionProps {
  stageState: StageState;
  serviceTypes: ServiceTypeDTO[];
  plans: PlanDTO[];
  wirelessChannels: WirelessChannel[];
  teamPositions: TeamPositionDTO[];
  layoutTemplates: LayoutTemplate[];
  localSlots: Slot[];
  slotsDirty: boolean;
  isSavingSlots: boolean;
  /** Draft slots resolved server-side (no save) for the live preview; null when clean. */
  resolvedDraftSlots: Slot[] | null;
  isRefreshing: boolean;
  slotPresets: SlotPreset[];
  updateStatus: UpdateStatus | null;
  handlers: SectionHandlers;
}
