// companion-info-panel.test.tsx — the first Companion card: the address to give
// Companion, and the Copy buttons beside it.
//
// What is guarded:
//
//  - THE ADDRESS IS THE LAN ADDRESS, split into host and port: Companion takes them
//    as two fields and cannot resolve DNS, so the card shows the IP from
//    `state.lanUrl`, never the DNS `publicUrl`.
//  - COPY WORKS ON PLAIN HTTP. Production is plain HTTP, where `navigator.clipboard`
//    does not exist, so a Copy that only called it would do nothing in the one place
//    it is used. Where it cannot copy, the field is SELECTED and the operator is
//    told to copy by hand: a Copy that silently does nothing is the failure.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see test-dom.ts).

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, blankState, settleFor } = await import("../test-fixtures/integrations-harness.js");
const { CompanionInfoPanel } = await import("./companion-info-panel.js");
const { toast } = await import("./ui/toast.js");

const server = installFakeServer({}, { "/api/state": { lanUrl: "http://192.168.1.50:8788", publicUrl: "http://stage.example.test:8788" } });

after(() => {
  server.restore();
  teardown();
});
afterEach(() => cleanup());

async function mount() {
  const view = render(withQueryClient(<CompanionInfoPanel state={blankState("companion", { enabled: true })} />));
  await settleFor(40);
  return view;
}
const field = (id: string) => document.getElementById(id) as HTMLInputElement | null;

describe("the address", () => {
  test("is the LAN address, host and port apart, and never the DNS name", async () => {
    await mount();
    assert.equal(field("companion-copy-host")?.value, "192.168.1.50");
    assert.equal(field("companion-copy-port")?.value, "8788");
    assert.ok(!(document.body.textContent ?? "").includes("stage.example.test"));
  });

  test("the fields are read-only", async () => {
    await mount();
    assert.equal(field("companion-copy-host")?.readOnly, true);
    assert.equal(field("companion-copy-port")?.readOnly, true);
  });
});

describe("Copy", () => {
  test("uses the clipboard where it exists, and says what was copied", async () => {
    const copied: string[] = [];
    const nav = globalThis.navigator as unknown as { clipboard?: unknown };
    const hadClipboard = Object.getOwnPropertyDescriptor(nav, "clipboard");
    Object.defineProperty(nav, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    const w = globalThis.window as unknown as { isSecureContext: boolean };
    const hadSecure = Object.getOwnPropertyDescriptor(w, "isSecureContext");
    Object.defineProperty(w, "isSecureContext", { configurable: true, value: true });
    const said: string[] = [];
    const real = toast.success;
    toast.success = ((m: string) => void said.push(m)) as typeof toast.success;
    try {
      await mount();
      await act(async () => {
        fireEvent.click(document.querySelector('[aria-label="Copy Host"]')!);
        await settleFor(10);
      });
      assert.deepEqual(copied, ["192.168.1.50"]);
      assert.deepEqual(said, ["Host copied"]);
    } finally {
      toast.success = real;
      if (hadClipboard) Object.defineProperty(nav, "clipboard", hadClipboard);
      else delete nav.clipboard;
      if (hadSecure) Object.defineProperty(w, "isSecureContext", hadSecure);
      else delete (w as { isSecureContext?: boolean }).isSecureContext;
    }
  });

  test("where nothing can copy (plain HTTP), the field is selected and the toast says to copy by hand", async () => {
    // jsdom has no execCommand and, here, no clipboard: the plain-HTTP case.
    const said: string[] = [];
    const real = toast.error;
    toast.error = ((m: string) => void said.push(m)) as typeof toast.error;
    try {
      await mount();
      await act(async () => {
        fireEvent.click(document.querySelector('[aria-label="Copy Port"]')!);
        await settleFor(10);
      });
      const port = field("companion-copy-port")!;
      assert.equal(port.selectionEnd! - port.selectionStart!, "8788".length, "the field was not selected for a manual copy");
      assert.deepEqual(said, ["Couldn't copy — select and copy manually"]);
    } finally {
      toast.error = real;
    }
  });
});
