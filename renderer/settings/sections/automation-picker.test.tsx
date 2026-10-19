// The grouped, searchable picker, over the REAL registries.
//
// What is guarded is what a flat select could not do and a broken picker would
// quietly stop doing:
//
//  - every definition is reachable, under its heading,
//  - a search runs across every heading and names the heading beside each match,
//  - each choice carries the definition's own one-line description,
//  - choosing calls back with the id, and an excluded id is not offered,
//  - a definition nothing claims is drawn under Other, not dropped.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see test-dom.ts).
//
// NOT unit-tested here, and driven in a browser instead: the two columns, the
// option list scrolling inside the dialog, and the selected row's tint.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { AutomationPicker, PickerField, pickerEntries, pickerHeadings } = await import("./automation-picker.js");
const { AUTOMATION_TRIGGERS } = await import("@main/services/automation-triggers.js");
const { AUTOMATION_ACTIONS } = await import("@main/services/automation-actions.js");
const { AUTOMATION_CONDITIONS } = await import("@main/services/automation-conditions.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const triggers = Object.values(AUTOMATION_TRIGGERS).map(({ id, label, channel, help }) => ({ id, label, channel, help }));
const actions = Object.values(AUTOMATION_ACTIONS).map(({ id, label, help }) => ({ id, label, help }));
const conditions = Object.values(AUTOMATION_CONDITIONS).map(({ id, label, help }) => ({ id, label, help }));

const optionIds = (): string[] =>
  [...document.querySelectorAll("[data-picker-option]")].map((el) => el.getAttribute("data-picker-option") ?? "");
const headingNames = (): string[] =>
  [...document.querySelectorAll("[data-picker-group]")].map((el) => el.getAttribute("data-picker-group") ?? "");

async function press(el: Element | null | undefined, what: string) {
  assert.ok(el, `nothing to press: ${what}`);
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
}

async function search(text: string) {
  const input = document.querySelector("[data-picker] input");
  assert.ok(input, "no search field");
  await act(async () => {
    fireEvent.change(input as HTMLInputElement, { target: { value: text } });
  });
  await settle();
}

describe("the panel", () => {
  test("every trigger is reachable under some heading, and nothing falls under Other", async () => {
    const reached: string[] = [];
    render(React.createElement(AutomationPicker, { kind: "trigger", defs: triggers, value: "", onChange: () => {} }));
    assert.equal(headingNames().includes("Other"), false, "a trigger fell under Other");
    for (const name of headingNames()) {
      await press(document.querySelector(`[data-picker-group="${name}"]`), name);
      reached.push(...optionIds());
    }
    assert.deepEqual(reached.slice().sort(), triggers.map((t) => t.id).sort());
  });

  test("the same for every action and every condition", async () => {
    for (const [kind, defs] of [["action", actions], ["condition", conditions]] as const) {
      cleanup();
      const reached: string[] = [];
      render(React.createElement(AutomationPicker, { kind, defs, value: "", onChange: () => {} }));
      assert.equal(headingNames().includes("Other"), false, `a ${kind} fell under Other`);
      for (const name of headingNames()) {
        await press(document.querySelector(`[data-picker-group="${name}"]`), name);
        reached.push(...optionIds());
      }
      assert.deepEqual(reached.slice().sort(), defs.map((d) => d.id).sort(), `${kind}s reachable`);
    }
  });

  test("a heading's choices each carry the definition's own help", async () => {
    render(React.createElement(AutomationPicker, { kind: "trigger", defs: triggers, value: "", onChange: () => {} }));
    await press(document.querySelector('[data-picker-group="People"]'), "People");
    const row = document.querySelector('[data-picker-option="occupancy.crossed-above"]');
    assert.ok(row, "People count rises above is not under People");
    assert.ok(
      (row.textContent ?? "").includes(AUTOMATION_TRIGGERS["occupancy.crossed-above"].help),
      `the row did not show its help, it read ${JSON.stringify(row.textContent)}`,
    );
  });

  test("a search runs across every heading and names the heading beside each match", async () => {
    render(React.createElement(AutomationPicker, { kind: "trigger", defs: triggers, value: "", onChange: () => {} }));
    // Opens on Service and plan. "recording" is under Recording and streaming, and
    // is also named in the plan group's neighbours' help.
    await search("starts recording");
    const ids = optionIds();
    assert.ok(ids.includes("recording.started"), `OBS starts recording not found, got ${ids.join(", ")}`);
    assert.ok(ids.includes("reaper.recording-started"), "REAPER starts recording not found: the search stayed in one heading");
    const row = document.querySelector('[data-picker-option="recording.started"]');
    assert.ok(
      (row?.textContent ?? "").startsWith("OBS starts recordingRecording and streaming · "),
      `the match did not name its heading, it read ${JSON.stringify(row?.textContent)}`,
    );
  });

  test("a search that matches nothing says so", async () => {
    render(React.createElement(AutomationPicker, { kind: "action", defs: actions, value: "", onChange: () => {} }));
    await search("zzzzzz");
    assert.equal(optionIds().length, 0);
    assert.ok((document.body.textContent ?? "").includes("Nothing matches"));
  });

  test("pressing a choice calls back with its id", async () => {
    const picked: string[] = [];
    render(React.createElement(AutomationPicker, { kind: "action", defs: actions, value: "", onChange: (id: string) => picked.push(id) }));
    await press(document.querySelector('[data-picker-group="OBS"]'), "OBS");
    await press(document.querySelector('[data-picker-option="obs.record"]'), "OBS recording");
    assert.deepEqual(picked, ["obs.record"]);
  });

  test("an excluded id is not offered", async () => {
    render(
      React.createElement(AutomationPicker, {
        kind: "trigger",
        defs: triggers,
        value: "",
        exclude: new Set(["call.by-name"]),
        onChange: () => {},
      }),
    );
    assert.equal(headingNames().includes("This app"), true);
    await press(document.querySelector('[data-picker-group="This app"]'), "This app");
    assert.deepEqual(optionIds(), ["update.available"], "Called by name was offered");
    await search("called by name");
    assert.equal(optionIds().length, 0, "Called by name was found by search");
  });
});

describe("headings", () => {
  test("a definition nothing claims is under Other, last, not dropped", () => {
    const entries = pickerEntries("trigger", [
      { id: "mystery.fired", label: "Something", channel: "no:such-channel", help: "x" },
      { id: "update.available", label: "Update", channel: "update:status", help: "y" },
    ]);
    assert.deepEqual(pickerHeadings(entries), [
      { name: "This app", count: 1 },
      { name: "Other", count: 1 },
    ]);
    assert.deepEqual(entries.map((e) => e.id), ["update.available", "mystery.fired"]);
  });
});

describe("the field", () => {
  test("shows the choice, opens on press, and closes on choosing", async () => {
    const picked: string[] = [];
    render(
      React.createElement(PickerField, {
        kind: "action",
        defs: actions,
        value: "log.message",
        placeholder: "Pick an action…",
        ariaLabel: "Action",
        onChange: (id: string) => picked.push(id),
      }),
    );
    const field = () => document.querySelector("[data-picker-field]");
    assert.equal(field()?.textContent?.trim(), "Write a log message");
    assert.equal(document.querySelector("[data-picker]"), null, "the panel was open before it was pressed");
    await press(field(), "the field");
    assert.ok(document.querySelector("[data-picker]"), "pressing the field did not open the panel");
    await press(document.querySelector('[data-picker-option="display.refresh"]'), "Refresh all displays");
    assert.deepEqual(picked, ["display.refresh"]);
    assert.equal(document.querySelector("[data-picker]"), null, "the panel stayed open after a choice");
  });

  test("an empty value shows the placeholder, and a stored id nobody lists is shown, with a note", () => {
    render(
      React.createElement(PickerField, { kind: "trigger", defs: triggers, value: "", placeholder: "Pick a trigger…", ariaLabel: "Trigger", onChange: () => {} }),
    );
    assert.equal(document.querySelector("[data-picker-field]")?.textContent?.trim(), "Pick a trigger…");
    cleanup();
    render(
      React.createElement(PickerField, { kind: "trigger", defs: triggers, value: "gone.trigger", placeholder: "Pick a trigger…", ariaLabel: "Trigger", onChange: () => {} }),
    );
    assert.equal(document.querySelector("[data-picker-field]")?.textContent?.trim(), "gone.trigger · not found");
  });
});
