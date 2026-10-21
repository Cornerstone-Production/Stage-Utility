// self-signed-page.ts — an HTTPS page whose certificate nothing trusts.
//
// What a firewall that intercepts TLS looks like from this server: the connection
// is answered, with a certificate of the firewall's own. The certificate is made
// for each run by openssl, so no key is kept in the repository, and Node refuses
// it with its real error, on the real fetch path.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export interface SelfSignedPage {
  /** `https://localhost:<port>`. */
  origin: string;
  /** How many requests got past the handshake: none should. */
  requests: number;
  close(): Promise<void>;
}

export async function startSelfSignedPage(): Promise<SelfSignedPage> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "su-self-signed-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", key, "-out", cert],
      { stdio: "ignore" },
    );
    const page: SelfSignedPage = { origin: "", requests: 0, close: async () => {} };
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
      page.requests++;
      // What the firewall's block page answers, should a request ever get this far.
      res.writeHead(403, { "Content-Type": "text/html" }).end("<h1>Blocked</h1>");
    });
    // Every address, so "localhost" reaches it whichever family it resolves to first.
    await new Promise<void>((resolve) => server.listen(0, resolve));
    page.origin = `https://localhost:${(server.address() as AddressInfo).port}`;
    page.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return page;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
