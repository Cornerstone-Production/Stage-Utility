// Every settings.json key a restore can carry, and what its check does with a
// value the key's setter would not save.
//
// The table below is keyed by every key the check covers, sorted, one per line:
// a settings key added without a rule fails to compile (the check's table is
// typed against SettingsData), and one added with a rule but no case here fails
// the first test. Each case is either a value the setter refuses, with a word
// the refusal must carry, or a value the setter normalises, with what it saves.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-settings-restore-check-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { CHECKED_SETTINGS_KEYS, settingsRestoreCheck } = await import("./settings-restore-check.js");

type Case = { bad: unknown; says: string } | { in: unknown; out: unknown };

const SCREEN = { id: "1", name: "Main", viewId: null };

const CASES: Record<string, Case> = {
  accentColor: { bad: "red", says: "#rrggbb" },
  allowedServiceTypeIds: { bad: [123], says: "list of text" },
  appIcon: { bad: "javascript:alert(1)", says: "image" },
  appIcon192: { bad: "https://example.org/x.png", says: "image" },
  appIcon512: { bad: 5, says: "image" },
  appIconApple: { bad: "data:text/html,x", says: "image" },
  appIconBackground: { bad: "black", says: "#rrggbb" },
  appIconCrop: { in: { scale: "big", x: 0, y: 0 }, out: null },
  appIconMaskable: { bad: {}, says: "image" },
  appIconOriginal: { bad: "/etc/passwd", says: "image" },
  appLogo: { bad: "javascript:alert(1)", says: "image" },
  appLogoCrop: { in: { scale: 1, x: 2, y: 3, extra: true }, out: { scale: 1, x: 2, y: 3 } },
  appLogoMonochrome: { bad: "yes", says: "true or false" },
  appLogoOriginal: { bad: "data:image/png;base64," + "A".repeat(2_000_001), says: "too large" },
  appName: { in: "   ", out: "Stage Utility" },
  autoUpdate: { bad: { mode: "whenever", hour: 3, dayOfWeek: null }, says: "update mode" },
  autoUpdateMachines: { bad: 1, says: "true or false" },
  backupSchedule: { in: { enabled: true, intervalDays: 0.4, keep: 500, destination: " /mnt/x " }, out: { enabled: true, intervalDays: 1, keep: 100, destination: "/mnt/x" } },
  baptismAutoStart: { in: { enabled: true, testimonyKeyword: "x".repeat(90) }, out: { enabled: true, testimonyKeyword: "x".repeat(80) } },
  baptismDefaultMode: { bad: "solo", says: "one of" },
  captionChannelColors: { bad: { Pastor: "red" }, says: "hex colour" },
  cardHairlineRaised: { bad: "yes", says: "true or false" },
  checklistNoteCategories: { bad: "Band", says: "list" },
  checklistNoteTeams: { bad: [1], says: "list of text" },
  defaultAvatar: { bad: "http://example.org/a.png", says: "image" },
  defaultAvatarCrop: { in: "x", out: null },
  defaultAvatarOriginal: { bad: 1, says: "image" },
  displays: { bad: "junk", says: "must be a list" },
  emptySlotLogo: { bad: "javascript:x", says: "image" },
  emptySlotLogoCrop: { in: null, out: null },
  emptySlotLogoOriginal: { bad: [], says: "image" },
  followProdcomColors: { bad: "no", says: "true or false" },
  hourCycle: { bad: "13h", says: "one of" },
  iconColors: { bad: { "tools/clock": "orange" }, says: "colour" },
  iconGlyphs: { bad: { "../x": "Clock" }, says: "not an id or a tool path" },
  idFloors: { bad: 4, says: "must be an object" },
  integrationConfigs: { in: { obs: { host: "192.0.2.4", password: "planted", "bad key": 1 } }, out: { obs: { host: "192.0.2.4" } } },
  integrationEnabled: { bad: { obs: "yes" }, says: "true or false" },
  kioskDiscovery: { bad: "on", says: "true or false" },
  kioskDiscoveryPort: { bad: 70000, says: "port" },
  layoutDefaultsCleaned: { bad: 1, says: "true or false" },
  ndiEnabled: { bad: null, says: "true or false" },
  onboardingDismissed: { bad: "y", says: "true or false" },
  oscFeedbackPort: { in: 70000.7, out: 65535 },
  outputs: { bad: [SCREEN, { ...SCREEN, name: "Copy" }], says: 'lists the id "1" more than once' },
  planDates: { bad: 5, says: "text or null" },
  planId: { bad: {}, says: "text or null" },
  planMode: { bad: "sometimes", says: "one of" },
  planSeriesTitle: { bad: [], says: "text or null" },
  planSwitcherMode: { bad: "random", says: "one of" },
  planTitle: { bad: 1, says: "text or null" },
  publicUrl: { bad: "javascript:alert(1)//", says: "http or https" },
  reconnectSchedule: { in: { enabled: true, leadMin: 2000.4, tailMin: -5, dormantMin: 0 }, out: { enabled: true, leadMin: 1440, tailMin: 0, dormantMin: 1 } },
  screenRolesFromView: { bad: "y", says: "true or false" },
  serverId: { bad: "not-an-id", says: "server id" },
  serviceTypeId: { bad: 123, says: "text or null" },
  serviceTypeName: { bad: true, says: "text or null" },
  showQr: { bad: "y", says: "true or false" },
  splTrendMetric: { bad: 1, says: "text or null" },
  splTrendShown: { bad: "y", says: "true or false" },
  splVisibleMetrics: { bad: "laeq", says: "list" },
  taperWindow: { bad: { preMin: "an hour" }, says: "a number" },
  timezone: { bad: "Mars/Olympus_Mons", says: "time zone" },
  wirelessMeterRateMs: { in: 0, out: 100 },
};

