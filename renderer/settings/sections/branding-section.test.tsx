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
import { after, afterEach, before, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();
const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { BrandingSection } = await import("./branding-section.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

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
  appIconTabBackground: "none",
  appIconArt: null,
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
function fakeCanvas(side = 512): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const proto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const saved = { Image: g.Image, getContext: proto.getContext, toDataURL: proto.toDataURL };
  g.Image = class {
    naturalWidth = side;
    naturalHeight = side;
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

  describe("the custom accent's debounced save", () => {
    // The colour panel's saved-colour row reads the shared stage state: answer
    // its request and stream with nothing. Restored after the group.
    const g = globalThis as unknown as Record<string, unknown>;
    const realFetch = g.fetch;
    const realEventSource = g.EventSource;
    before(() => {
      g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });
      g.EventSource = class {
        static readonly CLOSED = 2;
        readyState = 1;
        addEventListener() {}
        removeEventListener() {}
        close() {}
      };
    });
    after(() => {
      g.fetch = realFetch;
      g.EventSource = realEventSource;
    });
    const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

    /** Mount, open the colour panel and type a hex into it; `next()` re-renders over fresh handlers. */
    async function drag(value: string) {
      const writes: Partial_[] = [];
      const makeHandlers = () => ({
        handleSetBranding: async (p: Partial_) => {
          writes.push(p);
          return true;
        },
        handleShowQrChange: () => {},
      });
      const client = new QueryClient();
      const tree = (handlers: ReturnType<typeof makeHandlers>) =>
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            TooltipProvider,
            null,
            React.createElement(BrandingSection, { stageState: { ...BASE }, handlers } as never),
          ),
        );
      const view = render(tree(makeHandlers()));
      await press(screen.getByRole("button", { name: "Custom accent color" }));
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Custom accent color value"), { target: { value } });
      });
      return { writes, view, rerenderWithNewHandlers: () => view.rerender(tree(makeHandlers())) };
    }

    test("a re-render with new handlers does not save early, and the change saves once", async () => {
      const { writes, rerenderWithNewHandlers } = await drag("#123456");
      assert.deepEqual(writes, [], "saved before the debounce");
      rerenderWithNewHandlers();
      await wait(0);
      assert.deepEqual(writes, [], "a new handlers identity flushed the pending save early");
      await wait(400);
      assert.deepEqual(writes, [{ accentColor: "#123456" }]);
    });

    test("new handlers, then closing the page with a change pending, saves it once, not twice", async () => {
      const { writes, view, rerenderWithNewHandlers } = await drag("#123456");
      rerenderWithNewHandlers();
      await wait(0);
      view.unmount();
      await wait(400);
      assert.deepEqual(writes, [{ accentColor: "#123456" }]);
    });
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
    // Document order: the QR card comes after the last asset card.
    const qrCard = sw.closest("div.rounded-xl");
    const avatarCard = screen.getByRole("button", { name: /Default avatar/ });
    assert.ok(
      qrCard !== null && (avatarCard.compareDocumentPosition(qrCard) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      "the QR card is not after the asset cards",
    );
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
  test("the logo dialog: Upload only until there is a logo, then Replace and Remove, never Adjust", async () => {
    mount();
    await press(screen.getByRole("button", { name: "Add a logo" }));
    let d = within(await dialog("Logo"));
    assert.ok(button(d, "Upload"));
    assert.ok(d.getByText("Drop an image here, or click to choose one"), "no place to drop the first logo");
    absent(d.queryByRole("button", { name: /Remove/ }), "Remove is offered with no logo");
    cleanup();
    await settle();
    mount({ appLogo: LOGO });
    await press(screen.getByRole("button", { name: "Change logo" }));
    d = within(await dialog("Logo"));
    assert.ok(button(d, "Replace"));
    assert.ok(button(d, "Remove logo"));
    // The editor is the dialog's body now; a button to reach it is a second step.
    absent(d.queryByRole("button", { name: "Adjust" }), "Adjust is still a separate step");
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
    absent(d.queryByRole("slider", { name: "Zoom" }), "an editor is offered with no icon to edit");
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
    await press(button(d, "Home-screen background white"));
    assert.equal(writes.length, 0, "a background alone created an icon");
    assert.equal(button(d, "Home-screen background white").getAttribute("aria-pressed"), "true");
    assert.equal(button(d, "Home-screen background black").getAttribute("aria-pressed"), "false");
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
      await press(button(d, "Home-screen background white"));
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
      const d = within(await dialog("Tab and home-screen icon"));
      await act(async () => settle());
      // Opening reads the source for the editor; the swatch must read nothing more.
      const opened = asked.length;
      await press(button(d, "Home-screen background accent"));
      await act(async () => settle());
      assert.deepEqual([asked.length - opened, writes.length], [0, 0]);
    } finally {
      globalThis.fetch = before;
    }
  });

  test("two quick swatch clicks on a saved icon make one icon, the first", async () => {
    const before = globalThis.fetch;
    const beforeTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => new AbortController().signal;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ original: null, crop: null, art: "/branding-images/cccccccccccccccc.png" }),
    })) as unknown as typeof fetch;
    const restoreCanvas = fakeCanvas();
    try {
      const { writes } = mount({
        appIcon192: "/branding-images/aaaaaaaaaaaaaaaa.png",
        appIconMaskable: "/branding-images/bbbbbbbbbbbbbbbb.png",
        appIconBackground: "#2e6691",
      });
      await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
      const d = within(await dialog("Tab and home-screen icon"));
      await act(async () => {
        fireEvent.click(button(d, "Home-screen background black"));
        fireEvent.click(button(d, "Home-screen background white"));
        await new Promise((r) => setTimeout(r, 50));
      });
      const icons = writes.filter((w) => w.icon);
      assert.equal(icons.length, 1, `expected one icon write, got ${icons.length}`);
      assert.equal((icons[0]!.icon as { background: string }).background, "#000000");
    } finally {
      restoreCanvas();
      globalThis.fetch = before;
      AbortSignal.timeout = beforeTimeout;
    }
  });

  test("Use my logo says so when the logo is under 512 px, and says nothing when it is not", async () => {
    for (const [side, expected] of [[300, true], [1024, false]] as const) {
      const restore = fakeCanvas(side);
      try {
        mount({ appLogo: LOGO });
        await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
        await dialog("Tab and home-screen icon");
        await act(async () => {
          await settle();
          await settle();
        });
        const note = screen.queryByText(`Your logo is ${side} × ${side}, so an icon made from it may look soft.`);
        assert.equal(note !== null, expected, `${side} px logo: note ${expected ? "missing" : "shown"}`);
      } finally {
        restore();
        cleanup();
        await settle();
      }
    }
  });

  test("with an icon set the dialog offers Replace and Remove, and the saved background is pressed", async () => {
    const { writes } = mount({
      appIcon192: "/branding-images/aaaaaaaaaaaaaaaa.png",
      appIconMaskable: "/branding-images/bbbbbbbbbbbbbbbb.png",
      appIconBackground: "#2e6691",
    });
    await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
    const d = within(await dialog("Tab and home-screen icon"));
    assert.ok(button(d, "Replace"));
    absent(d.queryByRole("button", { name: "Adjust" }), "Adjust is still a separate step");
    absent(d.queryByRole("button", { name: "Use my logo" }), "Use my logo is offered once an icon exists");
    assert.equal(button(d, "Home-screen background accent").getAttribute("aria-pressed"), "true");
    await press(button(d, "Remove tab and home-screen icon"));
    assert.deepEqual(writes, [{ icon: null }]);
  });
});

