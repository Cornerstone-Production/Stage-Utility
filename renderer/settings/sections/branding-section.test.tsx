// The Branding page, rendered: every control the old single-card page had is still
// here and still does the same write, and the new cards open the dialogs that edit
// them.
//
// NOT unit-tested here, and driven in Chrome against a real server instead (see the
// PR): the layout and tokens (jsdom loads no stylesheet), the file chooser and the
// crop editor's canvas export, the generated icon's pixels and sizes, and what the
// server then serves at /apple-touch-icon.png and /manifest.webmanifest.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: node:assert inspects its
// operand on failure, and inspecting a live jsdom element does not terminate.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();
const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { BrandingSection } = await import("./branding-section.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(() => {
  cleanup();
  teardown();
});
afterEach(async () => {
  cleanup();
  await settle();
});

type Partial_ = Record<string, unknown>;

const BASE = {
  appName: "Stage Utility",
  accentColor: null,
  appLogo: null,
  appLogoMonochrome: true,
  emptySlotLogo: null,
  defaultAvatar: null,
  appIcon192: null,
  appIconMaskable: null,
  appIconBackground: "#000000",
  showQr: true,
};

/** Mount the page over `state`; `accept` is what every write answers. */
function mount(state: Partial_ = {}, accept = true) {
  const writes: Partial_[] = [];
  const qr: boolean[] = [];
  const handlers = {
    handleSetBranding: async (p: Partial_) => {
      writes.push(p);
      return accept;
    },
    handleShowQrChange: (v: boolean) => qr.push(v),
  };
  render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(BrandingSection, {
        stageState: { ...BASE, ...state },
        handlers,
      } as never),
    ),
  );
  return { writes, qr };
}

/** Asserts absence WITHOUT handing the node to assert, whose failure message would inspect it. */
const absent = (found: Element | null, message: string) => assert.ok(found === null, message);

/** `Image` and a 2D canvas that always succeed. Returns the undo. */
function fakeCanvas(): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const proto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const saved = { Image: g.Image, getContext: proto.getContext, toDataURL: proto.toDataURL };
  g.Image = class {
    naturalWidth = 512;
    naturalHeight = 512;
    onload: (() => void) | null = null;
    set src(_: string) {
      queueMicrotask(() => this.onload?.());
    }
  };
  proto.getContext = () => ({ fillRect() {}, drawImage() {} });
  proto.toDataURL = () => "data:image/png;base64,AAAA";
  return () => {
    g.Image = saved.Image;
    proto.getContext = saved.getContext;
    proto.toDataURL = saved.toDataURL;
  };
}

const LOGO = "/branding-images/0123456789abcdef.png";
const press = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
    await settle();
  });
};
const dialog = (name: string) => screen.findByRole("dialog", { name });
const button = (scope: ReturnType<typeof within> | typeof screen, name: string | RegExp) =>
  scope.getByRole("button", { name });

describe("the identity hero", () => {
  test("with no logo it invites one, and Recolor is not offered", () => {
    mount();
    assert.ok(screen.getByRole("button", { name: "Add a logo" }));
    absent(screen.queryByText("Recolor to match theme"), "Recolor is offered with no logo");
  });

  test("with a logo Recolor appears and flips monochrome", async () => {
    const { writes } = mount({ appLogo: LOGO });
    assert.ok(screen.getByRole("button", { name: "Change logo" }));
    await press(screen.getByRole("switch", { name: "Recolor logo to match theme" }));
    assert.deepEqual(writes, [{ monochrome: false }]);
  });

  test("the name commits on blur, is trimmed, and a blank one is refused", async () => {
    const { writes } = mount();
    const input = screen.getByRole("textbox", { name: "App name" }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "  Chapel AV  " } });
      fireEvent.blur(input);
      await settle();
    });
    assert.deepEqual(writes, [{ name: "Chapel AV" }]);
    await act(async () => {
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.blur(input);
      await settle();
    });
    assert.equal(writes.length, 1, "a blank name was sent");
    assert.equal(input.value, "Stage Utility", "a blank name was left in the field");
  });

  test("Enter commits the name", async () => {
    const { writes } = mount();
    const input = screen.getByRole("textbox", { name: "App name" }) as HTMLInputElement;
    await act(async () => {
      input.focus();
      fireEvent.change(input, { target: { value: "Chapel AV" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await settle();
    });
    assert.deepEqual(writes, [{ name: "Chapel AV" }]);
  });
});

describe("the accent", () => {
  test("a preset saves its hex and is marked pressed once it is the accent", async () => {
    const { writes } = mount();
    await press(screen.getByRole("button", { name: "Set accent #0d9488" }));
    assert.deepEqual(writes, [{ accentColor: "#0d9488" }]);
  });

  test("the chosen preset is the pressed one, and only it", () => {
    mount({ accentColor: "#6E56CF" });
    const pressed = screen
      .getAllByRole("button", { name: /^Set accent / })
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.getAttribute("aria-label"));
    assert.deepEqual(pressed, ["Set accent #6e56cf"]);
  });

  test("Default clears it", async () => {
    const { writes } = mount({ accentColor: "#6e56cf" });
    await press(screen.getByRole("button", { name: "Default" }));
    assert.deepEqual(writes, [{ accentColor: null }]);
  });
});

