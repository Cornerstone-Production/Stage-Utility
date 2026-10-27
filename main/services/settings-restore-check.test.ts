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
import { describe, test, type TestContext } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-settings-restore-check-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { CHECKED_SETTINGS_KEYS, settingsRestoreCheck } = await import("./settings-restore-check.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

type Case = { bad: unknown; says: string } | { in: unknown; out: unknown };

const SCREEN = { id: "1", name: "Main", viewId: null };

const CASES: Record<string, Case> = {
  accentColor: { bad: "red", says: "#rrggbb" },
  allowedServiceTypeIds: { bad: [123], says: "list of text" },
  appIcon: { bad: "javascript:alert(1)", says: "PNG data URL" },
  appIcon192: { bad: "https://example.org/x.png", says: "PNG data URL" },
  appIcon512: { bad: 5, says: "PNG data URL" },
  appIconApple: { bad: "data:text/html,x", says: "PNG data URL" },
  appIconBackground: { bad: "black", says: "#rrggbb" },
  appIconCrop: { in: { scale: "big", x: 0, y: 0 }, out: null },
  appIconMaskable: { bad: {}, says: "PNG data URL" },
  appIconOriginal: { bad: "/etc/passwd", says: "image" },
  appLogo: { bad: "javascript:alert(1)", says: "image" },
  appLogoCrop: { in: { scale: 1, x: 2, y: 3, extra: true }, out: { scale: 1, x: 2, y: 3 } },
  appLogoMonochrome: { bad: "yes", says: "true or false" },
  appLogoOriginal: { bad: "data:image/png;base64," + "A".repeat(2_000_001), says: "too large" },
  appName: { in: "   ", out: "Stage Utility" },
  autoUpdate: { in: { mode: "auto-full", hour: 25, dayOfWeek: null, extra: 1 }, out: { mode: "auto-full", hour: 23, dayOfWeek: null } },
  autoUpdateMachines: { bad: 1, says: "true or false" },
  backupSchedule: {
    in: { enabled: true, intervalDays: 0.4, keep: 500, destination: " /mnt/x ", lastRunAt: null, extra: 1 },
    out: { enabled: true, intervalDays: 1, keep: 100, destination: "/mnt/x", lastRunAt: null },
  },
  baptismAutoStart: { in: { enabled: true, testimonyKeyword: "x".repeat(90), extra: 1 }, out: { enabled: true, testimonyKeyword: "x".repeat(80) } },
  baptismDefaultMode: { bad: "solo", says: "one of" },
  captionChannelColors: { in: { Pastor: " ffcc00 ", Band: "#00ff00" }, out: { Pastor: "#ffcc00", Band: "#00ff00" } },
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
  publicUrl: { in: "http://stage box", out: null },
  reconnectSchedule: {
    in: { enabled: true, leadMin: 2000.4, tailMin: -5, dormantMin: 0, extra: 1 },
    out: { enabled: true, leadMin: 1440, tailMin: 0, dormantMin: 1 },
  },
  screenRolesFromView: { bad: "y", says: "true or false" },
  serverId: { bad: "not-an-id", says: "server id" },
  serviceTypeId: { bad: 123, says: "text or null" },
  serviceTypeName: { bad: true, says: "text or null" },
  showQr: { bad: "y", says: "true or false" },
  splTrendMetric: { bad: 1, says: "text or null" },
  splTrendShown: { bad: "y", says: "true or false" },
  splVisibleMetrics: { bad: "laeq", says: "list" },
  taperWindow: { in: { preMin: 30.4, postMin: 400, extra: 1 }, out: { preMin: 30, postMin: 240 } },
  timezone: { bad: "Mars/Olympus_Mons", says: "time zone" },
  wirelessMeterRateMs: { in: 0, out: 100 },
};

/** Further rules, beyond the one case per key above: values a setter refuses. */
const MORE_BAD: { settings: Record<string, unknown>; says: string }[] = [
  { settings: { autoUpdate: { mode: "whenever", hour: 3, dayOfWeek: null } }, says: "update mode" },
  { settings: { taperWindow: { preMin: "an hour" } }, says: "a number" },
  { settings: { captionChannelColors: { Pastor: "red" } }, says: "hex colour" },
  { settings: { backupSchedule: { lastRunAt: "yesterday" } }, says: "lastRunAt" },
  // parseAppIcon takes all five images or none.
  { settings: { appIcon: "/branding-images/0123456789abcdef.png", appIcon192: null }, says: "not all of" },
];

/** Further screen rules. */
const SCREEN_CASES: { screens: unknown[]; says: string }[] = [
  { screens: [{ ...SCREEN, slug: "Bad Slug!" }], says: "lowercase" },
  { screens: [{ ...SCREEN, slug: "preview-<b>/../x" }], says: "lowercase" },
  { screens: [{ ...SCREEN, slug: "settings" }, { id: "2", name: "Two", slug: "settings" }], says: "built-in page" },
  { screens: [{ ...SCREEN, id: "" }], says: "id is not allowed" },
  { screens: [{ ...SCREEN, id: "a/b" }], says: "id is not allowed" },
  { screens: [{ ...SCREEN, slug: "lobby" }, { id: "2", name: "Two", slug: "lobby" }], says: "already used" },
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

  for (const { settings, says } of MORE_BAD) {
    test(`refuses ${JSON.stringify(settings).slice(0, 60)}`, async () => {
      const result = await settingsRestoreCheck(settings);
      assert.ok(!result.ok && result.reason.includes(says), !result.ok ? result.reason : "accepted");
    });
  }

  test("a screen's address is stored as setOutputSlug stores it, and an empty one is removed", async () => {
    const result = await settingsRestoreCheck({ outputs: [{ ...SCREEN, slug: " Lobby-TV " }, { id: "2", name: "Two", slug: "  " }] });
    assert.ok(result.ok, !result.ok ? result.reason : "");
    assert.deepEqual((result.value as { outputs: unknown[] }).outputs, [{ ...SCREEN, slug: "lobby-tv" }, { id: "2", name: "Two" }]);
  });

  test("a screen whose address has since become a built-in page is left for the start-up migration", async () => {
    const result = await settingsRestoreCheck({ outputs: [{ ...SCREEN, slug: "settings" }] });
    assert.ok(result.ok, !result.ok ? result.reason : "");
  });

  test("an address equal only to another screen's id is kept, and logged", async (t) => {
    // addOutput minted display-2 without looking at display-1's address, so a
    // v1.26.0 install can hold exactly this.
    const warnings = captureConsole(t as TestContext, "warn");
    const screens = [{ id: "display-1", name: "A", slug: "display-2" }, { id: "display-2", name: "B" }];
    const result = await settingsRestoreCheck({ outputs: screens });
    assert.ok(result.ok, !result.ok ? result.reason : "");
    assert.deepEqual((result.value as { outputs: unknown[] }).outputs, screens);
    assert.ok(
      warnings.some((w) => w.includes("[config-snapshot]") && w.includes('/display-2 is also the id of screen "B"')),
      warnings.join("\n"),
    );
  });

  test("a public URL that is not a web address is restored as none, and logged", async (t) => {
    const warnings = captureConsole(t as TestContext, "warn");
    for (const bad of ["http://stage box", "javascript:alert(1)//"]) {
      const result = await settingsRestoreCheck({ publicUrl: bad });
      assert.ok(result.ok, !result.ok ? result.reason : "");
      assert.equal((result.value as { publicUrl: unknown }).publicUrl, null, bad);
    }
    assert.equal(warnings.filter((w) => w.includes("[config-snapshot]") && w.includes("publicUrl")).length, 2, warnings.join("\n"));
  });

  test("a key no code reads is dropped", async () => {
    const result = await settingsRestoreCheck({ showQr: true, somethingElse: { x: 1 } });
    assert.ok(result.ok);
    assert.deepEqual(result.value, { showQr: true });
  });
});
