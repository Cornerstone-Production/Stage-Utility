// servicecue-deploy-section.test.tsx — "Keep the page up to date", inside the Public link card.
//
// Driven through the real card with a stubbed fetch that keeps the server's own state: a write
// changes what the next read answers, as the routes do. The words are the approved mockup's for the
// states it draws, and the rest are asserted as written because the card's wording is the spec.
//
// What jsdom cannot see — the dot's colour, the section's spacing, the layout at 390 px wide, the
// dialog over the page — is not unit-tested here; it was driven in a browser against a real server.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (node:assert inspects `actual` to build its
// message, and inspecting a live jsdom element does not finish in any useful time).

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { reply, stubFetchWithLog, ok } from "../../test-fixtures/fetch-log.js";
import type { DeployStatus, PublishSettingsDTO } from "../../../main/types/servicecue-publish-status.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const React = await import("react");
const { PublicLinkCard } = await import("./servicecue-public-link.js");
const { setDisplayHourCycle } = await import("../../lib/clock-format.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { RouterContextProvider } = await import("@tanstack/react-router");
const { routerAt } = await import("../../test-fixtures/router.js");
const { FORM_MASK, MASK } = await import("../../../main/services/mask.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(async () => {
  await settle();
  cleanup();
});

const ORIGIN = "https://servicecue.example-account.example";
const NOW = 1_800_000_000_000;
/** 21 Oct 2026, 13:14 UTC: 8:14 AM in Chicago. */
const DEPLOYED_AT = Date.UTC(2026, 9, 21, 13, 14);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
/** What a person would paste: never in anything the server sends back, so never in anything the card draws. */
const TOKEN = "cf-token-canary-0123456789abcdefABCDEF_-0123";

const deployOf = (over: Partial<DeployStatus> = {}): DeployStatus => ({
  state: "current",
  accountId: ACCOUNT,
  token: MASK,
  bundle: { build: "3f2a91c", version: "1.28.0" },
  noBundle: null,
  runningVersion: "1.28.0",
  page: { build: "3f2a91c", version: "1.28.0", at: DEPLOYED_AT },
  files: { uploaded: 2, held: 21 },
  waitingFor: null,
  error: null,
  now: NOW,
  ...over,
});

const NO_TOKEN = (): DeployStatus => deployOf({ state: "off", accountId: "", token: "", page: null, files: null });

const dtoOf = (deploy: DeployStatus): PublishSettingsDTO => ({
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
  },
  deploy,
});

interface Server {
  dto: PublishSettingsDTO;
  /** Every POST, as [path, body]. */
  posts: [string, Record<string, unknown>][];
  /** What the next "Update the page now" answers, in order; the last is kept. */
  deployAnswers: { status: number; json: unknown }[];
  /** What a credentials write answers: the new status, from the body. */
  credentials: (body: Record<string, unknown>) => DeployStatus;
}

let server: Server;
let restore: () => void;

beforeEach(() => {
  // The mockup writes "8:14 AM"; the card follows the operator's own clock format, so the test says which.
  setDisplayHourCycle("12h");
  server = {
    dto: dtoOf(deployOf()),
    posts: [],
    deployAnswers: [],
    credentials: (body) => {
      if (body.token === "") return NO_TOKEN();
      return deployOf({ accountId: typeof body.accountId === "string" ? body.accountId : ACCOUNT });
    },
  };
  const f = stubFetchWithLog((url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      if (url === "/api/servicecue/publish/deploy-credentials") {
        server.posts.push(["credentials", body]);
        server.dto = { ...server.dto, deploy: server.credentials(body) };
        return ok(server.dto);
      }
      if (url === "/api/servicecue/publish/deploy") {
        server.posts.push(["deploy", body]);
        const answer = server.deployAnswers.length > 1 ? server.deployAnswers.shift()! : (server.deployAnswers[0] ?? { status: 200, json: server.dto });
        return reply(answer.status, answer.json);
      }
    }
    if (url === "/api/servicecue/publish") return ok(server.dto);
    if (url === "/api/update/status") return ok({ branch: "beta" });
    return ok({});
  });
  restore = f.restore;
});
afterEach(() => {
  restore();
  setDisplayHourCycle(null);
});

