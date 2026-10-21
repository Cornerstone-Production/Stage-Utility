// host-names-card.test.tsx — the Host names card's add field, through the real
// component with a stubbed fetch. A refused add (a full list, or a page opened
// by a name not on the list) once cleared what the operator typed along with
// the toast that said why. NOTHING BELOW PASSES A DOM NODE AS AN ASSERT
// OPERAND: see advanced-section-writes.test.tsx.
//
// Every name below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, unmountAndTeardown } from "../../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { HostNamesCard } = await import("./host-names-card.js");
const { TooltipProvider, Toaster } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const VIEW = { enforce: false, seeded: false, automatic: [], accepted: [], waiting: [], dismissed: [] };

function mount(addAnswer: () => unknown) {
  const stub = stubFetchWithLog((url, init) => {
    if (url.includes("/api/security/host-names") && init?.method === "POST") return addAnswer();
    if (url.includes("/api/security/host-names")) return ok(VIEW);
    return ok({});
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TooltipProvider, null, React.createElement(HostNamesCard), React.createElement(Toaster)),
    ),
  );
  return stub;
}

async function addName(name: string): Promise<HTMLInputElement> {
  const input = (await screen.findByLabelText("Add a host name")) as HTMLInputElement;
  await eventually(() => assert.equal(input.disabled, false));
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  return input;
}

test("a refused add keeps what was typed, and says why", async () => {
  const stub = mount(() => reply(400, { error: "The list is full (200 names); remove one first." }));
  try {
    const input = await addName("stage.example.org");
    await eventually(() => assert.ok((document.body.textContent ?? "").includes("The list is full"), "no toast said why"));
    assert.equal(input.value, "stage.example.org");
  } finally {
    stub.restore();
  }
});

test("control: an add the server takes clears the field", async () => {
  const stub = mount(() => ok({ ...VIEW, accepted: [{ name: "stage.example.org", source: "added", at: "" }] }));
  try {
    const input = await addName("stage.example.org");
    await eventually(() => assert.equal(input.value, ""));
  } finally {
    stub.restore();
  }
});
