// The ProVideoPlayer "now" widget's Layout choice (Full / Compact / Countdown
// only) and its Warn near the end setting, driven through the real render and the
// real Home menu rows.
//
// WHAT THIS FILE CANNOT SEE, and was driven in a browser instead: how big the
// number is. Countdown only sizes its digits from the MEASURED box (62% of its
// height, never wider than it for the string's length) and follows a resize, and
// jsdom loads no stylesheet and reports every offsetHeight as 0. The arithmetic
// is pinned below (countdownFontPx); that it lands on the screen at the size the
// arithmetic says, in a wide strip, a square tile and a small tile, was checked
// in Chrome against a fake ProVideoPlayer. The same goes for the colours: a test
// can see that the amber token is written, not that it is amber on a dark card.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PvpNowObject, type PvpNowConfig } from "./pvp-now.js";
import {
  countdownFontPx, pvpNowLayout, pvpWarnColor, pvpWarnThresholds, pvpWarnTone, withPvpNowLayout,
} from "./pvp-now-config.js";
import { LAYOUT_OBJECTS } from "./layout-objects.js";
import type { PvpLayerDTO, PvpStatusDTO } from "@main/types/pvp";

const T = "2026-08-30T12:00:00.000Z";
const AT = Date.parse(T);

/** A rolling clip with EXACTLY `remaining` seconds left at `now`. Every name is a
 *  different string, so a layout that leaks one fails by name. */
const clip = (remaining: number, over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics (1s)", index: 0, state: "video",
  mediaName: "Mark Vance - Lead Pastor.mov", mediaUuid: "m1",
  lastCueName: "Mark Vance", lastCueUuid: "cue-0001", nextCueName: "CLEAR GRAPHIC",
  mediaSinceAt: null,
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 100, durationSec: remaining + 100,
  ...over,
});
const STILL = {
  state: "still" as const, mediaName: "slide.png", playbackRate: 0,
  anchorElapsedSec: 0, durationSec: null, mediaSinceAt: new Date(AT - 5000).toISOString(),
};
const status = (layers: PvpLayerDTO[], over: Partial<PvpStatusDTO> = {}): PvpStatusDTO => ({
  connected: true, layers, sampledAt: T, imageDurationSec: null, ...over,
});
const draw = (s: PvpStatusDTO | null, config: PvpNowConfig = {}): string =>
  renderToStaticMarkup(<PvpNowObject config={config} status={s} now={AT} />);

/** The inline style of the element whose ONLY content is `text` — the digits
 *  themselves, so a colour on the hairline beside them cannot satisfy a check on
 *  the number. */
function inkOfTime(html: string, text: string): string {
  const m = new RegExp(`<span[^>]*style="([^"]*)"[^>]*>${text}</span>`).exec(html);
  assert.ok(m, `no element holds exactly "${text}":\n${html}`);
  return m[1];
}

const WARN = "var(--color-warn-11)";
const OVER = "var(--color-danger-11)";

describe("a widget saved before Layout existed", () => {
  test("compact: true reads as Compact; anything else as Full", () => {
    assert.equal(pvpNowLayout({ compact: true }), "compact");
    assert.equal(pvpNowLayout({ compact: false }), "full");
    assert.equal(pvpNowLayout({}), "full");
  });

  test("layout wins over a stale compact", () => {
    assert.equal(pvpNowLayout({ layout: "full", compact: true }), "full");
    assert.equal(pvpNowLayout({ layout: "countdown", compact: true }), "countdown");
  });

  test("an unknown layout string falls back the way a missing one does", () => {
    assert.equal(pvpNowLayout({ layout: "huge" as never }), "full");
    assert.equal(pvpNowLayout({ layout: "huge" as never, compact: true }), "compact");
  });

  test("DRAWN: a saved compact: true draws exactly what layout: compact draws, and not Full", () => {
    const s = status([clip(277)]);
    const legacy = draw(s, { compact: true });
    assert.equal(legacy, draw(s, { layout: "compact" }), "the legacy switch no longer draws Compact");
    assert.notEqual(legacy, draw(s, {}), "compact: true drew the Full composition");
    assert.ok(legacy.includes("PVP · Mark Vance"), legacy);
  });

  test("choosing a layout retires the legacy key", () => {
    const next = withPvpNowLayout({ compact: true, showProgress: true }, "full");
    assert.equal(next.layout, "full");
    assert.equal(next.compact, undefined);
    assert.equal(JSON.stringify(next).includes("compact"), false, "compact would be written back to the file");
  });
});

