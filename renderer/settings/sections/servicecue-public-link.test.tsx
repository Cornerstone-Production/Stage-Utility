// servicecue-public-link.test.tsx — the "Public link" card, in the three states the
// approved mockup draws, and the controls that move between them.
//
// Driven through the real component with a stubbed fetch that keeps the server's
// own state: a write changes what the next read answers, as the real routes do. The
// words are the mockup's, asserted as written, because they are the spec.
//
// What jsdom cannot see — that the card matches the mockup's spacing, type and
// colour in light and dark — is not unit-tested here; it was driven in a browser.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: node:assert inspects `actual`
// to build its failure message, and inspecting a live jsdom element does not finish
// in any useful time. Every query is coerced to a boolean or a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const React = await import("react");
const { PublicLinkCard, ProblemText, sentAgo } = await import("./servicecue-public-link.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { RouterContextProvider } = await import("@tanstack/react-router");
const { routerAt } = await import("../../test-fixtures/router.js");
const { FORM_MASK, MASK } = await import("../../../main/services/mask.js");

after(() => unmountAndTeardown(cleanup, teardown));
// Whatever the last answer set going (react-query tells its observers a tick later) lands inside an act, then the card goes.
afterEach(async () => {
  await settle();
  cleanup();
});

const ORIGIN = "https://servicecue.example-account.example";
const NOW = 1_800_000_000_000;

type Dto = {
  enabled: boolean;
  url: string;
  token: string;
  status: {
    enabled: boolean;
    state: "off" | "publishing" | "problem";
    lastSentAt: number | null;
    lastError: { kind: string; status?: number; message: string } | null;
    sourceProblem: { message: string } | null;
    counts: { types: number; plans: number; layouts: number };
    now: number;
  };
  dropped?: { ok: true } | { ok: false; message: string };
};

const off = (): Dto => ({
  enabled: false,
  url: "",
  token: "",
  status: { enabled: false, state: "off", lastSentAt: null, lastError: null, sourceProblem: null, counts: { types: 0, plans: 0, layouts: 0 }, now: NOW },
});

const publishing = (over: Partial<Dto["status"]> = {}): Dto => ({
  enabled: true,
  url: ORIGIN,
  token: MASK,
  status: {
    enabled: true,
    state: "publishing",
    lastSentAt: NOW - 8_000,
    lastError: null,
    sourceProblem: null,
    counts: { types: 4, plans: 11, layouts: 4 },
    now: NOW,
    ...over,
  },
});

const AUTH_PROBLEM = { kind: "auth", status: 401, message: "The page answered 401: it did not accept the publishing token." };
const problem = (): Dto =>
  publishing({ state: "problem", lastSentAt: NOW - 6 * 60_000, lastError: AUTH_PROBLEM });

interface Server {
  dto: Dto;
  /** Every POST, as [path, body]. */
  posts: [string, Record<string, unknown>][];
  /** What the connection test answers. */
  test: unknown;
  /** What a settings write answers, from the body it was sent. */
  save: (body: Record<string, unknown>) => Dto;
  failRead: boolean;
  /** How many reads of the settings have been made, and how long each takes to answer. */
  reads: number;
  slowRead: number;
  /** When set, a settings write is refused with this message, as the route refuses a bad token or address. */
  refuseSave: string | null;
}

let server: Server;
let restore: () => void;
let logs: { tag: string; message: string }[];

beforeEach(() => {
  server = {
    dto: off(),
    posts: [],
    test: { ok: true, message: "Reached the page: it holds 0 documents and 0 images." },
    save: (body) => {
      const token = typeof body.token === "string" ? MASK : server.dto.token;
      const url = typeof body.url === "string" ? body.url : server.dto.url;
      const enabled = typeof body.enabled === "boolean" ? body.enabled : server.dto.enabled;
      return enabled ? { ...publishing(), url, token } : { ...off(), url, token };
    },
    failRead: false,
    reads: 0,
    slowRead: 0,
    refuseSave: null,
  };
  const f = stubFetchWithLog((url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      if (url === "/api/servicecue/publish/test") {
        server.posts.push(["test", body]);
        return ok(server.test);
      }
      if (url === "/api/servicecue/publish") {
        server.posts.push(["save", body]);
        if (server.refuseSave) return reply(400, { error: server.refuseSave });
        server.dto = server.save(body);
        return ok(server.dto);
      }
    }
    if (url === "/api/servicecue/publish") {
      if (server.failRead) throw new TypeError("fetch failed");
      server.reads += 1;
      // What the server held when the read was made, delivered later: a read in flight across a write.
      const held = server.dto;
      if (server.slowRead > 0) return new Promise((resolve) => setTimeout(() => resolve(ok(held)), server.slowRead));
      return ok(held);
    }
    if (url === "/api/update/status") return ok({ branch: "beta" });
    return ok({});
  });
  restore = f.restore;
  logs = f.logs;
});
afterEach(() => restore());

