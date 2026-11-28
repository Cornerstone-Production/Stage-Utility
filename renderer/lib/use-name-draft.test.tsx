// useNameDraft is the blur behaviour of every name field on the Screens page: a
// changed, non-empty name is saved trimmed, anything else puts the stored name
// back, and a rename made elsewhere reaches the field without eating a draft.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const { settle } = await import("../test-dom.js");
const { useNameDraft } = await import("./use-name-draft.js");

after(() => {
  cleanup();
  teardown();
});

function Field({ stored, onRename }: { stored: string; onRename: (name: string) => void | boolean | Promise<boolean | void> }) {
  const { draft, setDraft, commit } = useNameDraft(stored, onRename);
  return <input aria-label="name" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
}

function typeAndLeave(input: HTMLElement, text: string): void {
  act(() => {
    fireEvent.change(input, { target: { value: text } });
  });
  act(() => {
    fireEvent.blur(input);
  });
}

describe("useNameDraft", () => {
  test("saves a changed name, trimmed", (t) => {
    const saved: string[] = [];
    const view = render(<Field stored="Lobby" onRename={(n) => { saved.push(n); }} />);
    t.after(() => cleanup());
    typeAndLeave(view.getByLabelText("name"), "  Foyer  ");
    assert.deepEqual(saved, ["Foyer"]);
  });

  test("puts the stored name back for an unchanged or emptied field, and saves nothing", (t) => {
    const saved: string[] = [];
    const view = render(<Field stored="Lobby" onRename={(n) => { saved.push(n); }} />);
    t.after(() => cleanup());
    const input = view.getByLabelText("name") as HTMLInputElement;
    typeAndLeave(input, "  Lobby ");
    assert.equal(input.value, "Lobby");
    typeAndLeave(input, "   ");
    assert.equal(input.value, "Lobby");
    assert.deepEqual(saved, []);
  });

  test("follows a rename made elsewhere", (t) => {
    const view = render(<Field stored="Lobby" onRename={() => {}} />);
    t.after(() => cleanup());
    act(() => {
      view.rerender(<Field stored="Atrium" onRename={() => {}} />);
    });
    assert.equal((view.getByLabelText("name") as HTMLInputElement).value, "Atrium");
  });

  // A refused save resolves false. Nothing else will put the field back: the stored
  // name did not change, so the resync on `stored` never fires, and the field shows a
  // name the app does not have until the page is reloaded.
  test("a refused save puts the stored name back", async (t) => {
    const view = render(<Field stored="Lobby" onRename={async () => false} />);
    t.after(() => cleanup());
    const input = view.getByLabelText("name") as HTMLInputElement;
    typeAndLeave(input, "Foyer");
    await settle();
    assert.equal(input.value, "Lobby", "a refused name was left in the field");
  });

  test("an accepted save, or a callback that answers nothing, leaves the typed name", async (t) => {
    const accepted = render(<Field stored="Lobby" onRename={async () => true} />);
    t.after(() => cleanup());
    const a = accepted.getAllByLabelText("name")[0] as HTMLInputElement;
    typeAndLeave(a, "Foyer");
    await settle();
    assert.equal(a.value, "Foyer");
    cleanup();
    const silent = render(<Field stored="Lobby" onRename={() => undefined} />);
    const b = silent.getByLabelText("name") as HTMLInputElement;
    typeAndLeave(b, "Foyer");
    await settle();
    assert.equal(b.value, "Foyer", "undefined was read as a refusal");
  });

  test("a refusal that lands after typing resumed does not eat the new typing", async (t) => {
    let answer!: (ok: boolean) => void;
    const view = render(<Field stored="Lobby" onRename={() => new Promise<boolean>((r) => { answer = r; })} />);
    t.after(() => cleanup());
    const input = view.getByLabelText("name") as HTMLInputElement;
    typeAndLeave(input, "Foyer");
    act(() => {
      fireEvent.change(input, { target: { value: "Foyer 2" } });
    });
    await act(async () => {
      answer(false);
      await Promise.resolve();
    });
    await settle();
    assert.equal(input.value, "Foyer 2");
  });
});
