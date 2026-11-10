// capture/kit.ts — the browser side: sessions, waiting, and writing a PNG.

import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export const APP_VIEWPORT = { width: 1440, height: 900 };
export const WALL_VIEWPORT = { width: 1920, height: 1080 };

/** A screenshot bigger than this is cropped tighter or the page is simplified. */
export const MAX_BYTES = 250 * 1024;

/**
 * Launch the installed Google Chrome. `channel: "chrome"` drives the browser that
 * is already on the machine, so there is no browser download to run.
 */
export async function launch() {
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch (err) {
    throw new Error(`could not start Google Chrome (the capture step drives the installed one): ${(err as Error).message}`, { cause: err });
  }
}

/**
 * The sidebar prints the running version; a screenshot in the docs should not age with it.
 * The callback runs in the page, not in node.
 */
async function hideVersion(page: Page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length === 0 && /^v\d+\.\d+\.\d+/.test((el.textContent ?? "").trim())) (el as HTMLElement).style.visibility = "hidden";
    }
  });
}

export class Session {
  browser: Browser;
  base: string;
  outDir: string;
  written: { name: string; bytes: number }[];
  screens: { id: string; context: BrowserContext; page: Page }[];

  constructor(browser: Browser, base: string, outDir: string) {
    this.browser = browser;
    this.base = base;
    this.outDir = outDir;
    this.written = [];
    this.screens = [];
  }

  /**
   * Open every screen's own URL, and keep it open. A screen counts as connected
   * while a browser is sending its heartbeat, so the Screens page only shows
   * "online" and a live preview if the screens are really being shown.
   */
  async openScreens(ids: string[]) {
    for (const id of ids) {
      const context = await this.browser.newContext({ viewport: WALL_VIEWPORT, colorScheme: "dark" });
      const page = await context.newPage();
      await page.goto(`${this.base}/${id}`);
      this.screens.push({ id, context, page });
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  /** A fresh app-page context (light theme, desktop). */
  async appPage({ viewport = APP_VIEWPORT, scheme = "light" }: { viewport?: { width: number; height: number }; scheme?: "light" | "dark" } = {}) {
    const context = await this.browser.newContext({ viewport, colorScheme: scheme });
    const page = await context.newPage();
    page.on("pageerror", (err) => console.warn(`  page error: ${err.message}`));
    return page;
  }

  async goto(page: Page, route: string, { settle = 2500 }: { settle?: number } = {}) {
    await page.goto(`${this.base}${route}`);
    await page.waitForTimeout(settle);
    await hideVersion(page);
  }

  /** Write `<name>.png`; `clip` crops to the feature. Returns the size in bytes. */
  async shoot(page: Page, name: string, { clip }: { clip?: { x: number; y: number; width: number; height: number } } = {}) {
    const file = path.join(this.outDir, `${name}.png`);
    fs.mkdirSync(this.outDir, { recursive: true });
    await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
    const bytes = fs.statSync(file).size;
    this.written.push({ name, bytes });
    const note = bytes > MAX_BYTES ? "  (OVER the size budget)" : "";
    console.log(`  ${name}.png  ${(bytes / 1024).toFixed(0)} KB${note}`);
    return bytes;
  }

  async close() {
    for (const s of this.screens) await s.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
