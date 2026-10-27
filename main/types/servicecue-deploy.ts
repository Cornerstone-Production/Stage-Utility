// servicecue-deploy.ts — what build/servicecue/deploy.json says.
//
// Written by scripts/servicecue-bundle.ts and read by main/services/servicecue-cloudflare.ts, so the
// shape lives here, where neither depends on the other.

/** How long one request to Cloudflare's API may take. */
export const CLOUDFLARE_REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long the card waits on "Update the page now": six of Cloudflare's requests at their ceiling
 * (the token, two reads of what is deployed, the Worker, the upload session, the script). The file
 * uploads come on top, so an answer later than this is not a failure: the card says the update is
 * still going, and the status it polls carries the outcome.
 */
export const DEPLOY_NOW_TIMEOUT_MS = 6 * CLOUDFLARE_REQUEST_TIMEOUT_MS;

/** One binding, in the shape Cloudflare's upload metadata takes. */
export type DeployBinding =
  | { type: "assets"; name: string }
  | { type: "durable_object_namespace"; name: string; class_name: string }
  | { type: "json"; name: string; json: unknown }
  | { type: "plain_text"; name: string; text: string };

/** What a deployer needs to know about the files beside it. */
export interface DeployManifest {
  /** The Worker's name, wrangler.jsonc's `name`: what an upload is addressed to. */
  name: string;
  /** The page's build id: the one stamped into the document, and that the Worker reports. */
  build: string;
  /** The app's version, when the bundle was made. */
  version: string;
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  protocol: number;
  /**
   * The `config` the upload's assets metadata takes: wrangler.jsonc's `assets` less where the
   * files are and what the Worker calls them, and `_headers`, the text of the headers file the
   * asset service reads. wrangler does not upload `_headers` as an asset (it says "Ignoring
   * asset: _headers" and sends the text in this config), so the bundle does the same: the file
   * is not in `public/`, and a deployer sends these fields as they are.
   */
  assets: Record<string, unknown>;
  bindings: DeployBinding[];
  /** Which existing bindings an upload keeps when it names none for them: the secrets `wrangler secret put` set, such as PUBLISH_TOKEN. wrangler sends the same two on every deploy. */
  keep_bindings: string[];
  /** wrangler.jsonc's `exports`, as it is: what each Durable Object class is (wrangler 4.150 sends it with the script). */
  exports: Record<string, unknown>;
}
