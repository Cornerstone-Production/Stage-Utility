// useNameDraft is the blur behaviour of every name field on the Screens page: a
// changed, non-empty name is saved trimmed, anything else puts the stored name
// back, and a rename made elsewhere reaches the field without eating a draft.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const { useNameDraft } = await import("./use-name-draft.js");

after(() => {
  cleanup();
  teardown();
});

function Field({ stored, onRename }: { stored: string; onRename: (name: string) => void }) {
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
    const view = render(<Field stored="Lobby" onRename={(n) => saved.push(n)} />);
    t.after(() => cleanup());
    typeAndLeave(view.getByLabelText("name"), "  Foyer  ");
    assert.deepEqual(saved, ["Foyer"]);
  });

  test("puts the stored name back for an unchanged or emptied field, and saves nothing", (t) => {
    const saved: string[] = [];
    const view = render(<Field stored="Lobby" onRename={(n) => saved.push(n)} />);
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
});
