// The Screens page's side panel (a screen's settings, a view's settings, a new
// screen, and nothing selected), driven through the real component with real events.
//
// A control that renders is not a control that does anything, so every setting
// here is changed the way an operator changes it and the assertion is on what the
// panel TELLS THE OUTSIDE WORLD: which callback, with which id, with which value.
// The panel reads only props and calls only callbacks, so nothing here needs a
// server; the wiring from those callbacks to the server is screens-panel-wiring
// .test.tsx.
//
// This file also carries the guards the card's menu used to have, now that the
// settings live here: the lock and the top bar are offered only where a bar is
// drawn ("Lock display" shipped as a no-op on a calendar wall), the HLS switch is
// about the OUTPUT and so is always offered, and the message-group checklist
// sends the WHOLE new list in the config's order.
//
// NOT unit-tested here, driven in a browser instead: the panel's width, its
// position beside the cards, and its stacking on a narrow screen. jsdom loads no
// stylesheet.
//
// Every id and name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";
import { KIND_DRAWS_TOP_BAR, type ViewKind } from "@main/types/views";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** What /api/devices answers. Swapped per test; the panel's Device line reads it. */
let devicesPayload: Record<string, unknown> = { scanning: false, seen: [], matches: {}, bound: [], error: null };
/** Every request the panel made, so a click can be shown to have reached the server. */
const fetchCalls: { url: string; method: string; body: string }[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  fetchCalls.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") });
  return {
  ok: true,
  status: 200,
  json: async () => devicesPayload,
  text: async () => JSON.stringify(devicesPayload),
  };
};

const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ScreenSettingsPanel } = await import("./screen-settings-panel.js");
const { __resetDevicesForTests, refreshDevices } = await import("../../app/screens/use-devices.js");
type PanelProps = import("./screen-settings-panel.js").ScreenSettingsPanelProps;
type Actions = import("./screen-settings-panel.js").ScreenPanelActions;
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => {
  cleanup();
  __resetDevicesForTests();
  devicesPayload = { scanning: false, seen: [], matches: {}, bound: [], health: [], error: null };
  fetchCalls.length = 0;
});
afterEach(async () => { cleanup(); await settle(); });

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z";
const WALL_A: View = { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW };
const WALL_B: View = { id: "wall-b", name: "Hallway loop", kind: "custom", surface: "display", createdAt: NOW };
const CTL_A: View = { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW };
const CTL_B: View = { id: "ctl-b", name: "Stage controls", kind: "custom", surface: "console", createdAt: NOW };
const VIEWS = [WALL_A, WALL_B, CTL_A, CTL_B];

// A screen is a control surface when the view it shows is a console, so which of
// these is which is the view's surface, not a field on the screen.
const MINE: Output = { id: "display-1", name: "Lobby TV", viewId: "wall-a" };
const PANEL_A: Output = { id: "display-3", name: "Booth panel", viewId: "ctl-a" };

const GREEN = { id: "g-11111111", name: "Green room" };
const STAGE = { id: "g-22222222", name: "Stage" };
const BOOTH = { id: "g-33333333", name: "Booth" };
const ALL_GROUPS = [GREEN, STAGE, BOOTH];

type Call = [string, ...unknown[]];

/** Actions that record every call, and answer the way a landed write does. */
function recorder(over: Partial<Actions> = {}): { calls: Call[]; actions: Actions } {
  const calls: Call[] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const actions: Actions = {
    onRename: rec("rename"),
    onSetSlug: async (...a) => { calls.push(["slug", ...a]); },
    onSetView: rec("view"),
    onSetLocked: rec("locked"),
    onSetHideTopBar: rec("hideTopBar"),
    onSetTextSize: rec("textSize"),
    onSetRotation: rec("rotation"),
    onSetVideoMode: rec("videoMode"),
    onSetAllowHls: rec("allowHls"),
    onSetGroups: rec("groups"),
    onSetShowInSidebar: rec("sidebar"),
    onOpenMessagingSettings: rec("openMessaging"),
    onRequestNewView: rec("newView"),
    onCreate: async (...a) => { calls.push(["create", ...a]); return { refused: null, outputId: null }; },
    onSelect: rec("select"),
    onAddScreen: rec("add"),
    onEditLayout: rec("editLayout"),
    onRemoveScreen: rec("removeScreen"),
    onRenameView: rec("renameView"),
    onSetViewSurface: rec("viewSurface"),
    onDuplicateView: rec("duplicate"),
    onDeleteView: rec("deleteView"),
    ...over,
  };
  return { calls, actions };
}

function mount(over: Partial<PanelProps> & { actions?: Actions }) {
  const rec = recorder();
  const outputs = over.outputs ?? [MINE];
  const onClose = over.onClose ?? (() => { rec.calls.push(["close"]); });
  const props: PanelProps = {
    target: { kind: "edit", outputId: outputs[0].id },
    outputs,
    views: VIEWS,
    baseUrl: "http://display.invalid",
    online: false,
    messageGroups: { groups: ALL_GROUPS, known: true, failed: false },
    actions: rec.actions,
    onClose,
    ...over,
  };
  const tree = (p: PanelProps) =>
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ScreenSettingsPanel, p),
      React.createElement(ConfirmHost),
    );
  const r = render(tree(props));
  /** Re-render with new props, as a stage-state broadcast does. */
  const rerender = async (next: Partial<PanelProps>) => {
    await act(async () => { r.rerender(tree({ ...props, ...next })); await settle(); });
  };
  return { ...rec, rerender };
}

/** Mount the panel on a screen routed to a view of this kind (null = unrouted). */
function mountForKind(kind: ViewKind | null) {
  const view: View = { id: "v1", name: "The view", kind, createdAt: NOW } as View;
  return mount({
    outputs: [{ id: "display-1", name: "Stage left", viewId: kind ? "v1" : null }],
    views: kind ? [view] : [],
  });
}

const click = async (el: Element) => { await act(async () => { fireEvent.click(el); await settle(); }); };
const choose = async (el: Element, value: string) => { await act(async () => { fireEvent.change(el, { target: { value } }); await settle(); }); };
const type = async (el: Element, value: string) => { await act(async () => { fireEvent.change(el, { target: { value } }); await settle(); }); };
const sw = (name: string) => screen.getByRole("switch", { name });
const role = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
/** Answer the confirm dialog that choosing a view of the other kind opens. */
async function answerConfirm(label: string | null): Promise<void> {
  const dialog = await screen.findByRole("alertdialog");
  await click(within(dialog).getByRole("button", { name: label ?? "Cancel" }));
}

// ── The sections ─────────────────────────────────────────────────────────