const NAMES = { typeNames: ["Weekend"], layoutNames: ["Audio"] };

async function mount(over: Partial<React.ComponentProps<typeof PublicLinkCard>> = {}): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const router = routerAt("/servicecue/manage", "/servicecue/manage", "/settings/integrations");
  render(
    React.createElement(RouterContextProvider, {
      router,
      children: React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(TooltipProvider, null, React.createElement(PublicLinkCard, { ...NAMES, timeZone: "America/Chicago", ...over }), React.createElement(ConfirmHost)),
      ),
    } as never),
  );
  await eventually(() => assert.ok(screen.getByRole("switch", { name: "Publish ServiceCue to the web" })));
  await settle();
  // Behind "Cloudflare connection", as the card keeps it.
  if (!autoOpened()) {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
      await settle();
    });
  }
}

/** Is "Cloudflare connection" open without anyone having opened it? */
const autoOpened = () => screen.getByRole("button", { name: "Cloudflare connection" }).getAttribute("aria-expanded") === "true";

/** The status line's words, as a person reads them. */
const status = () => (screen.getByRole("status").textContent ?? "").replace(/\s+/g, " ").trim();
const section = () => screen.getByRole("heading", { name: "Keep the page up to date" }).parentElement!.parentElement!;
const sectionText = () => (section().textContent ?? "").replace(/\s+/g, " ").trim();
const updateButton = () => screen.queryByRole("button", { name: "Update the page now" }) as HTMLButtonElement | null;
const acctField = () => screen.getByLabelText("Cloudflare account ID") as HTMLInputElement;
const tokField = () => screen.getByLabelText("API token") as HTMLInputElement;
const type = (el: HTMLInputElement, value: string) => fireEvent.change(el, { target: { value } });
const leave = async (el: HTMLInputElement) => {
  await act(async () => {
    fireEvent.blur(el);
    await settle();
  });
};

async function with_(deploy: DeployStatus, over: Partial<React.ComponentProps<typeof PublicLinkCard>> = {}) {
  server.dto = dtoOf(deploy);
  await mount(over);
}