describe("the connect QR card", () => {
  test("is last on the page and writes the switch", async () => {
    const { qr } = mount({ showQr: true });
    const sw = screen.getByRole("switch", { name: "Show connect QR on displays" });
    await press(sw);
    assert.deepEqual(qr, [false]);
    const labels = [...document.querySelectorAll("span")].map((s) => s.textContent);
    assert.ok(labels.lastIndexOf("Show connect QR on displays") > labels.indexOf("Accent color"));
  });
});

describe("the asset cards", () => {
  test("each says where it is used and what state it is in", () => {
    mount();
    assert.ok(screen.getByText("Not set: the tab shows your logo, and phones show the built-in Stage Utility icon."));
    assert.ok(screen.getByText("Not set · built-in silhouette"));
    assert.ok(screen.getByText("Not set"));
    cleanup();
    mount({ appIcon192: "/branding-images/aaaaaaaaaaaaaaaa.png" });
    assert.ok(screen.getByText("Custom icon"));
  });

  test("none of the review annotations ship", () => {
    mount();
    absent(screen.queryByText("NEW"), "a review annotation shipped");
  });
});

describe("the dialogs", () => {
  test("the logo dialog: Upload only until there is a logo, then Replace, Adjust and Remove", async () => {
    mount();
    await press(screen.getByRole("button", { name: "Add a logo" }));
    let d = within(await dialog("Logo"));
    assert.ok(button(d, "Upload"));
    absent(d.queryByRole("button", { name: "Adjust" }), "Adjust is offered with no logo");
    absent(d.queryByRole("button", { name: /Remove/ }), "Remove is offered with no logo");
    cleanup();
    await settle();
    mount({ appLogo: LOGO });
    await press(screen.getByRole("button", { name: "Change logo" }));
    d = within(await dialog("Logo"));
    assert.ok(button(d, "Replace"));
    assert.ok(button(d, "Adjust"));
    assert.ok(button(d, "Remove logo"));
  });

  test("Remove writes null and closes; a refused write leaves the dialog open", async () => {
    const ok = mount({ appLogo: LOGO });
    await press(screen.getByRole("button", { name: "Change logo" }));
    await press(button(within(await dialog("Logo")), "Remove logo"));
    assert.deepEqual(ok.writes, [{ logo: null }]);
    await act(async () => settle());
    absent(screen.queryByRole("dialog", { name: "Logo" }), "the dialog stayed open after a good write");
    cleanup();
    await settle();

    const refused = mount({ appLogo: LOGO }, false);
    await press(screen.getByRole("button", { name: "Change logo" }));
    await press(button(within(await dialog("Logo")), "Remove logo"));
    assert.deepEqual(refused.writes, [{ logo: null }]);
    assert.ok(screen.queryByRole("dialog", { name: "Logo" }), "the dialog closed on a refused write");
  });

  test("the empty slot image and the default avatar remove their own field", async () => {
    const empty = mount({ emptySlotLogo: LOGO });
    await press(screen.getByRole("button", { name: /Empty slot image/ }));
    await press(button(within(await dialog("Empty slot image")), "Remove empty slot image"));
    assert.deepEqual(empty.writes, [{ emptyLogo: null }]);
    cleanup();
    await settle();
    const avatar = mount({ defaultAvatar: LOGO });
    await press(screen.getByRole("button", { name: /Default avatar/ }));
    await press(button(within(await dialog("Default avatar")), "Remove default avatar"));
    assert.deepEqual(avatar.writes, [{ avatar: null }]);
  });

  test("the icon dialog with nothing set offers Upload and Use my logo, which needs a logo", async () => {
    mount();
    await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
    let d = within(await dialog("Tab and home-screen icon"));
    assert.ok(button(d, "Upload"));
    assert.equal((button(d, "Use my logo") as HTMLButtonElement).disabled, true);
    absent(d.queryByRole("button", { name: "Adjust" }), "Adjust is offered with no icon");
    assert.ok(d.getByText("Stage Utility", { selector: "b" }), "the home-screen label names the app");
    cleanup();
    await settle();
    mount({ appLogo: LOGO });
    await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
    d = within(await dialog("Tab and home-screen icon"));
    assert.equal((button(d, "Use my logo") as HTMLButtonElement).disabled, false);
  });

  test("a swatch picked before an icon exists is remembered, not written", async () => {
    const { writes } = mount();
    await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
    const d = within(await dialog("Tab and home-screen icon"));
    await press(button(d, "Background #15425c"));
    assert.equal(writes.length, 0, "a background alone created an icon");
    assert.equal(button(d, "Background #15425c").getAttribute("aria-pressed"), "true");
    assert.equal(button(d, "Background #000000").getAttribute("aria-pressed"), "false");
  });

  test("a swatch on a saved icon whose source cannot be read writes nothing", async () => {
    // Redrawing from the 192 px thumbnail instead would bake the old background in
    // for good and wipe the original and crop, with a success toast to say so.
    const before = globalThis.fetch;
    const beforeTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => new AbortController().signal; // the stub never reads it; a live timer would outlive the test
    const asked: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      asked.push(String(url));
      throw new Error("network down");
    }) as unknown as typeof fetch;
    // A drawing surface that always succeeds, so the ONLY thing standing between a
    // failed read and a saved icon is the code under test, not jsdom's missing canvas.
    const restoreCanvas = fakeCanvas();
    try {
      const { writes } = mount({
        appIcon192: "/branding-images/aaaaaaaaaaaaaaaa.png",
        appIconMaskable: "/branding-images/bbbbbbbbbbbbbbbb.png",
        appIconBackground: "#2e6691",
      });
      await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
      const d = within(await dialog("Tab and home-screen icon"));
      await press(button(d, "Background #ffffff"));
      await act(async () => settle());
      assert.ok(asked.some((u) => u.includes("/api/branding/source?target=icon")), `the source was never asked for: ${asked.join()}`);
      assert.deepEqual(writes, [], "an icon was saved from a stand-in after the source read failed");
    } finally {
      restoreCanvas();
      globalThis.fetch = before;
      AbortSignal.timeout = beforeTimeout;
    }
  });

  test("the already-saved background is not redrawn", async () => {
    const before = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: unknown) => (asked.push(String(url)), { ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      const { writes } = mount({
        appIcon192: "/branding-images/aaaaaaaaaaaaaaaa.png",
        appIconMaskable: "/branding-images/bbbbbbbbbbbbbbbb.png",
        appIconBackground: "#2e6691",
      });
      await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
      await press(button(within(await dialog("Tab and home-screen icon")), "Background #2e6691"));
      await act(async () => settle());
      assert.deepEqual([asked.length, writes.length], [0, 0]);
    } finally {
      globalThis.fetch = before;
    }
  });

  test("with an icon set the dialog offers Replace, Adjust and Remove, and the saved background is pressed", async () => {
    const { writes } = mount({
      appIcon192: "/branding-images/aaaaaaaaaaaaaaaa.png",
      appIconMaskable: "/branding-images/bbbbbbbbbbbbbbbb.png",
      appIconBackground: "#2e6691",
    });
    await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
    const d = within(await dialog("Tab and home-screen icon"));
    assert.ok(button(d, "Replace"));
    assert.ok(button(d, "Adjust"));
    absent(d.queryByRole("button", { name: "Use my logo" }), "Use my logo is offered once an icon exists");
    assert.equal(button(d, "Background #2e6691").getAttribute("aria-pressed"), "true");
    await press(button(d, "Remove tab and home-screen icon"));
    assert.deepEqual(writes, [{ icon: null }]);
  });
});