const SAVED_ICON = {
  appIcon192: "/branding-images/aaaaaaaaaaaaaaaa.png",
  appIconMaskable: "/branding-images/bbbbbbbbbbbbbbbb.png",
  appIconArt: "/branding-images/cccccccccccccccc.png",
  appIconBackground: "#000000",
  appIconTabBackground: "none",
};

describe("the icon dialog: two backgrounds, Recolor, and the real shapes", () => {
  /** fetch answering the icon source read, as a saved icon has one. */
  function iconSource() {
    const before = globalThis.fetch;
    const beforeTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => new AbortController().signal;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ original: null, crop: { scale: 1, x: 0, y: 0 }, art: "/branding-images/cccccccccccccccc.png" }),
    })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = before;
      AbortSignal.timeout = beforeTimeout;
    };
  }

  test("the tab can be transparent and the home screen cannot", async () => {
    mount({ ...SAVED_ICON });
    await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
    const d = within(await dialog("Tab and home-screen icon"));
    const tab = within(d.getByRole("group", { name: "Tab background" }));
    const home = within(d.getByRole("group", { name: "Home-screen background" }));
    assert.equal(tab.getByRole("button", { name: "Tab background transparent" }).getAttribute("aria-pressed"), "true");
    absent(home.queryByRole("button", { name: /transparent/i }), "the home screen offers Transparent: iOS would fill it black");
  });

  test("the swatches are black, white, the accent and a custom colour, not fixed blues", async () => {
    mount({ ...SAVED_ICON });
    await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
    const d = within(await dialog("Tab and home-screen icon"));
    const names = (group: string) =>
      within(d.getByRole("group", { name: group }))
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"));
    assert.deepEqual(names("Tab background"), [
      "Tab background transparent",
      "Tab background black",
      "Tab background white",
      "Tab background accent",
      "Tab background, custom colour",
    ]);
    assert.deepEqual(names("Home-screen background"), [
      "Home-screen background black",
      "Home-screen background white",
      "Home-screen background accent",
      "Home-screen background, custom colour",
    ]);
  });

  test("the tab and home screen are picked apart: a tab pick redraws with the home background untouched", async () => {
    const restoreSource = iconSource();
    const restoreCanvas = fakeCanvas();
    try {
      const { writes } = mount({ ...SAVED_ICON, appIconBackground: "#ffffff" });
      await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
      const d = within(await dialog("Tab and home-screen icon"));
      await press(button(d, "Tab background black"));
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      const icon = writes.find((w) => w.icon)?.icon as { background: string; tabBackground: string } | undefined;
      assert.ok(icon, "no icon was written");
      assert.deepEqual([icon.tabBackground, icon.background], ["#000000", "#ffffff"]);
    } finally {
      restoreCanvas();
      restoreSource();
    }
  });

  test("a home-screen pick redraws with the tab background untouched", async () => {
    const restoreSource = iconSource();
    const restoreCanvas = fakeCanvas();
    try {
      const { writes } = mount({ ...SAVED_ICON, appIconTabBackground: "#2e6691" });
      await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
      const d = within(await dialog("Tab and home-screen icon"));
      await press(button(d, "Home-screen background white"));
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      const icon = writes.find((w) => w.icon)?.icon as { background: string; tabBackground: string } | undefined;
      assert.ok(icon, "no icon was written");
      assert.deepEqual([icon.background, icon.tabBackground], ["#ffffff", "#2e6691"]);
    } finally {
      restoreCanvas();
      restoreSource();
    }
  });

  test("Recolor in the dialog is the logo's setting, and redraws the icon in the same save", async () => {
    const restoreSource = iconSource();
    const restoreCanvas = fakeCanvas();
    try {
      const { writes } = mount({ ...SAVED_ICON, appLogoMonochrome: true });
      await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
      const d = within(await dialog("Tab and home-screen icon"));
      await press(d.getByRole("switch", { name: "Recolor icon to match theme" }));
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      assert.equal(writes.length, 1, `expected one write, got ${writes.length}`);
      assert.equal(writes[0]!.monochrome, false);
      assert.ok(writes[0]!.icon, "the icon was not redrawn with the new setting");
    } finally {
      restoreCanvas();
      restoreSource();
    }
  });

  test("Recolor on the logo card also redraws an existing icon, and only flips the setting when there is none", async () => {
    const { writes } = mount({ appLogo: LOGO });
    await press(screen.getByRole("switch", { name: "Recolor logo to match theme" }));
    assert.deepEqual(writes, [{ monochrome: false }]);
    cleanup();
    await settle();
    const restoreSource = iconSource();
    const restoreCanvas = fakeCanvas();
    try {
      const again = mount({ appLogo: LOGO, ...SAVED_ICON });
      await press(screen.getByRole("switch", { name: "Recolor logo to match theme" }));
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      assert.equal(again.writes.length, 1);
      assert.equal(again.writes[0]!.monochrome, false);
      assert.ok(again.writes[0]!.icon, "the logo card's switch left the icon as it was drawn");
    } finally {
      restoreCanvas();
      restoreSource();
    }
  });

  test("the icon editor shows the art in the theme ink when Recolor is on, as uploaded when off", async () => {
    // The editor is the recoloured preview (a CSS mask filled from currentColor)
    // or the plain image: what the saved icon will be drawn as.
    for (const [monochrome, expectMask] of [[true, true], [false, false]] as const) {
      const restoreSource = iconSource();
      const restoreCanvas = fakeCanvas();
      try {
        mount({ ...SAVED_ICON, appLogoMonochrome: monochrome });
        await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
        const d = await dialog("Tab and home-screen icon");
        await act(async () => new Promise((r) => setTimeout(r, 30)));
        const zoom = within(d).getByRole("slider", { name: "Zoom" });
        const viewport = zoom.closest("div.flex-col")?.parentElement?.querySelector("div.touch-none");
        assert.ok(viewport, "the editor's viewport was not found");
        const masked = [...viewport.querySelectorAll("span[aria-hidden]")].some((el) => (el as HTMLElement).style.backgroundColor.toLowerCase() === "currentcolor");
        assert.equal(masked, expectMask, `Recolor ${monochrome ? "on" : "off"}: the editor ${masked ? "recoloured" : "did not recolour"} the art`);
        assert.equal(viewport.className.includes("bg-[image:conic-gradient"), true, "the viewport is not a transparency checker");
      } finally {
        restoreCanvas();
        restoreSource();
        cleanup();
        await settle();
      }
    }
  });

  test("the iPhone and Android previews are their own shape: no black backing shows at the corners", async () => {
    // Size() used to wrap the rounded iPhone image in a black 4 px-radius square,
    // so black showed at the corners. The check is on the real tree: nothing between
    // a preview image and its label has a background or a clip of its own.
    mount({ ...SAVED_ICON });
    await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
    const d = await dialog("Tab and home-screen icon");
    for (const label of ["iPhone 180", "Android 192"]) {
      const caption = within(d).getByText(label);
      const img = caption.querySelector("img");
      assert.ok(img, `${label}: no image in the preview`);
      for (let el: Element | null = img; el && el !== caption.parentElement; el = el.parentElement) {
        const cls = el.getAttribute("class") ?? "";
        const style: CSSStyleDeclaration = (el as HTMLElement).style;
        assert.ok(!/\bbg-/.test(cls), `${label}: a ${el.tagName} behind the icon has ${cls}`);
        if (el !== img) assert.ok(!/overflow-hidden|rounded/.test(cls) && style.borderRadius === "", `${label}: a frame clips the icon: ${cls}`);
        assert.equal(style.backgroundColor, "", `${label}: a ${el.tagName} behind the icon is painted`);
      }
    }
  });

  test("the tab is previewed on a light strip and a dark strip", async () => {
    mount({ ...SAVED_ICON });
    await press(screen.getByRole("button", { name: /Tab and home-screen icon/ }));
    const d = within(await dialog("Tab and home-screen icon"));
    assert.ok(d.getByText("Tab, light browser"));
    assert.ok(d.getByText("Tab, dark browser"));
  });
});

