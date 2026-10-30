// The badges on a slot card: channel top-left, own-in-ears top-right, the capsule
// plate bottom-left, and the flat mic and IEM rows under the name.
//
// What this CANNOT see, and was checked in a real browser instead (screenshots
// under /private/tmp/su-card-shots, listed in the PR): jsdom loads no stylesheet
// and resolves no container-query unit, so the placement, the sizes at 1080p /
// editor / phone widths and the red edge's paint are not asserted here. This file
// pins WHAT is drawn for which data, which is the part a render can prove.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { SlotPanel } = await import("./slot-panel.js");

// afterEach, not a trailing cleanup() in each test: a failed assertion must not leave
// this test's DOM behind for the next.
afterEach(() => cleanup());

after(() => {
  cleanup();
  teardown();
});

type Over = Omit<Partial<Slot>, "device"> & { device?: Partial<SlotDevice> };

function slot(over: Over = {}): Slot {
  const { device, ...rest } = over;
  return {
    id: "s1",
    channel: "07",
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
    displayName: "Jordan Example",
    photoUrl: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null, ...device },
    ...rest,
  } as unknown as Slot;
}

const LIVE = { status: "ok", rf: 4, battery: 88, freq: "574.000", charge: 88 } as const;

function badge(c: HTMLElement, kind: string): HTMLElement | null {
  return c.querySelector(`[data-slot-badge="${kind}"]`);
}

// Assert on a boolean, never on the element: a failed equal() against a jsdom node
// makes the runner format the whole DOM tree for its diff, which takes ~20s and
// reports the file as failed instead of the test.
const has = (c: HTMLElement, kind: string) => badge(c, kind) !== null;

describe("channel badge", () => {
  test("shows the channel", () => {
    const { container } = render(<SlotPanel slot={slot()} />);
    assert.equal(badge(container, "channel")?.textContent, "07");
    cleanup();
  });

  test("a blank channel draws no badge", () => {
    for (const channel of ["", "   "]) {
      const { container } = render(<SlotPanel slot={slot({ channel })} />);
      assert.equal(has(container, "channel"), false, JSON.stringify(channel));
      cleanup();
    }
  });
});

describe("a slot with no channel at all", () => {
  test("draws no badge and does not throw", () => {
    // Nothing validates a channel on save, so the field can be missing.
    for (const channel of [undefined, null]) {
      const { container } = render(<SlotPanel slot={slot({ channel: channel as unknown as string })} />);
      assert.equal(has(container, "channel"), false, String(channel));
      cleanup();
    }
  });
});

describe("prep badges", () => {
  test("a capsule and own in-ears draw the plate and the ears", () => {
    const { container } = render(<SlotPanel slot={slot({ prep: { capsule: "KSM9", ownIems: true } })} />);
    assert.equal(badge(container, "capsule")?.textContent, "KSM9");
    assert.equal(has(container, "ears"), true, "ears badge");
    cleanup();
  });

  test("no prep draws neither", () => {
    const { container } = render(<SlotPanel slot={slot()} />);
    assert.equal(has(container, "capsule"), false);
    assert.equal(has(container, "ears"), false);
    cleanup();
  });

  test("a capsule alone draws no ears, and own in-ears alone draws no plate", () => {
    const a = render(<SlotPanel slot={slot({ prep: { capsule: "B58a", ownIems: false } })} />);
    assert.equal(has(a.container, "capsule"), true);
    assert.equal(has(a.container, "ears"), false);
    cleanup();
    const b = render(<SlotPanel slot={slot({ prep: { capsule: null, ownIems: true } })} />);
    assert.equal(has(b.container, "capsule"), false);
    assert.equal(has(b.container, "ears"), true);
    cleanup();
  });

  test("the phone overlay variant draws the same badges, once each", () => {
    const { container } = render(<SlotPanel overlay slot={slot({ prep: { capsule: "KSM9", ownIems: true } })} />);
    assert.equal(container.querySelectorAll('[data-slot-badge="capsule"]').length, 1);
    assert.equal(container.querySelectorAll('[data-slot-badge="ears"]').length, 1);
    assert.equal(badge(container, "channel")?.textContent, "07");
    cleanup();
  });

  test("the ears badge is neutral: no brand accent on stage", () => {
    const { container } = render(<SlotPanel slot={slot({ prep: { capsule: null, ownIems: true } })} />);
    const ears = badge(container, "ears")!;
    assert.match(ears.style.background, /rgba\(255,\s*255,\s*255,\s*0\.18\)/);
    assert.doesNotMatch(ears.getAttribute("style") ?? "", /accent|--su-/);
    cleanup();
  });

  test("an empty slot draws no badges", () => {
    const { container } = render(<SlotPanel slot={slot({ link: { kind: "empty" }, prep: { capsule: "KSM9", ownIems: true } })} />);
    assert.equal(container.querySelectorAll("[data-slot-badge]").length, 0);
    cleanup();
  });
});