describe("edit mode", () => {
  test("has the six sections, in order, and no role to choose: the view decides", () => {
    mount({});
    const headings = [...document.querySelectorAll("h4")].map((h) => h.textContent);
    assert.deepEqual(headings, ["What it shows", "Name and address", "On the screen", "Messages", "Video", "Device"]);
    assert.equal(screen.queryByRole("group", { name: "What this screen is" }) !== null, false, "a role the screen does not have is offered");
  });

  test("says what it is and that changes save as they are made", () => {
    mount({});
    assert.ok(screen.getByRole("complementary", { name: "Settings" }));
    assert.ok(screen.getByText("Changes save as you make them."));
    assert.ok(screen.getByRole("heading", { name: "Lobby TV" }));
  });

  test("a screen that has gone leaves the empty state, not a stale form", () => {
    mount({ target: { kind: "edit", outputId: "display-9" } });
    assert.ok(screen.getByRole("heading", { name: "Select a screen or view" }));
    assert.equal(screen.queryByRole("switch", { name: "Use HLS" }) !== null, false, "a form was drawn for a screen that is gone");
  });

  test("does not take focus when it mounts: it is on the page from the start, and a click on a card's name must keep the focus it just took", () => {
    mount({});
    assert.equal(document.activeElement === screen.getByRole("complementary", { name: "Settings" }), false);
  });

  test("Remove screen… asks for THIS screen to be removed, and is off for the last one", async () => {
    const { calls } = mount({ outputs: [MINE, PANEL_A] });
    await click(screen.getByRole("button", { name: "Remove screen…" }));
    assert.deepEqual(calls, [["removeScreen", "display-1"]]);
    cleanup();
    mount({ outputs: [MINE] });
    assert.equal((screen.getByRole("button", { name: "Remove screen…" }) as HTMLButtonElement).disabled, true, "the last screen can be removed; the server refuses it");
  });

  test("View settings → and Edit layout sit under the role line and go to this screen's view", async () => {
    const { calls } = mount({});
    await click(screen.getByRole("button", { name: "View settings →" }));
    await click(screen.getByRole("button", { name: "Edit layout" }));
    assert.deepEqual(calls, [["select", { kind: "view", viewId: "wall-a" }], ["editLayout", "wall-a"]]);
  });

  test("an unrouted screen has neither: there is no view to open", () => {
    mount({ outputs: [{ ...MINE, viewId: null }] });
    assert.equal(screen.queryByRole("button", { name: "View settings →" }) !== null, false, "it is on screen");
    assert.equal(screen.queryByRole("button", { name: "Edit layout" }) !== null, false, "it is on screen");
  });

  test("Escape closes it", async () => {
    const { calls } = mount({});
    await act(async () => { fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" }); await settle(); });
    assert.deepEqual(calls, [["close"]]);
  });

  test("Escape in a field saves what was typed there before closing, as the X does", async () => {
    // The X commits because pressing it blurs the field first. Escape used to
    // close straight away, and a typed name or text size was lost.
    const { calls } = mount({});
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    await act(async () => { name.focus(); await settle(); });
    await type(name, "Atrium TV");
    await act(async () => { fireEvent.keyDown(name, { key: "Escape" }); await settle(); });
    assert.deepEqual(calls, [["rename", "display-1", "Atrium TV"], ["close"]]);
  });

  test("Escape in the text size saves the typed size before closing", async () => {
    const { calls } = mount({});
    const size = screen.getByLabelText("Text size") as HTMLInputElement;
    await act(async () => { size.focus(); await settle(); });
    await type(size, "150");
    await act(async () => { fireEvent.keyDown(size, { key: "Escape" }); await settle(); });
    assert.deepEqual(calls, [["textSize", "display-1", 150], ["close"]]);
  });
});

describe("the top bar and the lock follow the bar", () => {
  for (const [kind, draws] of Object.entries(KIND_DRAWS_TOP_BAR) as [ViewKind, boolean][]) {
    test(`${kind}: ${draws ? "offers" : "hides"} the lock and the top-bar switch`, () => {
      mountForKind(kind);
      // Sanity: the panel really drew. Without this the whole file passes by
      // asserting an absent switch is absent.
      assert.ok(sw("Use HLS"), "the panel did not draw");
      assert.equal(
        screen.queryByRole("switch", { name: "Lock" }) !== null,
        draws,
        draws ? `${kind} draws a bar but its lock is gone` : `${kind} draws no bar and still offers "Lock" — the shipped no-op`,
      );
      assert.equal(
        screen.queryByRole("switch", { name: "Top bar" }) !== null,
        draws,
        draws ? `${kind} draws a bar but cannot hide it` : `${kind} draws no bar and still offers "Top bar"`,
      );
      // About the OUTPUT, not the routed view's bar: a Video widget can land on
      // any custom layout this screen is routed to next.
      assert.ok(sw("Use HLS"), `${kind}: the HLS switch must be offered whatever kind is routed`);
    });
  }

  test("an unrouted screen keeps both: its placeholder draws a bar", () => {
    mountForKind(null);
    assert.ok(sw("Lock"), "an unrouted screen lost its lock");
    assert.ok(sw("Top bar"), "an unrouted screen lost its top-bar switch");
  });

  test("the top-bar switch reads on when the bar is shown, and off turns it away", async () => {
    const { calls } = mount({ outputs: [{ ...MINE, hideTopBar: false }] });
    assert.equal(sw("Top bar").getAttribute("aria-checked"), "true");
    await click(sw("Top bar"));
    assert.deepEqual(calls, [["hideTopBar", "display-1", true]], "turning the switch off must HIDE the bar");
  });

  test("a hidden bar reads off, and turning it on shows it again", async () => {
    const { calls } = mount({ outputs: [{ ...MINE, hideTopBar: true }] });
    assert.equal(sw("Top bar").getAttribute("aria-checked"), "false");
    await click(sw("Top bar"));
    assert.deepEqual(calls, [["hideTopBar", "display-1", false]]);
  });

  test("the lock switch locks and unlocks THIS screen", async () => {
    const first = mount({});
    await click(sw("Lock"));
    assert.deepEqual(first.calls, [["locked", "display-1", true]]);
    cleanup();
    const second = mount({ outputs: [{ ...MINE, locked: true }] });
    assert.equal(sw("Lock").getAttribute("aria-checked"), "true");
    await click(sw("Lock"));
    assert.deepEqual(second.calls, [["locked", "display-1", false]]);
  });
});

describe("the HLS switch", () => {
  const HELP = "Off, this screen plays only WebRTC. A feed that needs HLS says it can't play here.";

  test("on by default (allowHls absent), with its caption shown as help", () => {
    mount({});
    assert.equal(sw("Use HLS").getAttribute("aria-checked"), "true", "absent must read as allowed");
    assert.ok(screen.getByText(HELP), "the caption is the switch's help text, whether it is on or off");
  });

  test("off with allowHls: false", () => {
    mount({ outputs: [{ ...MINE, allowHls: false }] });
    assert.equal(sw("Use HLS").getAttribute("aria-checked"), "false");
  });

  test("flipping it sends the flipped value for THIS screen", async () => {
    const { calls } = mount({});
    await click(sw("Use HLS"));
    assert.deepEqual(calls, [["allowHls", "display-1", false]]);
  });
});

describe("text size", () => {
  const field = () => screen.getByLabelText("Text size") as HTMLInputElement;

  test("is the themed NumberInput, never a raw number input", () => {
    mount({});
    assert.equal(document.querySelectorAll('input[type="number"]').length, 0, "a raw <input type=number> is in the panel");
    assert.ok(field(), "the text size field is gone");
  });

  test("shows the kept size, or 100 when none is kept", () => {
    mount({ outputs: [{ ...MINE, textSize: 140 }] });
    assert.equal(field().value, "140");
    cleanup();
    mount({});
    assert.equal(field().value, "100");
  });

  test("writes once when the value settles, not on every keystroke", async () => {
    const { calls } = mount({});
    await act(async () => { fireEvent.focus(field()); await settle(); });
    // Typing 150 passes through 1 and 15, which clamp to 50 — each of those must
    // not reach a live wall.
    for (const v of ["1", "15", "150"]) await type(field(), v);
    assert.deepEqual(calls, [], "a keystroke was written to the screen");
    await act(async () => { fireEvent.blur(field()); await settle(); });
    assert.deepEqual(calls, [["textSize", "display-1", 150]]);
  });

  test("is held between 50 and 300", async () => {
    const { calls } = mount({});
    await act(async () => { fireEvent.focus(field()); await settle(); });
    await type(field(), "900");
    await act(async () => { fireEvent.blur(field()); await settle(); });
    assert.deepEqual(calls, [["textSize", "display-1", 300]]);
    cleanup();
    const low = mount({});
    await act(async () => { fireEvent.focus(field()); await settle(); });
    await type(field(), "5");
    await act(async () => { fireEvent.blur(field()); await settle(); });
    assert.deepEqual(low.calls, [["textSize", "display-1", 50]]);
  });
});

describe("the message groups", () => {
  const boxes = () => ALL_GROUPS.map((g) => screen.getByRole("checkbox", { name: g.name }));

  test("one checkbox per group, checked for the ones this screen is in", () => {
    mount({ outputs: [{ ...MINE, groups: [STAGE.id] }] });
    assert.deepEqual(boxes().map((b) => b.getAttribute("aria-checked")), ["false", "true", "false"]);
  });

  test("ticking a group sends the whole new list, in the config's order", async () => {
    const { calls } = mount({ outputs: [{ ...MINE, groups: [BOOTH.id] }] });
    await click(screen.getByRole("checkbox", { name: "Green room" }));
    assert.deepEqual(calls, [["groups", "display-1", [GREEN.id, BOOTH.id]]]);
  });

  test("unticking removes only that group", async () => {
    const { calls } = mount({ outputs: [{ ...MINE, groups: [GREEN.id, STAGE.id, BOOTH.id] }] });
    await click(screen.getByRole("checkbox", { name: "Stage" }));
    assert.deepEqual(calls, [["groups", "display-1", [GREEN.id, BOOTH.id]]]);
  });

  test("a stored id the config no longer holds is not sent back", async () => {
    const { calls } = mount({ outputs: [{ ...MINE, groups: [STAGE.id, "g-99999999"] }] });
    await click(screen.getByRole("checkbox", { name: "Booth" }));
    assert.deepEqual(calls, [["groups", "display-1", [STAGE.id, BOOTH.id]]], "the server refuses an id it does not know, so one in the list would fail every later tick");
  });

  test("with no groups it says so and links to Settings -> Messages", async () => {
    const { calls } = mount({ messageGroups: { groups: [], known: true, failed: false } });
    await click(screen.getByText(/No groups yet/));
    assert.deepEqual(calls, [["openMessaging"]]);
  });

  test("while the groups are unread it does not claim there are none", () => {
    mount({ messageGroups: { groups: [], known: false, failed: false } });
    assert.ok(screen.getByText("Loading groups..."));
    assert.equal(screen.queryByText(/No groups yet/) !== null, false, "it is on screen");
  });

  test("when the read failed it says so rather than claiming there are none", () => {
    mount({ messageGroups: { groups: [], known: true, failed: true } });
    assert.ok(screen.getByText("Couldn't load the groups."));
    assert.equal(screen.queryByText(/No groups yet/) !== null, false, "it is on screen");
  });
});

describe("what it shows", () => {
  const picker = () => screen.getByLabelText("View") as HTMLSelectElement;
  const options = () => [...picker().options].map((o) => o.textContent);
  const groups = () => [...picker().querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)]);

  test("offers views of both kinds, grouped as wall views and control surfaces", () => {
    mount({});
    assert.deepEqual(groups(), [["Wall views", ["Lobby loop", "Hallway loop"]], ["Control surfaces", ["Booth controls", "Stage controls"]]]);
    assert.equal(options()[0], "— No view yet —", "the panel's empty row is the mockup's; the card's picker keeps Unrouted");
  });

  test("says in one line what the view makes the screen: a pill, then what it means", () => {
    mount({});
    assert.ok(screen.getByText("Wall display"));
    assert.ok(screen.getByText("Read-only. Buttons draw but do nothing."));
    cleanup();
    mount({ outputs: [PANEL_A] });
    assert.ok(screen.getByText("Control surface"));
    assert.ok(screen.getByText("Its buttons work for anyone at it."));
    cleanup();
    mount({ outputs: [{ ...MINE, viewId: null }] });
    assert.ok(screen.getByText("Shows nothing yet."));
  });

  test("ends with both ways to make a view, wall first, whatever the screen shows", () => {
    mount({});
    assert.deepEqual(options().slice(-2), ["+ New wall view…", "+ New control surface…"]);
    cleanup();
    mount({ outputs: [PANEL_A] });
    assert.deepEqual(options().slice(-2), ["+ New wall view…", "+ New control surface…"]);
  });

  test("keeps the view it is already on, so the picker never goes blank", () => {
    mount({ outputs: [{ ...PANEL_A, viewId: "wall-a" }] });
    assert.equal(picker().value, "wall-a");
  });

  test("choosing a view of the same kind routes THIS screen to it, asking nothing", async () => {
    const { calls } = mount({});
    await choose(picker(), "wall-b");
    assert.equal(screen.queryByRole("alertdialog") !== null, false, "a confirm was asked for a change that changes nothing");
    assert.deepEqual(calls, [["view", "display-1", "wall-b", "display"]]);
    cleanup();
    const ctl = mount({ outputs: [PANEL_A] });
    await choose(picker(), "ctl-b");
    assert.deepEqual(ctl.calls, [["view", "display-3", "ctl-b", "console"]]);
  });

  test("choosing Unrouted clears it, asking nothing, even for a control surface", async () => {
    const { calls } = mount({ outputs: [PANEL_A] });
    await choose(picker(), "__none__");
    assert.equal(screen.queryByRole("alertdialog") !== null, false);
    assert.deepEqual(calls, [["view", "display-3", null]]);
  });

  test("each new-view entry asks for a view of ITS kind for THIS screen and routes nothing itself", async () => {
    const { calls } = mount({});
    await choose(picker(), "__new_wall__");
    await choose(picker(), "__new_control__");
    assert.deepEqual(calls, [["newView", "display-1", "display"], ["newView", "display-1", "console"]]);
  });
});

