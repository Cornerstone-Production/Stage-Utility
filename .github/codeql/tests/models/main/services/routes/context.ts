// Stand-ins for the real body readers. Each returns something a handler logs, and
// none reads a request, so only the source model makes the result remote.
export async function readBody(_req: unknown): Promise<unknown> {
  return {};
}

export async function readBodyOrEmpty(_req: unknown): Promise<Record<string, unknown>> {
  return {};
}

export async function readRawBody(_req: unknown): Promise<Uint8Array> {
  return new Uint8Array();
}
