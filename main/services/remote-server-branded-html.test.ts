// The app's HTML documents carry the operator's app name, as the real static
// handler serves them.
//
// install-metadata.test.ts proves brandHtml over the real documents; this proves
// the server CALLS it, for each of the three ways a document is answered: the kiosk
// entry, the operator app (every operator path maps to app.html) and the
// extensionless fallback (/display-1). iOS reads the home-screen label from the
// document when the app is added, so a call site that regressed would put
// "Stage Utility" under an icon with the operator's name on the page.
//
// The handler is reached directly: it needs no listening socket, only the build
// directory, which is pointed at a temp install holding the real two documents.

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type * as http from "node:http";

const root = mkdtempSync(path.join(os.tmpdir(), "branded-html-root-"));
mkdirSync(path.join(root, "build", "renderer"), { recursive: true });
writeFileSync(path.join(root, "package.json"), "{}");
for (const doc of ["index.html", "app.html"]) {
  copyFileSync(new URL(`../../${doc}`, import.meta.url), path.join(root, "build", "renderer", doc));
}
writeFileSync(path.join(root, "build", "renderer", "control.html"), "<html><head><title>Stage Utility — Remote</title></head></html>");
process.env.STAGE_UTILITY_ROOT = root;
process.env.STAGE_UTILITY_DATA = mkdtempSync(path.join(os.tmpdir(), "branded-html-data-"));

const { remoteServer } = await import("./remote-server.js");
const { stageController } = await import("./stage-controller.js");

type Serve = (pathname: string, res: http.ServerResponse, acceptEncoding?: string) => Promise<boolean>;

async function fetchDoc(pathname: string): Promise<string> {
  let body = "";
  const res = {
    writeHead: () => res,
    end: (chunk?: unknown) => {
      body += String(chunk ?? "");
      return res;
    },
  } as unknown as http.ServerResponse;
  const serve = (remoteServer as unknown as { tryServeStatic: Serve }).tryServeStatic.bind(remoteServer);
  assert.equal(await serve(pathname, res), true, `${pathname} was not served`);
  return body;
}

const NAME = 'Chapel "AV" & Co';
const ESCAPED = "Chapel &quot;AV&quot; &amp; Co";

test("the kiosk entry, the operator app and the fallback all carry the app name", async () => {
  await stageController.setBranding({ name: NAME });
  for (const pathname of ["/index.html", "/settings", "/display-1"]) {
    const html = await fetchDoc(pathname);
    assert.ok(
      html.includes(`name="apple-mobile-web-app-title" content="${ESCAPED}"`),
      `${pathname}: the home-screen label is not the app name`,
    );
    assert.ok(html.includes(`<title>${ESCAPED}</title>`), `${pathname}: the page title is not the app name`);
  }
});

test("the version stamp is still on the two documents that always had it", async () => {
  for (const pathname of ["/index.html", "/settings"]) {
    assert.match(await fetchDoc(pathname), /window\.__APP_VERSION__=/, pathname);
  }
});

test("a document that is not an app entry keeps its own title", async () => {
  assert.ok((await fetchDoc("/control.html")).includes("<title>Stage Utility — Remote</title>"));
});