describe("the sidebar listing", () => {
  test("is offered for a control surface only", () => {
    mount({ outputs: [PANEL_A] });
    assert.ok(sw("List in the sidebar"));
    cleanup();
    mount({});
    assert.equal(screen.queryByRole("switch", { name: "List in the sidebar" }) !== null, false, "it is on screen");
  });

  test("reads on for a console that was never hidden, and writes the VIEW the screen shows", async () => {
    const { calls } = mount({ outputs: [PANEL_A] });
    assert.equal(sw("List in the sidebar").getAttribute("aria-checked"), "true");
    await click(sw("List in the sidebar"));
    assert.deepEqual(calls, [["sidebar", "ctl-a", false]], "the switch must write the shown view, not the screen");
  });

  test("reads off for a console kept out of the sidebar", async () => {
    const { calls } = mount({ outputs: [PANEL_A], views: [{ ...CTL_A, showInSidebar: false }, WALL_A] });
    assert.equal(sw("List in the sidebar").getAttribute("aria-checked"), "false");
    await click(sw("List in the sidebar"));
    assert.deepEqual(calls, [["sidebar", "ctl-a", true]]);
  });

  test("is not offered for a screen on a wall view, or on no view: the sidebar lists consoles", () => {
    // The sidebar never lists a wall view, so a switch here would write a flag
    // nothing reads; and with no view there is nothing to write it on.
    mount({ outputs: [{ ...PANEL_A, viewId: "wall-a" }] });
    assert.equal(screen.queryByRole("switch", { name: "List in the sidebar" }) !== null, false, "it is on screen");
    cleanup();
    mount({ outputs: [{ ...PANEL_A, viewId: null }] });
    assert.equal(screen.queryByRole("switch", { name: "List in the sidebar" }) !== null, false, "it is on screen");
  });
});