describe("the section", () => {
  test("is the mockup's: its title, description, fields, help and the link to the guide", async () => {
    await with_(deployOf());
    assert.ok(sectionText().includes("Keep the page up to date"));
    assert.ok(
      sectionText().includes(
        "This server is linked to the page, so after each update it puts its own copy of the page on Cloudflare, and the public page always matches what is here. Never during a live service. Clear the API token to stop.",
      ),
    );
    assert.ok(sectionText().includes("A token with the Workers Editor role on the servicecue Worker only. It cannot touch DNS, domains or anything else."));
    const guide = screen.getByRole("link", { name: "How to make one" }) as HTMLAnchorElement;
    assert.match(guide.href, /\/docs\/ops\/servicecue-on-the-web\.md#keeping-it-up-to-date$/);
    assert.equal(acctField().value, ACCOUNT);
    assert.equal(tokField().placeholder, "Paste a token to turn updating on");
  });

  test("has no switch of its own: the card's one switch is the only one", async () => {
    await with_(deployOf());
    assert.equal(screen.getAllByRole("switch").length, 1);
  });
});

describe("the status line, by state", () => {
  test("off: the no-token sentence, and no button", async () => {
    await with_(NO_TOKEN());
    assert.equal(
      status(),
      "Not updating: with no API token, the page stays on the build it has until someone runs npm run servicecue:deploy from a computer.",
    );
    assert.equal(updateButton() === null, true);
    assert.equal(tokField().value, "");
  });

  test("current: build, version and the time it went live, in the app's zone", async () => {
    await with_(deployOf());
    assert.equal(status(), "Up to date: build 3f2a91c (1.28.0), deployed 21 Oct, 8:14 AM");
    assert.equal(updateButton()?.disabled, false);
  });

  test("updating: how many files go up and how many Cloudflare holds, and the button is disabled", async () => {
    await with_(deployOf({ state: "updating", files: { uploaded: 2, held: 21 } }));
    assert.equal(status(), "Updating the page… 2 files to upload, 21 already on Cloudflare");
    assert.equal(updateButton()?.disabled, true);
  });

  test("updating, with one file, and with the count not known yet", async () => {
    await with_(deployOf({ state: "updating", files: { uploaded: 1, held: 0 } }));
    assert.equal(status(), "Updating the page… 1 file to upload, 0 already on Cloudflare");
    cleanup();
    await with_(deployOf({ state: "updating", files: null }));
    assert.equal(status(), "Updating the page…");
  });

  test("waiting for a live service: says so, and what the build is", async () => {
    await with_(deployOf({ state: "waiting", waitingFor: "live", page: { build: "9c41e07", version: "1.27.0", at: DEPLOYED_AT } }));
    assert.equal(status(), "Waiting for the service to end, then updating to build 3f2a91c (1.28.0)");
    assert.ok(sectionText().includes("A service is live in Planning Center, so the page is left alone until it ends."));
    // A request now could only be refused: the status line says why.
    assert.equal(updateButton()?.disabled, true);
  });

  test("waiting to hear whether one is live: says that, and that Update the page now goes ahead when it is merely unknown", async () => {
    await with_(deployOf({ state: "waiting", waitingFor: "unknown" }));
    assert.equal(status(), "Waiting to hear whether a service is live, then updating");
    assert.ok(sectionText().includes("Update the page now goes ahead when the state is merely unknown, never through a live service."));
    assert.ok(!sectionText().includes("A service is live in Planning Center"));
    // Allowed when the state is merely unknown, so it can be pressed.
    assert.equal(updateButton()?.disabled, false);
  });

  test("failed, refused: the token is named, the page is unchanged, and the fix is to paste a new one", async () => {
    await with_(
      deployOf({
        state: "failed",
        error: { message: "Invalid API Token", code: 1000, status: 401, step: "verify the token", at: NOW - 1000, refused: true, retryAt: null },
      }),
    );
    assert.equal(status(), "Couldn't update the page: Cloudflare refused the API token. The page is unchanged.");
    assert.ok(sectionText().includes("The token may have been deleted or its role changed. Make a new one and paste it above."));
    // Never promises a retry the server will not make.
    assert.ok(!sectionText().includes("Tries again"));
  });

  test("failed, retrying: Cloudflare's code and words, and when it tries again, counted from the server's clock", async () => {
    await with_(
      deployOf({
        state: "failed",
        error: { message: "Service unavailable.", code: 10013, status: 503, step: "upload the files", at: NOW - 1000, refused: false, retryAt: NOW + 5 * 60_000 },
      }),
    );
    assert.equal(status(), "Couldn't update the page: Service unavailable (upload the files, Cloudflare code 10013). The page is unchanged.");
    assert.ok(sectionText().includes("Tries again in about 5 min."));
  });

  test("failed, with a retry time already gone by: tries again shortly; with none: says it will not on its own", async () => {
    const e = { message: "x", code: null, status: null, step: "upload the files", at: NOW, refused: false };
    await with_(deployOf({ state: "failed", error: { ...e, retryAt: NOW - 1 } }));
    assert.ok(sectionText().includes("Tries again shortly."));
    cleanup();
    await with_(deployOf({ state: "failed", error: { ...e, retryAt: null } }));
    assert.ok(sectionText().includes("It is not tried again on its own. Update the page now tries once more."));
  });

  test("the retry time is in seconds, minutes or hours, rounded up", async () => {
    const e = { message: "x", code: null, status: null, step: "upload the files", at: NOW, refused: false };
    for (const [ms, said] of [[20_000, "20 s"], [150_000, "3 min"], [9_000_000, "3 h"]] as const) {
      await with_(deployOf({ state: "failed", error: { ...e, retryAt: NOW + ms } }));
      assert.ok(sectionText().includes(`Tries again in about ${said}.`), said);
      cleanup();
    }
  });

  test("newer: names both versions", async () => {
    await with_(deployOf({ state: "newer", page: { build: "9c41e07", version: "1.29.0-beta.2", at: DEPLOYED_AT } }));
    assert.equal(status(), "The page runs build 9c41e07 (1.29.0-beta.2), newer than this server's 1.28.0");
    assert.ok(sectionText().includes("This server never rolls the page back by itself."));
  });

  test("other-build: the same version, another build", async () => {
    await with_(deployOf({ state: "other-build", page: { build: "9c41e07", version: "1.28.0", at: DEPLOYED_AT } }));
    assert.equal(status(), "The page runs build 9c41e07 of this server's own version (1.28.0), deployed by another server");
  });

  test("no-bundle: says so, gives the reason and points at the log; the button cannot be pressed", async () => {
    await with_(deployOf({ state: "no-bundle", bundle: null, noBundle: "The build ran without the page's copy (build/servicecue/deploy.json is missing)." }));
    assert.equal(status(), "This server's build has no copy of the page");
    assert.ok(sectionText().includes("The build ran without the page's copy (build/servicecue/deploy.json is missing). The reason is in the log."));
    assert.equal((screen.getByRole("link", { name: "log" }) as HTMLAnchorElement).getAttribute("href"), "/log");
    assert.equal(updateButton()?.disabled, true);
  });

  test("unchecked (a token, publishing not yet at the page): says the build has not been read", async () => {
    await with_(deployOf({ state: "unchecked", page: null, files: null }));
    assert.equal(status(), "Updating is on. The page's build has not been read yet.");
  });

  test("the time is written in the app's zone, not this machine's, and in the operator's clock format", async () => {
    for (const [zone, said] of [["America/Chicago", "21 Oct, 8:14 AM"], ["UTC", "21 Oct, 1:14 PM"], ["Asia/Tokyo", "21 Oct, 10:14 PM"]] as const) {
      await with_(deployOf(), { timeZone: zone });
      assert.equal(status(), `Up to date: build 3f2a91c (1.28.0), deployed ${said}`, zone);
      cleanup();
    }
    setDisplayHourCycle("24h");
    await with_(deployOf(), { timeZone: "America/Chicago" });
    assert.ok(status().endsWith("deployed 21 Oct, 08:14"));
  });

  test("a month is three letters whatever the locale calls it: September is Sep, not Sept", async () => {
    await with_(deployOf({ page: { build: "3f2a91c", version: "1.28.0", at: Date.UTC(2026, 8, 4, 13, 14) } }), { timeZone: "UTC" });
    assert.equal(status(), "Up to date: build 3f2a91c (1.28.0), deployed 4 Sep, 1:14 PM");
  });

  test("a zone Intl does not know is the host's, never an error in the card", async () => {
    await with_(deployOf(), { timeZone: "Mars/Olympus_Mons" });
    assert.ok(status().startsWith("Up to date: build 3f2a91c (1.28.0), deployed 21 Oct"));
  });
});

describe("the Cloudflare connection disclosure", () => {
  const opened = () => screen.getByRole("button", { name: "Cloudflare connection" }).getAttribute("aria-expanded");
  const mountRaw = async (deploy: DeployStatus, pollMs = 5_000, setDto = true) => {
    if (setDto) server.dto = dtoOf(deploy);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const router = routerAt("/servicecue/manage", "/servicecue/manage", "/settings/integrations");
    render(
      React.createElement(RouterContextProvider, {
        router,
        children: React.createElement(QueryClientProvider, { client }, React.createElement(TooltipProvider, null, React.createElement(PublicLinkCard, { ...NAMES, timeZone: "UTC", pollMs }))),
      } as never),
    );
    await eventually(() => assert.ok(screen.getByRole("button", { name: "Cloudflare connection" })));
    await settle();
  };

  test("opens by itself for a failed update and for a build with no page, so neither hides", async () => {
    await mountRaw(deployOf({ state: "failed", error: { message: "x", code: null, status: null, step: "upload the files", at: NOW, refused: false, retryAt: null } }));
    assert.equal(opened(), "true");
    assert.ok(status().startsWith("Couldn't update the page"));
    cleanup();
    await mountRaw(deployOf({ state: "no-bundle", bundle: null, noBundle: "none" }));
    assert.equal(opened(), "true");
  });

  test("stays open when the update is fixed after it failed, until the operator shuts it", async () => {
    await mountRaw(deployOf({ state: "failed", error: { message: "x", code: null, status: null, step: "upload the files", at: NOW, refused: false, retryAt: NOW + 60_000 } }), 40);
    assert.equal(opened(), "true");
    server.dto = dtoOf(deployOf());
    await eventually(() => assert.ok(status().startsWith("Up to date:")));
    assert.equal(opened(), "true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
      await settle();
    });
    assert.equal(opened(), "false");
  });

  test("a publish answer with no deploy status opens the disclosure without throwing", async () => {
    server.dto = { ...dtoOf(deployOf()), deploy: undefined } as unknown as PublishSettingsDTO;
    await mountRaw(deployOf(), 5_000, false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
      await settle();
    });
    assert.equal(opened(), "true");
    assert.equal(screen.queryByRole("heading", { name: "Keep the page up to date" }) === null, true);
  });

  test("stays shut for the states that need nothing, and the operator can still shut an open one", async () => {
    for (const state of ["current", "updating", "waiting", "newer", "off"] as const) {
      await mountRaw(deployOf({ state }));
      assert.equal(opened(), "false", state);
      cleanup();
    }
    await mountRaw(deployOf({ state: "no-bundle", bundle: null, noBundle: "none" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cloudflare connection" }));
      await settle();
    });
    assert.equal(opened(), "false");
  });
});