describe("Countdown only draws the time left and nothing else", () => {
  const cfg: PvpNowConfig = { layout: "countdown", showNextCue: true, nowLabel: "layer", layerName: null };

  test("the fixture really has every name Full draws — so the absences below mean something", () => {
    const full = draw(status([clip(277)]), { showNextCue: true });
    for (const word of ["ProVideoPlayer", "playing", "Mark Vance - Lead Pastor.mov", "CLEAR GRAPHIC", "4:37"]) {
      assert.ok(full.includes(word), `Full lost "${word}" — the countdown-only assertions are vacuous:\n${full}`);
    }
  });

  test("the time, and no caption, state word, cue, file, layer, sub-line or next cue", () => {
    const html = draw(status([clip(277)]), cfg);
    assert.ok(html.includes("4:37"), html);
    for (const word of [
      "ProVideoPlayer", "PVP", "playing", "Mark Vance", "Lead Pastor", "Graphics", "CLEAR GRAPHIC",
      "Next", "remaining", "on screen",
    ]) {
      assert.ok(!html.includes(word), `Countdown only drew "${word}":\n${html}`);
    }
  });

  test("a pinned layer's name is not a caption here either", () => {
    const html = draw(status([clip(277, { name: "Exit screen" })]), { ...cfg, layerName: "Exit screen" });
    assert.ok(html.includes("4:37"), html);
    assert.ok(!html.includes("Exit screen"), html);
  });

  test("m:ss under an hour, h:mm:ss over it, from the widget's own formatter", () => {
    assert.ok(draw(status([clip(59)]), cfg).includes(">0:59<"));
    assert.ok(draw(status([clip(3599)]), cfg).includes(">59:59<"));
    const long = draw(status([clip(3912)]), cfg);
    assert.ok(long.includes(">1:05:12<"), long);
  });

  test("the progress hairline follows the Progress bar switch", () => {
    assert.ok(draw(status([clip(50)]), { ...cfg, showProgress: true }).includes("data-readout-meter"));
    assert.ok(!draw(status([clip(50)]), { ...cfg, showProgress: false }).includes("data-readout-meter"));
    // On by default, like the other layouts.
    assert.ok(draw(status([clip(50)]), cfg).includes("data-readout-meter"));
  });

  test("Layer still applies: a pinned layer is the one that is counted", () => {
    const two = status([clip(277, { uuid: "a", name: "Top" }), clip(61, { uuid: "b", name: "Lyrics" })]);
    assert.ok(draw(two, cfg).includes(">4:37<"), "unpinned follows the first layer with content");
    assert.ok(draw(two, { ...cfg, layerName: "Lyrics" }).includes(">1:01<"), "the pinned layer was not the one counted");
  });

  test("Count down stills still applies", () => {
    const still = status([clip(0, STILL)], { imageDurationSec: 20 });
    assert.ok(draw(still, { ...cfg, countStills: true }).includes(">0:15<"), "a counted still did not count");
  });
});

describe("Countdown only honours the Align pad", () => {
  const at = (align: "left" | "center" | "right" | undefined) =>
    renderToStaticMarkup(<PvpNowObject config={{ layout: "countdown" }} status={status([clip(277)])} now={AT} align={align} />);

  test("left, centre and right each draw their own alignment", () => {
    assert.ok(at("left").includes("align-items:flex-start"), at("left"));
    assert.ok(at("center").includes("align-items:center"), at("center"));
    assert.ok(at("right").includes("align-items:flex-end"), at("right"));
  });

  test("unset is Readout's own default, which is what the pad shows", () => {
    assert.equal(at(undefined), at("left"));
  });

  test("the vertical alignment is the custom property the object's box publishes", () => {
    assert.ok(at("center").includes("justify-content:var(--readout-v-align, center)"), at("center"));
  });
});

describe("Countdown only, nothing counting: a dim dash", () => {
  const cfg: PvpNowConfig = { layout: "countdown" };
  const dash = (html: string) => {
    assert.ok(html.includes(">—<"), `no dash:\n${html}`);
    assert.ok(/opacity:0\.45/.test(html), `the dash is not dimmed:\n${html}`);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(html), `a dash widget drew a time:\n${html}`);
    for (const word of ["Nothing on", "empty", "No layer", "PVP", "ProVideoPlayer", "not found"]) {
      assert.ok(!html.includes(word), `the dash widget also drew "${word}":\n${html}`);
    }
  };

  test("nothing on any layer", () => dash(draw(status([clip(0, { state: "empty", mediaName: null, mediaUuid: null, anchorElapsedSec: null, durationSec: null })]), cfg)));
  test("ProVideoPlayer unreachable", () => dash(draw(null, cfg)));
  test("a pinned layer PVP does not report", () => dash(draw(status([clip(50)]), { ...cfg, layerName: "Typo" })));
  test("a still with Count down stills off", () => dash(draw(status([clip(0, STILL)], { imageDurationSec: 20 }), { ...cfg, countStills: false })));

  test("a counting widget is NOT dimmed", () => {
    assert.ok(!/opacity:0\.45/.test(draw(status([clip(50)]), cfg)));
  });
});