describe("name and address", () => {
  test("renaming saves the trimmed name when the field is left, and not before", async () => {
    const { calls } = mount({});
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    await type(name, "  Atrium TV ");
    assert.deepEqual(calls, []);
    await act(async () => { fireEvent.blur(name); await settle(); });
    assert.deepEqual(calls, [["rename", "display-1", "Atrium TV"]]);
  });

  test("an empty name is put back, not saved", async () => {
    const { calls } = mount({});
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    await type(name, "   ");
    await act(async () => { fireEvent.blur(name); await settle(); });
    assert.deepEqual(calls, []);
    assert.equal(name.value, "Lobby TV");
  });

  test("shows the permanent address, and the friendly one beside it when there is one", () => {
    mount({});
    assert.ok(screen.getByText("http://display.invalid/display-1"));
    cleanup();
    mount({ outputs: [{ ...MINE, slug: "lobby" }] });
    // One paragraph, whatever elements it is split into for wrapping.
    assert.ok(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "http://display.invalid/lobby · also /display-1"));
  });

  test("copies the permanent address over plain HTTP, where navigator.clipboard does not exist", async () => {
    // Prod is served over plain HTTP, so copyText takes its execCommand path,
    // which copies whatever is selected at that moment. Record what that is.
    let copied: string | null = null;
    const doc = document as unknown as { execCommand: (cmd: string) => boolean };
    const had = doc.execCommand;
    doc.execCommand = (cmd: string) => {
      if (cmd === "copy") copied = (document.activeElement as HTMLTextAreaElement | null)?.value ?? null;
      return true;
    };
    try {
      mount({ outputs: [{ ...MINE, slug: "lobby" }] });
      await click(screen.getByRole("button", { name: "Copy the permanent URL" }));
    } finally {
      doc.execCommand = had;
    }
    assert.equal(copied, "http://display.invalid/display-1");
  });

  test("Save appears only once the link differs, and sends it lower-cased and trimmed", async () => {
    const { calls } = mount({});
    assert.equal(screen.queryByRole("button", { name: "Save" }) !== null, false, "it is on screen");
    await type(screen.getByLabelText(/Friendly link/), "  Lobby-TV ");
    await click(screen.getByRole("button", { name: "Save" }));
    assert.deepEqual(calls, [["slug", "display-1", "lobby-tv"]]);
  });

  test("a link the server refuses stays on screen with the reason", async () => {
    const { actions } = recorder({ onSetSlug: async () => { throw new Error('"/history" is a built-in page.'); } });
    mount({ actions });
    await type(screen.getByLabelText(/Friendly link/), "history");
    await click(screen.getByRole("button", { name: "Save" }));
    assert.match(screen.getByRole("alert").textContent ?? "", /built-in page/);
    assert.equal((screen.getByLabelText(/Friendly link/) as HTMLInputElement).value, "history", "the refused link was cleared");
  });
});

describe("the device", () => {
  test("names the machine bound to this screen, with its address and whether the screen is online", async () => {
    devicesPayload = {
      scanning: false, seen: [], matches: {}, error: null,
      bound: [{ id: "kiosk-aaaa", outputId: "display-1", macs: [], hostname: "lobby-pi", ip: "192.0.2.10" }],
    };
    mount({ online: true });
    await act(async () => { await settle(); await settle(); });
    assert.ok(screen.getByText("lobby-pi · 192.0.2.10"));
    assert.ok(screen.getByText(/^Online\./));
  });

  test("says so when none is bound", async () => {
    mount({});
    // The device list is one shared fetch whose last answer outlives a test:
    // wait for this test's own (empty) answer before reading.
    await act(async () => { await settle(); await settle(); });
    assert.ok(screen.getByText("No device is set up for this screen."));
  });
});

