// Shared contracts for the settings view and its section components.

import type { DragEndEvent } from "@dnd-kit/core";
import type { useSensors } from "@dnd-kit/core";

export type SectionId =
  | "plan"
  | "service-types"
  | "displays"
  | "slots"
  | "integrations"
  | "connect"
  | "branding";

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
  }) => Promise<void>;
  updateSlot: (idx: number, updated: Slot) => void;
  addSlot: () => void;
  removeSlot: (idx: number) => void;
  saveSlots: () => Promise<void>;
  handleSavePreset: () => Promise<void>;
  handleApplyPreset: (id: string) => Promise<void>;
  handleDeletePreset: (id: string) => Promise<void>;
  handleAddDisplay: () => Promise<void>;
  handleRenameDisplay: (id: string, name: string) => Promise<void>;
  handleRemoveDisplay: (id: string) => Promise<void>;
  handleSetDisplayKind: (id: string, kind: DisplayKind) => Promise<void>;
  handleOpenDisplayWindow: (id: string) => Promise<void>;
  handleDragEnd: (event: DragEndEvent) => void;
  sensors: ReturnType<typeof useSensors>;
}

export interface SectionProps {
  stageState: StageState;
  serviceTypes: ServiceTypeDTO[];
  plans: PlanDTO[];
  wirelessChannels: WirelessChannel[];
  teamPositions: TeamPositionDTO[];
  presets: SlotPreset[];
  selectedDisplayId: string;
  setSelectedDisplayId: (id: string) => void;
  localSlots: Slot[];
  slotsDirty: boolean;
  isSavingSlots: boolean;
  isRefreshing: boolean;
  presetName: string;
  setPresetName: (name: string) => void;
  isSavingPreset: boolean;
  handlers: SectionHandlers;
}
