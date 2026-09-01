import { defineConfig, type PluginOption } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "fs";
import { resolve } from "path";
import { isOperatorPath } from "./main/services/routes/operator-paths";
import { serverPort } from "./main/services/server-port";

// Dev-only: map clean URLs to their entry HTML so the dev server matches what
// the production Node server serves (see remote-server.ts tryServeStatic).
//   /settings, /history, /patch → app.html (operator app; see operator-paths.ts)
//   /display-1, …    → index.html (kiosk; the slug is read client-side)
//   /preview-<view>  → index.html (settings live preview of a View)
//
// The operator-path test lives in operator-paths.ts rather than here so dev and
// prod cannot answer the same URL with different documents.
function cleanUrls(): PluginOption {
  return {
    name: "clean-urls",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (isOperatorPath(pathname)) {
          req.url = "/app.html";
        } else if (/^\/(display|preview)-[^/]+\/?$/.test(pathname)) {
          req.url = "/index.html";
        }
        next();
      });
    },
  };
}

/** `{"@x/*": ["./x/*"]}` from tsconfig → `{"@x": "<root>/x"}` for Vite. */
function tsconfigAliases(): Record<string, string> {
  const paths: Record<string, string[]> =
    JSON.parse(readFileSync(resolve(__dirname, "tsconfig.json"), "utf8")).compilerOptions?.paths ?? {};
  const out: Record<string, string> = {};
  for (const [k, [v]] of Object.entries(paths)) {
    if (!v) continue;
    out[k.replace(/\/\*$/, "")] = resolve(__dirname, v.replace(/^\.\//, "").replace(/\/\*$/, ""));
  }
  return out;
}

/** Where the dev server forwards API traffic. Announced on start, because a
 *  proxy pointing at somebody else's server is invisible until it is not. */
const API_TARGET = `http://localhost:${serverPort()}`;

export default defineConfig({
  plugins: [
    cleanUrls(),
    react(),
    // React Compiler auto-memoises components/hooks at build time (React 19).
    babel({
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
  ],

  // Path aliases come from tsconfig, which tsc and the production build already
  // read. The dev server does not, so an import through an alias would type-check,
  // build, and then 500 the page in dev. Deriving them here rather than repeating
  // the list keeps the two from drifting apart when a new alias is added.
  resolve: {
    alias: tsconfigAliases(),
  },

  // Multi-page: kiosk display + settings panel
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
      },
    },
    outDir: "build/renderer",
    emptyOutDir: true,
  },

  // Dev server proxies /api/* and /photos to the standalone Node server.
  //
  // The target FOLLOWS STAGE_UTILITY_PORT, through the same serverPort() the
  // server binds with, so `STAGE_UTILITY_PORT=8799 npm run server` and
  // `STAGE_UTILITY_PORT=8799 npm run dev` move together. Hard-coding 8788 here
  // meant the two halves could not: move the server off the default — the
  // obvious thing to do when something else already holds it — and the dev UI
  // went on talking to whatever answered on 8788, editing it, with nothing on
  // screen saying so.
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
      "/photos": {
        target: API_TARGET,
        changeOrigin: true,
      },
      // Uploaded images live in the data dir and are served by the Node server.
      // Without these the dev server answers with the SPA fallback — an HTML 200,
      // not a 404 — so every logo and layout image silently renders blank in dev
      // while working perfectly in production.
      "/branding-images": {
        target: API_TARGET,
        changeOrigin: true,
      },
      "/layout-images": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
