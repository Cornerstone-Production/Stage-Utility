// A route handler's own call to a body reader. Nothing here is a request the stock
// model knows, so each alert below exists only because of the source model.
import { readBody, readBodyOrEmpty, readRawBody } from "./routes/context.js";

export async function handler(req: unknown): Promise<void> {
  console.log(`readBody ${await readBody(req)}`);
  console.log(`readBodyOrEmpty ${(await readBodyOrEmpty(req))["name"]}`);
  console.log(`readRawBody ${await readRawBody(req)}`);
}
