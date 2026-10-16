// lib/api.mjs — the app's own HTTP API, for the seed step.
//
// Seeding goes through the server's routes wherever there is one, so the data is
// validated by the code that will read it. The exceptions (recorded history, which
// no route writes) are in seed/history.mjs and are written before the server starts.

export function makeApi(base) {
  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${typeof json === "string" ? json : JSON.stringify(json)}`);
    return json;
  }
  return {
    get: (p) => call("GET", p),
    post: (p, b = {}) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    patch: (p, b) => call("PATCH", p, b),
    del: (p) => call("DELETE", p),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns something truthy. */
export async function until(fn, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}