const NAMES = {
  typeNames: ["Weekend", "Salt", "Youth", "Special Events"],
  layoutNames: ["Audio", "Video", "Lighting"],
};

const INTEGRATIONS = "/settings/integrations";
let router: ReturnType<typeof routerAt>;

/** The card inside what the app puts around it: a query client that does not retry, the tooltips, and a router for its link. */
function inApp(card: React.ReactElement): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  router = routerAt("/servicecue/manage", "/servicecue/manage", INTEGRATIONS);
  return React.createElement(
    RouterContextProvider,
    { router, children: React.createElement(QueryClientProvider, { client }, React.createElement(TooltipProvider, null, card)) } as never,
  );
}

async function mount(over: Partial<React.ComponentProps<typeof PublicLinkCard>> = {}): Promise<void> {
  render(inApp(React.createElement(PublicLinkCard, { ...NAMES, ...over })));
  await eventually(() => assert.ok(screen.getByRole("switch", { name: "Publish ServiceCue to the web" })));
  await settle();
}

const card = () => screen.getByRole("region", { name: "Public link" });
const sw = () => screen.getByRole("switch", { name: "Publish ServiceCue to the web" }) as HTMLButtonElement;
/** Which of the three states the card is drawn in. */
const stateOf = () => card().getAttribute("data-state");
/** The card's words in reading order, the way a person would read them: one space
 *  between the pieces of markup, none before punctuation. */
function text(): string {
  const walker = document.createTreeWalker(card(), NodeFilter.SHOW_TEXT);
  const words: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) words.push(n.textContent ?? "");
  return words.join(" ").replace(/\s+/g, " ").replace(/ ([:.,;])/g, "$1").trim();
}
/** A field by its label, which also holds its hint: "Page address" + "Your Cloudflare Worker". */
const input = (label: string) => screen.getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;

/** What the server says to a token under 32 characters (servicecue-publish-routes.ts). */
const SHORT_TOKEN = "The publishing token has to be at least 32 characters: the page treats a shorter one as not set.";

const AUTH_TEXT =
  "Cloudflare answered 401: the publishing token doesn't match the one set on the page. Enter it again below. Until then the public page keeps showing the rundown it last got, with a note saying how old it is.";

/** The words of the first mockup paragraph, as written there. */
const LEAD =
  "Anyone with the link sees ServiceCue as it is here: every service type on the landing page, every layout, the live item and countdown. No login. Editing stays in the building.";

