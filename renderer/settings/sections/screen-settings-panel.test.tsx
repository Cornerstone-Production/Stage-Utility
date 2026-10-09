// The Screen settings panel, driven through the real component with real events.
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
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => devicesPayload,
  text: async () => JSON.stringify(devicesPayload),
});

const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ScreenSettingsPanel, viewsFittingRole } = await import("./screen-settings-panel.js");
const { roleChangeConflict } = await import("@main/types/views");
type PanelProps = import("./screen-settings-panel.js").ScreenSettingsPanelProps;
type Actions = import("./screen-settings-panel.js").ScreenPanelActions;
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => {
  cleanup();
  devicesPayload = { scanning: false, seen: [], matches: {}, bound: [], error: null };
});
afterEach(async () => { cleanup(); await settle(); });

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z";
const WALL_A: View = { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW };
const WALL_B: View = { id: "wall-b", name: "Hallway loop", kind: "custom", surface: "display", createdAt: NOW };
const CTL_A: View = { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW };
const CTL_B: View = { id: "ctl-b", name: "Stage controls", kind: "custom", surface: "console", createdAt: NOW };
const VIEWS = [WALL_A, WALL_B, CTL_A, CTL_B];

const MINE: Output = { id: "display-1", name: "Lobby TV", viewId: "wall-a" };
const OTHER_WALL: Output = { id: "display-2", name: "Hallway TV", viewId: "wall-a" };
const PANEL_A: Output = { id: "display-3", name: "Booth panel", viewId: "ctl-a", mode: "panel" };
const PANEL_B: Output = { id: "display-4", name: "Stage panel", viewId: "ctl-a", mode: "panel" };

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
    onSetRole: async (...a) => { calls.push(["role", ...a]); return true; },
    onSetLocked: rec("locked"),
    onSetHideTopBar: rec("hideTopBar"),
    onSetTextSize: rec("textSize"),
    onSetAllowHls: rec("allowHls"),
    onSetGroups: rec("groups"),
    onSetShowInSidebar: rec("sidebar"),
    onOpenMessagingSettings: rec("openMessaging"),
    onRequestNewView: rec("newView"),
    onCreate: async (...a) => { calls.push(["create", ...a]); return null; },
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
/** Answer the confirm dialog the role change opens. */
async function answerConfirm(label: string | null): Promise<void> {
  const dialog = await screen.findByRole("alertdialog");
  await click(within(dialog).getByRole("button", { name: label ?? "Cancel" }));
}

// ── The sections ─────────────────────────────────────────────────────────