describe("the device of a Mac output helper", () => {
  const SDI = { kind: "decklink", name: "SDI 1 · Card A", port: "SDI 1", modes: ["720p50", "1080p50", "1080p59.94", "2160p30"] };
  const HDMI = { kind: "display", name: "HDMI 1 · Monitor", port: "HDMI 1" };
  const device = (output: unknown) => ({
    id: "mac1.out-1", outputId: "display-1", macs: ["02:aa:00:bb:11:cc"], hostname: "booth-mini", ip: "192.0.2.40", output,
  });
  const HEALTH = { deviceId: "mac1.out-1", fps: 59.94, repeated: 0.24, dropped: 3, at: 1, receivedAt: 2, struggling: false };

  /** Mount a screen shown by `output`, and wait for the device list. */
  async function open(output: unknown, over: { screen?: Partial<Output>; health?: unknown[]; online?: boolean } = {}) {
    devicesPayload = { scanning: false, seen: [], matches: {}, bound: [device(output)], health: over.health ?? [], error: null };
    const m = mount({ outputs: [{ ...MINE, ...over.screen }], online: over.online ?? true });
    await act(async () => { await settle(); await settle(); });
    return m;
  }
  const format = () => screen.getByRole("combobox", { name: "Format" }) as HTMLSelectElement;
  const rotation = () => within(screen.getByRole("group", { name: "Rotation" }));

  test("names the port and the card, and says whether the screen is online", async () => {
    await open(SDI);
    assert.ok(screen.getByText("booth-mini · SDI 1"));
    assert.ok(screen.getByText("Card A · via the output helper on 192.0.2.40"));
    assert.ok(screen.getByText("Online"));
  });

  test("says Offline when no page is connected", async () => {
    await open(SDI, { online: false });
    assert.ok(screen.getByText("Offline"));
  });

  test("offers Format for a DeckLink port, from the modes it reported, the house default first", async () => {
    await open(SDI);
    // 2160p30 is reported but not accepted by the server, so it is not offered.
    assert.deepEqual([...format().options].map((o) => o.value), ["1080p59.94", "1080p50", "720p50"]);
    assert.equal(format().value, "1080p59.94", "an unset screen shows the house mode");
  });

  test("a port that reported no modes is offered the whole accepted list", async () => {
    await open({ ...SDI, modes: undefined });
    const { VIDEO_MODES } = await import("@main/types/output-format");
    assert.deepEqual([...format().options].map((o) => o.value).sort(), [...VIDEO_MODES]);
  });

  test("choosing a Format sends that mode for this screen", async () => {
    const { calls } = await open(SDI);
    await choose(format(), "1080p50");
    assert.deepEqual(calls, [["videoMode", "display-1", "1080p50"]]);
  });

  test("shows the mode the screen already has, even one the port did not report", async () => {
    await open(SDI, { screen: { videoMode: "1080i50" } });
    assert.equal(format().value, "1080i50");
  });

  test("a display has no Format: it runs at what the Mac drives it at", async () => {
    await open(HDMI);
    assert.equal(screen.queryByRole("combobox", { name: "Format" }) !== null, false, "it is on screen");
    assert.ok(rotation().getByRole("button", { name: "0°" }), "rotation is for every output");
  });

  test("Rotation shows the current turn and sends the one chosen", async () => {
    const { calls } = await open(SDI, { screen: { rotation: 90 } });
    const pressed = rotation().getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true");
    assert.deepEqual(pressed.map((b) => b.textContent), ["90°"]);
    await click(rotation().getByRole("button", { name: "270°" }));
    assert.deepEqual(calls, [["rotation", "display-1", 270]]);
  });

  test("an unset rotation reads as 0°", async () => {
    await open(SDI);
    const pressed = rotation().getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true");
    assert.deepEqual(pressed.map((b) => b.textContent), ["0°"]);
  });

  test("shows what the output last reported", async () => {
    await open(SDI, { health: [HEALTH] });
    const stats = within(screen.getByRole("group", { name: "Output health" }));
    assert.ok(stats.getByText("59.94"));
    assert.ok(stats.getByText("0.2%"));
    assert.ok(stats.getByText("3"));
    assert.equal(screen.queryByText("No report from the helper yet.") !== null, false, "it is on screen");
  });

  test("shows a DeckLink output's latency, to the millisecond, with what it measures", async () => {
    await open(SDI, { health: [{ ...HEALTH, latencyMs: 20.4 }] });
    assert.ok(screen.getByText("Latency 20 ms (render to air)"));
  });

  test("shows no latency line when the report carried none", async () => {
    await open(SDI, { health: [HEALTH] });
    assert.equal(screen.queryByText(/Latency/) !== null, false, "a latency line is on screen with no latency");
  });

  test("shows no latency line when nothing has been reported", async () => {
    await open(SDI);
    assert.equal(screen.queryByText(/Latency/) !== null, false, "a latency line is on screen with no report");
  });

  test("a display output shows no latency, whatever it reports", async () => {
    await open(HDMI, { health: [{ ...HEALTH, latencyMs: 20 }] });
    assert.equal(screen.queryByText(/Latency/) !== null, false, "a display shows a DeckLink figure");
  });

  test("a display output at 0 fps shows a dash: its display link sleeps with the display", async () => {
    await open(HDMI, { health: [{ ...HEALTH, fps: 0 }] });
    const stats = within(screen.getByRole("group", { name: "Output health" }));
    assert.equal(stats.queryByText("0.00") !== null, false, "it is on screen");
    assert.equal(stats.getAllByText("—").length, 1);
  });

  test("a DeckLink output at 0 fps shows 0.00: the card clock does not sleep", async () => {
    await open(SDI, { health: [{ ...HEALTH, fps: 0 }] });
    assert.ok(within(screen.getByRole("group", { name: "Output health" })).getByText("0.00"));
  });

  test("says so, rather than showing zeros, when nothing has been reported", async () => {
    await open(SDI);
    const stats = within(screen.getByRole("group", { name: "Output health" }));
    assert.equal(stats.getAllByText("—").length, 3);
    assert.ok(screen.getByText("No report from the helper yet."));
  });

  test("a health report for another device is not shown here", async () => {
    await open(SDI, { health: [{ ...HEALTH, deviceId: "mac1.out-2", fps: 12 }] });
    assert.ok(screen.getByText("No report from the helper yet."));
  });

  // Three different reasons for the same dashes, each said differently: nothing
  // yet, a helper that was reporting and went quiet, and a screen that is offline.
  test("a helper that was reporting and went quiet says so, not that it has yet to report", async () => {
    await open(SDI, { health: [HEALTH] });
    // The server drops a reading 60 s after the last one.
    devicesPayload = { ...devicesPayload, health: [] };
    await act(async () => { await refreshDevices(); await settle(); });
    assert.ok(screen.getByText("The helper stopped reporting."));
    assert.equal(screen.queryByText("No report from the helper yet.") !== null, false, "it still says it has yet to report");
  });

  test("an offline screen with no report says it is offline, not that the helper is silent", async () => {
    await open(SDI, { online: false });
    assert.ok(screen.getByText("Offline, so nothing is being reported."));
    assert.equal(screen.queryByText("No report from the helper yet.") !== null, false, "it says the helper is silent");
    assert.equal(screen.queryByText("The helper stopped reporting.") !== null, false, "it says the helper stopped");
  });

  test("an offline screen that has reported says it is offline too", async () => {
    await open(SDI, { health: [HEALTH], online: false });
    devicesPayload = { ...devicesPayload, health: [] };
    await act(async () => { await refreshDevices(); await settle(); });
    assert.ok(screen.getByText("Offline, so nothing is being reported."));
  });

  test("says when the output is struggling", async () => {
    await open(SDI, { health: [{ ...HEALTH, struggling: true }] });
    assert.match(screen.getByRole("status").textContent ?? "", /dropping frames or running late/);
  });

  test("Release unbinds this device, and only this one", async () => {
    await open(SDI);
    await click(screen.getByRole("button", { name: "Release" }));
    const release = fetchCalls.find((c) => c.url.endsWith("/api/devices/release"));
    assert.ok(release, "Release never reached the server");
    assert.deepEqual(JSON.parse(release.body), { deviceId: "mac1.out-1" });
  });

  test("a device that is not an output keeps today's section, with none of this", async () => {
    devicesPayload = {
      scanning: false, seen: [], matches: {}, health: [], error: null,
      bound: [{ id: "kiosk-aaaa", outputId: "display-1", macs: [], hostname: "lobby-pi", ip: "192.0.2.10" }],
    };
    mount({ online: true });
    await act(async () => { await settle(); await settle(); });
    assert.ok(screen.getByText("lobby-pi · 192.0.2.10"));
    assert.equal(screen.queryByRole("group", { name: "Rotation" }) !== null, false, "it is on screen");
    assert.equal(screen.queryByRole("button", { name: "Release" }) !== null, false, "it is on screen");
  });
});

