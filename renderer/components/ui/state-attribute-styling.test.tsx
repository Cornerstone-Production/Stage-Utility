// A control cannot be styled by an attribute that is not on it.
//
// Checkbox, Radio and Switch each painted their checked state with
// `data-[state=checked]:…`, which is the idiomatic Radix hook and worked
// everywhere it was tested. It did not work in the service-history rundown,
// where every checkbox sits inside a `Tooltip` — and `Tooltip` renders
// `Trigger asChild`, which merges the TOOLTIP's `data-state` (open / closed)
// onto the same element. So a checked box carried `data-state="closed"`, the
// selector never matched, and it kept the unchecked near-white background with
// a white tick on it. Invisible in light mode.
//
// The obvious test — render a Checkbox, assert it is checked — passes on the
// bug: `checked` was never the problem, the STYLING HOOK was. And jsdom applies
// no Tailwind, so asserting a computed colour would assert nothing either.
//
// So this asserts the invariant directly: for a control in a given state, every
// class that paints its ACTIVE look must be gated on an attribute that is
// actually present, with that value, on the rendered element. That is exactly
// what was false, and it is false again the moment someone writes data-state.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { Checkbox } = await import("./checkbox.js");
const { Radio, RadioGroup } = await import("./radio.js");
const { Switch } = await import("./switch.js");
const { Tooltip } = await import("./tooltip.js");
const { TooltipProvider } = await import("./tooltip-provider.js");

after(() => {
  cleanup();
  teardown();
});

/**
 * Every attribute condition a Tailwind variant chain places on a utility.
 *
 * A token can stack them — `dark:aria-checked:bg-accent/85` is gated on the
 * colour scheme AND on aria-checked — so this returns all of them rather than
 * the first. Only the attribute gates are returned; `dark:` and `hover:` are
 * not attribute conditions and are not this test's business.
 *
 * Handles the three spellings in use: `data-[state=checked]:`,
 * `aria-[checked=false]:` and the bare `aria-checked:` (which means "true").
 */
function gatesOf(token: string): { attr: string; value: string }[] {
  const gates: { attr: string; value: string }[] = [];
  for (const m of token.matchAll(/(?:^|:)(data|aria)-\[([a-z-]+)=([^\]]+)\]:/g)) {
    gates.push({ attr: `${m[1]}-${m[2]}`, value: m[3] });
  }
  for (const _ of token.matchAll(/(?:^|:)aria-checked:/g)) {
    gates.push({ attr: "aria-checked", value: "true" });
  }
  return gates;
}

/** Classes that paint the control's ACTIVE look, i.e. mention the accent. */
function accentTokens(el: Element): string[] {
  return el.className
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => /(^|:)(bg|border|text)-accent/.test(t));
}

/** Every accent class on this element is gated on an attribute it really has. */
function assertActiveLookApplies(el: Element, what: string): void {
  const tokens = accentTokens(el);
  assert.ok(tokens.length > 0, `${what}: found no accent class at all — has the checked look moved?`);
  for (const token of tokens) {
    const gates = gatesOf(token);
    assert.ok(gates.length > 0, `${what}: "${token}" paints the checked look with no state gate on it`);
    for (const gate of gates) {
      assert.equal(
        el.getAttribute(gate.attr),
        gate.value,
        `${what}: "${token}" waits for ${gate.attr}="${gate.value}", but the element carries ` +
          `${gate.attr}="${el.getAttribute(gate.attr)}" — the checked look will never paint. ` +
          `A Tooltip wrapper overwrites data-state; use aria-checked.`,
      );
    }
  }
}

describe("a checked control inside a Tooltip still paints as checked", () => {
  test("Checkbox", () => {
    const { container } = render(
      <TooltipProvider><Tooltip label="Counted in the service timers">
        <Checkbox checked onCheckedChange={() => {}} />
      </Tooltip></TooltipProvider>,
    );
    const box = container.querySelector('[role="checkbox"]');
    assert.ok(box, "no checkbox rendered");
    assertActiveLookApplies(box, "Checkbox in a Tooltip");
  });

  test("Radio", () => {
    // The tooltip goes on the ITEM, which is how you label one radio among
    // several. Wrapping the GROUP instead puts the clobbered data-state on the
    // group and the item is untouched — a version of this test that did that
    // passed on the unfixed component, for the wrong reason.
    const { container } = render(
      <TooltipProvider>
        <RadioGroup value="a">
          <Tooltip label="Pick this one">
            <Radio value="a" />
          </Tooltip>
        </RadioGroup>
      </TooltipProvider>,
    );
    const radio = container.querySelector('[role="radio"]');
    assert.ok(radio, "no radio rendered");
    assertActiveLookApplies(radio, "Radio in a Tooltip");
  });

  test("Switch", () => {
    const { container } = render(
      <TooltipProvider><Tooltip label="On or off">
        <Switch checked onCheckedChange={() => {}} />
      </Tooltip></TooltipProvider>,
    );
    const sw = container.querySelector('[role="switch"]');
    assert.ok(sw, "no switch rendered");
    assertActiveLookApplies(sw, "Switch in a Tooltip");
  });
});

describe("the mechanism, written down so the fix is not undone by accident", () => {
  test("a Tooltip really does overwrite its child's data-state", () => {
    // If this ever stops being true — Radix changes, or Tooltip stops using
    // asChild — the three tests above become trivially true and this one goes
    // red to say so, rather than leaving them passing for the wrong reason.
    const { container } = render(
      <TooltipProvider><Tooltip label="anything">
        <Checkbox checked onCheckedChange={() => {}} />
      </Tooltip></TooltipProvider>,
    );
    const box = container.querySelector('[role="checkbox"]');
    assert.ok(box);
    assert.notEqual(
      box.getAttribute("data-state"),
      "checked",
      "the Tooltip no longer clobbers data-state — the aria-checked hook is now belt and braces, not load-bearing",
    );
    assert.equal(box.getAttribute("aria-checked"), "true", "aria-checked is the hook the styles rely on");
  });
});