describe("Not set up", () => {
  test("is the mockup: Off, the setup fields, and a switch that waits for both", async () => {
    await mount();
    assert.ok(text().startsWith("Public link Off"), text());
    assert.equal(stateOf(), "off");
    assert.ok(text().includes(LEAD));
    assert.equal(sw().getAttribute("aria-checked"), "false");
    assert.equal(sw().disabled, true);

    assert.ok(screen.getByText("Your Cloudflare Worker"));
    assert.ok(screen.getByText("The same one set on the page"));
    assert.equal(input("Page address").getAttribute("placeholder"), "https://servicecue.your-account.workers.dev");
    assert.equal(input("Publishing token").getAttribute("placeholder"), "Paste the token");
    assert.equal(input("Publishing token").type, "password");
    assert.ok(text().includes("The switch turns on once both are filled in. Setting up the page takes one command; the guide walks through it."));

    // None of what a card that is publishing shows.
    for (const absent of ["Copy", "QR code", "What the public sees", "Cloudflare connection", "Last sent"]) {
      assert.equal(text().includes(absent), false, `"${absent}" is shown before anything is set up`);
    }
    assert.equal(alerts(), "");
  });

  test("links to the setup guide on the branch this build came from", async () => {
    await mount();
    const a = await eventually(() => {
      const el = screen.getByRole("link", { name: "Setup guide" }) as HTMLAnchorElement;
      assert.equal(el.href, "https://github.com/Cornerstone-Production/Stage-Utility/blob/beta/docs/ops/servicecue-on-the-web.md");
      return el;
    });
    assert.equal(a.target, "_blank");
    assert.match(a.rel, /noreferrer/);
  });

  test("turns on once both fields are filled, and not before", async () => {
    await mount();
    fireEvent.change(input("Page address"), { target: { value: ORIGIN } });
    assert.equal(sw().disabled, true, "the switch turned on with an address and no token");
    fireEvent.change(input("Publishing token"), { target: { value: "  " } });
    assert.equal(sw().disabled, true, "a token of spaces counts as a token");
    fireEvent.change(input("Publishing token"), { target: { value: "tok-typed" } });
    assert.equal(sw().disabled, false);
    fireEvent.change(input("Page address"), { target: { value: "" } });
    assert.equal(sw().disabled, true, "the switch stayed on with the address cleared");
  });

  test("tests the page first, then saves and publishes: the switch is the connection test", async () => {
    await mount();
    fireEvent.change(input("Page address"), { target: { value: ORIGIN } });
    fireEvent.change(input("Publishing token"), { target: { value: "tok-typed" } });
    fireEvent.click(sw());
    await eventually(() => assert.ok(text().startsWith("Public link Publishing"), text()));
    assert.deepEqual(server.posts, [
      ["test", { url: ORIGIN, token: "tok-typed" }],
      ["save", { url: ORIGIN, token: "tok-typed", enabled: true }],
    ]);
    // Typed over, then read back: the token is not on the page, only that one is stored.
    assert.equal(sw().getAttribute("aria-checked"), "true");
    assert.equal(text().includes("tok-typed"), false);
  });

  // [when, what the connection test answers, the token typed, what the card says]
  const REFUSED: [string, Record<string, unknown>, string, RegExp][] = [
    ["the page does not accept the token", { ok: false, kind: "auth", status: 401, message: "m" }, "tok-wrong", /^Cloudflare answered 401: the publishing token doesn't match/],
    // The page treats a token under 32 characters as none and answers 503 to everything, so the server refuses
    // one at the connection test and the card says what it said.
    ["the token is one the page would call not set", { ok: false, kind: "config", message: SHORT_TOKEN }, "too-short", new RegExp(`^${SHORT_TOKEN}$`)],
    ["the page has no token of its own", { ok: false, kind: "no-token", status: 503, message: "m" }, "tok-unset-on-page", /^The page answered 503: it has no token set, or one under 32 characters/],
    ["nobody answers at the address", { ok: false, kind: "unreachable", message: "getaddrinfo ENOTFOUND nowhere.example" }, "tok", /^This server couldn't reach the page: getaddrinfo ENOTFOUND nowhere\.example\. Check the address below/],
  ];
  for (const [when, answer, token, says] of REFUSED) {
    test(`stays off, saves nothing and says why, when ${when}`, async () => {
      server.test = answer;
      await mount();
      fireEvent.change(input("Page address"), { target: { value: ORIGIN } });
      fireEvent.change(input("Publishing token"), { target: { value: token } });
      fireEvent.click(sw());
      await eventually(() => assert.match(alerts(), says));
      assert.deepEqual(server.posts.map(([p]) => p), ["test"], "an address that failed its test was saved and switched on");
      assert.ok(text().startsWith("Public link Off"), text());
      assert.equal(input("Page address").value, ORIGIN, "what was typed is kept for another try");
    });
  }

  test("shows a write that failed instead of letting the switch sit where it was", async () => {
    await mount();
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === "/api/servicecue/publish" && init?.method === "POST") throw new TypeError("fetch failed");
      return real(input as string, init);
    }) as typeof fetch;
    try {
      fireEvent.change(screen.getByLabelText(/^Page address/), { target: { value: ORIGIN } });
      fireEvent.change(screen.getByLabelText(/^Publishing token/), { target: { value: "tok" } });
      fireEvent.click(sw());
      await eventually(() => assert.ok(alerts().length > 0, "nothing says the switch did not take"));
      assert.ok(text().startsWith("Public link Off"));
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("Publishing", () => {
  beforeEach(() => {
    server.dto = publishing();
  });

  test("is the mockup: the link, what was sent, and what the public sees", async () => {
    await mount();
    assert.ok(text().startsWith("Public link Publishing"), text());
    assert.equal(stateOf(), "publishing");
    assert.equal(sw().getAttribute("aria-checked"), "true");
    assert.equal(sw().disabled, false);
    assert.ok(text().includes(LEAD));
    assert.ok(text().includes(`${ORIGIN}/servicecue`));
    assert.ok(text().includes("Last sent 8 s ago"), text());
    assert.ok(text().includes("4 service types"));
    assert.ok(text().includes("11 plans in the next 60 days"));
    assert.ok(text().includes("4 layouts"));
    assert.ok(text().includes("What the public sees"));
    assert.ok(text().includes('Weekend, Salt, Youth, Special Events · follows "Shown on the landing page" above'), text());
    assert.ok(text().includes("Audio, Video, Lighting, All columns · every layout below"));
    assert.ok(text().includes("The live item, countdown and clock · as they change"));
    assert.equal(alerts(), "");
    // Not the setup fields: they are for a card that is not set up.
    assert.ok(screen.queryByLabelText(/^Page address/) === null, "the setup fields are drawn on a card that is already publishing");
  });

  test("says one service type, one plan and one layout in the singular", async () => {
    server.dto = publishing({ counts: { types: 1, plans: 1, layouts: 1 } });
    await mount();
    assert.ok(text().includes("1 service type"));
    assert.equal(text().includes("1 service types"), false);
    assert.ok(text().includes("1 plan in the next 60 days"));
    assert.ok(text().includes("1 layout"));
    assert.equal(text().includes("1 layouts"), false);
  });

  test("says the first copy is on its way before anything has been sent", async () => {
    server.dto = publishing({ lastSentAt: null, counts: { types: 0, plans: 0, layouts: 0 } });
    await mount();
    assert.ok(text().includes("Sending the first copy"));
    assert.equal(text().includes("Last sent"), false);
  });

  test("lists the landing page's types and the layouts as the page around it says them", async () => {
    await mount({ typeNames: ["Only One"], layoutNames: [] });
    assert.ok(text().includes('Only One · follows "Shown on the landing page" above'));
    assert.ok(text().includes("All columns · every layout below"));
    cleanup();
    await mount({ typeNames: [], layoutNames: ["A"] });
    assert.ok(text().includes("No service types yet"));
  });

  test("counts the time since the last send on its own, off the server's stamps", async () => {
    await mount();
    assert.ok(text().includes("Last sent 8 s ago"));
    // A second on, with no new answer from the server: 9 s. The browser's own clock
    // is never compared with the server's, only with itself.
    await eventually(() => assert.ok(text().includes("Last sent 9 s ago"), text()), 4000);
  });

  test("copies the link, and says so", async () => {
    const copied: string[] = [];
    const nav = globalThis.navigator as unknown as { clipboard?: unknown };
    const hadClipboard = Object.getOwnPropertyDescriptor(nav, "clipboard");
    Object.defineProperty(nav, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    const win = globalThis.window as unknown as { isSecureContext: boolean };
    const hadSecure = win.isSecureContext;
    Object.defineProperty(win, "isSecureContext", { configurable: true, value: true });
    try {
      await mount();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      });
      await eventually(() => assert.ok(screen.getByRole("button", { name: "Copied" })));
      assert.deepEqual(copied, [`${ORIGIN}/servicecue`]);
    } finally {
      if (hadClipboard) Object.defineProperty(nav, "clipboard", hadClipboard);
      else delete nav.clipboard;
      Object.defineProperty(win, "isSecureContext", { configurable: true, value: hadSecure });
    }
  });

  describe("the QR code", () => {
    // jsdom has no canvas. What colour the code is drawn in is held in qr-hint.test.tsx.
    const proto = (window as unknown as { HTMLCanvasElement: { prototype: { getContext: unknown } } }).HTMLCanvasElement.prototype;
    const real = proto.getContext;
    beforeEach(() => {
      proto.getContext = () => ({
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData() {},
        clearRect() {},
        fillRect() {},
      });
    });
    afterEach(() => {
      proto.getContext = real;
    });

    test("opens on its own button, with the mockup's words, and closes again", async () => {
      await mount();
      const button = screen.getByRole("button", { name: "QR code" });
      assert.equal(button.getAttribute("aria-expanded"), "false");
      assert.equal(text().includes("Print it for the green room"), false);
      fireEvent.click(button);
      assert.equal(button.getAttribute("aria-expanded"), "true");
      assert.ok(
        text().includes(
          "Print it for the green room or the band area. Volunteers scan once and keep the bookmark. The links work exactly like they do here: /servicecue/weekend/audio, ?plan=, text size.",
        ),
        text(),
      );
      fireEvent.click(button);
      assert.equal(text().includes("Print it for the green room"), false);
    });
  });

  test("keeps the connection fields behind 'Cloudflare connection', with the token masked", async () => {
    await mount();
    const toggle = screen.getByRole("button", { name: "Cloudflare connection" });
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.ok(screen.queryByLabelText(/^Page address/) === null, "the connection fields are open before they were asked for");
    fireEvent.click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(input("Page address").value, ORIGIN);
    assert.equal(input("Publishing token").type, "password");
    assert.equal(input("Publishing token").value, FORM_MASK);
  });

  test("saves a token typed over the mask, to the same address, when the field is left", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
    fireEvent.change(input("Publishing token"), { target: { value: "tok-new" } });
    fireEvent.blur(input("Publishing token"));
    await eventually(() => assert.equal(server.posts.length, 1));
    await settle();
    assert.deepEqual(server.posts[0], ["save", { token: "tok-new" }], "the address was sent with a token for the same address");
    await eventually(() => assert.equal(input("Publishing token").value, FORM_MASK));
  });

  test("says so when the server refuses a token typed in the connection fields, and stays publishing", async () => {
    server.refuseSave = SHORT_TOKEN;
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
    fireEvent.change(input("Publishing token"), { target: { value: "too-short" } });
    fireEvent.blur(input("Publishing token"));
    await eventually(() => assert.equal(alerts(), SHORT_TOKEN));
    assert.equal(stateOf(), "publishing", "a refused token took the card out of Publishing");
    assert.equal(server.dto.token, MASK, "the stored token was touched by a write the server refused");
  });

  test("does not save the mask back as a token", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
    fireEvent.focus(input("Publishing token"));
    fireEvent.blur(input("Publishing token"));
    fireEvent.blur(input("Page address"));
    await settle();
    assert.deepEqual(server.posts, [], "nothing was changed and something was saved");
  });

  test("asks for the token again before it moves to a new address, instead of sending half of it", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
    fireEvent.change(input("Page address"), { target: { value: "https://another.example-account.example" } });
    fireEvent.blur(input("Page address"));
    await settle();
    assert.deepEqual(server.posts, [], "a new address was sent with the token it was not saved for");
    assert.ok(text().includes("A different address needs its token: paste it again."));
    fireEvent.change(input("Publishing token"), { target: { value: "tok-for-it" } });
    fireEvent.blur(input("Publishing token"));
    await eventually(() => assert.equal(server.posts.length, 1));
    await settle();
    assert.deepEqual(server.posts[0], ["save", { url: "https://another.example-account.example", token: "tok-for-it" }]);
  });

  test("switches off with the switch, and goes back to the setup fields with what is stored in them", async () => {
    await mount();
    fireEvent.click(sw());
    await eventually(() => assert.ok(text().startsWith("Public link Off"), text()));
    assert.deepEqual(server.posts, [["save", { enabled: false }]]);
    assert.equal(input("Page address").value, ORIGIN);
    assert.equal(input("Publishing token").value, FORM_MASK);
    assert.equal(sw().disabled, false, "both fields are stored, so it can be switched straight back on");
    assert.ok(screen.queryByText(/may still show the last rundown/) === null, "a note about the page's copy with nothing to say");
  });

  test("tells the operator when the page could not be asked to forget its copy", async () => {
    server.save = (body) => ({ ...off(), url: ORIGIN, token: MASK, dropped: { ok: false, message: "No answer from the page within 10 seconds." }, ...(body ? {} : {}) });
    await mount();
    fireEvent.click(sw());
    await eventually(() => assert.match(alerts(), /Publishing is off, but the page didn't answer/));
    assert.match(alerts(), /may still show the last rundown it was sent\. No answer from the page within 10 seconds\./);
  });

  test("says so when the old page could not be asked to forget its copy after the address changed", async () => {
    const MOVED = "https://another.example-account.example";
    server.save = (body) => ({ ...publishing(), url: String(body.url ?? ORIGIN), token: MASK, dropped: { ok: false, message: "No answer from the page within 10 seconds." } });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
    fireEvent.change(input("Page address"), { target: { value: MOVED } });
    fireEvent.change(input("Publishing token"), { target: { value: "tok-for-it" } });
    fireEvent.blur(input("Publishing token"));
    await eventually(() => assert.match(alerts(), /The address changed, but the page didn't answer/));
    assert.equal(stateOf(), "publishing", "the card left Publishing for an address that was saved");
  });

  test("drops a read that was in flight when a write began, instead of putting back what the write changed", async () => {
    server.slowRead = 150;
    await mount({ pollMs: 30 });
    // A poll is on its way, carrying what the server holds now: Publishing.
    await eventually(() => assert.ok(server.reads >= 2, `reads: ${server.reads}`));
    fireEvent.click(sw());
    await eventually(() => assert.ok(text().startsWith("Public link Off"), text()));
    // Watch for the stale answer landing: it would put Publishing back until the next poll corrects it.
    const seen: string[] = [];
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      seen.push(stateOf() ?? "");
    }
    assert.equal(seen.includes("publishing"), false, `the card went back to Publishing: ${seen.join(",")}`);
  });

  test("follows the server while the page is open", async () => {
    await mount({ pollMs: 40 });
    assert.ok(text().startsWith("Public link Publishing"));
    server.dto = problem();
    await eventually(() => assert.ok(text().startsWith("Public link Not reaching the page"), text()), 3000);
    server.dto = publishing();
    await eventually(() => assert.ok(text().startsWith("Public link Publishing"), text()), 3000);
  });
});

describe("Problem", () => {
  beforeEach(() => {
    server.dto = problem();
  });

  test("is the mockup: Not reaching the page, how old the last send is, and why", async () => {
    await mount();
    assert.ok(text().startsWith("Public link Not reaching the page"), text());
    assert.equal(stateOf(), "problem");
    assert.ok(text().includes("Last sent 6 min ago"), text());
    assert.equal(alerts(), AUTH_TEXT);
    // Switched on still, and still the card's own link and facts.
    assert.equal(sw().getAttribute("aria-checked"), "true");
    assert.ok(text().includes(`${ORIGIN}/servicecue`));
    assert.ok(text().includes("What the public sees"));
  });

  test("has the connection fields open already when the fix is in them, so it does not say 'below' over nothing", async () => {
    await mount();
    assert.equal(screen.getByRole("button", { name: "Cloudflare connection" }).getAttribute("aria-expanded"), "true");
    assert.ok(input("Publishing token"));
    // And the operator can still shut them.
    fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
    assert.ok(screen.queryByLabelText(/^Page address/) === null);
  });

  // [kind, whether the fix is in the connection fields]
  const OPENS: [string, boolean][] = [
    ["auth", true],
    ["rejected", true],
    ["redirect", true],
    ["unreachable", true],
    ["config", true],
    ["blocked", false],
    ["limited", false],
    ["no-token", false],
    ["server", false],
    ["protocol", false],
  ];
  for (const [kind, opens] of OPENS) {
    test(`${kind}: the connection fields are ${opens ? "open" : "left shut"}`, async () => {
      server.dto = publishing({ state: "problem", lastError: { kind, status: 500, message: "m" } });
      await mount();
      assert.equal(screen.getByRole("button", { name: "Cloudflare connection" }).getAttribute("aria-expanded"), String(opens));
    });
  }

  test("takes the token again where it says to, and recovers", async () => {
    await mount();
    fireEvent.change(input("Publishing token"), { target: { value: "tok-fixed" } });
    fireEvent.blur(input("Publishing token"));
    await eventually(() => assert.equal(server.posts.length, 1));
    await settle();
    await eventually(() => assert.ok(text().startsWith("Public link Publishing"), text()));
    assert.equal(alerts(), "");
  });

  test("can still be switched off", async () => {
    await mount();
    fireEvent.click(sw());
    await eventually(() => assert.ok(text().startsWith("Public link Off"), text()));
  });
});

describe("Planning Center can't be read", () => {
  const PCO = "PCO auth failed — check App ID/Secret in Integrations settings";
  const PCO_TEXT = `Publishing, but Planning Center can't be read: ${PCO}. The public page keeps what it last received. Open Integrations`;

  test("is the mockup: Can't read Planning Center, why, and the way to Integrations", async () => {
    server.dto = publishing({ sourceProblem: { message: PCO }, counts: { types: 0, plans: 0, layouts: 6 } });
    await mount();
    assert.ok(text().startsWith("Public link Can't read Planning Center"), text());
    assert.equal(stateOf(), "source");
    assert.equal(alerts(), PCO_TEXT);
    // The page is reached: still switched on, still the link and what was sent.
    assert.equal(sw().getAttribute("aria-checked"), "true");
    assert.ok(text().includes("0 service types"), text());
    assert.ok(text().includes("6 layouts"), text());

    const link = screen.getByRole("link", { name: "Open Integrations" });
    assert.equal(link.getAttribute("href"), INTEGRATIONS);
    fireEvent.click(link);
    await eventually(() => assert.equal(router.state.location.pathname, INTEGRATIONS));
  });

  test("with the page not reached too: that keeps the pill, and both notes show, the page's first", async () => {
    server.dto = publishing({ state: "problem", lastSentAt: NOW - 6 * 60_000, lastError: AUTH_PROBLEM, sourceProblem: { message: PCO } });
    await mount();
    assert.ok(text().startsWith("Public link Not reaching the page"), text());
    assert.equal(alerts(), `${AUTH_TEXT} | ${PCO_TEXT}`);
  });

  test("goes when Planning Center can be read again", async () => {
    server.dto = publishing({ sourceProblem: { message: PCO } });
    await mount({ pollMs: 50 });
    server.dto = publishing();
    await eventually(() => assert.ok(text().startsWith("Public link Publishing"), text()));
    assert.equal(alerts(), "");
  });
});

describe("a read that fails", () => {
  test("says so, instead of drawing a card that is off", async () => {
    server.failRead = true;
    render(inApp(React.createElement(PublicLinkCard, NAMES)));
    await eventually(() => assert.match(alerts(), /Couldn't load the public link settings\./));
    assert.ok(screen.queryByRole("switch") === null, "a switch was drawn for settings that were never read");
    assert.ok(logs.some((l) => l.tag === "servicecue" && /public link/.test(l.message)), "the failure did not reach /log");
    // And it comes back by itself when the server does.
    server.failRead = false;
    cleanup();
    await mount();
    assert.equal(alerts(), "");
  });
});

describe("the problem text", () => {
  /** The text of one problem, rendered. */
  function say(p: { kind: string; status?: number; message: string }): string {
    const { container } = render(React.createElement("div", null, React.createElement(ProblemText, { problem: p as never })));
    const t = (container.textContent ?? "").replace(/\s+/g, " ").trim();
    cleanup();
    return t;
  }

  test("says each cause in its own words, and the token one as the mockup does", () => {
    assert.equal(say(AUTH_PROBLEM), AUTH_TEXT);
    assert.equal(
      say({ kind: "blocked", status: 403, message: "m" }),
      "Cloudflare answered 403: a rule on the account blocked this server. Check the firewall and access rules for the page's address, then save the connection again. Until then the public page keeps showing the rundown it last got, with a note saying how old it is.",
    );
    assert.equal(
      say({ kind: "limited", status: 429, message: "m" }),
      "Cloudflare answered 429: the page is being asked too often. This server keeps trying, a little less often each time. Until then the public page keeps showing the rundown it last got, with a note saying how old it is.",
    );
    assert.equal(
      say({ kind: "server", status: 502, message: "m" }),
      "Cloudflare answered 502: the page had a problem of its own. This server keeps trying, a little less often each time. Until then the public page keeps showing the rundown it last got, with a note saying how old it is.",
    );
    assert.equal(
      say({ kind: "rejected", status: 404, message: "m" }),
      "The address answered 404, which isn't what the ServiceCue page says. Check the address below. Until then the public page keeps showing the rundown it last got, with a note saying how old it is.",
    );
    assert.equal(
      say({ kind: "redirect", message: "m" }),
      "The address answered with a redirect, and a redirect is never followed. Use the address the page was deployed at, below. Until then the public page keeps showing the rundown it last got, with a note saying how old it is.",
    );
    assert.equal(
      say({ kind: "unreachable", message: "getaddrinfo ENOTFOUND x.example" }),
      "This server couldn't reach the page: getaddrinfo ENOTFOUND x.example. Check the address below, and that this server can get to the internet. Until then the public page keeps showing the rundown it last got, with a note saying how old it is.",
    );
    assert.equal(say({ kind: "config", message: "No publishing token is set." }), "No publishing token is set.");
    assert.equal(say({ kind: "protocol", message: "The page speaks protocol 2 and this server speaks 1. Update whichever is older." }), "The page speaks protocol 2 and this server speaks 1. Update whichever is older.");
  });

  test("says a 503 to the first request is the page having no token set, or one under 32 characters", () => {
    // The page answers 503 to every request, a correct token included, while its own token is missing
    // or under 32 characters. That is the operator's to fix, and "a problem of its own" would not say so.
    assert.equal(
      say({ kind: "no-token", status: 503, message: "m" }),
      "The page answered 503: it has no token set, or one under 32 characters. Set it on the page, as the setup guide shows. This server keeps trying, a little less often each time. Until then the public page keeps showing the rundown it last got, with a note saying how old it is.",
    );
  });

  test("does not add a second full stop to an unreachable message that has one", () => {
    assert.match(say({ kind: "unreachable", message: "connect ECONNREFUSED." }), /ECONNREFUSED\. Check the address below/);
  });

  test("names the status the page answered", () => {
    assert.match(say({ kind: "auth", status: 401, message: "m" }), /^Cloudflare answered 401:/);
  });
});

describe("how long ago", () => {
  test("is seconds, then minutes, then hours", () => {
    assert.equal(sentAgo(0), "0 s");
    assert.equal(sentAgo(8_400), "8 s");
    assert.equal(sentAgo(59_000), "59 s");
    assert.equal(sentAgo(60_000), "1 min");
    assert.equal(sentAgo(6 * 60_000), "6 min");
    assert.equal(sentAgo(59 * 60_000), "59 min");
    assert.equal(sentAgo(2 * 3_600_000), "2 h");
    assert.equal(sentAgo(-5_000), "0 s", "a server stamp ahead of the clock is never negative");
  });
});
