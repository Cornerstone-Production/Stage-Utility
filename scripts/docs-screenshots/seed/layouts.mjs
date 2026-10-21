// seed/layouts.mjs — views, their layouts and slot boards, and the screens that
// show them.

import { SERVICE_TYPES } from "../world.mjs";
import { CARD, layout, obj } from "./layout-kit.mjs";

const NO_DEVICE = { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null };

/** A mic-board slot filled by a Planning Center position, optionally on a mic. */
function slot(n, channel, positions, binding, extra = {}) {
  return {
    id: `slot-${n}`,
    channel,
    order: n,
    link: positions
      ? { kind: "pco", matchBy: "position", positions }
      : { kind: "static", label: extra.label ?? "", color: "#3b82f6" },
    deviceBinding: binding ? { providerId: "shure-ulxd", channelId: binding } : null,
    chargeSource: binding ? "mic" : "off",
    device: NO_DEVICE,
  };
}

function micBoard(wirelessIds) {
  const [rackA, rackB] = wirelessIds;
  return [
    slot(1, "1", [{ name: "Worship Leader" }], `${rackA}::1`),
    slot(2, "2", [{ name: "Vocals", notesStartsWith: "2" }], `${rackA}::2`),
    slot(3, "3", [{ name: "Vocals (BGVs)" }], `${rackA}::3`),
    slot(4, "4", [{ name: "Host" }], `${rackA}::4`),
    slot(5, "5", [{ name: "Electric Guitar" }], null),
    slot(6, "6", [{ name: "Acoustic Guitar" }], `${rackB}::2`),
    slot(7, "7", [{ name: "Keys" }], null),
    slot(8, "8", [{ name: "Drums" }], `${rackB}::3`),
  ];
}

async function createView(api, body) {
  const state = await api.post("/api/views", body);
  const view = [...state.views].reverse().find((v) => v.name === body.name);
  return view.id;
}

function stageWall(micBoardViewId, rundownViewId) {
  const title = { fontSize: 0.034, fontWeight: 700, color: "#9aa0a6", uppercase: true, letterSpacing: 0.12, vAlign: "middle" };
  const big = { fontSize: 0.075, fontWeight: 600, color: "#f1f3f4", vAlign: "middle" };
  return layout([
    obj({ type: "text", text: "Main Room · Stage" }, [0.02, 0.03, 0.3, 0.08], { style: title }),
    obj({ type: "timer", source: "service", hideWhenIdle: false, caption: "Time left" }, [0.34, 0.015, 0.3, 0.115], { style: { ...CARD, ...big, textAlign: "center", fontSize: 0.07 } }),
    obj({ type: "clock", showSeconds: false, format: "12h", showMeridiem: true }, [0.78, 0.015, 0.2, 0.115], { style: { ...CARD, ...big, textAlign: "center" } }),
    obj({ type: "slots-grid", source: "view", sourceViewId: micBoardViewId }, [0.02, 0.15, 0.62, 0.62], {}),
    obj({ type: "messages" }, [0.66, 0.15, 0.32, 0.3], { id: "wall-messages", style: { ...CARD, fontSize: 0.026 } }),
    obj(
      { type: "view-embed", viewId: rundownViewId, showHeader: false, autoScroll: true },
      [0.66, 0.47, 0.32, 0.5],
      { style: { ...CARD, fontSize: 0.022 } },
    ),
    obj({ type: "wireless-summary", showOnline: true, showBattery: true, showRuntime: false, showLabel: true, label: "Wireless" }, [0.02, 0.8, 0.2, 0.17], { style: { ...CARD, ...big, fontSize: 0.05, textAlign: "center" } }),
    obj({ type: "integration-status", integrationId: "planning-center", showLabel: true, label: "Planning Center" }, [0.24, 0.8, 0.18, 0.17], { style: { ...CARD, fontSize: 0.03, textAlign: "center" } }),
    obj({ type: "integration-status", integrationId: "wireless", showLabel: true, label: "Wireless gear" }, [0.44, 0.8, 0.2, 0.17], { style: { ...CARD, fontSize: 0.03, textAlign: "center" } }),
  ]);
}

function producerConsole(wallOutputId) {
  const button = { ...CARD, fontSize: 0.03, fontWeight: 600, textAlign: "center", vAlign: "middle" };
  return layout(
    [
      obj({ type: "message-composer" }, [0.02, 0.03, 0.6, 0.94], { id: "console-composer", style: { ...CARD, fontSize: 0.022 } }),
      obj({ type: "action-button", actionId: "pco.live.advance", label: "Next item" }, [0.64, 0.03, 0.17, 0.13], { style: { ...button, background: "#1d4ed8", color: "#ffffff" } }),
      obj({ type: "action-button", actionId: "display.refresh", label: "Refresh screens" }, [0.83, 0.03, 0.15, 0.13], { style: button }),
      obj({ type: "screen-embed", outputId: wallOutputId, showLabel: true, showStatus: true }, [0.64, 0.19, 0.34, 0.78], { style: { ...CARD, fontSize: 0.02 } }),
    ],
    { background: "#101114", fit: "fill" },
  );
}