/** Further screen rules, beyond the one case per key above. */
const SCREEN_CASES: { screens: unknown[]; says: string }[] = [
  { screens: [{ ...SCREEN, slug: "Bad Slug!" }], says: "lowercase" },
  { screens: [{ ...SCREEN, slug: "lobby" }, { id: "2", name: "Two", slug: "lobby" }], says: "already used" },
  { screens: [{ ...SCREEN, slug: "2" }, { id: "2", name: "Two" }], says: "already used" },
  { screens: [{ ...SCREEN, id: "__proto__" }], says: "id is not allowed" },
  { screens: [{ ...SCREEN, textSize: "huge" }], says: "text size" },
];

describe("settings.json restore check", () => {
  test("every key the check covers has a case here, and the list stays sorted", () => {
    assert.deepEqual(Object.keys(CASES), [...Object.keys(CASES)].sort(), "keep CASES sorted, one key per line");
    assert.deepEqual(Object.keys(CASES), CHECKED_SETTINGS_KEYS);
  });

  for (const [key, c] of Object.entries(CASES)) {
    test(key, async () => {
      const value = "bad" in c ? c.bad : c.in;
      const result = await settingsRestoreCheck({ [key]: value });
      if ("bad" in c) {
        assert.equal(result.ok, false, `${key}: ${JSON.stringify(value).slice(0, 80)} was accepted`);
        assert.ok(!result.ok && result.reason.includes(c.says), `${key}: the reason should say "${c.says}": ${!result.ok ? result.reason : ""}`);
      } else {
        assert.ok(result.ok, `${key}: refused: ${!result.ok ? result.reason : ""}`);
        assert.deepEqual((result.value as Record<string, unknown>)[key], c.out);
      }
    });
  }

  for (const { screens, says } of SCREEN_CASES) {
    test(`screens: ${says}`, async () => {
      const result = await settingsRestoreCheck({ outputs: screens });
      assert.ok(!result.ok && result.reason.includes(says), !result.ok ? result.reason : "accepted");
    });
  }

  test("a screen whose address has since become a built-in page is left for the start-up migration", async () => {
    const result = await settingsRestoreCheck({ outputs: [{ ...SCREEN, slug: "settings" }] });
    assert.ok(result.ok, !result.ok ? result.reason : "");
  });

  test("a key no code reads is dropped", async () => {
    const result = await settingsRestoreCheck({ showQr: true, somethingElse: { x: 1 } });
    assert.ok(result.ok);
    assert.deepEqual(result.value, { showQr: true });
  });
});
