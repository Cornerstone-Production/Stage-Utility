// Where the "Setup guide" link in an integration dialog points.
//
// Its own module, and a pure one, so the guard over it does not have to import a
// React component into a main/services test.

import type { IntegrationDescriptor } from "../../main/types/integrations.js";

/** Only a ref, never anything that could reshape the path. */
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

/**
 * The integration's page in `docs/integrations/`, on GitHub.
 *
 * The repo is public, so this is a link an operator can open from a console on
 * the LAN without the app having to serve the docs itself. `docs` is a required
 * field on the descriptor rather than derived from `id` — `pvp`'s page is
 * `provideoplayer.md`, and deriving would 404 on exactly that one.
 *
 * ON THE BRANCH THIS BUILD CAME FROM, not a hardcoded `main`. ProVideoPlayer and
 * Live scores are beta-only integrations whose pages are beta-only too, so a
 * `blob/main/` link 404'd on exactly the two an operator running beta can see —
 * and only on those two, because every integration that has reached main has its
 * page there as well. An install can only show a card for an integration its own
 * build carries, so its own ref is the ref that always has the page.
 *
 * `main` when the branch is unknown or unusable: a packaged install may have no
 * checkout to read one from, and main is the ref whose pages are a superset of
 * what such a build can show.
 */
export function docsUrl(descriptor: Pick<IntegrationDescriptor, "docs">, branch?: string | null): string {
  const ref = branch && SAFE_REF.test(branch) ? branch : "main";
  return `https://github.com/Cornerstone-Production/Stage-Utility/blob/${ref}/docs/integrations/${descriptor.docs}.md`;
}