describe("Countdown only, an ended clip: holds 0:00", () => {
  const cfg: PvpNowConfig = { layout: "countdown" };
  // As PVP reports one: state "ended", the duration gone, the last frame held.
  const ENDED = { state: "ended" as const, playbackRate: 1, anchorElapsedSec: 7.97, durationSec: null };
  const ended = (config: PvpNowConfig = cfg) => draw(status([clip(0, ENDED)]), config);

  test("0:00, undimmed, and no dash", () => {
    const html = ended();
    assert.ok(html.includes(">0:00<"), `no 0:00:\n${html}`);
    assert.ok(!html.includes(">—<"), `an ended clip drew the dash:\n${html}`);
    assert.ok(!/opacity:0\.45/.test(html), `the 0:00 is dimmed:\n${html}`);
  });

  test("with Warn near the end on it is red, as 0:00 is on a running clip", () => {
    assert.ok(inkOfTime(ended({ ...cfg, warnNearEnd: true }), "0:00").includes(OVER));
    assert.ok(!inkOfTime(ended(), "0:00").includes(OVER), "red with the warning off");
  });

  test("the hairline is full, and follows the Progress bar switch", () => {
    assert.ok(/scaleX\(1\)|width:100%/.test(ended()), `the hairline is not full:\n${ended()}`);
    assert.ok(!/scaleX\(1\)|width:100%/.test(ended({ ...cfg, showProgress: false })), "a hairline with Progress bar off");
  });
});