// ── Choosing a view of the other kind ───────────────────────────────────

describe("choosing a view of the other kind", () => {
  // The view decides what a screen is, so pointing it at a console makes its
  // buttons live and pointing it at a wall view switches them off. That is asked
  // about first, and the answer is a plain routing change: nothing else moves.
  const picker = () => screen.getByLabelText("View") as HTMLSelectElement;

  test("a wall display pointed at a console asks first, and says what changes", async () => {
    const { calls } = mount({});
    await choose(picker(), "ctl-b");
    const dialog = await screen.findByRole("alertdialog");
    assert.match(dialog.textContent ?? "", /Make "Lobby TV" a control surface\?/);
    assert.match(dialog.textContent ?? "", /"Stage controls" is a control surface\. Buttons on this screen will work, and anyone standing at it can press them/);
    assert.deepEqual(calls, [], "the screen was routed before the operator said yes");
    await answerConfirm("Show it and make it live");
    assert.deepEqual(calls, [["view", "display-1", "ctl-b", "console"]]);
  });

  test("sends the kind of view the operator was asked about, not what it is when they answer", async () => {
    // The server holds the write to this: a view made a wall view while the dialog
    // was open is refused, rather than a screen going live on what nobody confirmed.
    const { calls, rerender } = mount({});
    await choose(picker(), "ctl-b");
    await screen.findByRole("alertdialog");
    await rerender({ views: VIEWS.map((v) => (v.id === "ctl-b" ? { ...v, surface: "display" as const } : v)) });
    await answerConfirm("Show it and make it live");
    assert.deepEqual(calls, [["view", "display-1", "ctl-b", "console"]]);
  });

  test("declining changes nothing", async () => {
    const { calls } = mount({});
    await choose(picker(), "ctl-b");
    await answerConfirm(null);
    assert.deepEqual(calls, []);
    assert.equal(picker().value, "wall-a", "the picker moved off the view the screen still shows");
  });

  test("a control surface pointed at a wall view asks first, too", async () => {
    const { calls } = mount({ outputs: [PANEL_A] });
    await choose(picker(), "wall-b");
    const dialog = await screen.findByRole("alertdialog");
    assert.match(dialog.textContent ?? "", /Make "Booth panel" a wall display\?/);
    assert.match(dialog.textContent ?? "", /read-only/);
await answerConfirm("Show it");
    assert.deepEqual(calls, [["view", "display-3", "wall-b", "display"]]);
  });

  test("a screen showing nothing, given a console, asks: its buttons would go live", async () => {
    const { calls } = mount({ outputs: [{ ...MINE, viewId: null }] });
    await choose(picker(), "ctl-a");
    await screen.findByRole("alertdialog");
await answerConfirm("Show it and make it live");
    assert.deepEqual(calls, [["view", "display-1", "ctl-a", "console"]]);
  });

  test("a screen showing nothing, given a wall view, asks nothing: it was read-only and stays so", async () => {
    const { calls } = mount({ outputs: [{ ...MINE, viewId: null }] });
    await choose(picker(), "wall-b");
    assert.equal(screen.queryByRole("alertdialog") !== null, false, "a confirm was asked for a change that changes nothing");
    assert.deepEqual(calls, [["view", "display-1", "wall-b", "display"]]);
  });
});

// ── Nothing selected ────────────────────────────────────────────────────

describe("nothing selected", () => {
  test("says so, and offers Add a screen", async () => {
    const { calls } = mount({ target: null });
    assert.ok(screen.getByText("Nothing selected"));
    assert.ok(screen.getByRole("heading", { name: "Select a screen or view" }));
    assert.ok(screen.getByText("Click any card on the left to see its settings here."));
    await click(screen.getByRole("button", { name: "+ Add a screen" }));
    assert.deepEqual(calls, [["add"]]);
  });
});

// ── The note after a screen is made ─────────────────────────────────────

describe("after Create screen", () => {
  test("names the screen and its view, says the view is blank, and offers Edit layout", async () => {
    const { calls } = mount({ target: { kind: "edit", outputId: "display-1", created: { viewMade: true } } });
    const note = screen.getByRole("status");
    assert.match(note.textContent ?? "", /Created "Lobby TV" and its view\. The view is blank until you lay it out\./);
    // Two Edit layout buttons: the note's, and the one under the role line. The
    // note's comes first.
    await click(within(note).getByRole("button", { name: "Edit layout" }));
    assert.deepEqual(calls, [["editLayout", "wall-a"]]);
  });

  test("without a view made it says only that the screen was created, and has no Edit layout of its own", () => {
    mount({ target: { kind: "edit", outputId: "display-1", created: { viewMade: false } } });
    const note = screen.getByRole("status");
    assert.equal((note.textContent ?? "").trim(), 'Created "Lobby TV".');
    assert.equal(within(note).queryByRole("button", { name: "Edit layout" }) !== null, false, "it is on screen");
  });
});

// ── View settings ───────────────────────────────────────────────────────

