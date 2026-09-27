// fetch-log.ts — the half of a read-failure test's fetch stub that never varies.
//
// Such a test answers some routes, fails one, and asserts two things: what the
// operator sees, and that the failure reached /log. Which routes exist and how
// each one answers is the test's own business — the route table test-dom.ts
// declines to share, for reasons that still hold — so the caller passes it in
// as a function. What every one of them also needs, identically, is every
// logToServer line captured and the real fetch put back afterwards. That is this.
//
//   const f = stubFetchWithLog((url) => {
//     if (url.endsWith("/api/patch")) throw new TypeError("fetch failed");
//     return ok(FILE);
//   });
//   try { …; assert.ok(f.logs.some((l) => l.tag === "patch")); } finally { f.restore(); }
//
// Imports nothing from Testing Library: its `screen` binds to `document` when
// it is first imported, and these tests install the DOM before that import.

/** One POST to /api/log/client, as logToServer sent it. */
export interface ClientLogLine {
  tag: string;
  message: string;
}

/** A response in the shape apiFetch reads, with `status` and a JSON body. */
export function reply(status: number, json: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

/** A 200 whose body is `json`. */
export function ok(json: unknown) {
  return reply(200, json);
}

/**
 * Replace fetch with `answer`, capturing every client log line on the way.
 *
 * `answer` sees every request except /api/log/client. Throwing from it is how a
 * test fails a read: apiFetch then rejects, as it does for a network error.
 */
export function stubFetchWithLog(answer: (url: string, init?: RequestInit) => unknown): {
  logs: ClientLogLine[];
  restore: () => void;
} {
  const logs: ClientLogLine[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/log/client")) {
      logs.push(JSON.parse(String(init?.body ?? "{}")) as ClientLogLine);
      return ok({});
    }
    return answer(url, init);
  }) as unknown as typeof fetch;
  return {
    logs,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** Every `role="alert"` on the page, as text, joined — "" when there is none. */
export function alerts(): string {
  return [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent ?? "").join(" | ");
}