describe("Warn near the end: the thresholds and their edges", () => {
  const on = { warnNearEnd: true };

  test("off unless the widget turned it on, whatever is left", () => {
    assert.equal(pvpWarnTone(0, {}), null);
    assert.equal(pvpWarnTone(5, { warnNearEnd: false }), null);
  });

  test("defaults 30 and 10, inclusive: 31 plain, 30 amber, 11 amber, 10 red, 0 red", () => {
    assert.equal(pvpWarnTone(31, on), null);
    assert.equal(pvpWarnTone(30, on), "caution");
    assert.equal(pvpWarnTone(11, on), "caution");
    assert.equal(pvpWarnTone(10, on), "over");
    assert.equal(pvpWarnTone(0, on), "over");
  });

  test("judged on the second the digits SHOW: 30.4 reads 0:30 and is amber, 30.6 reads 0:31 and is not", () => {
    assert.equal(pvpWarnTone(30.4, on), "caution");
    assert.equal(pvpWarnTone(30.6, on), null);
    assert.equal(pvpWarnTone(10.4, on), "over");
    assert.equal(pvpWarnTone(10.6, on), "caution");
  });

  test("custom thresholds", () => {
    const c = { ...on, warnAmberSec: 60, warnRedSec: 20 };
    assert.equal(pvpWarnTone(61, c), null);
    assert.equal(pvpWarnTone(60, c), "caution");
    assert.equal(pvpWarnTone(21, c), "caution");
    assert.equal(pvpWarnTone(20, c), "over");
  });

  test("the colours are the app's semantic caution and over tokens", () => {
    assert.equal(pvpWarnColor("caution"), WARN);
    assert.equal(pvpWarnColor("over"), OVER);
    assert.equal(pvpWarnColor(null), null);
  });

  const LAYOUTS = ["full", "compact", "countdown"] as const;
  for (const layout of LAYOUTS) {
    describe(`drawn in ${layout}`, () => {
      const at = (remaining: number, extra: PvpNowConfig = {}) =>
        draw(status([clip(remaining)]), { layout, warnNearEnd: true, ...extra });

      test("plain at 31 s, amber at 30 s, red at 10 s — the time AND the hairline", () => {
        const plain = at(31);
        assert.ok(!plain.includes(WARN) && !plain.includes(OVER), `31 s was already coloured:\n${plain}`);
        inkOfTime(plain, "0:31"); // the digits are there; the colour absence is the line above
        const amber = at(30);
        assert.ok(amber.includes(WARN) && !amber.includes(OVER), `30 s was not amber:\n${amber}`);
        assert.ok(inkOfTime(amber, "0:30").includes(WARN), `the 30 s DIGITS were not amber:\n${amber}`);
        const red = at(10);
        assert.ok(red.includes(OVER) && !red.includes(WARN), `10 s was not red:\n${red}`);
        assert.ok(inkOfTime(red, "0:10").includes(OVER), `the 10 s DIGITS were not red:\n${red}`);
        // The rule carries the colour too, not just the digits: its FILL, which
        // the track behind it (a 22% mix of the same colour) cannot stand in for.
        for (const [html, token] of [[amber, WARN], [red, OVER]] as const) {
          const fill = /class="su-meter-fill"[^>]*?background:([^;"]*)/.exec(html);
          assert.ok(fill, `no hairline fill drawn:\n${html}`);
          assert.equal(fill[1], token, `the hairline fill stayed white:\n${html}`);
        }
      });

      test("with the switch off nothing is coloured, even at 5 s", () => {
        const html = draw(status([clip(5)]), { layout, warnNearEnd: false });
        assert.ok(!html.includes(WARN) && !html.includes(OVER), html);
      });

      test("a counted still takes the colour too", () => {
        const html = draw(
          // On screen 5 s of a 20 s hold: 15 s left, inside the amber threshold.
          status([clip(0, STILL)], { imageDurationSec: 20 }),
          { layout, warnNearEnd: true, countStills: true },
        );
        assert.ok(html.includes(WARN), `15 s left on a counted still was not amber:\n${html}`);
      });
    });
  }

  test("a cue NAME standing where the time would be takes no colour", () => {
    // Full, a still that is not being counted: the value is the cue name, not a
    // clock running out.
    const html = draw(status([clip(0, STILL)], { imageDurationSec: 20 }), { warnNearEnd: true, countStills: false });
    assert.ok(!html.includes(WARN) && !html.includes(OVER), html);
  });
});

describe("red is held at amber", () => {
  test("a red above the amber is read as the amber", () => {
    assert.deepEqual(pvpWarnThresholds({ warnAmberSec: 20, warnRedSec: 50 }), { amberSec: 20, redSec: 20 });
  });

  test("so the two colours arrive together, with no white-to-red jump past an amber step", () => {
    const c = { warnNearEnd: true, warnAmberSec: 20, warnRedSec: 50 };
    assert.equal(pvpWarnTone(21, c), null);
    assert.equal(pvpWarnTone(20, c), "over", "red above amber was not held at amber");
  });

  test("defaults, and junk, fall back instead of throwing", () => {
    assert.deepEqual(pvpWarnThresholds({}), { amberSec: 30, redSec: 10 });
    assert.deepEqual(pvpWarnThresholds({ warnAmberSec: -5, warnRedSec: Number.NaN }), { amberSec: 30, redSec: 10 });
    // Only the amber lowered below the default red: red follows it down.
    assert.deepEqual(pvpWarnThresholds({ warnAmberSec: 5 }), { amberSec: 5, redSec: 5 });
  });

  test("lowering amber does not destroy a stored red — raising it again gives it back", () => {
    const stored = { warnAmberSec: 30, warnRedSec: 10 };
    assert.equal(pvpWarnThresholds({ ...stored, warnAmberSec: 4 }).redSec, 4);
    assert.equal(pvpWarnThresholds({ ...stored, warnAmberSec: 30 }).redSec, 10);
  });
});

describe("the fit arithmetic (the browser shows it lands)", () => {
  test("height-bound: 62% of a short, wide box", () => {
    assert.equal(countdownFontPx(820, 250, 4), 250 * 0.62);
  });

  test("width-bound: a long string in a tall, narrow box is drawn smaller, never wider than the box", () => {
    const four = countdownFontPx(300, 300, 4);
    const seven = countdownFontPx(300, 300, 7);
    assert.ok(seven < four, `h:mm:ss (${seven}) was not smaller than m:ss (${four})`);
    assert.ok(seven * 0.6 * 7 <= 300, `7 characters at ${seven}px overflow a 300px box`);
  });

  test("it follows a resize", () => {
    assert.ok(countdownFontPx(1000, 400, 4) > countdownFontPx(500, 200, 4));
  });

  test("an unmeasured box (0 x 0) answers 0, not NaN", () => {
    assert.equal(countdownFontPx(0, 0, 4), 0);
    assert.equal(countdownFontPx(300, 0, 4), 0);
  });
});

describe("the registry's defaults", () => {
  test("both types default to Full with the warning off, and carry no legacy compact", () => {
    for (const type of ["pvp-now", "home-pvp-now"] as const) {
      const c = LAYOUT_OBJECTS[type].config() as unknown as Record<string, unknown>;
      assert.equal(c.layout, "full", type);
      assert.equal(c.warnNearEnd, false, type);
      assert.equal(c.warnAmberSec, 30, type);
      assert.equal(c.warnRedSec, 10, type);
      assert.equal("compact" in c, false, `${type} still writes compact`);
    }
  });
});