describe("editing in the dialog itself", () => {
  // installRenderDom does not put jsdom's FileReader on the global, and the page
  // reads a picked or dropped file with one.
  const g = globalThis as unknown as Record<string, unknown>;
  const hadReader = g.FileReader;
  before(() => {
    g.FileReader = (window as unknown as Record<string, unknown>).FileReader;
  });
  after(() => {
    g.FileReader = hadReader;
  });
  /** fetch answering the branding source read with `source`, recording what was asked. */
  function stubSource(source: Partial_) {
    const before = globalThis.fetch;
    const beforeTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => new AbortController().signal;
    const asked: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      asked.push(String(url));
      return { ok: true, status: 200, json: async () => source };
    }) as unknown as typeof fetch;
    return {
      asked,
      restore: () => {
        globalThis.fetch = before;
        AbortSignal.timeout = beforeTimeout;
      },
    };
  }

  /** A real File, as a drop or the file chooser hands one over. */
  // jsdom's File, not Node's: jsdom's FileReader only reads its own Blobs.
  const png = (name = "slot.png", type = "image/png") =>
    new (window as unknown as { File: typeof File }).File([new Uint8Array([137, 80, 78, 71])], name, { type });

  /** Drop `file` on `el` the way a browser does: enter, over, drop. */
  async function dropOn(el: Element, file: File) {
    const dataTransfer = { types: ["Files"], files: [file], dropEffect: "none" };
    await act(async () => {
      fireEvent.dragEnter(el, { dataTransfer });
      fireEvent.dragOver(el, { dataTransfer });
      fireEvent.drop(el, { dataTransfer });
      // FileReader and the editor's image load are both a turn or two away.
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  for (const [card, title, field] of [
    [/Empty slot image/, "Empty slot image", "emptyLogo"],
    [/Default avatar/, "Default avatar", "avatar"],
  ] as const) {
    test(`${title}: opening it shows the saved image in the editor, with no second step`, async () => {
      const source = stubSource({ original: LOGO, crop: { scale: 1, x: 0, y: 0 } });
      const restoreCanvas = fakeCanvas();
      try {
        mount({ [field === "emptyLogo" ? "emptySlotLogo" : "defaultAvatar"]: LOGO });
        await press(screen.getByRole("button", { name: card }));
        const d = within(await dialog(title));
        await act(async () => new Promise((r) => setTimeout(r, 30)));
        assert.ok(d.getByRole("slider", { name: "Zoom" }), "the zoom is not in the dialog");
        assert.ok(source.asked.some((u) => u.includes("/api/branding/source")), "the saved original was never read");
      } finally {
        restoreCanvas();
        source.restore();
      }
    });

    test(`${title}: an image dropped on the card opens the dialog with it, and Save writes it`, async () => {
      const restoreCanvas = fakeCanvas();
      try {
        const { writes } = mount();
        await dropOn(screen.getByRole("button", { name: card }), png());
        const d = within(await dialog(title));
        assert.ok(d.getByRole("slider", { name: "Zoom" }), "the dropped image is not in the editor");
        await press(d.getByRole("button", { name: /^Save / }));
        assert.equal(writes.length, 1, `expected one write, got ${writes.length}`);
        assert.ok(writes[0]![field], `the drop did not write ${field}`);
      } finally {
        restoreCanvas();
      }
    });
  }

  test("an image dropped on an open dialog replaces the one in its editor", async () => {
    const restoreCanvas = fakeCanvas();
    try {
      mount();
      await press(screen.getByRole("button", { name: /Empty slot image/ }));
      const el = await dialog("Empty slot image");
      absent(within(el).queryByRole("slider", { name: "Zoom" }), "an editor with nothing to edit");
      await dropOn(el, png());
      assert.ok(within(el).getByRole("slider", { name: "Zoom" }), "the dropped image is not in the editor");
    } finally {
      restoreCanvas();
    }
  });

  test("the logo takes a drop on the stage it is drawn on", async () => {
    const restoreCanvas = fakeCanvas();
    try {
      mount();
      await dropOn(screen.getByRole("button", { name: "Add a logo" }), png("logo.png"));
      assert.ok(within(await dialog("Logo")).getByRole("slider", { name: "Zoom" }));
    } finally {
      restoreCanvas();
    }
  });

  test("a file that is not an image is refused, and nothing opens", async () => {
    const { writes } = mount();
    await dropOn(screen.getByRole("button", { name: /Default avatar/ }), png("notes.txt", "text/plain"));
    absent(screen.queryByRole("dialog"), "a dialog opened for a text file");
    assert.equal(writes.length, 0);
  });
});