describe("view settings", () => {
  const onView = (view: View, over: Partial<PanelProps> = {}) =>
    mount({ target: { kind: "view", viewId: view.id }, outputs: [MINE, PANEL_A, { id: "display-4", name: "Stage panel", viewId: "ctl-a" }], ...over });

  test("has its sections in order, with the view's name as the title", () => {
    onView(CTL_A);
    assert.ok(screen.getByText("View settings"));
    assert.ok(screen.getByRole("heading", { name: "Booth controls" }));
    assert.deepEqual([...document.querySelectorAll("h4")].map((h) => h.textContent), ["Name", "What this view is", "Shown on", "Layout"]);
    assert.ok(screen.getByText("Changes save as you make them."));
  });

  test("renaming saves the trimmed name when the field is left", async () => {
    const { calls } = onView(CTL_A);
    const name = screen.getByLabelText("View name") as HTMLInputElement;
    await type(name, "  Booth desk ");
    assert.deepEqual(calls, []);
    await act(async () => { fireEvent.blur(name); await settle(); });
    assert.deepEqual(calls, [["renameView", "ctl-a", "Booth desk"]]);
  });

  test("a control surface reads as one, and asks to become a wall view", async () => {
    const { calls } = onView(CTL_A);
    assert.equal(role("Control surface").getAttribute("aria-pressed"), "true");
    assert.equal(role("Wall view").getAttribute("aria-pressed"), "false");
    await click(role("Wall view"));
    assert.deepEqual(calls, [["viewSurface", "ctl-a", "display"]]);
  });

  test("the kind cards use the mockup's sentences", () => {
    onView(CTL_A);
    assert.ok(screen.getByText("Read from across the room. Buttons draw but do nothing."));
    assert.ok(screen.getByText("Its buttons work, in the sidebar and on any screen showing it."));
  });

  test("choosing the kind it already is sends nothing", async () => {
    const { calls } = onView(CTL_A);
    await click(role("Control surface"));
    assert.deepEqual(calls, []);
  });

  test("a view with nothing to operate cannot be a control surface, and says why", async () => {
    const slots: View = { id: "mics", name: "Mic board", kind: "slots", surface: "display", createdAt: NOW };
    const { calls } = mount({ target: { kind: "view", viewId: "mics" }, views: [slots], outputs: [MINE] });
    assert.equal((role("Control surface") as HTMLButtonElement).disabled, true);
    assert.ok(screen.getByText("Only a layout or a calendar can be a control surface: this view has nothing to press."));
    await click(role("Control surface"));
    assert.deepEqual(calls, []);
  });

  test("a calendar CAN be a control surface: its month chevrons are something to operate", async () => {
    const calendar: View = { id: "cal", name: "Month calendar", kind: "calendar", surface: "display", createdAt: NOW };
    const { calls } = mount({ target: { kind: "view", viewId: "cal" }, views: [calendar], outputs: [MINE] });
    assert.equal((role("Control surface") as HTMLButtonElement).disabled, false, "a calendar's Control surface card is off");
    assert.equal(screen.queryByText(/has nothing to press/) !== null, false, "the refusal note is shown for a calendar");
    await click(role("Control surface"));
    assert.deepEqual(calls, [["viewSurface", "cal", "console"]]);
  });

  test("List in the sidebar is there for a control surface only, and writes this view", async () => {
    const { calls } = onView(CTL_A);
    assert.equal(sw("List in the sidebar").getAttribute("aria-checked"), "true");
    await click(sw("List in the sidebar"));
    assert.deepEqual(calls, [["sidebar", "ctl-a", false]]);
    cleanup();
    onView(WALL_A);
    assert.equal(screen.queryByRole("switch", { name: "List in the sidebar" }) !== null, false, "a wall view is listed in the sidebar");
  });

  test("Shown on has a chip for each screen showing it, and each jumps to that screen", async () => {
    const { calls } = onView(CTL_A);
    const chips = ["Booth panel", "Stage panel"].map((n) => screen.getByRole("button", { name: n }));
    assert.equal(screen.queryByRole("button", { name: "Lobby TV" }) !== null, false, "a screen that shows another view is listed");
    assert.ok(screen.getByText("Buttons work on each of these. Click one to jump to it."));
    await click(chips[1]);
    assert.deepEqual(calls, [["select", { kind: "edit", outputId: "display-4" }]]);
  });

  test("a wall view says it is read-only on its screens", () => {
    onView(WALL_A);
    assert.ok(screen.getByText("Read-only on each of these. Click one to jump to it."));
  });

  test("a view no screen shows says so", () => {
    onView(CTL_B);
    assert.ok(screen.getByText("No screen shows it. Pick it from a screen's view picker to put it on one."));
    assert.equal(screen.queryByText(/Click one to jump to it/) !== null, false, "it is on screen");
  });

  test("Edit layout is for a custom view, and Duplicate for any", async () => {
    const { calls } = onView(CTL_A);
    await click(screen.getByRole("button", { name: "Edit layout" }));
    await click(screen.getByRole("button", { name: "Duplicate" }));
    assert.deepEqual(calls, [["editLayout", "ctl-a"], ["duplicate", "ctl-a"]]);
    cleanup();
    const calendar: View = { id: "cal", name: "Month calendar", kind: "calendar", surface: "display", createdAt: NOW };
    mount({ target: { kind: "view", viewId: "cal" }, views: [calendar], outputs: [MINE] });
    assert.equal(screen.queryByRole("button", { name: "Edit layout" }) !== null, false, "a calendar has no layout to edit, though it can be a control surface");
    assert.ok(screen.getByRole("button", { name: "Duplicate" }));
  });

  test("Delete view… asks for THIS view to be deleted", async () => {
    const { calls } = onView(CTL_A);
    await click(screen.getByRole("button", { name: "Delete view…" }));
    assert.deepEqual(calls, [["deleteView", "ctl-a"]]);
  });

  test("a view that is gone leaves the empty state", () => {
    mount({ target: { kind: "view", viewId: "gone" } });
    assert.ok(screen.getByRole("heading", { name: "Select a screen or view" }));
  });
});

// ── Guided creation ──────────────────────────────────────────────────────