/** The lobby screen: what time it is, how long until the doors close, what is on. */
function lobbyWelcome() {
  const title = { fontSize: 0.04, fontWeight: 700, color: "#9aa0a6", uppercase: true, letterSpacing: 0.12, vAlign: "middle" };
  const big = { fontSize: 0.14, fontWeight: 600, color: "#f1f3f4", vAlign: "middle", textAlign: "center" };
  return layout([
    obj({ type: "text", text: "Welcome" }, [0.05, 0.05, 0.4, 0.1], { style: title }),
    obj({ type: "clock", showSeconds: false, format: "12h", showMeridiem: true }, [0.05, 0.18, 0.42, 0.34], { style: { ...CARD, ...big } }),
    obj({ type: "timer", source: "service", hideWhenIdle: false, caption: "Time left" }, [0.53, 0.18, 0.42, 0.34], { style: { ...CARD, ...big, fontSize: 0.12 } }),
    obj({ type: "text", text: "Coffee is in the lobby. Kids check-in is down the hall." }, [0.05, 0.6, 0.9, 0.2], { style: { fontSize: 0.05, fontWeight: 500, color: "#e8eaed", textAlign: "center", vAlign: "middle" } }),
  ]);
}

/** What a stage-side panel shows: the thread with quick-reply buttons, over the time. */
function stageConsole() {
  const big = { fontSize: 0.07, fontWeight: 600, color: "#f1f3f4", vAlign: "middle", textAlign: "center" };
  return layout(
    [
      obj({ type: "clock", showSeconds: false, format: "12h", showMeridiem: true }, [0.04, 0.04, 0.44, 0.16], { style: { ...CARD, ...big } }),
      obj({ type: "timer", source: "service", hideWhenIdle: false, caption: "Time left" }, [0.52, 0.04, 0.44, 0.16], { style: { ...CARD, ...big } }),
      obj({ type: "messages" }, [0.04, 0.24, 0.92, 0.72], { id: "panel-messages", style: { ...CARD, fontSize: 0.03 } }),
    ],
    { background: "#101114", fit: "fill" },
  );
}

/** ServiceCue: the service types on its landing page, the roles its columns use,
 *  and three column presets, one per department. */
async function seedServiceCue(api) {
  await api.post("/api/servicecue/config", { serviceTypeIds: SERVICE_TYPES.map((t) => t.id) });
  await api.post("/api/servicecue/roles/seed", { serviceTypeId: SERVICE_TYPES[0].id });
  const shared = { showClock: true, showLength: true, showKey: true, showBpm: true, showMeter: true, showArrangement: true, showItemNotes: true, showTotalTime: true, rowColor: "none" };
  const saved = await api.post("/api/servicecue/layouts", {
    layouts: [
      { id: "layout-audio", name: "Audio", order: 0, columnRoles: ["role-audio", "role-band"], ...shared },
      { id: "layout-band", name: "Band", order: 1, columnRoles: ["role-band"], ...shared },
      { id: "layout-video", name: "Video and Lights", order: 2, columnRoles: ["role-video", "role-lights"], ...shared, showKey: false, showBpm: false, showMeter: false },
    ],
  });
  const layouts = Array.isArray(saved) ? saved : saved.layouts;
  return { audioLayoutId: layouts.find((l) => l.name === "Audio").id, layouts };
}

export async function seedLayouts(api, { wirelessIds }) {
  // The first display ships with the app: make it the mic board.
  const { views, outputs } = await api.get("/api/state");
  const micBoardId = views.find((v) => v.kind === "slots").id;
  const firstOutputId = outputs[0].id;
  await api.patch(`/api/views/${micBoardId}`, { name: "Mic Board" });
  await api.patch(`/api/outputs/${firstOutputId}`, { name: "Stage Monitors" });
  await api.post(`/api/views/${micBoardId}/slots`, {
    slots: micBoard(wirelessIds),
    target: { kind: "default", serviceTypeId: SERVICE_TYPES[0].id },
  });

  const rundownId = await createView(api, { name: "Audio Rundown", kind: "script" });
  const serviceCue = await seedServiceCue(api);
  await api.patch(`/api/views/${rundownId}`, { serviceCueLayoutId: serviceCue.audioLayoutId });

  const wallId = await createView(api, { name: "Stage Wall", kind: "custom" });
  await api.patch(`/api/views/${wallId}`, { layout: stageWall(micBoardId, rundownId) });

  const consoleId = await createView(api, { name: "Producer Console", kind: "custom", surface: "console" });

  const panelId = await createView(api, { name: "Stage Panel", kind: "custom", surface: "console" });
  await api.patch(`/api/views/${panelId}`, { layout: stageConsole() });

  const lobbyViewId = await createView(api, { name: "Lobby Welcome", kind: "custom" });
  await api.patch(`/api/views/${lobbyViewId}`, { layout: lobbyWelcome() });

  const wall = await api.post("/api/outputs", { name: "Main Room Wall", viewId: wallId });
  const lobby = await api.post("/api/outputs", { name: "Lobby Display", viewId: lobbyViewId });
  const greenRoom = await api.post("/api/outputs", { name: "Green Room", viewId: rundownId });
  const stageLeft = await api.post("/api/outputs", { name: "Stage Left Panel", viewId: panelId });
  const greenPanel = await api.post("/api/outputs", { name: "Green Room Panel", viewId: panelId });
  // The producer console shows the wall as it is, which needs the screen to exist.
  await api.patch(`/api/views/${consoleId}`, { layout: producerConsole(wall.outputId) });

  return {
    micBoardId,
    wallId,
    consoleId,
    panelId,
    lobbyViewId,
    rundownId,
    outputs: {
      stageMonitors: firstOutputId,
      wall: wall.outputId,
      lobby: lobby.outputId,
      greenRoom: greenRoom.outputId,
      stageLeft: stageLeft.outputId,
      greenPanel: greenPanel.outputId,
    },
    widgets: { wallMessages: "wall-messages", panelMessages: "panel-messages", consoleComposer: "console-composer" },
  };
}