describe("edit mode", () => {
  test("has the seven sections, in the mockup's order", () => {
    mount({});
    const headings = [...document.querySelectorAll("h4")].map((h) => h.textContent);
    assert.deepEqual(headings, ["What this screen is", "What it shows", "Name and address", "On the screen", "Messages", "Video", "Device"]);
  });

  test("says what it is and that changes save as they are made", () => {
    mount({});
    assert.ok(screen.getByRole("complementary", { name: "Screen settings" }));
    assert.ok(screen.getByText("Changes save as you make them."));
    assert.ok(screen.getByRole("heading", { name: "Lobby TV" }));
  });

  test("draws nothing when its screen has gone", () => {
    mount({ target: { kind: "edit", outputId: "display-9" } });
    assert.equal(document.querySelector("aside") !== null, false, "a panel was drawn for a screen that is gone");
  });

  test("takes focus when it opens, so a keyboard user is in the form", () => {
    mount({});
    assert.equal(document.activeElement === screen.getByRole("complementary", { name: "Screen settings" }), true, `focus is on ${document.activeElement?.tagName}`);
  });

  test("Escape closes it", async () => {
    const { calls } = mount({});
    await act(async () => { fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" }); await settle(); });
    assert.deepEqual(calls, [["close"]]);
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

  test("a wall display is offered wall-screen views only, and says so", () => {
    mount({});
    assert.deepEqual(options(), ["— Unrouted —", "Lobby loop", "Hallway loop", "+ New wall view…"]);
    assert.ok(screen.getByText("Wall-display views only."));
  });

  test("a control surface is offered control-surface views only, and says so", () => {
    mount({ outputs: [PANEL_A] });
    assert.deepEqual(options(), ["— Unrouted —", "Booth controls", "Stage controls", "+ New control surface…"]);
    assert.ok(screen.getByText("Control-surface views only."));
  });

  test("keeps the view it is already on, so the picker never goes blank", () => {
    // A control surface on a wall view: allowed by the server, and not a reason
    // for the picker to show nothing.
    mount({ outputs: [{ ...PANEL_A, viewId: "wall-a" }] });
    assert.ok(options().includes("Lobby loop"));
    assert.equal(picker().value, "wall-a");
  });

  test("choosing a view routes THIS screen to it", async () => {
    const { calls } = mount({});
    await choose(picker(), "wall-b");
    assert.deepEqual(calls, [["view", "display-1", "wall-b"]]);
  });

  test("choosing Unrouted clears it", async () => {
    const { calls } = mount({});
    await choose(picker(), "__none__");
    assert.deepEqual(calls, [["view", "display-1", null]]);
  });

  test("the new-view entry asks for a view for THIS screen and routes nothing itself", async () => {
    const { calls } = mount({});
    await choose(picker(), "__new__");
    assert.deepEqual(calls, [["newView", "display-1"]]);
  });

  test("viewsFittingRole filters by surface and keeps the current one", () => {
    assert.deepEqual(viewsFittingRole(VIEWS, "panel", null).map((v) => v.id), ["ctl-a", "ctl-b"]);
    assert.deepEqual(viewsFittingRole(VIEWS, "display", null).map((v) => v.id), ["wall-a", "wall-b"]);
    assert.deepEqual(viewsFittingRole(VIEWS, "panel", "wall-a").map((v) => v.id), ["wall-a", "ctl-a", "ctl-b"]);
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

  test("cannot be set before a view is chosen: the listing belongs to the view", () => {
    mount({ outputs: [{ ...PANEL_A, viewId: null }] });
    assert.equal((sw("List in the sidebar") as HTMLButtonElement).disabled, true);
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
    assert.ok(screen.getByText("http://display.invalid/lobby · also /display-1"));
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

// ── The role ─────────────────────────────────────────────────────────────

describe("choosing a role", () => {
  test("a control surface asks first, and says what changes", async () => {
    const { calls } = mount({ outputs: [{ ...MINE, viewId: null }] });
    await click(role("Control surface"));
    const dialog = await screen.findByRole("alertdialog");
    assert.match(dialog.textContent ?? "", /Anyone standing at it can press them/);
    assert.deepEqual(calls, [], "the role changed before the operator said yes");
    await answerConfirm("Use as a control surface");
    assert.deepEqual(calls, [["role", "display-1", "panel", {}]]);
  });

  test("declining the confirm changes nothing", async () => {
    const { calls } = mount({ outputs: [{ ...MINE, viewId: null }] });
    await click(role("Control surface"));
    await answerConfirm(null);
    assert.deepEqual(calls, []);
  });

  test("going back to a wall display asks first, too", async () => {
    const { calls } = mount({ outputs: [{ ...PANEL_A, viewId: null }] });
    await click(role("Wall display"));
    const dialog = await screen.findByRole("alertdialog");
    assert.match(dialog.textContent ?? "", /read-only/);
    await answerConfirm("Make it a display");
    assert.deepEqual(calls, [["role", "display-3", "display", {}]]);
  });

  test("the role it already has asks for nothing", async () => {
    const { calls } = mount({});
    await click(role("Wall display"));
    assert.deepEqual(calls, []);
    assert.equal(screen.queryByRole("alertdialog") !== null, false, "it is on screen");
  });

  test("a view only this screen shows goes with it: no prompt, the server flips them together", async () => {
    const { calls } = mount({ outputs: [MINE, { ...OTHER_WALL, viewId: "wall-b" }] });
    await click(role("Control surface"));
    assert.equal(screen.queryByRole("group", { name: "This view is shared" }) !== null, false, "it is on screen");
    await answerConfirm("Use as a control surface");
    assert.deepEqual(calls, [["role", "display-1", "panel", {}]]);
  });
});

describe("changing the role of a view other screens also show", () => {
  const prompt = () => screen.getByRole("group", { name: "This view is shared" });

  test("names the other screens and offers a copy, and asks nothing of the server yet", async () => {
    const { calls } = mount({ outputs: [PANEL_A, PANEL_B] });
    await click(role("Wall display"));
    assert.match(prompt().textContent ?? "", /"Booth controls" is also on Stage panel, which stays a control surface\. Changing this screen never changes another one\./);
    assert.match(prompt().textContent ?? "", /"Booth controls \(wall\)", made as a wall display\. Stage panel keeps the original\./);
    assert.equal((screen.getByRole("radio", { name: /Use a copy on this screen/ }) as HTMLInputElement).checked, true, "the copy is the default");
    assert.deepEqual(calls, []);
  });

  test("names every screen when there are several", async () => {
    mount({ outputs: [PANEL_A, PANEL_B, { ...PANEL_B, id: "display-5", name: "Wing panel" }] });
    await click(role("Wall display"));
    assert.match(prompt().textContent ?? "", /also on Stage panel, Wing panel, which stay a control surface/);
  });

  test("Apply uses a copy, after the confirm, and says so to the server", async () => {
    const { calls } = mount({ outputs: [PANEL_A, PANEL_B] });
    await click(role("Wall display"));
    await click(screen.getByRole("button", { name: "Apply" }));
    await answerConfirm("Make it a display");
    assert.deepEqual(calls, [["role", "display-3", "display", { copyView: true }]]);
  });

  test("a wall display made a control surface is offered '(control surface)'", async () => {
    mount({ outputs: [MINE, OTHER_WALL] });
    await click(role("Control surface"));
    assert.match(prompt().textContent ?? "", /"Lobby loop \(control surface\)", made as a control surface\. Hallway TV keeps the original\./);
  });

  test("choosing a different view offers only views that fit, and not the shared one", async () => {
    const { calls } = mount({ outputs: [PANEL_A, PANEL_B] });
    await click(role("Wall display"));
    await click(screen.getByRole("radio", { name: /Choose a different view/ }));
    const picker = screen.getByLabelText("A different view") as HTMLSelectElement;
    assert.deepEqual([...picker.options].map((o) => o.textContent), ["Pick a view…", "Lobby loop", "Hallway loop"]);
    assert.equal((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled, true, "applied with no view picked");
    await choose(picker, "wall-b");
    await click(screen.getByRole("button", { name: "Apply" }));
    await answerConfirm("Make it a display");
    assert.deepEqual(calls, [["role", "display-3", "display", { viewId: "wall-b" }]]);
  });

  test("Cancel puts the role cards back and sends nothing", async () => {
    const { calls } = mount({ outputs: [PANEL_A, PANEL_B] });
    await click(role("Wall display"));
    assert.equal(role("Wall display").getAttribute("aria-pressed"), "true", "the chosen role is shown while it waits");
    await click(screen.getByRole("button", { name: "Cancel" }));
    assert.equal(screen.queryByRole("group", { name: "This view is shared" }) !== null, false, "it is on screen");
    assert.equal(role("Control surface").getAttribute("aria-pressed"), "true");
    assert.deepEqual(calls, []);
  });

  test("a declined confirm leaves the prompt open", async () => {
    const { calls } = mount({ outputs: [PANEL_A, PANEL_B] });
    await click(role("Wall display"));
    await click(screen.getByRole("button", { name: "Apply" }));
    await answerConfirm(null);
    assert.deepEqual(calls, []);
    assert.ok(prompt());
  });

  test("when the other screen stops sharing the view, the chosen role stays and Apply makes the plain change", async () => {
    // The prompt is about other screens. If they move off the view while it is
    // open, there is nothing left to ask, but the operator's choice still stands:
    // it must not sit there shown as chosen with nothing written and no way on.
    const { calls, rerender } = mount({ outputs: [PANEL_A, PANEL_B] });
    await click(role("Wall display"));
    assert.ok(prompt());
    await rerender({ outputs: [PANEL_A, { ...PANEL_B, viewId: "ctl-b" }] });
    assert.equal(screen.queryByRole("group", { name: "This view is shared" }) !== null, false, "the shared prompt outlived the sharing");
    assert.equal(role("Wall display").getAttribute("aria-pressed"), "true", "the operator's choice was dropped");
    assert.match(screen.getByRole("group", { name: "Change the role" }).textContent ?? "", /No other screen shows "Booth controls" now/);
    await click(screen.getByRole("button", { name: "Apply" }));
    await answerConfirm("Make it a display");
    assert.deepEqual(calls, [["role", "display-3", "display", {}]]);
  });

  test("a refused change leaves the prompt open to try again", async () => {
    const { actions } = recorder({ onSetRole: async () => false });
    mount({ outputs: [PANEL_A, PANEL_B], actions });
    await click(role("Wall display"));
    await click(screen.getByRole("button", { name: "Apply" }));
    await answerConfirm("Make it a display");
    assert.ok(prompt(), "the prompt closed on a change that did not land");
  });

  describe("roleChangeConflict", () => {
    test("only when the view no longer fits AND another screen shows it, or it cannot take the role", () => {
      const outs = [PANEL_A, PANEL_B, MINE];
      assert.ok(roleChangeConflict(PANEL_A, outs, VIEWS, "display"), "a shared console cannot become a wall view");
      assert.equal(roleChangeConflict(PANEL_A, outs, VIEWS, "panel"), null, "the view already fits");
      assert.equal(roleChangeConflict(PANEL_A, [PANEL_A, MINE], VIEWS, "display"), null, "nobody else shows it");
      assert.equal(roleChangeConflict({ ...MINE, viewId: null }, outs, VIEWS, "panel"), null, "no view, nothing to share");
      const cal: View = { id: "cal-a", name: "Week ahead", kind: "calendar", surface: "display", createdAt: NOW };
      const alone = roleChangeConflict({ ...MINE, viewId: "cal-a" }, [MINE], [cal], "panel");
      assert.deepEqual(alone && { others: alone.others, copyName: alone.copyName }, { others: [], copyName: null }, "a calendar view cannot be a console, nor can a copy");
    });
  });
});

describe("a view that cannot be a control surface", () => {
  // Only a custom view has a layout to put a control on. The server refuses a
  // calendar view, or a copy of one, as a control surface; the panel must not
  // offer what it would refuse.
  const CAL: View = { id: "cal-a", name: "Week ahead", kind: "calendar", surface: "display", createdAt: NOW };
  const CAL_CONSOLE: View = { id: "cal-c", name: "Old calendar console", kind: "calendar", surface: "console", createdAt: NOW };
  const views = [...VIEWS, CAL, CAL_CONSOLE];
  const prompt = () => screen.getByRole("group", { name: /This view/ });

  test("a shared calendar view offers a different view, never a copy", async () => {
    const { calls } = mount({ views, outputs: [{ ...MINE, viewId: "cal-a" }, { ...OTHER_WALL, viewId: "cal-a" }] });
    await click(role("Control surface"));
    assert.match(prompt().textContent ?? "", /"Week ahead" is also on Hallway TV/);
    assert.match(prompt().textContent ?? "", /only a custom view/i);
    assert.equal(screen.queryByRole("radio", { name: /Use a copy/ }) !== null, false, "a copy that the server would refuse is offered");
    await choose(screen.getByLabelText("A different view"), "ctl-b");
    await click(screen.getByRole("button", { name: "Apply" }));
    await answerConfirm("Use as a control surface");
    assert.deepEqual(calls, [["role", "display-1", "panel", { viewId: "ctl-b" }]]);
  });

  test("a calendar view only this screen shows is not flipped: it asks for a different view", async () => {
    const { calls } = mount({ views, outputs: [{ ...MINE, viewId: "cal-a" }] });
    await click(role("Control surface"));
    assert.match(prompt().textContent ?? "", /"Week ahead"/);
    assert.equal(screen.queryByRole("alertdialog") !== null, false, "it went straight to the confirm, and the server refuses the flip");
    assert.deepEqual(calls, []);
  });

  test("the picker offers a control surface no non-custom console", () => {
    mount({ views, outputs: [PANEL_A] });
    const options = [...(screen.getByLabelText("View") as HTMLSelectElement).options].map((o) => o.textContent);
    assert.equal(options.includes("Old calendar console"), false, `offered: ${options.join(", ")}`);
  });
});

// ── Guided creation ──────────────────────────────────────────────────────

describe("guided creation", () => {
  const NEW_TARGET: PanelProps["target"] = { kind: "new", device: null, defaultName: "Display 4" };
  const create = () => screen.getByRole("button", { name: "Create screen" }) as HTMLButtonElement;

  test("opens on step 1 of 3 with the screen's own questions", () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    assert.ok(screen.getByText("New screen · step 1 of 3"));
    assert.ok(screen.getByRole("heading", { name: "What is this screen?" }));
    assert.ok(role("Wall display") && role("Control surface"));
    assert.equal(screen.queryByRole("button", { name: "Back" }) !== null, false, "it is on screen");
  });

  test("Next and Back walk the three steps, each with its own question", async () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    await click(screen.getByRole("button", { name: "Next" }));
    assert.ok(screen.getByText("New screen · step 2 of 3"));
    assert.ok(screen.getByRole("heading", { name: "What should it show?" }));
    await click(screen.getByRole("button", { name: "Next" }));
    assert.ok(screen.getByRole("heading", { name: "Name it" }));
    assert.equal(screen.queryByRole("button", { name: "Next" }) !== null, false, "no Next on the last step");
    await click(screen.getByRole("button", { name: "Back" }));
    assert.ok(screen.getByRole("heading", { name: "What should it show?" }));
  });

  test("Create screen is enabled on every step", async () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    for (let step = 1; step <= 3; step++) {
      assert.equal(create().disabled, false, `Create screen is disabled on step ${step}`);
      if (step < 3) await click(screen.getByRole("button", { name: "Next" }));
    }
  });

  test("creating on step 1 uses every default: a wall display, no view, a numbered name", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await click(create());
    assert.deepEqual(calls, [["create", { name: "Display 4", mode: "display" }, null], ["close"]]);
  });

  test("closing creates nothing", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await click(role("Control surface"));
    await click(screen.getByRole("button", { name: "Close" }));
    assert.deepEqual(calls, [["close"]], "something was created, or the close was never sent");
  });

  test("a control surface with a new view, the listing off, a name and a link", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await click(role("Control surface"));
    await click(sw("List in the sidebar"));
    await click(screen.getByRole("button", { name: "Next" }));
    await choose(screen.getByLabelText("View"), "__new__");
    assert.ok(screen.getByText(/A blank control-surface view named after the screen is made with it/));
    await click(screen.getByRole("button", { name: "Next" }));
    await type(screen.getByLabelText("Name"), " Wing ");
    await type(screen.getByLabelText(/Friendly link/), "wing");
    await click(create());
    assert.deepEqual(calls[0], ["create", { name: "Wing", mode: "panel", newView: true, slug: "wing", showInSidebar: false }, null]);
  });

  test("the sidebar listing is not sent unless the operator moved it", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await click(role("Control surface"));
    await click(screen.getByRole("button", { name: "Next" }));
    await choose(screen.getByLabelText("View"), "ctl-b");
    await click(create());
    assert.deepEqual(calls[0], ["create", { name: "Display 4", mode: "panel", viewId: "ctl-b" }, null],
      "an existing console that is hidden must not be re-listed by a screen made for it");
  });

  test("the picker is filtered to the role chosen on step 1", async () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    await click(role("Control surface"));
    await click(screen.getByRole("button", { name: "Next" }));
    const options = [...(screen.getByLabelText("View") as HTMLSelectElement).options].map((o) => o.textContent);
    assert.deepEqual(options, ["— No view yet —", "Booth controls", "Stage controls", "+ New blank view"]);
  });

  test("a view chosen for one role does not follow the screen to the other", async () => {
    const { calls } = mount({ target: NEW_TARGET, outputs: [MINE] });
    await click(role("Control surface"));
    await click(screen.getByRole("button", { name: "Next" }));
    await choose(screen.getByLabelText("View"), "ctl-b");
    await click(screen.getByRole("button", { name: "Back" }));
    await click(role("Wall display"));
    await click(create());
    assert.deepEqual(calls[0], ["create", { name: "Display 4", mode: "display" }, null], "a console view was sent for a wall display");
  });

  test("a refusal stays on screen with its reason, and creates nothing more", async () => {
    const { actions, calls } = recorder({ onCreate: async () => '"/history" is a built-in page.' });
    mount({ target: NEW_TARGET, outputs: [MINE], actions, onClose: () => calls.push(["close"]) });
    await click(screen.getByRole("button", { name: "Next" }));
    await click(screen.getByRole("button", { name: "Next" }));
    await type(screen.getByLabelText(/Friendly link/), "history");
    await click(create());
    assert.match(screen.getByRole("alert").textContent ?? "", /built-in page/);
    assert.deepEqual(calls, [], "the panel closed on a screen that was refused");
  });

  test("a refusal sends the operator to the link when a link was typed", async () => {
    const { actions } = recorder({ onCreate: async () => "taken" });
    mount({ target: NEW_TARGET, outputs: [MINE], actions });
    await click(screen.getByRole("button", { name: "Next" }));
    await click(screen.getByRole("button", { name: "Next" }));
    await type(screen.getByLabelText(/Friendly link/), "cafe");
    await click(screen.getByRole("button", { name: "Back" }));
    await click(create());
    assert.ok(screen.getByRole("heading", { name: "Name it" }));
  });

  test("for a device it says the device then shows this screen, and hands the device on", async () => {
    const device = { id: "kiosk-aaaa", hostname: "lobby-pi", ip: "192.0.2.10" };
    const { calls } = mount({ target: { kind: "new", device, defaultName: "lobby-pi" }, outputs: [MINE] });
    assert.ok(screen.getByText("Nothing is created until you finish. The device then shows this screen."));
    await click(create());
    assert.deepEqual(calls[0], ["create", { name: "lobby-pi", mode: "display" }, device]);
  });

  test("without a device it says to point a monitor at the address", () => {
    mount({ target: NEW_TARGET, outputs: [MINE] });
    assert.ok(screen.getByText("Nothing is created until you finish. Then point a monitor at its address."));
  });
});
