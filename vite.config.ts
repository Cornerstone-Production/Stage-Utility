import { defineConfig, type PluginOption } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

// Dev-only: map clean URLs to their entry HTML so the dev server matches what
// the production Node server serves (see remote-server.ts tryServeStatic).
//   /settings        → settings-window.html
//   /display-1, …    → index.html (kiosk; the slug is read client-side)
//   /preview-<view>  → index.html (settings live preview of a View)
function cleanUrls(): PluginOption {
  return {
    name: "clean-urls",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (pathname === "/settings" || pathname === "/settings/") {
          req.url = "/settings-window.html";
        } else if (/^\/(display|preview)-[^/]+\/?$/.test(pathname)) {
          req.url = "/index.html";
        }
        next();
      });
    },
  };
}

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

  // `@renderer/*` is declared in tsconfig.json, which is enough for tsc and for the
  // production build, but the dev server does not read tsconfig paths — so an import
  // through the alias type-checked, built, and then 500'd the moment anyone opened
  // the page in dev. Declared here too, pointing at the same place.
  resolve: {
    alias: { "@renderer": resolve(__dirname, "renderer") },
  },

  // Multi-page: kiosk display + settings panel
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings-window.html"),
      },
    },
    outDir: "build/renderer",
    emptyOutDir: true,
  },

  // Dev server proxies /api/* and /photos to the standalone Node server
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:8788",
        changeOrigin: true,
      },
      "/photos": {
        target: "http://localhost:8788",
        changeOrigin: true,
      },
      // Uploaded images live in the data dir and are served by the Node server.
      // Without these the dev server answers with the SPA fallback — an HTML 200,
      // not a 404 — so every logo and layout image silently renders blank in dev
      // while working perfectly in production.
      "/branding-images": {
        target: "http://localhost:8788",
        changeOrigin: true,
      },
      "/layout-images": {
        target: "http://localhost:8788",
        changeOrigin: true,
      },
    },
  },
});
