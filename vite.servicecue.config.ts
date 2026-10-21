import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildManifest } from "./main/services/install-metadata";
import { tsconfigAliases } from "./main/services/vite-aliases";
import { PUBLIC_STATIC_FILES, VIEWER_HTML, viewerBuildTag } from "./main/types/servicecue-publish";
import { STATIC_HEADERS_FILE, staticHeaders } from "./publish/servicecue/src/headers";

// The public ServiceCue viewer: servicecue.html and what it loads, built into the
// folder the Worker in publish/servicecue/ serves as its static assets.
//
//   npm run servicecue:build
//
// Its own config and not a third entry of vite.config.ts, because it is a different
// product: served by a different host, from a different origin, with a content
// security policy that allows no inline script, and built from a smaller part of
// the same code (renderer/public/public-router.tsx names what it mounts).

/** Where the build goes, and where wrangler.jsonc's `assets.directory` looks. Gitignored. */
const OUT_DIR = resolve(__dirname, "publish/servicecue/public");

const MANIFEST = "/manifest.webmanifest";

/**
 * What the build adds to what Vite writes:
 *
 *  - the files the Worker names beside the page (PUBLIC_STATIC_FILES): the stock icons,
 *    copied from public/ by name, and a manifest for the page. `publicDir` is off for
 *    this build, because public/ also holds control.html and whatever else gets put
 *    there, and copying the folder would put it on the public host;
 *  - the headers file the asset service reads, for the files it answers itself;
 *  - the document's build id (VIEWER_BUILD_META), the hash of the document as Vite wrote
 *    it. Its script and style names carry their own content hashes, so the document
 *    differs whenever either does; an icon or a manifest that changes alone is not a new
 *    build, and does not reload an open page.
 *
 * And takes one thing out: api.ts names the operator app's shared worker, which Vite
 * emits as a file of its own. The public page never starts one, so it is not shipped.
 */
function viewerFiles(): Plugin {
  return {
    name: "servicecue-viewer-files",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const path of PUBLIC_STATIC_FILES) {
        const fileName = path.slice(1);
        // The operator app's manifest, with the page's own name and address: the
        // installed icon opens the launcher.
        const source =
          path === MANIFEST
            ? `${JSON.stringify({ ...buildManifest("ServiceCue"), start_url: "/servicecue" }, null, 2)}\n`
            : readFileSync(resolve(__dirname, "public", fileName));
        this.emitFile({ type: "asset", fileName, source });
      }
      this.emitFile({ type: "asset", fileName: STATIC_HEADERS_FILE, source: staticHeaders() });

      for (const fileName of Object.keys(bundle)) if (fileName.includes("sse-shared-worker")) delete bundle[fileName];

      const document = bundle[VIEWER_HTML.slice(1)];
      if (!document || document.type !== "asset") throw new Error(`the build wrote no ${VIEWER_HTML.slice(1)} to stamp with its id`);
      const html = typeof document.source === "string" ? document.source : new TextDecoder().decode(document.source);
      if (!html.includes("</head>")) throw new Error(`${VIEWER_HTML.slice(1)} has no </head> to put the build id before`);
      const id = createHash("sha256").update(html).digest("hex").slice(0, 12);
      document.source = html.replace("</head>", `${viewerBuildTag(id)}</head>`);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    // The same React Compiler setup as the operator app.
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    viewerFiles(),
  ],

  resolve: { alias: tsconfigAliases(__dirname) },

  publicDir: false,

  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    // Nothing becomes a data: URI. The page's policy allows data: for images and
    // not for fonts, and a small font inlined into the stylesheet would be blocked.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { servicecue: resolve(__dirname, "servicecue.html") },
    },
  },
});
