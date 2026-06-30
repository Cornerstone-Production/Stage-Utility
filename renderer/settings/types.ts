// Shared contracts for the settings view and its section components.

import type { DragEndEvent } from "@dnd-kit/core";
import type { useSensors } from "@dnd-kit/core";

export type SectionId =
  | "plan"
  | "views"
  | "displays"
  | "integrations"
  | "connect"
  | "branding"
  | "spl-history"
  | "attendance"
  | "advanced";

export interface SectionItem {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
}

export interface WirelessChannel {
  id: string;
  label: string;
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
  handleApplyUpdate: () => Promise<void>;
  handleSetAutoUpdate: (partial: { enabled?: boolean; dayOfWeek?: number | null; hour?: number }) => Promise<void>;
  handleSetAllowedServiceTypes: (ids: string[]) => Promise<void>;
  handleSetBranding: (partial: {
    name?: string;
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
  handleSetViewSlotsLayout: (id: string, slotsLayout: SlotsLayout | null) => Promise<void>;
  // Views (content)
  handleAddView: (name: string, kind: ViewKind) => Promise<void>;
  handleRenameView: (id: string, name: string) => Promise<void>;
  handleDuplicateView: (id: string) => Promise<void>;
  handleRemoveView: (id: string) => Promise<void>;
  handleSetViewKind: (id: string, kind: ViewKind) => Promise<void>;
  handleSetViewLayout: (id: string, layout: LayoutDTO) => Promise<void>;
  handleSaveLayoutTemplate: (name: string, layout: LayoutDTO) => Promise<void>;
  handleUpdateLayoutTemplate: (id: string, patch: { name?: string; layout?: LayoutDTO }) => Promise<void>;
  handleDeleteLayoutTemplate: (id: string) => Promise<void>;
  handleCopySlots: (targetViewId: string, fromViewId: string) => Promise<void>;
  handleReorderViews: (ids: string[]) => Promise<void>;
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
  handleRemoveOutput: (id: string) => Promise<void>;
  handleReorderOutputs: (ids: string[]) => Promise<void>;
  handleOpenOutputWindow: (id: string) => Promise<void>;
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
  selectedViewId: string;
  setSelectedViewId: (id: string) => void;
  localSlots: Slot[];
  slotsDirty: boolean;
  isSavingSlots: boolean;
  isRefreshing: boolean;
  slotPresets: SlotPreset[];
  updateStatus: UpdateStatus | null;
  handlers: SectionHandlers;
}