describe("the API token", () => {
  test("is never shown: a stored one reads as the mask, and nothing the card draws holds it", async () => {
    await with_(deployOf());
    assert.equal(tokField().value, FORM_MASK);
    assert.equal(tokField().type, "password");
    assert.ok(!(document.body.textContent ?? "").includes(TOKEN));
  });

  test("a pasted one is sent once, and what the card holds afterwards is the mask", async () => {
    await with_(NO_TOKEN());
    type(acctField(), ACCOUNT);
    type(tokField(), TOKEN);
    assert.equal(tokField().type, "password");
    await leave(tokField());
    assert.deepEqual(server.posts, [["credentials", { accountId: ACCOUNT, token: TOKEN }]]);
    await eventually(() => assert.equal(tokField().value, FORM_MASK));
    assert.ok(!(document.body.textContent ?? "").includes(TOKEN));
    assert.equal(status(), "Up to date: build 3f2a91c (1.28.0), deployed 21 Oct, 8:14 AM");
  });

  const dialog = () => screen.findByRole("alertdialog");
  const answer = async (name: string) => {
    const d = await dialog();
    await act(async () => {
      fireEvent.click(within(d).getByRole("button", { name }));
      await settle();
    });
  };

  test("clearing it asks first, and on yes sends an empty token, and updating is off", async () => {
    await with_(deployOf());
    type(tokField(), "");
    await leave(tokField());
    const d = await dialog();
    assert.ok((d.textContent ?? "").includes("Stop keeping the page up to date?"));
    assert.ok((d.textContent ?? "").includes("The token is deleted from this server; to turn updating on again you will need a new token from Cloudflare."));
    // Nothing is deleted while the question is open.
    assert.deepEqual(server.posts, []);
    await answer("Delete the token");
    await eventually(() => assert.deepEqual(server.posts, [["credentials", { token: "" }]]));
    await eventually(() => assert.equal(updateButton() === null, true));
    assert.ok(status().startsWith("Not updating:"));
  });

  test("saying no to that puts the mask back and sends nothing", async () => {
    await with_(deployOf());
    type(tokField(), "");
    await leave(tokField());
    await answer("Cancel");
    await settle();
    assert.deepEqual(server.posts, []);
    assert.equal(tokField().value, FORM_MASK);
    assert.ok(status().startsWith("Up to date:"));
  });

  test("emptying the account ID with a token stored asks the same question, and on yes clears both", async () => {
    await with_(deployOf());
    type(acctField(), "");
    await leave(acctField());
    const d = await dialog();
    assert.ok((d.textContent ?? "").includes("Stop keeping the page up to date?"));
    assert.deepEqual(server.posts, []);
    await answer("Delete the token");
    await eventually(() => assert.deepEqual(server.posts, [["credentials", { token: "" }]]));
    await eventually(() => assert.ok(status().startsWith("Not updating:")));
  });

  test("saying no to that puts the stored account ID back and sends nothing", async () => {
    await with_(deployOf());
    type(acctField(), "");
    await leave(acctField());
    await answer("Cancel");
    await settle();
    assert.deepEqual(server.posts, []);
    assert.equal(acctField().value, ACCOUNT);
    assert.equal(tokField().value, FORM_MASK);
    assert.ok(status().startsWith("Up to date:"));
  });

  test("a save the route refuses leaves nothing typed behind: the mask and the stored account are back, and the next blur sends nothing", async () => {
    const f = stubFetchWithLog((url, init) => {
      if (init?.method === "POST" && url.endsWith("/deploy-credentials")) {
        server.posts.push(["credentials", JSON.parse(String(init.body))]);
        return reply(400, { error: "Cloudflare did not accept that account ID." });
      }
      if (url === "/api/servicecue/publish") return ok(server.dto);
      return ok({});
    });
    try {
      await with_(deployOf());
      type(acctField(), "fedcba9876543210fedcba9876543210");
      type(tokField(), TOKEN);
      await leave(tokField());
      await eventually(() => assert.ok(sectionText().includes("Cloudflare did not accept that account ID.")));
      assert.equal(tokField().value, FORM_MASK);
      assert.equal(acctField().value, ACCOUNT);
      await leave(tokField());
      await leave(acctField());
      assert.equal(server.posts.length, 1, "the typed token was sent again");
    } finally {
      f.restore();
    }
  });

  test("leaving the mask as it is sends nothing", async () => {
    await with_(deployOf());
    await leave(tokField());
    await leave(acctField());
    assert.deepEqual(server.posts, []);
  });

  test("an account ID typed with no token waits for one: the route wants both, so nothing is sent", async () => {
    await with_(NO_TOKEN());
    type(acctField(), ACCOUNT);
    await leave(acctField());
    assert.deepEqual(server.posts, []);
  });

  test("a token with no account ID is said at once, and nothing is sent", async () => {
    await with_(NO_TOKEN());
    type(tokField(), TOKEN);
    await leave(tokField());
    assert.deepEqual(server.posts, []);
    assert.ok(sectionText().includes("Enter the Cloudflare account ID with the token."));
  });

  test("a new account ID beside a stored token is sent alone, and the token is left", async () => {
    await with_(deployOf());
    type(acctField(), "fedcba9876543210fedcba9876543210");
    await leave(acctField());
    assert.deepEqual(server.posts, [["credentials", { accountId: "fedcba9876543210fedcba9876543210" }]]);
  });

  test("a refusal from the route is shown where the operator is looking, not swallowed", async () => {
    server.credentials = () => {
      throw new Error("never reached");
    };
    const f = stubFetchWithLog((url, init) => {
      if (init?.method === "POST" && url.endsWith("/deploy-credentials")) return reply(400, { error: "The Cloudflare account ID is 32 hexadecimal digits." });
      if (url === "/api/servicecue/publish") return ok(server.dto);
      return ok({});
    });
    try {
      await with_(NO_TOKEN());
      type(acctField(), "nope");
      type(tokField(), TOKEN);
      await leave(tokField());
      await eventually(() => assert.ok(sectionText().includes("The Cloudflare account ID is 32 hexadecimal digits.")));
    } finally {
      f.restore();
    }
  });
});

