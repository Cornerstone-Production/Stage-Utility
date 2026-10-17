// capture/shots.mjs — every image, what it shows, and how it is taken.
//
// Each entry names its file (`docs/images/<name>.png`), the phase it needs, and a
// `run` that drives a real Chrome against the seeded server. `phase` is "week"
// (nothing live: the plan is days away) or "live" (the plan's first service is under
// way, with "Hold Fast" on air). Week shots are taken first because going live makes
// the app's own recorders start a record for today, which belongs in no screenshot
// of History.
//
// `shows` is what docs/images/README.md prints beside the file.

import { announceDevices } from "../lib/probe.mjs";
import { DISCOVERY_PORT } from "../lib/server.mjs";
import { SERVICE_TYPES } from "../world.mjs";

const SCREEN_NAMES = (world) => Object.values(world.outputs);

export const SHOTS = [
  // ── week ────────────────────────────────────────────────────────────────────
  {
    name: "history-overview",
    phase: "week",
    shows: "History: Trends chart across three service types, the month calendar and the recorded services list.",
    async run({ session, page }) {
      await session.goto(page, "/history");
      await session.shoot(page, "history-overview");
    },
  },
  {
    name: "history-trends",
    phase: "week",
    shows: "History Trends card on its own: attendance per service type over 16 weeks with milestones.",
    async run({ session, page }) {
      await session.goto(page, "/history");
      const card = page.locator("section, div").filter({ hasText: /^Trends/ }).first();
      const box = await card.boundingBox();
      await session.shoot(page, "history-trends", { clip: box ? { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 440) } : undefined });
    },
  },
  {
    name: "history-service",
    phase: "week",
    shows: "A recorded service: its attendance curve, item timing against the plan and sound levels per item.",
    async run({ session, page }) {
      await session.goto(page, "/history");
      await page.locator("button").filter({ hasText: /Weekend/ }).filter({ hasText: /PEAK IN ROOM/i }).first().click();
      await page.waitForTimeout(3000);
      await session.shoot(page, "history-service");
    },
  },
  {
    name: "automation-rules",
    phase: "week",
    shows: "Automation: the rules list with simulate mode, the Home Assistant group and everything else.",
    async run({ session, page }) {
      await session.goto(page, "/automation");
      await session.shoot(page, "automation-rules");
    },
  },
  {
    name: "integrations-overview",
    phase: "week",
    shows: "Settings → Integrations: connected integrations above, the ones not set up below.",
    async run({ session, page }) {
      await session.goto(page, "/settings/integrations");
      await session.shoot(page, "integrations-overview");
    },
  },
  {
    name: "integrations-wireless",
    phase: "week",
    shows: "The Wireless Gear dialog: two receivers, each connected.",
    async run({ session, page }) {
      await session.goto(page, "/settings/integrations?integration=wireless");
      await session.shoot(page, "integrations-wireless", { clip: { x: 320, y: 250, width: 800, height: 400 } });
    },
  },
  {
    name: "messages-settings",
    phase: "week",
    shows: "Settings → Messages: groups with their screen counts, quick messages and quick replies.",
    async run({ session, page }) {
      await session.goto(page, "/settings/messages");
      await session.shoot(page, "messages-settings");
    },
  },
  {
    name: "plan-selection",
    phase: "week",
    shows: "The Plan page: manual plan selection, active service types and the plan switcher mode.",
    async run({ session, page }) {
      await session.goto(page, "/plan");
      await session.shoot(page, "plan-selection");
    },
  },
  {
    name: "patch-sheet",
    phase: "week",
    shows: "The volunteer patch sheet at /patch: this week and what changed in a column beside a table per rack, each input with its signal path.",
    async run({ session, page }) {
      await session.goto(page, "/patch");
      await session.shoot(page, "patch-sheet");
    },
  },
  {
    name: "video-feeds",
    phase: "week",
    shows: "Video feeds: pulled cameras and pushed encoders, with the editor for one feed.",
    async run({ session, page }) {
      await session.goto(page, "/video-feeds");
      await session.shoot(page, "video-feeds");
    },
  },
  {
    name: "servicecue-picker",
    phase: "week",
    shows: "ServiceCue landing page: a service type and a column preset to open its rundown.",
    async run({ session, page }) {
      await session.goto(page, "/servicecue");
      await session.shoot(page, "servicecue-picker", { clip: { x: 400, y: 340, width: 640, height: 280 } });
    },
  },
  {
    name: "layout-editor",
    phase: "week",
    shows: "The layout editor on a wall layout: canvas, layers, and the inspector for the selected text object.",
    async run({ session, page, world }) {
      await session.goto(page, `/screens/${world.wallId}/edit`);
      await session.shoot(page, "layout-editor");
    },
  },
  {
    name: "slots-editor",
    phase: "week",
    shows: "The mic board editor: slots linked to Planning Center positions and bound to wireless channels.",
    async run({ session, page, world }) {
      await session.goto(page, `/screens/${world.micBoardId}/edit`);
      await session.shoot(page, "slots-editor");
    },
  },
  {
    name: "baptisms-sessions",
    phase: "week",
    shows: "Baptisms: the saved sessions from past services.",
    async run({ session, page }) {
      await session.goto(page, "/baptism");
      await page.locator('a[href="#s-past"]').click();
      await page.waitForTimeout(1500);
      // Past sessions and the trends under it, below the half-scrolled card above.
      await session.shoot(page, "baptisms-sessions", { clip: { x: 224, y: 296, width: 1216, height: 604 } });
    },
  },

  // ── live ────────────────────────────────────────────────────────────────────
  {
    name: "home-dashboard",
    phase: "live",
    shows: "Home during a service: the live item, screens online, readiness and recent services.",
    async run({ session, page }) {
      await session.goto(page, "/", { settle: 3500 });
      await session.shoot(page, "home-dashboard");
    },
  },
  {
    name: "screens-overview",
    phase: "live",
    shows: "Screens: a card per screen with a live preview and its message groups, the found-devices banner and the sidebar's count of screens not set up.",
    async run({ session, page }) {
      await announceDevices(DISCOVERY_PORT);
      await session.goto(page, "/screens", { settle: 4000 });
      await session.shoot(page, "screens-overview");
    },
  },
  {
    name: "wall-stage-wall",
    phase: "live",
    shows: "A wall display as it renders at 1920x1080: mic slots with wireless telemetry, clock, countdown, messages with replies, the service order and integration status.",
    async run({ session, world }) {
      const screen = session.screens.find((s) => s.id === world.outputs.wall);
      await session.shoot(screen.page, "wall-stage-wall");
    },
  },
  {
    name: "wall-servicecue",
    phase: "live",
    shows: "A ServiceCue rundown on a screen, with the live item highlighted and the Audio and Band note columns.",
    async run({ session, world }) {
      const screen = session.screens.find((s) => s.id === world.outputs.greenRoom);
      await session.shoot(screen.page, "wall-servicecue");
    },
  },
  {
    name: "wall-lobby",
    phase: "live",
    shows: "A lobby screen built in the layout editor: clock and countdown.",
    async run({ session, world }) {
      const screen = session.screens.find((s) => s.id === world.outputs.lobby);
      await session.shoot(screen.page, "wall-lobby");
    },
  },
  {
    name: "messages-composer",
    phase: "live",
    shows: "The Producer Console: the message composer with groups, quick messages and the day's thread with replies.",
    async run({ session, page, world }) {
      await session.goto(page, `/consoles/${world.consoleId}`, { settle: 3500 });
      await session.shoot(page, "messages-composer");
    },
  },
  {
    name: "messages-panel",
    phase: "live",
    shows: "A stage-side panel showing the thread with each reply under its message and quick-reply buttons.",
    async run({ session, world }) {
      const screen = session.screens.find((s) => s.id === world.outputs.stageLeft);
      await session.shoot(screen.page, "messages-panel");
    },
  },
  {
    name: "messages-alert",
    phase: "live",
    shows: "A stage message sent as an alert, drawn over a wall display as a red banner.",
    async run({ session, api, world }) {
      const messaging = await api.get("/api/messaging");
      const stage = messaging.groups.find((g) => g.name === "Stage");
      await api.post("/api/messages", { to: [stage.id], text: "Wrap it up, we are running long", alert: true, from: "Jamie Park" });
      const screen = session.screens.find((s) => s.id === world.outputs.wall);
      await screen.page.waitForTimeout(2500);
      await session.shoot(screen.page, "messages-alert");
    },
  },
  {
    name: "servicecue-rundown",
    phase: "live",
    shows: "The ServiceCue page in the app for the Weekend plan with the Audio preset, the live item highlighted.",
    async run({ session, page }) {
      await session.goto(page, `/servicecue/${SERVICE_TYPES[0].id}/layout-audio`, { settle: 3500 });
      await session.shoot(page, "servicecue-rundown");
    },
  },
];

export { SCREEN_NAMES };