describe("rows", () => {
  const rows = (c: HTMLElement) => [...c.querySelectorAll("[data-slot-row]")].map((r) => r.getAttribute("data-slot-row"));

  test("a live mic is one row: label or frequency, and battery", () => {
    const { container } = render(<SlotPanel slot={slot({ device: LIVE })} />);
    assert.deepEqual(rows(container), ["mic"]);
    const row = container.querySelector('[data-slot-row="mic"]')!;
    assert.match(row.textContent ?? "", /574\.000/);
    assert.match(row.textContent ?? "", /88%/);
    cleanup();
  });

  test("a bound IEM adds the IEM row with its label and charge", () => {
    const { container } = render(<SlotPanel slot={slot({ device: { ...LIVE, iemCharge: 76, iemLabel: "IEM 1" } })} />);
    assert.deepEqual(rows(container), ["mic", "iem"]);
    assert.match(container.querySelector('[data-slot-row="iem"]')!.textContent ?? "", /IEM 1.*76%/);
    cleanup();
  });

  test("hideRf keeps the charge and drops the frequency", () => {
    const { container } = render(<SlotPanel slot={slot({ hideRf: true, device: LIVE })} />);
    const text = container.querySelector('[data-slot-row="mic"]')!.textContent ?? "";
    assert.match(text, /88%/);
    assert.doesNotMatch(text, /574/);
    cleanup();
  });

  test("an offline device is the same rows with its label and no percent", () => {
    const { container } = render(
      <SlotPanel slot={slot({ device: { status: "error", label: "VOX 3", iemLabel: "IEM 2", charge: 50, iemCharge: 40 } })} />,
    );
    assert.deepEqual(rows(container), ["mic", "iem"]);
    const text = container.querySelector("[data-slot-rows]")!.textContent ?? "";
    assert.match(text, /VOX 3/);
    assert.match(text, /IEM 2/);
    assert.doesNotMatch(text, /%/);
    cleanup();
  });

  test("a charger bay's level with no mic bound is a battery row with no bars and no label", () => {
    const { container } = render(<SlotPanel slot={slot({ device: { status: "none", charge: 72 } })} />);
    assert.deepEqual(rows(container), ["mic"]);
    const row = container.querySelector('[data-slot-row="mic"]')!;
    assert.match(row.textContent ?? "", /^72%$/);
    assert.equal(row.querySelectorAll("span.block.shrink-0").length, 0, "RF bars drawn for a device that is not answering");
    cleanup();
  });

  test("a bound mic that is not answering, on a charger bay, shows the level and no bars", () => {
    const { container } = render(<SlotPanel slot={slot({ device: { status: "error", charge: 72 } })} />);
    const row = container.querySelector('[data-slot-row="mic"]')!;
    assert.match(row.textContent ?? "", /^72%$/);
    assert.equal(row.querySelectorAll("span.block.shrink-0").length, 0, "RF bars drawn for a device that is not answering");
    cleanup();
  });

  test("an IEM with Offline picked and no label reads Offline, not blank", () => {
    for (const device of [{ ...LIVE, iemLabel: "" }, { status: "error", iemLabel: "" }] as const) {
      const { container } = render(<SlotPanel slot={slot({ device })} />);
      assert.equal(container.querySelector('[data-slot-row="iem"]')?.textContent, "Offline", JSON.stringify(device));
      cleanup();
    }
  });

  test("an IEM with a live charge and no label is called IEM", () => {
    const { container } = render(<SlotPanel slot={slot({ device: { ...LIVE, iemCharge: 76, iemLabel: "" } })} />);
    assert.match(container.querySelector('[data-slot-row="iem"]')!.textContent ?? "", /^IEM.*76%$/);
    cleanup();
  });

  test("nothing bound draws no rows", () => {
    const { container } = render(<SlotPanel slot={slot()} />);
    assert.equal(container.querySelector("[data-slot-rows]") === null, true);
    cleanup();
  });
});

describe("battery colours", () => {
  // green >=60, amber 25-59, red <25: one set of thresholds, on the mic row and the
  // IEM row alike.
  const level = (c: HTMLElement, row: string) => {
    const spans = c.querySelectorAll(`[data-slot-row="${row}"] > span`);
    const cls = spans[spans.length - 1]?.className ?? "";
    return /text-green-10/.test(cls) ? "green" : /text-yellow-10/.test(cls) ? "amber" : /text-red-10/.test(cls) ? "red" : `none (${cls})`;
  };
  const cases: [number, string][] = [[100, "green"], [60, "green"], [59, "amber"], [25, "amber"], [24, "red"], [0, "red"]];

  test("the mic row", () => {
    for (const [charge, want] of cases) {
      const { container } = render(<SlotPanel slot={slot({ device: { ...LIVE, charge } })} />);
      assert.equal(level(container, "mic"), want, `${charge}%`);
      cleanup();
    }
  });

  test("the IEM row", () => {
    for (const [iemCharge, want] of cases) {
      const { container } = render(<SlotPanel slot={slot({ device: { ...LIVE, iemCharge, iemLabel: "IEM 1" } })} />);
      assert.equal(level(container, "iem"), want, `${iemCharge}%`);
      cleanup();
    }
  });
});

describe("low battery", () => {
  const edge = (c: HTMLElement) => c.querySelector(".su-card")!.classList.contains("su-card-live");

  test("under 25 percent puts the red edge on the card", () => {
    const { container } = render(<SlotPanel slot={slot({ device: { ...LIVE, charge: 24 } })} />);
    assert.equal(edge(container), true);
    cleanup();
  });

  test("25 percent and up does not", () => {
    for (const charge of [25, 60, 100]) {
      const { container } = render(<SlotPanel slot={slot({ device: { ...LIVE, charge } })} />);
      assert.equal(edge(container), false, String(charge));
      cleanup();
    }
  });

  test("no reading is not a low battery", () => {
    const { container } = render(<SlotPanel slot={slot({ device: { ...LIVE, charge: null } })} />);
    assert.equal(edge(container), false);
    cleanup();
  });
});
