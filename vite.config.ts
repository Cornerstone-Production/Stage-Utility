import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    react(),
    // React Compiler auto-memoises components/hooks at build time (React 19).
    babel({
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
  ],

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
    },
  },
});