describe("Update the page now", () => {
  const dialog = () => screen.findByRole("alertdialog");
  const press = async (name: string) => {
    const d = await dialog();
    await act(async () => {
      fireEvent.click(within(d).getByRole("button", { name }));
      await settle();
    });
  };
  const click = async () => {
    await act(async () => {
      fireEvent.click(updateButton()!);
      await settle();
    });
  };

  const NEWER = {
    status: 409,
    json: {
      error: "The page was deployed from 1.29.0-beta.2, which is newer than this server's 1.28.0.",
      code: "newer",
      pageVersion: "1.29.0-beta.2",
      runningVersion: "1.28.0",
      deploy: deployOf({ state: "newer", page: { build: "9c41e07", version: "1.29.0-beta.2", at: DEPLOYED_AT } }),
    },
  };

  test("posts with no body when nothing needs confirming, and takes the answer as the new status", async () => {
    await with_(deployOf({ page: { build: "0ldbuild", version: "1.27.0", at: DEPLOYED_AT }, state: "failed", error: null }));
    server.deployAnswers = [{ status: 200, json: dtoOf(deployOf()) }];
    await click();
    assert.deepEqual(server.posts, [["deploy", {}]]);
    await eventually(() => assert.ok(status().startsWith("Up to date:")));
  });

  test("a newer page asks first, naming both versions, and replaces it only on yes, with confirmDowngrade", async () => {
    await with_(deployOf({ state: "newer", page: { build: "9c41e07", version: "1.29.0-beta.2", at: DEPLOYED_AT } }));
    server.deployAnswers = [NEWER, { status: 200, json: dtoOf(deployOf()) }];
    await click();
    const d = await dialog();
    assert.ok((d.textContent ?? "").includes("1.29.0-beta.2"));
    assert.ok((d.textContent ?? "").includes("1.28.0"));
    // Nothing is replaced while the question is open.
    assert.deepEqual(server.posts, [["deploy", {}]]);
    await press("Replace the page");
    await eventually(() => assert.deepEqual(server.posts, [["deploy", {}], ["deploy", { confirmDowngrade: true }]]));
    await eventually(() => assert.ok(status().startsWith("Up to date:")));
  });

  test("saying no to the question leaves the page alone: no second request", async () => {
    await with_(deployOf({ state: "newer", page: { build: "9c41e07", version: "1.29.0-beta.2", at: DEPLOYED_AT } }));
    server.deployAnswers = [NEWER];
    await click();
    await press("Leave it");
    await settle();
    assert.deepEqual(server.posts, [["deploy", {}]]);
    assert.equal(screen.queryByRole("alertdialog") === null, true);
    assert.ok(status().startsWith("The page runs build 9c41e07"));
    assert.equal(updateButton()?.disabled, false);
  });

  test("another build of the same version asks too, naming that build", async () => {
    await with_(deployOf({ state: "other-build", page: { build: "9c41e07", version: "1.28.0", at: DEPLOYED_AT } }));
    server.deployAnswers = [
      {
        status: 409,
        json: {
          error: "The page is build 9c41e07 of this server's own version 1.28.0.",
          code: "other-build",
          pageBuild: "9c41e07",
          pageVersion: "1.28.0",
          deploy: deployOf({ state: "other-build", page: { build: "9c41e07", version: "1.28.0", at: DEPLOYED_AT } }),
        },
      },
      { status: 200, json: dtoOf(deployOf()) },
    ];
    await click();
    const d = await dialog();
    assert.ok((d.textContent ?? "").includes("9c41e07"));
    await press("Replace the page");
    await eventually(() => assert.deepEqual(server.posts.at(-1), ["deploy", { confirmDowngrade: true }]));
  });

  test("asked again after yes, a refusal is shown rather than asked in a loop", async () => {
    await with_(deployOf({ state: "newer", page: { build: "9c41e07", version: "1.29.0-beta.2", at: DEPLOYED_AT } }));
    server.deployAnswers = [NEWER];
    await click();
    await press("Replace the page");
    await eventually(() => assert.equal(server.posts.length, 2));
    await settle();
    assert.equal(server.posts.length, 2);
    assert.equal(screen.queryByRole("alertdialog") === null, true);
    assert.ok(sectionText().includes("newer than this server's 1.28.0"));
  });

  test("too soon (429): says how many seconds, and the button waits", async () => {
    await with_(deployOf());
    server.deployAnswers = [{ status: 429, json: { error: "The page was updated a moment ago. Try again in 41 seconds.", code: "too-soon", retryAfterSec: 41, deploy: deployOf() } }];
    await click();
    await eventually(() => assert.ok(sectionText().includes("Try again in 41 s.")));
    assert.equal(updateButton()?.disabled, true);
  });

  test("already current: says so", async () => {
    await with_(deployOf());
    server.deployAnswers = [{ status: 200, json: { ...dtoOf(deployOf()), already: "current" } }];
    await click();
    await eventually(() => assert.ok(sectionText().includes("Already up to date.")));
  });

  test("gone ahead with the service state unknown: says that it did", async () => {
    await with_(deployOf({ state: "waiting" }));
    server.deployAnswers = [{ status: 200, json: { ...dtoOf(deployOf()), serviceState: "unknown" } }];
    await click();
    await eventually(() =>
      assert.ok(sectionText().includes("Updated the page. Planning Center had not said whether a service is live, so this went ahead without knowing.")),
    );
  });

  test("a live service (409) and a failed deploy (502) say the server's words, and the status is the one the refusal carried", async () => {
    await with_(deployOf({ state: "waiting" }));
    server.deployAnswers = [
      { status: 409, json: { error: "A service is live. The page is not updated during one: it updates when the service ends.", code: "service-live", deploy: deployOf({ state: "waiting" }) } },
    ];
    await click();
    await eventually(() => assert.ok(sectionText().includes("A service is live. The page is not updated during one: it updates when the service ends.")));

    server.deployAnswers = [
      {
        status: 502,
        json: {
          error: "The page could not be updated: Service unavailable. It is unchanged.",
          code: "failed",
          deploy: deployOf({
            state: "failed",
            error: { message: "Service unavailable.", code: null, status: 503, step: "upload the files", at: NOW, refused: false, retryAt: NOW + 60_000 },
          }),
        },
      },
    ];
    await click();
    await eventually(() => assert.ok(status().startsWith("Couldn't update the page: Service unavailable")));
    assert.ok(sectionText().includes("The page could not be updated: Service unavailable. It is unchanged."));
  });
});

describe("live status", () => {
  test("moves from updating to current on the card's own poll, with no reload and no extra request of its own", async () => {
    await with_(deployOf({ state: "updating" }), { pollMs: 40 });
    assert.ok(status().startsWith("Updating the page"));
    server.dto = dtoOf(deployOf());
    await eventually(() => assert.ok(status().startsWith("Up to date:")));
    assert.equal(updateButton()?.disabled, false);
  });
});
