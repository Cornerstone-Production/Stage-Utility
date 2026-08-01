// Shared types — ALIASED from the backend contract so the two can't drift.
//
// The renderer has always referenced these unqualified (`StageState`, `Slot`, …),
// and still does: every name below is declared into the global scope. What changed
// is that each one is now an alias of the real type in main/types/ rather than a
// hand-maintained copy. A backend field the renderer hasn't caught up with is now
// a compile error instead of a runtime surprise on a kiosk.
//
// `import type` is fully erased, so nothing from main/ is bundled into the renderer.

import type * as Stage from "@main/types/stage";
import type * as Osc from "@main/types/osc";
import type * as RossTalk from "@main/types/rosstalk";
import type * as Integrations from "@main/types/integrations";
import type * as Devices from "@main/types/devices";

declare global {
  // ── Stage / views / layouts / patch (main/types/stage.ts) ──
  type AttendanceSample = Stage.AttendanceSample;
  type AutoUpdateSettings = Stage.AutoUpdateSettings;
  type BaptismMode = Stage.BaptismMode;
  type BaptismPerson = Stage.BaptismPerson;
  type BaptismPhase = Stage.BaptismPhase;
  type BaptismSession = Stage.BaptismSession;
  type BaptismState = Stage.BaptismState;
  type ChargerBayDTO = Stage.ChargerBayDTO;
  type DisplayInfo = Stage.DisplayInfo;
  type ViewKind = Stage.ViewKind;
  type LayoutCanvas = Stage.LayoutCanvas;
  type LayoutDTO = Stage.LayoutDTO;
  type LayoutGroup = Stage.LayoutGroup;
  type LayoutHAlign = Stage.LayoutHAlign;
  type LayoutObject = Stage.LayoutObject;
  type LayoutObjectConfig = Stage.LayoutObjectConfig;
  type LayoutObjectType = Stage.LayoutObjectType;
  type LayoutStyle = Stage.LayoutStyle;
  type LayoutTemplate = Stage.LayoutTemplate;
  type LayoutVAlign = Stage.LayoutVAlign;
  type ObsStatusDTO = Stage.ObsStatusDTO;
  type Output = Stage.Output;
  type PatchAssignments = Stage.PatchAssignments;
  type PatchDevice = Stage.PatchDevice;
  type PatchDeviceKind = Stage.PatchDeviceKind;
  type PatchEndpoint = Stage.PatchEndpoint;
  type PatchFile = Stage.PatchFile;
  type PatchHop = Stage.PatchHop;
  type PatchSheet = Stage.PatchSheet;
  type PatchSheetKind = Stage.PatchSheetKind;
  type PatchVariant = Stage.PatchVariant;
  type PcoAttachmentDTO = Stage.PcoAttachmentDTO;
  type PcoLiveDTO = Stage.PcoLiveDTO;
  type PeopleCountDTO = Stage.PeopleCountDTO;
  type PeopleHistoryPoint = Stage.PeopleHistoryPoint;
  type PeopleZoneCount = Stage.PeopleZoneCount;
  type PlanDTO = Stage.PlanDTO;
  type PlanItemDTO = Stage.PlanItemDTO;
  type PlanItemsDTO = Stage.PlanItemsDTO;
  type PropInstanceConn = Stage.PropInstanceConn;
  type PropInstanceMeta = Stage.PropInstanceMeta;
  type PropInstancesDTO = Stage.PropInstancesDTO;
  type ProPresenterStatusDTO = Stage.ProPresenterStatusDTO;
  type ProSection = Stage.ProSection;
  type ProTimer = Stage.ProTimer;
  type ReaperStatusDTO = Stage.ReaperStatusDTO;
  type ReconnectSchedule = Stage.ReconnectSchedule;
  type ResolvedOutput = Stage.ResolvedOutput;
  type ScriptViewConfig = Stage.ScriptViewConfig;
  type ScriptViewLayout = Stage.ScriptViewLayout;
  type ScriptViewRundownDTO = Stage.ScriptViewRundownDTO;
  type ServiceAttendance = Stage.ServiceAttendance;
  type ServiceSplHistory = Stage.ServiceSplHistory;
  type ServiceTimeline = Stage.ServiceTimeline;
  type ServiceTimelineItem = Stage.ServiceTimelineItem;
  type ServiceTypeDTO = Stage.ServiceTypeDTO;
  type Slot = Stage.Slot;
  type SlotDevice = Stage.SlotDevice;
  type SlotLink = Stage.SlotLink;
  type SlotPositionMatch = Stage.SlotPositionMatch;
  type SlotPreset = Stage.SlotPreset;
  type SlotsLayout = Stage.SlotsLayout;
  type SplItemHistory = Stage.SplItemHistory;
  type SplMeterDTO = Stage.SplMeterDTO;
  type SplMetricsDTO = Stage.SplMetricsDTO;
  type SplMetricStat = Stage.SplMetricStat;
  type StageState = Stage.StageState;
  type TaperWindow = Stage.TaperWindow;
  type TeamMemberDTO = Stage.TeamMemberDTO;
  type TeamPositionDTO = Stage.TeamPositionDTO;
  type TranscriptLineDTO = Stage.TranscriptLineDTO;
  type UpdateStatus = Stage.UpdateStatus;
  type View = Stage.View;
  type ViewKind = Stage.ViewKind;

  // ── RossTalk (main/types/rosstalk.ts) ──
  type RossTalkFamily = RossTalk.RossTalkFamily;
  type RossTalkParam = RossTalk.RossTalkParam;
  type RossTalkCommand = RossTalk.RossTalkCommand;
  type RossTalkTargetConfig = RossTalk.RossTalkTargetConfig;
  type RossTalkTarget = RossTalk.RossTalkTarget;

  // ── OSC (main/types/osc.ts) ──
  type OscArg = Osc.OscArg;
  type OscFeedbackBind = Osc.OscFeedbackBind;
  type OscFeedbackDTO = Osc.OscFeedbackDTO;
  type OscTarget = Osc.OscTarget;

  // ── Integrations (main/types/integrations.ts) ──
  type ConfigField = Integrations.ConfigField;
  type ConnectionState = Integrations.ConnectionState;
  type IntegrationDescriptor = Integrations.IntegrationDescriptor;
  type IntegrationState = Integrations.IntegrationState;

  // ── Wireless devices (main/types/devices.ts) ──
  type DeviceStatus = Devices.DeviceStatus;
  type WirelessConnection = Devices.WirelessConnection;

  // ── Renderer-local ──
  // The backend returns this shape inline from stageController.getBrandingSource()
  // rather than as a named export, so there is nothing to alias to.
  /** Editor source for a brand image (original upload + saved crop transform). */
  interface BrandingSource {
    original: string | null;
    crop: { scale: number; x: number; y: number } | null;
  }
}