describe("guided creation", () => {
  // As the Add tile opens it: no name, so the server names the screen from its id.
  const NEW_TARGET: PanelProps["target"] = { kind: "new", device: null, defaultName: "" };
  const create = () => screen.getByRole("button", { name: "Create screen" }) as HTMLButtonElement;
  const choice = (name: RegExp) => screen.getByRole("button", { name });
  const next = () => click(screen.getByRole("button", { name: "Next" }));

  test("opens on step 1 of 2 with the name and the friendly link, and no Create yet", () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    assert.ok(screen.getByText("New screen · step 1 of 2"));
    assert.ok(screen.getByRole("heading", { name: "Name it" }));
    assert.ok(screen.getByLabelText("Name") && screen.getByLabelText(/Friendly link/));
    assert.equal(screen.queryByRole("button", { name: "Create screen" }) !== null, false, "Create screen is on step 1");
    assert.equal(screen.queryByRole("button", { name: "Back" }) !== null, false, "it is on screen");
    assert.ok(screen.getByText("Nothing is created until the last step."));
  });

  test("Next is the primary button on step 1 and Create screen appears only on step 2", async () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    await next();
    assert.ok(screen.getByText("New screen · step 2 of 2"));
    assert.ok(screen.getByRole("heading", { name: "What should it show?" }));
    assert.equal(screen.queryByRole("button", { name: "Next" }) !== null, false, "no Next on the last step");
    assert.ok(create());
    await click(screen.getByRole("button", { name: "Back" }));
    assert.ok(screen.getByRole("heading", { name: "Name it" }));
    assert.equal(screen.queryByRole("button", { name: "Create screen" }) !== null, false, "Create screen stayed on step 1");
  });

  test("step 2 has four choices, a new wall view marked Usual first and chosen", async () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    await next();
    const titles = [...document.querySelectorAll('[aria-pressed]')].map((b) => b.querySelector("span")?.textContent);
    assert.deepEqual(titles, [
      "A new wall view named like the screenUsual",
      "A new control surface named like the screen",
      "A view you already have",
      "Nothing yet",
    ]);
    assert.equal(choice(/^A new wall view/).getAttribute("aria-pressed"), "true", "the usual choice is not the default");
  });

  test("the choices are named for the name typed", async () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    await type(screen.getByLabelText("Name"), " Wing ");
    await next();
    assert.ok(choice(/^A new wall view called "Wing"/));
    assert.ok(choice(/^A new control surface called "Wing"/));
    assert.ok(screen.getByText('Creates the screen and a wall view, both called "Wing".'));
    await click(choice(/^A new control surface/));
    assert.ok(screen.getByText('Creates the screen and a control surface, both called "Wing".'));
    await click(choice(/^Nothing yet/));
    assert.ok(screen.getByText("Creates the screen."));
  });

  test("creating with the default choice sends newView: wall", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await next();
    await click(create());
    assert.deepEqual(calls, [["create", { newView: "wall" }, null]]);
  });

  test("a new control surface sends newView: control, with the name and the link", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await type(screen.getByLabelText("Name"), " Wing ");
    await type(screen.getByLabelText(/Friendly link/), "wing");
    await next();
    await click(choice(/^A new control surface/));
    await click(create());
    assert.deepEqual(calls, [["create", { name: "Wing", newView: "control", slug: "wing" }, null]]);
  });

  test("Nothing yet sends neither a view nor a kind", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await next();
    await click(choice(/^Nothing yet/));
    await click(create());
    assert.deepEqual(calls, [["create", {}, null]]);
  });

  test("a view you already have reveals a picker of both kinds, and Create is off until one is picked", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await next();
    assert.equal(screen.queryByLabelText("Existing view") !== null, false, "the picker is open before it was asked for");
    await click(choice(/^A view you already have/));
    const picker = screen.getByLabelText("Existing view") as HTMLSelectElement;
    const groups = [...picker.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)]);
    assert.deepEqual(groups, [["Wall views", ["Lobby loop", "Hallway loop"]], ["Control surfaces", ["Booth controls", "Stage controls"]]]);
    assert.equal(create().disabled, true, "Create is offered with nothing picked");
    await click(create());
    assert.deepEqual(calls, [], "a screen was created with no view picked");
    await choose(picker, "ctl-b");
    assert.ok(screen.getByText("Control surface"));
    assert.ok(screen.getByText("Its buttons will work on this screen."));
    assert.equal(create().disabled, false);
    await click(create());
    assert.deepEqual(calls, [["create", { viewId: "ctl-b", expectSurface: "console" }, null]], "the kind the role line showed was not sent with the view");
  });

  test("a wall view picked says it is read-only", async () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    await next();
    await click(choice(/^A view you already have/));
    await choose(screen.getByLabelText("Existing view"), "wall-b");
    assert.ok(screen.getByText("Wall display"));
    assert.ok(screen.getByText("Read-only."));
  });

  test("closing creates nothing", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await next();
    await click(choice(/^A new control surface/));
    await click(screen.getByRole("button", { name: "Close" }));
    assert.deepEqual(calls, [["close"]], "something was created, or the close was never sent");
  });

  test("a refusal stays on screen with its reason, and creates nothing more", async () => {
    const { actions, calls } = recorder({ onCreate: async () => ({ refused: '"/history" is a built-in page.', outputId: null }) });
    mount({ target: NEW_TARGET, outputs: [MINE], actions, onClose: () => calls.push(["close"]) });
    await next();
    await click(create());
    assert.match(screen.getByRole("alert").textContent ?? "", /built-in page/);
    assert.deepEqual(calls, [], "the panel closed on a screen that was refused");
  });

  test("a view that changed kind keeps the form on step 2 with the message, even with a link typed, and the role line follows the view", async () => {
    const { actions } = recorder({ onCreate: async () => ({ refused: "The view changed while you were deciding: it is a wall view now, not a control surface. Nothing was changed.", outputId: null, viewChanged: true }) });
    const r = mount({ target: NEW_TARGET, outputs: [MINE], actions });
    await type(screen.getByLabelText(/Friendly link/), "cafe");
    await next();
    await click(choice(/^A view you already have/));
    await choose(screen.getByLabelText("Existing view"), "ctl-b");
    assert.ok(screen.getByText("Its buttons will work on this screen."));
    await click(create());
    assert.match(screen.getByRole("alert").textContent ?? "", /it is a wall view now/);
    assert.ok(screen.getByRole("heading", { name: "What should it show?" }), "the form went back to the link for a view problem");
    // The page reloads the views; the line says what the view is now.
    await r.rerender({ views: VIEWS.map((v) => (v.id === "ctl-b" ? { ...v, surface: "display" as const } : v)) });
    assert.ok(screen.getByText("Read-only."), "the role line still says the old kind");
  });

  test("a refusal sends the operator back to the link when a link was typed", async () => {
    const { actions } = recorder({ onCreate: async () => ({ refused: "taken", outputId: null }) });
    mount({ target: NEW_TARGET, outputs: [MINE], actions });
    await type(screen.getByLabelText(/Friendly link/), "cafe");
    await next();
    await click(create());
    assert.ok(screen.getByRole("heading", { name: "Name it" }));
    assert.match(screen.getByRole("alert").textContent ?? "", /taken/);
  });

  test("for a device it says the device then shows this screen, and hands the device on", async () => {
    const device = { id: "kiosk-aaaa", hostname: "lobby-pi", ip: "192.0.2.10" };
    const { calls } = mount({ target: { kind: "new", device, defaultName: "lobby-pi" }, outputs: [MINE] });
    assert.ok(screen.getByText("Nothing is created until the last step. The device then shows this screen."));
    await next();
    await click(create());
    assert.deepEqual(calls[0], ["create", { name: "lobby-pi", newView: "wall" }, device]);
  });

  test("a device bound elsewhere while the panel is open is not taken: it says so and Create is off", async () => {
    // Another operator set the same waiting device up meanwhile. The server now
    // refuses the claim, and the panel must not invite it.
    const device = { id: "kiosk-aaaa", hostname: "lobby-pi", ip: "192.0.2.10" };
    const { calls } = mount({ target: { kind: "new", device, defaultName: "lobby-pi" }, outputs: [MINE] });
    await act(async () => { await settle(); await settle(); });
    await next();
    assert.equal(create().disabled, false, "Create is off for a device that is still waiting");
    devicesPayload = {
      scanning: false, seen: [], matches: {}, error: null,
      bound: [{ id: "kiosk-aaaa", outputId: "display-1", macs: [], hostname: "lobby-pi" }],
    };
    const { refreshDevices } = await import("../../app/screens/use-devices.js");
    await act(async () => { await refreshDevices(); await settle(); });
    assert.match(screen.getByRole("status").textContent ?? "", /set up as "Lobby TV" meanwhile/);
    assert.equal(create().disabled, true, "Create is still offered for a device that is bound");
    await click(create());
    assert.deepEqual(calls.filter((c) => c[0] === "create"), []);
  });
});
