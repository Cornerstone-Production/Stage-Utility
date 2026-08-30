import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { copyText } = await import("./clipboard.js");

after(() => teardown());

// Prod is served over plain HTTP, so navigator.clipboard does not exist and
// every copy in the app goes down the textarea + execCommand path. Two things
// went wrong there and both were invisible:
//
//  1. Inside a Radix menu, the focus trap pulled focus back the instant the
//     textarea took it, so nothing was selected when execCommand ran.
//  2. execCommand returned TRUE regardless, so the app said "URL copied" having
//     copied nothing - a failure reported as success.
//
// The fix mounts the textarea inside the trapping container and verifies the
// selection actually held before claiming success.

function insecureContext() {
  Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
  delete (navigator as { clipboard?: unknown }).clipboard;
}

describe("copyText in a non-secure context", () => {
  beforeEach(() => {
    insecureContext();
    document.body.innerHTML = "";
  });

  test("copies when the textarea keeps focus and selection", async () => {
    let selectedAtCopy: string | null = null;
    document.execCommand = (cmd: string) => {
      if (cmd === "copy") {
        const a = document.activeElement as HTMLTextAreaElement | null;
        selectedAtCopy = a?.value?.slice(a.selectionStart, a.selectionEnd) ?? null;
      }
      return true;
    };
    assert.equal(await copyText("http://stage.local/display-1"), true);
    assert.equal(selectedAtCopy, "http://stage.local/display-1");
  });

  test("reports FAILURE when the selection was stolen, even though execCommand says true", async () => {
    // The exact production shape: a focus trap steals focus back, so nothing is
    // selected, yet execCommand still returns true. Claiming success here is
    // what made a broken button look like a working one.
    const thief = document.createElement("div");
    thief.tabIndex = 0;
    document.body.appendChild(thief);
    document.addEventListener("focusin", (e) => {
      if ((e.target as HTMLElement).tagName === "TEXTAREA") thief.focus();
    });
    document.execCommand = () => true;

    assert.equal(
      await copyText("http://stage.local/display-1"),
      false,
      "a copy whose selection was stolen must report failure, not success",
    );
  });

  test("mounts inside the given container, so a focus trap does not steal it", async () => {
    const trap = document.createElement("div");
    document.body.appendChild(trap);
    let hostTag: string | null = null;
    document.execCommand = (cmd: string) => {
      if (cmd === "copy") hostTag = (document.activeElement?.parentElement as HTMLElement)?.tagName ?? null;
      return true;
    };
    await copyText("x", trap);
    assert.equal(hostTag, "DIV", "the textarea must be mounted in the container it was given");
    assert.equal(trap.querySelector("textarea"), null, "and cleaned up afterwards");
  });

  test("leaves no textarea behind", async () => {
    document.execCommand = () => true;
    await copyText("http://stage.local/display-1");
    assert.ok(document.querySelector("textarea") === null, "the fallback textarea was left in the document");
  });
});
